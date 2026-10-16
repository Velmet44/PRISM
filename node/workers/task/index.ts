/**
 * Stage 2 task worker — Run-attempt lifecycle guard.
 *
 * Spec: §26 (Task = durable work unit, Run = execution instance), §27.5
 * (restarting from a checkpoint ALWAYS creates a new Run attempt
 * `attempt_no + 1` with `restart_of_run_id`/`from_checkpoint_id`; terminal
 * Runs and Tasks never resume), §27.2–§27.3 (dispatch/commit present the
 * current fencing token; stale workers rejected), §53.2-8.
 *
 * Security boundary (shared with the agent/model workers): the worker holds
 * only a run-scoped capability token derived for (Run, attempt) — an opaque
 * secret shown once at issue, stored as hex(SHA-256(token)). It is NEVER a
 * database handle: validation runs against the narrow `TaskLeaseReader`
 * interface implemented by the control plane over the `leases` table. The
 * token expires with the Run.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { compareFencingToken } from "@prism/schemas";
import type { ErrorCode } from "@prism/schemas";

// ---------------------------------------------------------------------------
// Errors (§58.5)
// ---------------------------------------------------------------------------

export class TaskWorkerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly remediation?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; remediation?: string },
  ) {
    super(message);
    this.name = "TaskWorkerError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    if (opts?.remediation !== undefined) this.remediation = opts.remediation;
  }
}

// ---------------------------------------------------------------------------
// Lease + token model (mirrors the `leases` table, migrations/002_stage2.sql)
// ---------------------------------------------------------------------------

export interface TaskLease {
  leaseId: string;
  runId: string;
  /** The Run attempt this token was derived for. */
  attemptNo: number;
  stepAttemptId: string | null;
  /** Current fencing token `epoch:counter` (§27.2). */
  fencingToken: string;
  /** hex(SHA-256(token secret)) — lookup/verifier, never the secret. */
  tokenSha256: string;
  issuedAtSec: number;
  /** Token expires with the Run: always <= runExpiresAtSec. */
  expiresAtSec: number;
  revokedAtSec: number | null;
}

/** Narrow control-plane view. NOT a database handle. */
export interface TaskLeaseReader {
  getLease(runId: string): TaskLease | null;
}

export interface IssueTaskTokenInput {
  runId: string;
  attemptNo: number;
  stepAttemptId?: string | null;
  fencingToken: string;
  runExpiresAtSec: number;
  ttlSec?: number;
  nowSec?: number;
}

export interface TaskWorkerOp {
  /** Presented opaque capability token (`wtk_…`, shown once at issue). */
  token: string;
  runId: string;
  stepAttemptId: string;
  fencingToken: string;
  nowSec?: number;
}

export type TaskValidation =
  | { ok: true; lease: TaskLease }
  | { ok: false; code: ErrorCode; reason: string };

/** Run states after which no new attempt may start under the same Run. */
const TERMINAL_RUN_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Issue a run-scoped capability token for (Run, attempt). Control-plane
 * side: persist the returned lease row (verifier only), hand the token to
 * the worker exactly once.
 */
export function issueTaskToken(input: IssueTaskTokenInput): {
  token: string;
  lease: TaskLease;
} {
  if (input.runId.length === 0) throw new TaskWorkerError("INVALID_ARGUMENT", "runId required");
  if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1) {
    throw new TaskWorkerError("INVALID_ARGUMENT", "attemptNo must be >= 1");
  }
  compareFencingToken(input.fencingToken, input.fencingToken);
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (input.runExpiresAtSec <= now) {
    throw new TaskWorkerError("INVALID_ARGUMENT", "cannot issue a token for an expired run");
  }
  const ttl = input.ttlSec ?? input.runExpiresAtSec - now;
  if (ttl <= 0) throw new TaskWorkerError("INVALID_ARGUMENT", "ttlSec must be > 0");
  const token = `wtk_${randomBytes(32).toString("hex")}`;
  return {
    token,
    lease: {
      leaseId: `lease_${randomBytes(8).toString("hex")}`,
      runId: input.runId,
      attemptNo: input.attemptNo,
      stepAttemptId: input.stepAttemptId ?? null,
      fencingToken: input.fencingToken,
      tokenSha256: sha256Hex(token),
      issuedAtSec: now,
      expiresAtSec: Math.min(now + ttl, input.runExpiresAtSec),
      revokedAtSec: null,
    },
  };
}

function verifyTokenSecret(presented: string, expectedSha256: string): boolean {
  let expected: Buffer;
  try {
    if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) return false;
    expected = Buffer.from(expectedSha256, "hex");
  } catch {
    return false;
  }
  const computed = Buffer.from(sha256Hex(presented), "hex");
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

