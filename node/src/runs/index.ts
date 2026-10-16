/**
 * Stage 2 Run lifecycle + durable step journal (PRISM V1 §27.2–§27.5,
 * §58.2, §58.6, §58.9).
 *
 * - Run states are the `run` machine, step attempts the `stepAttempt`
 *   machine, approvals the `approval` machine — all via `canTransition`
 *   from `@prism/schemas`. Terminal Runs never resume; `restartFromCheckpoint()`
 *   creates a NEW Run attempt (`attempt_no + 1`, `restart_of_run_id`,
 *   `from_checkpoint_id`) and never mutates the old record back to execution.
 * - Fencing: node-global `FencingEpoch` (boot-bumped once in a single
 *   `BEGIN IMMEDIATE` transaction; the epoch table is never restored from
 *   backup). Every dispatch issues a fresh `epoch:counter` token; dispatch,
 *   result commit, and checkpoint commit require the presented token to equal
 *   the Run's current token (`compareFencingToken`), so stale workers can
 *   neither start a new side effect nor commit state. `restartFromCheckpoint()`
 *   advances the epoch and fences in-flight (`STARTED`) steps of the
 *   superseded attempt to `SIDE_EFFECT_UNCERTAIN`.
 * - Approval consumption is atomic with the step `STARTED` transition and
 *   persistence of the request hash/idempotency key (single transaction when
 *   a database is present). A retry with the same key but different args
 *   fails with `CONFLICT`. `SIDE_EFFECT_UNCERTAIN` clears only via
 *   `RECONCILING` (receipt or explicit §27.5 resolution).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  canTransition,
  compareFencingToken,
  parseFencingToken,
} from "@prism/schemas";
import type { ErrorCode } from "@prism/schemas";
import type { SecretStore } from "../auth/index.js";
import { withTransaction } from "../storage/index.js";

export const RUN_MACHINE = "run" as const;
export const STEP_ATTEMPT_MACHINE = "stepAttempt" as const;
export const APPROVAL_MACHINE = "approval" as const;

export type RunState =
  | "QUEUED"
  | "ADMITTED"
  | "RUNNING"
  | "CHECKPOINTING"
  | "WAITING_APPROVAL"
  | "WAITING_CHILD"
  | "WAITING_MESSAGE"
  | "SLEEPING"
  | "WAITING_RESOURCES"
  | "WAITING_BUDGET"
  | "PAUSING"
  | "PAUSED"
  | "CANCELLING"
  | "SUCCEEDED"
  | "FAILED"
  | "RECOVERY_REQUIRED"
  | "CANCELLED";

export type StepAttemptState =
  | "PENDING"
  | "READY"
  | "WAITING_APPROVAL"
  | "CANCELLED"
  | "STARTED"
  | "SUCCEEDED"
  | "FAILED"
  | "SIDE_EFFECT_UNCERTAIN"
  | "RECONCILING"
  | "RETRYABLE"
  | "DENIED"
  | "EXPIRED";

export type ApprovalState =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "EXPIRED"
  | "CANCELLED"
  | "CONSUMED";

export const RUN_TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

export function isRunTerminal(state: RunState): boolean {
  return RUN_TERMINAL_STATES.has(state);
}

/** States the scheduler may requeue to `QUEUED` (no teardown needed). */
export const REQUEUEABLE_RUN_STATES: readonly string[] = [
  "WAITING_APPROVAL",
  "WAITING_CHILD",
  "WAITING_MESSAGE",
  "SLEEPING",
  "WAITING_RESOURCES",
  "WAITING_BUDGET",
  "PAUSED",
];

export type RunRecoveryResolution = "requeue" | "fail" | "cancel";

const RUN_RECOVERY_TARGET: Record<RunRecoveryResolution, RunState> = {
  requeue: "QUEUED",
  fail: "FAILED",
  cancel: "CANCELLED",
};

export interface RunTransition {
  from: RunState;
  to: RunState;
  at: number;
  reason?: string;
}

export interface RunRecord {
  readonly id: string;
  taskId: string;
  agentId: string;
  state: RunState;
  attemptNo: number;
  restartOfRunId: string | null;
  fromCheckpointId: string | null;
  /** Current execution-lease fencing token (`epoch:counter`). */
  fencingToken: string;
  checkpointIds: string[];
  readonly createdAt: number;
  updatedAt: number;
  history: RunTransition[];
}

export interface StepTransition {
  from: StepAttemptState;
  to: StepAttemptState;
  at: number;
  reason?: string;
}

export interface StepAttemptRecord {
  readonly id: string;
  runId: string;
  stepId: string;
  state: StepAttemptState;
  /** 1-based index of this journal attempt under its logical StepId. */
  attemptIndex: number;
  requestHash: string | null;
  idempotencyKey: string | null;
  approvalRef: string | null;
  workerLease: string | null;
  fencingToken: string;
  resultReceipt: string | null;
  reconciliation: "none" | "pending" | "resolved";
  readonly createdAt: number;
  updatedAt: number;
  history: StepTransition[];
}

export interface ApprovalRecord {
  readonly id: string;
  actionHash: string;
  runId: string | null;
  stepId: string | null;
  state: ApprovalState;
  consumedByAttemptId: string | null;
  readonly createdAt: number;
  updatedAt: number;
}

/** Immutable checkpoint snapshot referenced by its Run (§58.9). */
export interface CheckpointRecord {
  readonly id: string;
  runId: string;
  attemptNo: number;
  data: Record<string, unknown>;
  fencingToken: string;
  readonly createdAt: number;
}

export interface IdempotencyReceipt {
  key: string;
  requestHash: string;
  attemptId: string;
  runId: string;
  stepId: string;
}

export interface CreateRunInput {
  taskId: string;
  agentId: string;
}

export interface StartStepInput {
  workerLease: string;
  /** Presented lease token; must equal the Run's current fencing token. */
  fencingToken: string;
  requestHash: string;
  idempotencyKey?: string;
  approvalRef?: string;
  actionHash?: string;
}

export interface FinishStepInput {
  fencingToken: string;
  receipt?: string;
}

export interface RunManagerOptions {
  db?: DatabaseSync;
  /** When set, Run creation/restart throw `SECRETS_LOCKED` while locked. */
  secretStore?: SecretStore;
  now?: () => number;
}

export class RunError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "RunError";
    this.code = code;
  }
}

const T_RUNS = "stage2_runs";
const T_ATTEMPTS = "stage2_step_attempts";
const T_APPROVALS = "stage2_approvals";
const T_CHECKPOINTS = "stage2_checkpoints";
const T_IDEMPOTENCY = "stage2_idempotency";
const T_FENCING = "stage2_fencing_epoch";

const REQUEST_HASH_RE = /^[0-9a-f]{64}$/;
const ACTION_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Node-global fencing epoch (§27.2, §58.9, invariant 46/22).
 *
 * The epoch is bumped once at construction (boot) inside a single
 * `BEGIN IMMEDIATE` transaction before any admission, and again on every
 * restart. The epoch table is node-local and MUST never be restored from a
 * backup — a fresh `FencingEpoch` over restored data bumps past it.
 */
export class FencingEpoch {
  private epoch: number;
  private readonly counters = new Map<number, number>();
  private readonly db: DatabaseSync | null;
  private readonly now: () => number;