/**
 * Validate a worker operation against the durable lease: token binding,
 * expiry (token dies with the Run), revocation, StepAttemptId binding, and
 * fencing-token currency.
 */
export function validateTaskOp(
  store: TaskLeaseReader,
  op: TaskWorkerOp,
): TaskValidation {
  if (op.runId.length === 0) {
    throw new TaskWorkerError("INVALID_ARGUMENT", "runId required");
  }
  if (op.stepAttemptId.length === 0) {
    return { ok: false, code: "INVALID_ARGUMENT", reason: "step_attempt_required" };
  }
  const now = op.nowSec ?? Math.floor(Date.now() / 1000);
  const lease = store.getLease(op.runId);
  if (lease === null) {
    return { ok: false, code: "UNAUTHENTICATED", reason: "unknown_or_expired_lease" };
  }
  if (lease.revokedAtSec !== null) {
    return { ok: false, code: "UNAUTHENTICATED", reason: "lease_revoked" };
  }
  if (now >= lease.expiresAtSec) {
    return { ok: false, code: "UNAUTHENTICATED", reason: "token_expired_with_run" };
  }
  if (!verifyTokenSecret(op.token, lease.tokenSha256)) {
    return { ok: false, code: "UNAUTHENTICATED", reason: "token_mismatch" };
  }
  if (lease.stepAttemptId !== null && op.stepAttemptId !== lease.stepAttemptId) {
    return {
      ok: false,
      code: "CONFLICT",
      reason: "step_attempt_mismatch: lease covers a different attempt",
    };
  }
  let order: number;
  try {
    order = compareFencingToken(op.fencingToken, lease.fencingToken);
  } catch {
    return { ok: false, code: "CONFLICT", reason: "malformed_fencing_token" };
  }
  if (order < 0) {
    return {
      ok: false,
      code: "CONFLICT",
      reason: "stale_fencing_token: worker fenced; must not dispatch or commit",
    };
  }
  if (order > 0) {
    return {
      ok: false,
      code: "CONFLICT",
      reason: "unknown_fencing_token: presented epoch is newer than the durable lease",
    };
  }
  return { ok: true, lease };
}

// ---------------------------------------------------------------------------
// Run-attempt lifecycle (§27.5)
// ---------------------------------------------------------------------------

export interface BeginAttemptInput extends TaskWorkerOp {
  /** Current durable Run status, supplied by the control plane. */
  runStatus: string;
  /** Checkpoint the new attempt is seeded from (crash or owner restart). */
  fromCheckpointId?: string;
}

export interface RunAttemptDescriptor {
  runId: string;
  /** Always previous attempt_no + 1; terminal Runs never resume. */
  attemptNo: number;
  restartOfRunId: string;
  fromCheckpointId: string | null;
  workerLease: string;
  fencingToken: string;
}

/**
 * Open the next attempt of a Run. The worker's token + fencing token are
 * validated first; then §27.5 is enforced: a Run in a terminal state never
 * resumes — an owner-requested restart after terminal state creates a
 * successor Task instead (control-plane decision, not a new attempt here).
 */
export function beginRunAttempt(
  store: TaskLeaseReader,
  input: BeginAttemptInput,
): RunAttemptDescriptor {
  const result = validateTaskOp(store, input);
  if (!result.ok) {
    throw new TaskWorkerError(result.code, `begin-attempt refused: ${result.reason}`, {
      retryable: false,
    });
  }
  if (TERMINAL_RUN_STATES.has(input.runStatus)) {
    throw new TaskWorkerError(
      "INVALID_ARGUMENT",
      `run ${input.runId} is terminal (${input.runStatus}): never resume; create a successor Task`,
      { retryable: false },
    );
  }
  return {
    runId: input.runId,
    attemptNo: result.lease.attemptNo + 1,
    restartOfRunId: input.runId,
    fromCheckpointId: input.fromCheckpointId ?? null,
    workerLease: result.lease.leaseId,
    fencingToken: result.lease.fencingToken,
  };
}

export interface TaskCommitReceipt {
  runId: string;
  stepAttemptId: string;
  fencingToken: string;
  committedAtSec: number;
}

/** Guard a task-state commit (attempt progress, checkpoint pointer). */
export function commitTaskStep(
  store: TaskLeaseReader,
  op: TaskWorkerOp,
): TaskCommitReceipt {
  const result = validateTaskOp(store, op);
  if (!result.ok) {
    throw new TaskWorkerError(result.code, `commit refused: ${result.reason}`, {
      retryable: false,
      remediation:
        "do not assume success or failure; reconcile via receipt or mark SIDE_EFFECT_UNCERTAIN",
    });
  }
  return {
    runId: op.runId,
    stepAttemptId: op.stepAttemptId,
    fencingToken: result.lease.fencingToken,
    committedAtSec: op.nowSec ?? Math.floor(Date.now() / 1000),
  };
}