  constructor(opts?: { db?: DatabaseSync; now?: () => number }) {
    const db = opts?.db ?? null;
    this.db = db;
    this.now = opts?.now ?? Date.now;
    if (db !== null) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${T_FENCING} (` +
          `epoch INTEGER PRIMARY KEY AUTOINCREMENT, ` +
          `bumped_at INTEGER NOT NULL` +
          `);`,
      );
      const row = db
        .prepare(`SELECT MAX(epoch) AS epoch FROM ${T_FENCING};`)
        .get() as { epoch: number | null };
      this.epoch = row.epoch ?? 0;
    } else {
      this.epoch = 0;
    }
    this.bumpRaw();
    if (db !== null) {
      withTransaction(db, () => {
        db.prepare(`INSERT INTO ${T_FENCING}(bumped_at) VALUES (?);`).run(
          this.now(),
        );
      });
      const row = db
        .prepare(`SELECT MAX(epoch) AS epoch FROM ${T_FENCING};`)
        .get() as { epoch: number | null };
      if (row.epoch !== null) this.epoch = row.epoch;
    }
  }

  private bumpRaw(): void {
    this.epoch += 1;
  }

  /** Advance the epoch (restart/fence). Returns the new epoch. */
  bump(): number {
    this.bumpRaw();
    const db = this.db;
    if (db !== null) {
      const at = this.now();
      withTransaction(db, () => {
        db.prepare(`INSERT INTO ${T_FENCING}(bumped_at) VALUES (?);`).run(at);
      });
      const row = db
        .prepare(`SELECT MAX(epoch) AS epoch FROM ${T_FENCING};`)
        .get() as { epoch: number | null };
      if (row.epoch !== null) this.epoch = row.epoch;
    }
    return this.epoch;
  }

  currentEpoch(): number {
    return this.epoch;
  }

  /** Issue a fresh monotonically increasing `epoch:counter` token. */
  issue(): string {
    const next = (this.counters.get(this.epoch) ?? 0) + 1;
    this.counters.set(this.epoch, next);
    return `${this.epoch}:${next}`;
  }
}

function cloneRun(record: RunRecord): RunRecord {
  return {
    ...record,
    checkpointIds: [...record.checkpointIds],
    history: record.history.map((h) => ({ ...h })),
  };
}

function cloneAttempt(record: StepAttemptRecord): StepAttemptRecord {
  return { ...record, history: record.history.map((h) => ({ ...h })) };
}

function cloneApproval(record: ApprovalRecord): ApprovalRecord {
  return { ...record };
}

function cloneCheckpoint(record: CheckpointRecord): CheckpointRecord {
  return { ...record, data: structuredClone(record.data) };
}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly attempts = new Map<string, StepAttemptRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly checkpoints = new Map<string, CheckpointRecord>();
  private readonly idempotency = new Map<string, IdempotencyReceipt>();
  private readonly fencing: FencingEpoch;
  private readonly db: DatabaseSync | null;
  private readonly secretStore: SecretStore | null;
  private readonly now: () => number;

  constructor(opts: RunManagerOptions = {}) {
    const db = opts.db ?? null;
    this.db = db;
    this.secretStore = opts.secretStore ?? null;
    this.now = opts.now ?? Date.now;
    this.fencing = new FencingEpoch({ db: db ?? undefined, now: this.now });
    if (db !== null) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${T_RUNS} (` +
          `id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${T_ATTEMPTS} (` +
          `id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, state TEXT NOT NULL, ` +
          `data TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${T_APPROVALS} (` +
          `id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${T_CHECKPOINTS} (` +
          `id TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${T_IDEMPOTENCY} (` +
          `key TEXT PRIMARY KEY, data TEXT NOT NULL);`,
      );
      this.load(db);
    }
  }

  fencingEpoch(): number {
    return this.fencing.currentEpoch();
  }

  private load(db: DatabaseSync): void {
    for (const row of db.prepare(`SELECT data FROM ${T_RUNS};`).all() as Array<{
      data: string;
    }>) {
      const parsed = JSON.parse(row.data) as RunRecord;
      this.runs.set(parsed.id, parsed);
    }
    for (const row of db
      .prepare(`SELECT data FROM ${T_ATTEMPTS};`)
      .all() as Array<{ data: string }>) {
      const parsed = JSON.parse(row.data) as StepAttemptRecord;
      this.attempts.set(parsed.id, parsed);
    }
    for (const row of db
      .prepare(`SELECT data FROM ${T_APPROVALS};`)
      .all() as Array<{ data: string }>) {
      const parsed = JSON.parse(row.data) as ApprovalRecord;
      this.approvals.set(parsed.id, parsed);
    }
    for (const row of db
      .prepare(`SELECT data FROM ${T_CHECKPOINTS};`)
      .all() as Array<{ data: string }>) {
      const parsed = JSON.parse(row.data) as CheckpointRecord;
      this.checkpoints.set(parsed.id, parsed);
    }
    for (const row of db
      .prepare(`SELECT data FROM ${T_IDEMPOTENCY};`)
      .all() as Array<{ data: string }>) {
      const parsed = JSON.parse(row.data) as IdempotencyReceipt;
      this.idempotency.set(parsed.key, parsed);
    }
  }

  private transact(fn: () => void): void {
    const db = this.db;
    if (db === null) {
      fn();
      return;
    }
    withTransaction(db, () => {
      fn();
    });
  }

  private saveRunRaw(run: RunRecord): void {
    const db = this.db;
    if (db === null) return;
    db.prepare(
      `INSERT OR REPLACE INTO ${T_RUNS}(id, state, data, updated_at) VALUES (?, ?, ?, ?);`,
    ).run(run.id, run.state, JSON.stringify(run), run.updatedAt);
  }

  private saveAttemptRaw(attempt: StepAttemptRecord): void {
    const db = this.db;
    if (db === null) return;
    db.prepare(
      `INSERT OR REPLACE INTO ${T_ATTEMPTS}(id, run_id, step_id, state, data, updated_at) VALUES (?, ?, ?, ?, ?, ?);`,
    ).run(
      attempt.id,
      attempt.runId,
      attempt.stepId,
      attempt.state,
      JSON.stringify(attempt),
      attempt.updatedAt,
    );
  }

  private saveApprovalRaw(approval: ApprovalRecord): void {
    const db = this.db;
    if (db === null) return;
    db.prepare(
      `INSERT OR REPLACE INTO ${T_APPROVALS}(id, state, data, updated_at) VALUES (?, ?, ?, ?);`,
    ).run(
      approval.id,
      approval.state,
      JSON.stringify(approval),
      approval.updatedAt,
    );
  }

  private saveCheckpointRaw(checkpoint: CheckpointRecord): void {
    const db = this.db;
    if (db === null) return;
    db.prepare(
      `INSERT OR REPLACE INTO ${T_CHECKPOINTS}(id, run_id, data, created_at) VALUES (?, ?, ?, ?);`,
    ).run(
      checkpoint.id,
      checkpoint.runId,
      JSON.stringify(checkpoint),
      checkpoint.createdAt,
    );
  }

  private saveIdempotencyRaw(receipt: IdempotencyReceipt): void {
    const db = this.db;
    if (db === null) return;
    db.prepare(`INSERT OR REPLACE INTO ${T_IDEMPOTENCY}(key, data) VALUES (?, ?);`).run(
      receipt.key,
      JSON.stringify(receipt),
    );
  }

  private requireGuard(): void {
    if (this.secretStore !== null) this.secretStore.assertUnlocked();
  }

  private requireRun(id: string): RunRecord {
    const run = this.runs.get(id);
    if (run === undefined) throw new RunError("NOT_FOUND", `run not found: ${id}`);
    return run;
  }

  private requireAttempt(id: string): StepAttemptRecord {
    const attempt = this.attempts.get(id);
    if (attempt === undefined) {
      throw new RunError("NOT_FOUND", `step attempt not found: ${id}`);
    }
    return attempt;
  }

  private requireApproval(id: string): ApprovalRecord {
    const approval = this.approvals.get(id);
    if (approval === undefined) {
      throw new RunError("NOT_FOUND", `approval not found: ${id}`);
    }
    return approval;
  }

  private applyRunTransition(run: RunRecord, to: RunState, reason?: string): void {
    if (!canTransition(RUN_MACHINE, run.state, to)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        `illegal transition: run ${run.state} -> ${to}`,
      );
    }
    const from = run.state;
    run.state = to;
    run.updatedAt = this.now();
    const entry: RunTransition = { from, to, at: run.updatedAt };
    if (reason !== undefined) entry.reason = reason;
    run.history.push(entry);
  }

  private applyAttemptTransition(
    attempt: StepAttemptRecord,
    to: StepAttemptState,
    reason?: string,
  ): void {
    if (!canTransition(STEP_ATTEMPT_MACHINE, attempt.state, to)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        `illegal transition: stepAttempt ${attempt.state} -> ${to}`,
      );
    }
    const from = attempt.state;
    attempt.state = to;
    attempt.updatedAt = this.now();
    const entry: StepTransition = { from, to, at: attempt.updatedAt };
    if (reason !== undefined) entry.reason = reason;
    attempt.history.push(entry);
  }

  /**
   * The presented token must equal the Run's current fencing token.
   * Anything older is stale and rejected; anything else is not the lease.
   */
  private assertCurrentFencing(presented: string, current: string): void {
    parseFencingToken(presented);
    parseFencingToken(current);
    if (compareFencingToken(presented, current) !== 0) {
      throw new RunError(
        "CONFLICT",
        `stale fencing token: presented ${presented}, current ${current}`,
      );
    }
  }

  // ------------------------------------------------------------------ runs

  createRun(input: CreateRunInput): RunRecord {
    this.requireGuard();
    if (input.taskId.length === 0 || input.agentId.length === 0) {
      throw new RunError("INVALID_ARGUMENT", "taskId and agentId are required");
    }
    const now = this.now();
    const run: RunRecord = {
      id: `run_${randomUUID()}`,
      taskId: input.taskId,
      agentId: input.agentId,
      state: "QUEUED",
      attemptNo: 1,
      restartOfRunId: null,
      fromCheckpointId: null,
      fencingToken: this.fencing.issue(),
      checkpointIds: [],
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.runs.set(run.id, run);
    this.transact(() => {
      this.saveRunRaw(run);
    });
    return cloneRun(run);
  }

  getRun(id: string): RunRecord | null {
    const run = this.runs.get(id);
    return run === undefined ? null : cloneRun(run);
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].map(cloneRun);
  }

  transitionRun(id: string, to: RunState, reason?: string): RunRecord {
    const run = this.requireRun(id);
    if (isRunTerminal(run.state)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        `run ${id} is terminal (${run.state}); terminal runs never resume — ` +
          `use restartFromCheckpoint() for a new attempt`,
      );
    }
    let out: RunRecord | null = null;
    this.transact(() => {
      this.applyRunTransition(run, to, reason);
      this.saveRunRaw(run);
      out = cloneRun(run);
    });
    if (out === null) throw new RunError("WORKER_FAILURE", "transition failed");
    return out;
  }

  admit(id: string): RunRecord {
    return this.transitionRun(id, "ADMITTED");
  }

  beginRunning(id: string): RunRecord {
    return this.transitionRun(id, "RUNNING");
  }

  beginCheckpointing(id: string): RunRecord {
    return this.transitionRun(id, "CHECKPOINTING");
  }

  finishCheckpointing(id: string): RunRecord {
    return this.transitionRun(id, "RUNNING");
  }

  waitFor(id: string, state: RunState, reason?: string): RunRecord {
    if (!REQUEUEABLE_RUN_STATES.includes(state)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        `not a wait/sleep state: ${state}`,
      );
    }
    return this.transitionRun(id, state, reason);
  }

  requestPause(id: string): RunRecord {
    return this.transitionRun(id, "PAUSING");
  }

  markPaused(id: string): RunRecord {
    return this.transitionRun(id, "PAUSED");
  }

  /** Approved Login Assist pause: `WAITING_APPROVAL -> PAUSED`. */
  loginAssistPause(id: string): RunRecord {
    return this.transitionRun(id, "PAUSED", "login_assist");
  }

  requestCancel(id: string): RunRecord {
    return this.transitionRun(id, "CANCELLING");
  }

  markCancelled(id: string): RunRecord {
    return this.transitionRun(id, "CANCELLED");
  }

  /** Cancel from any `WAITING_*`/`SLEEPING`/`PAUSED` state (no teardown). */
  cancelWaiting(id: string): RunRecord {
    return this.transitionRun(id, "CANCELLED", "cancel");
  }

  /** Re-admit after waiting: `WAITING_*`/`SLEEPING`/`PAUSED -> QUEUED`. */
  requeue(id: string): RunRecord {
    const run = this.requireRun(id);
    if (!REQUEUEABLE_RUN_STATES.includes(run.state)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        `requeue requires a waiting state (now ${run.state})`,
      );
    }
    return this.transitionRun(id, "QUEUED", "requeue");
  }

  succeed(id: string): RunRecord {
    return this.transitionRun(id, "SUCCEEDED");
  }

  fail(id: string, reason?: string): RunRecord {
    return this.transitionRun(id, "FAILED", reason);
  }

  requireRecovery(id: string, reason?: string): RunRecord {
    return this.transitionRun(id, "RECOVERY_REQUIRED", reason);
  }

  /**
   * Leave `RECOVERY_REQUIRED` only through a §27.5 resolution action:
   * `requeue -> QUEUED`, `fail -> FAILED`, `cancel -> CANCELLED`.
   */
  resolveRecovery(id: string, resolution: RunRecoveryResolution): RunRecord {
    const run = this.requireRun(id);
    if (run.state !== "RECOVERY_REQUIRED") {
      throw new RunError(
        "INVALID_ARGUMENT",
        `resolveRecovery requires RECOVERY_REQUIRED (now ${run.state})`,
      );
    }
    return this.transitionRun(id, RUN_RECOVERY_TARGET[resolution], resolution);
  }

  // ------------------------------------------------------------ checkpoints

  /**
   * Commit an immutable checkpoint. Only the current fencing token may
   * commit; the Run passes `RUNNING -> CHECKPOINTING -> RUNNING`.
   */
  commitCheckpoint(
    runId: string,
    data: Record<string, unknown>,
    fencingToken: string,
  ): CheckpointRecord {
    const run = this.requireRun(runId);
    if (run.state !== "RUNNING") {
      throw new RunError(
        "CONFLICT",
        `run ${runId} is ${run.state}; checkpoints commit only while RUNNING`,
      );
    }
    this.assertCurrentFencing(fencingToken, run.fencingToken);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new RunError("INVALID_ARGUMENT", "checkpoint data must be an object");
    }
    const nextStep = (data as { nextStep?: unknown }).nextStep;
    if (typeof nextStep !== "string" || nextStep.length === 0) {
      throw new RunError(
        "INVALID_ARGUMENT",
        "checkpoint data requires a nextStep",
      );
    }
    const now = this.now();
    const checkpoint: CheckpointRecord = {
      id: `ckpt_${randomUUID()}`,
      runId: run.id,
      attemptNo: run.attemptNo,
      data: structuredClone(data),
      fencingToken: run.fencingToken,
      createdAt: now,
    };
    Object.freeze(checkpoint.data);
    this.checkpoints.set(checkpoint.id, checkpoint);
    let out: CheckpointRecord | null = null;
    this.transact(() => {
      this.applyRunTransition(run, "CHECKPOINTING", "commit");
      run.checkpointIds.push(checkpoint.id);
      this.applyRunTransition(run, "RUNNING", "commit");
      this.saveRunRaw(run);
      this.saveCheckpointRaw(checkpoint);
      out = cloneCheckpoint(checkpoint);
    });
    if (out === null) throw new RunError("WORKER_FAILURE", "checkpoint failed");
    return out;
  }

  getCheckpoint(id: string): CheckpointRecord | null {
    const checkpoint = this.checkpoints.get(id);
    return checkpoint === undefined ? null : cloneCheckpoint(checkpoint);
  }

  listCheckpoints(runId: string): CheckpointRecord[] {
    const out: CheckpointRecord[] = [];
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.runId === runId) out.push(cloneCheckpoint(checkpoint));
    }
    return out;
  }

  /**
   * Restart from a checkpoint (§27.5): always a NEW Run attempt
   * (`attempt_no + 1`, `restart_of_run_id`, `from_checkpoint_id`). The old
   * record is never resumed — not even when non-terminal. The fencing epoch
   * advances, the new attempt starts `QUEUED` with a fresh token, and any
   * in-flight (`STARTED`) steps of a non-terminal superseded attempt are
   * fenced to `SIDE_EFFECT_UNCERTAIN`.
   */
  restartFromCheckpoint(runId: string, checkpointId: string): RunRecord {
    this.requireGuard();
    const old = this.requireRun(runId);
    const checkpoint = this.checkpoints.get(checkpointId);
    if (checkpoint === undefined) {
      throw new RunError("NOT_FOUND", `checkpoint not found: ${checkpointId}`);
    }
    if (checkpoint.runId !== old.id) {
      throw new RunError(
        "INVALID_ARGUMENT",
        `checkpoint ${checkpointId} does not belong to run ${runId}`,
      );
    }
    const now = this.now();
    const next: RunRecord = {
      id: `run_${randomUUID()}`,
      taskId: old.taskId,
      agentId: old.agentId,
      state: "QUEUED",
      attemptNo: old.attemptNo + 1,
      restartOfRunId: old.id,
      fromCheckpointId: checkpoint.id,
      fencingToken: "",
      checkpointIds: [],
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.runs.set(next.id, next);
    let out: RunRecord | null = null;
    this.transact(() => {
      if (!isRunTerminal(old.state)) {
        for (const attempt of this.attempts.values()) {
          if (attempt.runId !== old.id || attempt.state !== "STARTED") continue;
          this.applyAttemptTransition(
            attempt,
            "SIDE_EFFECT_UNCERTAIN",
            "fenced by restart",
          );
          attempt.reconciliation = "pending";
          attempt.updatedAt = this.now();
          this.saveAttemptRaw(attempt);
        }
      }
      const epoch = this.fencing.bump();
      void epoch;
      next.fencingToken = this.fencing.issue();
      next.updatedAt = this.now();
      this.saveRunRaw(next);
      out = cloneRun(next);
    });
    if (out === null) throw new RunError("WORKER_FAILURE", "restart failed");
    return out;
  }

  // -------------------------------------------------------------- approvals

  registerApproval(input: {
    actionHash: string;
    runId?: string;
    stepId?: string;
  }): ApprovalRecord {
    if (!ACTION_HASH_RE.test(input.actionHash)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        "approval requires a 64-hex action hash",
      );
    }
    const now = this.now();
    const approval: ApprovalRecord = {
      id: `appr_${randomUUID()}`,
      actionHash: input.actionHash.toLowerCase(),
      runId: input.runId ?? null,
      stepId: input.stepId ?? null,
      state: "PENDING",
      consumedByAttemptId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.approvals.set(approval.id, approval);
    this.transact(() => {
      this.saveApprovalRaw(approval);
    });
    return cloneApproval(approval);
  }

  getApproval(id: string): ApprovalRecord | null {
    const approval = this.approvals.get(id);
    return approval === undefined ? null : cloneApproval(approval);
  }

  transitionApproval(id: string, to: ApprovalState): ApprovalRecord {
    const approval = this.requireApproval(id);
    if (!canTransition(APPROVAL_MACHINE, approval.state, to)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        `illegal transition: approval ${approval.state} -> ${to}`,
      );
    }
    let out: ApprovalRecord | null = null;
    this.transact(() => {
      approval.state = to;
      approval.updatedAt = this.now();
      this.saveApprovalRaw(approval);
      out = cloneApproval(approval);
    });
    if (out === null) throw new RunError("WORKER_FAILURE", "transition failed");
    return out;
  }

  approveApproval(id: string): ApprovalRecord {
    return this.transitionApproval(id, "APPROVED");
  }

  denyApproval(id: string): ApprovalRecord {
    return this.transitionApproval(id, "DENIED");
  }

  expireApproval(id: string): ApprovalRecord {
    return this.transitionApproval(id, "EXPIRED");
  }

  cancelApproval(id: string): ApprovalRecord {
    return this.transitionApproval(id, "CANCELLED");
  }

  // ---------------------------------------------------------- step attempts

  createStepAttempt(
    runId: string,
    stepId: string,
    opts?: { needsApproval?: boolean; requestHash?: string },
  ): StepAttemptRecord {
    const run = this.requireRun(runId);
    if (isRunTerminal(run.state)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        `run ${runId} is terminal (${run.state}); no new step attempts`,
      );
    }
    if (stepId.length === 0) {
      throw new RunError("INVALID_ARGUMENT", "stepId is required");
    }
    if (opts?.requestHash !== undefined && !REQUEST_HASH_RE.test(opts.requestHash)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        "requestHash must be 64 hex characters",
      );
    }
    let attemptIndex = 1;
    for (const attempt of this.attempts.values()) {
      if (attempt.runId === runId && attempt.stepId === stepId) {
        attemptIndex = Math.max(attemptIndex, attempt.attemptIndex + 1);
      }
    }
    const now = this.now();
    const attempt: StepAttemptRecord = {
      id: `satt_${randomUUID()}`,
      runId,
      stepId,
      state: opts?.needsApproval === true ? "WAITING_APPROVAL" : "PENDING",
      attemptIndex,
      requestHash: opts?.requestHash ?? null,
      idempotencyKey: null,
      approvalRef: null,
      workerLease: null,
      fencingToken: run.fencingToken,
      resultReceipt: null,
      reconciliation: "none",
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.attempts.set(attempt.id, attempt);
    this.transact(() => {
      this.saveAttemptRaw(attempt);
    });
    return cloneAttempt(attempt);
  }

  getStepAttempt(id: string): StepAttemptRecord | null {
    const attempt = this.attempts.get(id);
    return attempt === undefined ? null : cloneAttempt(attempt);
  }

  listStepAttempts(runId: string): StepAttemptRecord[] {
    const out: StepAttemptRecord[] = [];
    for (const attempt of this.attempts.values()) {
      if (attempt.runId === runId) out.push(cloneAttempt(attempt));
    }
    return out;
  }

  getIdempotencyReceipt(key: string): IdempotencyReceipt | null {
    const receipt = this.idempotency.get(key);
    return receipt === undefined ? null : { ...receipt };
  }

  markStepReady(id: string): StepAttemptRecord {
    const attempt = this.requireAttempt(id);
    let out: StepAttemptRecord | null = null;
    this.transact(() => {
      this.applyAttemptTransition(attempt, "READY");
      this.saveAttemptRaw(attempt);
      out = cloneAttempt(attempt);
    });
    if (out === null) throw new RunError("WORKER_FAILURE", "markStepReady failed");
    return out;
  }

  cancelStepAttempt(id: string): StepAttemptRecord {
    const attempt = this.requireAttempt(id);
    let out: StepAttemptRecord | null = null;
    this.transact(() => {
      this.applyAttemptTransition(attempt, "CANCELLED", "cancel");
      this.saveAttemptRaw(attempt);
      out = cloneAttempt(attempt);
    });
    if (out === null) {
      throw new RunError("WORKER_FAILURE", "cancelStepAttempt failed");
    }
    return out;
  }

  /**
   * Dispatch + start a step attempt. The presented fencing token must equal
   * the Run's current token (stale tokens cannot dispatch). The
   * `READY -> STARTED` transition commits atomically with approval
   * consumption and persistence of the request hash/idempotency key in a
   * single transaction when a database is present.
   *
   * Idempotency (§58.6): the same key with the same args replays the existing
   * attempt; the same key with different args fails with `CONFLICT`.
   */
  startStepAttempt(
    id: string,
    input: StartStepInput,
    opts?: { supersedesAttemptId?: string },
  ): StepAttemptRecord {
    const attempt = this.requireAttempt(id);
    const run = this.requireRun(attempt.runId);
    if (run.state !== "RUNNING") {
      throw new RunError(
        "CONFLICT",
        `run ${run.id} is ${run.state}; steps start only while RUNNING`,
      );
    }
    this.assertCurrentFencing(input.fencingToken, run.fencingToken);
    if (attempt.state !== "READY" && attempt.state !== "WAITING_APPROVAL") {
      throw new RunError(
        "INVALID_ARGUMENT",
        `step attempt ${id} is ${attempt.state}; STARTED requires READY`,
      );
    }
    if (!REQUEST_HASH_RE.test(input.requestHash)) {
      throw new RunError(
        "INVALID_ARGUMENT",
        "requestHash must be 64 hex characters",
      );
    }
    if (
      attempt.requestHash !== null &&
      attempt.requestHash !== input.requestHash.toLowerCase()
    ) {
      throw new RunError(
        "INVALID_ARGUMENT",
        "changed request requires a new StepId",
      );
    }
    if (typeof input.workerLease !== "string" || input.workerLease.length === 0) {
      throw new RunError("INVALID_ARGUMENT", "workerLease is required");
    }

    if (input.idempotencyKey !== undefined) {
      if (input.idempotencyKey.length === 0) {
        throw new RunError("INVALID_ARGUMENT", "idempotencyKey must be non-empty");
      }
      const existing = this.idempotency.get(input.idempotencyKey);
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash.toLowerCase()) {
          throw new RunError(
            "CONFLICT",
            `idempotency key ${input.idempotencyKey} already used with different args`,
          );
        }
        const supersedes = opts?.supersedesAttemptId;
        if (supersedes === undefined || existing.attemptId !== supersedes) {
          const prior = this.attempts.get(existing.attemptId);
          if (prior !== undefined) return cloneAttempt(prior);
        }
      }
    }

    let approval: ApprovalRecord | null = null;
    if (input.approvalRef !== undefined) {
      approval = this.requireApproval(input.approvalRef);
      if (
        input.actionHash !== undefined &&
        approval.actionHash !== input.actionHash.toLowerCase()
      ) {
        throw new RunError("APPROVAL_INVALID", "approval action hash mismatch");
      }
      if (approval.state !== "APPROVED") {
        throw new RunError(
          "APPROVAL_INVALID",
          `approval ${approval.id} is ${approval.state}; STARTED requires APPROVED`,
        );
      }
    } else if (attempt.state === "WAITING_APPROVAL") {
      throw new RunError(
        "APPROVAL_REQUIRED",
        `step attempt ${id} is waiting for approval`,
      );
    }

    let out: StepAttemptRecord | null = null;
    this.transact(() => {
      if (approval !== null) {
        if (!canTransition(APPROVAL_MACHINE, approval.state, "CONSUMED")) {
          throw new RunError(
            "APPROVAL_INVALID",
            `cannot consume approval ${approval.id} from ${approval.state}`,
          );
        }
        approval.state = "CONSUMED";
        approval.consumedByAttemptId = attempt.id;
        approval.updatedAt = this.now();
        this.saveApprovalRaw(approval);
      }
      if (attempt.state === "WAITING_APPROVAL") {
        this.applyAttemptTransition(attempt, "READY", "approval consumed");
      }
      this.applyAttemptTransition(attempt, "STARTED", "dispatch");
      attempt.workerLease = input.workerLease;
      attempt.requestHash = input.requestHash.toLowerCase();
      if (input.idempotencyKey !== undefined) {
        attempt.idempotencyKey = input.idempotencyKey;
      }
      if (input.approvalRef !== undefined) {
        attempt.approvalRef = input.approvalRef;
      }
      // A dispatch advances the Run lease: only this token may commit.
      const fresh = this.fencing.issue();
      attempt.fencingToken = fresh;
      run.fencingToken = fresh;
      run.updatedAt = this.now();
      if (attempt.idempotencyKey !== null && attempt.requestHash !== null) {
        const receipt: IdempotencyReceipt = {
          key: attempt.idempotencyKey,
          requestHash: attempt.requestHash,
          attemptId: attempt.id,
          runId: run.id,
          stepId: attempt.stepId,
        };
        this.idempotency.set(receipt.key, receipt);
        this.saveIdempotencyRaw(receipt);
      }
      this.saveAttemptRaw(attempt);
      this.saveRunRaw(run);
      out = cloneAttempt(attempt);
    });
    if (out === null) throw new RunError("WORKER_FAILURE", "start failed");
    return out;
  }

  /**
   * Convenience: create (`PENDING`, or `WAITING_APPROVAL` when
   * `needsApproval`) then move to `READY` and start atomically.
   */
  dispatchStep(
    runId: string,
    stepId: string,
    input: StartStepInput & { needsApproval?: boolean },
  ): StepAttemptRecord {
    const attempt = this.createStepAttempt(runId, stepId, {
      needsApproval: input.needsApproval,
      requestHash: input.requestHash,
    });
    if (attempt.state === "PENDING") this.markStepReady(attempt.id);
    return this.startStepAttempt(attempt.id, input);
  }

  /**
   * Commit a step result. Only the current fencing token may commit, so a
   * superseded (re-dispatched) attempt presenting an older token is rejected.
   */
  finishStepAttempt(
    id: string,
    outcome: "succeeded" | "failed",
    input: FinishStepInput,
  ): StepAttemptRecord {
    const attempt = this.requireAttempt(id);
    const run = this.requireRun(attempt.runId);
    if (attempt.state !== "STARTED") {
      throw new RunError(
        "INVALID_ARGUMENT",
        `step attempt ${id} is ${attempt.state}; only STARTED commits a result`,
      );
    }
    this.assertCurrentFencing(input.fencingToken, run.fencingToken);
    let out: StepAttemptRecord | null = null;
    this.transact(() => {
      this.applyAttemptTransition(
        attempt,
        outcome === "succeeded" ? "SUCCEEDED" : "FAILED",
        "result commit",
      );
      if (input.receipt !== undefined) attempt.resultReceipt = input.receipt;
      attempt.reconciliation =
        outcome === "succeeded" ? "resolved" : attempt.reconciliation;
      attempt.updatedAt = this.now();
      this.saveAttemptRaw(attempt);
      out = cloneAttempt(attempt);
    });
    if (out === null) throw new RunError("WORKER_FAILURE", "finish failed");
    return out;
  }

  /**
   * Lease expiry / fence timeout after a side effect started: the outcome is
   * unknown. `STARTED -> SIDE_EFFECT_UNCERTAIN`; never silently replayed.
   */
  markStepUncertain(id: string, reason = "side effect uncertain"): StepAttemptRecord {
    const attempt = this.requireAttempt(id);
    let out: StepAttemptRecord | null = null;
    this.transact(() => {
      this.applyAttemptTransition(attempt, "SIDE_EFFECT_UNCERTAIN", reason);
      attempt.reconciliation = "pending";
      attempt.updatedAt = this.now();
      this.saveAttemptRaw(attempt);
      out = cloneAttempt(attempt);
    });
    if (out === null) throw new RunError("WORKER_FAILURE", "markStepUncertain failed");
    return out;
  }

  beginReconciliation(id: string): StepAttemptRecord {
    const attempt = this.requireAttempt(id);
    let out: StepAttemptRecord | null = null;
    this.transact(() => {
      this.applyAttemptTransition(attempt, "RECONCILING", "reconcile");
      this.saveAttemptRaw(attempt);
      out = cloneAttempt(attempt);
    });
    if (out === null) {
      throw new RunError("WORKER_FAILURE", "beginReconciliation failed");
    }
    return out;
  }

  /**
   * Resolve reconciliation with a receipt or an explicit §27.5 resolution.
   * `SIDE_EFFECT_UNCERTAIN` cannot be cleared any other way.
   */
  resolveReconciliation(
    id: string,
    outcome: "SUCCEEDED" | "FAILED" | "RETRYABLE",
    opts?: { receipt?: string },
  ): StepAttemptRecord {
    const attempt = this.requireAttempt(id);
    let out: StepAttemptRecord | null = null;
    this.transact(() => {
      this.applyAttemptTransition(attempt, outcome, "reconciled");
      if (opts?.receipt !== undefined) attempt.resultReceipt = opts.receipt;
      attempt.reconciliation =
        outcome === "RETRYABLE" ? "pending" : "resolved";
      attempt.updatedAt = this.now();
      this.saveAttemptRaw(attempt);
      out = cloneAttempt(attempt);
    });
    if (out === null) {
      throw new RunError("WORKER_FAILURE", "resolveReconciliation failed");
    }
    return out;
  }

  /**
   * `FAILED -> RETRYABLE`, only when the failure is known and the tool's
   * declared retry contract permits it (caller-attested).
   */
  markStepRetryable(id: string, retryPermitted: boolean): StepAttemptRecord {
    if (!retryPermitted) {
      throw new RunError(
        "POLICY_DENIED",
        "retry requires the tool's declared retry contract",
      );
    }
    const attempt = this.requireAttempt(id);
    let out: StepAttemptRecord | null = null;
    this.transact(() => {
      this.applyAttemptTransition(attempt, "RETRYABLE", "retry permitted");
      attempt.reconciliation = "pending";
      attempt.updatedAt = this.now();
      this.saveAttemptRaw(attempt);
      out = cloneAttempt(attempt);
    });
    if (out === null) {
      throw new RunError("WORKER_FAILURE", "markStepRetryable failed");
    }
    return out;
  }

  /**
   * A retry is a NEW journal attempt under the same logical StepId. The
   * latest attempt for the step must be `RETRYABLE`, and the tool's declared
   * idempotency/reconciliation contract must permit it. The new attempt
   * reuses the same idempotency key and request hash (same canonical
   * request) and is dispatched with a fresh fencing token in one unit.
   */
  retryStep(
    runId: string,
    stepId: string,
    input: StartStepInput & { idempotencyDeclared: boolean },
  ): StepAttemptRecord {
    if (!input.idempotencyDeclared) {
      throw new RunError(
        "POLICY_DENIED",
        "retry requires the tool's declared idempotency/reconciliation contract",
      );
    }
    let latest: StepAttemptRecord | null = null;
    for (const attempt of this.attempts.values()) {
      if (attempt.runId !== runId || attempt.stepId !== stepId) continue;
      if (latest === null || attempt.attemptIndex > latest.attemptIndex) {
        latest = attempt;
      }
    }
    if (latest === null) {
      throw new RunError(
        "NOT_FOUND",
        `no attempts for step ${stepId} in run ${runId}`,
      );
    }
    if (latest.state !== "RETRYABLE") {
      throw new RunError(
        "INVALID_ARGUMENT",
        `step ${stepId} is ${latest.state}; retry requires RETRYABLE`,
      );
    }
    const priorKey = latest.idempotencyKey;
    const priorHash = latest.requestHash;
    if (priorKey === null || priorHash === null) {
      throw new RunError(
        "INVALID_ARGUMENT",
        "retry requires a recorded idempotency key and request hash",
      );
    }
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== priorKey) {
      throw new RunError(
        "INVALID_ARGUMENT",
        "retry reuses the same idempotency key; a changed request is a new step",
      );
    }
    if (input.requestHash.toLowerCase() !== priorHash) {
      throw new RunError(
        "INVALID_ARGUMENT",
        "retry reuses the same request hash; a changed request is a new step",
      );
    }
    const run = this.requireRun(runId);
    const now = this.now();
    const next: StepAttemptRecord = {
      id: `satt_${randomUUID()}`,
      runId,
      stepId,
      state: "PENDING",
      attemptIndex: latest.attemptIndex + 1,
      requestHash: priorHash,
      idempotencyKey: priorKey,
      approvalRef: input.approvalRef ?? null,
      workerLease: null,
      fencingToken: run.fencingToken,
      resultReceipt: null,
      reconciliation: "pending",
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.attempts.set(next.id, next);
    if (next.state === "PENDING") {
      this.transact(() => {
        this.applyAttemptTransition(next, "READY", "retry");
        this.saveAttemptRaw(next);
      });
    }
    return this.startStepAttempt(
      next.id,
      {
        workerLease: input.workerLease,
        fencingToken: input.fencingToken,
        requestHash: priorHash,
        idempotencyKey: priorKey,
        ...(input.approvalRef !== undefined
          ? { approvalRef: input.approvalRef }
          : {}),
        ...(input.actionHash !== undefined
          ? { actionHash: input.actionHash }
          : {}),
      },
      { supersedesAttemptId: latest.id },
    );
  }
}
