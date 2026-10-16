/**
 * Stage 2 Task lifecycle (PRISM V1 §27.5, §58.2).
 *
 * Task states are the `task` machine from `@prism/schemas`; every transition
 * goes through `canTransition` and illegal edges throw. `WAITING` always
 * carries a reason (`approval | child | message | resources | budget |
 * sleep`). Terminal states (`SUCCEEDED`, `FAILED`, `CANCELLED`) never resume:
 * any transition out of one throws, and an owner-requested restart of a
 * terminal Task creates a successor Task (`restarted_from_task_id`) via
 * `restartAsSuccessor()`. Recovery leaves `RECOVERY_REQUIRED` only through a
 * §27.5 resolution action (`resolveRecovery`).
 *
 * A Task's `RUNNING` state means it has an active Run attempt; wait reasons,
 * checkpoints, and side-effect reconciliation live on the Run and its step
 * journal (`../runs/index.js`).
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canTransition } from "@prism/schemas";
import type { ErrorCode } from "@prism/schemas";
import { withTransaction } from "../storage/index.js";

export const TASK_MACHINE = "task" as const;

export type TaskState =
  | "PENDING"
  | "RUNNABLE"
  | "RUNNING"
  | "WAITING"
  | "PAUSED"
  | "CANCELLING"
  | "RECOVERY_REQUIRED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type TaskWaitReason =
  | "approval"
  | "child"
  | "message"
  | "resources"
  | "budget"
  | "sleep";

/** §27.5 resolution actions for `RECOVERY_REQUIRED`. */
export type TaskRecoveryResolution = "resume" | "fail" | "cancel";

const RECOVERY_TARGET: Record<TaskRecoveryResolution, TaskState> = {
  resume: "RUNNABLE",
  fail: "FAILED",
  cancel: "CANCELLED",
};

export const TASK_TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

export function isTaskTerminal(state: TaskState): boolean {
  return TASK_TERMINAL_STATES.has(state);
}

export interface TaskTransition {
  from: TaskState;
  to: TaskState;
  at: number;
  reason?: string;
}

export interface TaskRecord {
  readonly id: string;
  agentId: string;
  title: string;
  state: TaskState;
  /** Set while `WAITING` (and preserved across `WAITING -> PAUSED`). */
  waitReason: TaskWaitReason | null;
  /** Latest Run attempt under this Task, if any. */
  activeRunId: string | null;
  /** Set when this Task is the successor of a restarted terminal Task. */
  restartedFromTaskId: string | null;
  readonly createdAt: number;
  updatedAt: number;
  history: TaskTransition[];
}

export interface CreateTaskInput {
  title: string;
  activeRunId?: string;
}

export interface TaskManagerOptions {
  db?: DatabaseSync;
  now?: () => number;
}

export class TaskError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}

const TABLE = "stage2_tasks";

function cloneTask(record: TaskRecord): TaskRecord {
  return {
    ...record,
    history: record.history.map((h) => ({ ...h })),
  };
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly db: DatabaseSync | null;
  private readonly now: () => number;

  constructor(opts: TaskManagerOptions = {}) {
    const db = opts.db ?? null;
    this.db = db;
    this.now = opts.now ?? Date.now;
    if (db !== null) {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${TABLE} (` +
          `id TEXT PRIMARY KEY, ` +
          `state TEXT NOT NULL, ` +
          `data TEXT NOT NULL, ` +
          `updated_at INTEGER NOT NULL` +
          `);`,
      );
      const rows = db
        .prepare(`SELECT data FROM ${TABLE};`)
        .all() as Array<{ data: string }>;
      for (const row of rows) {
        const parsed = JSON.parse(row.data) as TaskRecord;
        this.tasks.set(parsed.id, parsed);
      }
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

  private saveRaw(record: TaskRecord): void {
    const db = this.db;
    if (db === null) return;
    db.prepare(
      `INSERT OR REPLACE INTO ${TABLE}(id, state, data, updated_at) VALUES (?, ?, ?, ?);`,
    ).run(record.id, record.state, JSON.stringify(record), record.updatedAt);
  }

  private require(id: string): TaskRecord {
    const record = this.tasks.get(id);
    if (record === undefined) {
      throw new TaskError("NOT_FOUND", `task not found: ${id}`);
    }
    return record;
  }

  /**
   * Core transition. Terminal states never resume; entering `WAITING`
   * requires a reason; leaving `WAITING` (except `WAITING -> PAUSED`)
   * clears it.
   */
  transitionTo(id: string, to: TaskState, reason?: string): TaskRecord {
    const record = this.require(id);
    if (isTaskTerminal(record.state)) {
      throw new TaskError(
        "INVALID_ARGUMENT",
        `task ${id} is terminal (${record.state}); terminal tasks never resume — ` +
          `use restartAsSuccessor() for a new Task`,
      );
    }
    if (!canTransition(TASK_MACHINE, record.state, to)) {
      throw new TaskError(
        "INVALID_ARGUMENT",
        `illegal transition: task ${record.state} -> ${to}`,
      );
    }
    if (to === "WAITING" && reason === undefined) {
      throw new TaskError(
        "INVALID_ARGUMENT",
        "entering WAITING requires a wait reason",
      );
    }
    let out: TaskRecord | null = null;
    this.transact(() => {
      const from = record.state;
      record.state = to;
      if (to === "WAITING") {
        record.waitReason = reason as TaskWaitReason;
      } else if (!(from === "WAITING" && to === "PAUSED")) {
        record.waitReason = null;
      }
      record.updatedAt = this.now();
      const entry: TaskTransition = { from, to, at: record.updatedAt };
      if (reason !== undefined) entry.reason = reason;
      record.history.push(entry);
      this.saveRaw(record);
      out = cloneTask(record);
    });
    if (out === null) throw new TaskError("WORKER_FAILURE", "transition failed");
    return out;
  }

  create(agentId: string, input: CreateTaskInput): TaskRecord {
    if (agentId.length === 0) {
      throw new TaskError("INVALID_ARGUMENT", "agentId is required");
    }
    if (typeof input.title !== "string" || input.title.length === 0) {
      throw new TaskError("INVALID_ARGUMENT", "task title is required");
    }
    const now = this.now();
    const record: TaskRecord = {
      id: `task_${randomUUID()}`,
      agentId,
      title: input.title,
      state: "PENDING",
      waitReason: null,
      activeRunId: input.activeRunId ?? null,
      restartedFromTaskId: null,
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.tasks.set(record.id, record);
    this.transact(() => {
      this.saveRaw(record);
    });
    return cloneTask(record);
  }

  get(id: string): TaskRecord | null {
    const record = this.tasks.get(id);
    return record === undefined ? null : cloneTask(record);
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].map(cloneTask);
  }

  setActiveRun(id: string, runId: string): TaskRecord {
    const record = this.require(id);
    let out: TaskRecord | null = null;
    this.transact(() => {
      record.activeRunId = runId;
      record.updatedAt = this.now();
      this.saveRaw(record);
      out = cloneTask(record);
    });
    if (out === null) throw new TaskError("WORKER_FAILURE", "setActiveRun failed");
    return out;
  }

  makeRunnable(id: string): TaskRecord {
    return this.transitionTo(id, "RUNNABLE");
  }

  start(id: string): TaskRecord {
    return this.transitionTo(id, "RUNNING");
  }

  waitFor(id: string, reason: TaskWaitReason): TaskRecord {
    return this.transitionTo(id, "WAITING", reason);
  }

  pause(id: string): TaskRecord {
    return this.transitionTo(id, "PAUSED");
  }

  resume(id: string): TaskRecord {
    return this.transitionTo(id, "RUNNABLE");
  }

  succeed(id: string): TaskRecord {
    return this.transitionTo(id, "SUCCEEDED");
  }

  fail(id: string): TaskRecord {
    return this.transitionTo(id, "FAILED");
  }

  requireRecovery(id: string): TaskRecord {
    return this.transitionTo(id, "RECOVERY_REQUIRED");
  }

  /** A failed attempt may yield to a new attempt: `RUNNING -> RUNNABLE`. */
  retry(id: string): TaskRecord {
    return this.transitionTo(id, "RUNNABLE", "retry");
  }

  /**
   * Leave `RECOVERY_REQUIRED` only through a §27.5 resolution action:
   * `resume -> RUNNABLE`, `fail -> FAILED`, `cancel -> CANCELLED`.
   */
  resolveRecovery(id: string, resolution: TaskRecoveryResolution): TaskRecord {
    const record = this.require(id);
    if (record.state !== "RECOVERY_REQUIRED") {
      throw new TaskError(
        "INVALID_ARGUMENT",
        `resolveRecovery requires RECOVERY_REQUIRED (now ${record.state})`,
      );
    }
    return this.transitionTo(id, RECOVERY_TARGET[resolution], resolution);
  }

  /**
   * Cancel a Task by walking only legal edges to `CANCELLED`
   * (`... -> CANCELLING -> CANCELLED`, `RECOVERY_REQUIRED -> CANCELLED`).
   */
  cancel(id: string): TaskRecord {
    const record = this.require(id);
    if (isTaskTerminal(record.state)) {
      throw new TaskError(
        "INVALID_ARGUMENT",
        `task ${id} is already terminal (${record.state})`,
      );
    }
    let path: TaskState[];
    switch (record.state) {
      case "RUNNING":
        path = ["CANCELLING", "CANCELLED"];
        break;
      case "CANCELLING":
        path = ["CANCELLED"];
        break;
      case "RECOVERY_REQUIRED":
        path = ["CANCELLED"];
        break;
      case "PENDING":
        path = ["RUNNABLE", "RUNNING", "CANCELLING", "CANCELLED"];
        break;
      case "RUNNABLE":
        path = ["RUNNING", "CANCELLING", "CANCELLED"];
        break;
      case "WAITING":
      case "PAUSED":
        path = ["RUNNABLE", "RUNNING", "CANCELLING", "CANCELLED"];
        break;
      default:
        throw new TaskError(
          "INVALID_ARGUMENT",
          `cannot cancel from ${record.state}`,
        );
    }
    let out: TaskRecord = cloneTask(record);
    for (const next of path) {
      out = this.transitionTo(id, next, "cancel");
    }
    return out;
  }

  /**
   * Owner-requested restart of a terminal Task (§27.5): the terminal record
   * is never resumed; a successor Task is created `PENDING` with
   * `restarted_from_task_id` pointing at it.
   */
  restartAsSuccessor(id: string, title?: string): TaskRecord {
    const record = this.require(id);
    if (!isTaskTerminal(record.state)) {
      throw new TaskError(
        "INVALID_ARGUMENT",
        `restartAsSuccessor requires a terminal task (now ${record.state})`,
      );
    }
    const now = this.now();
    const successor: TaskRecord = {
      id: `task_${randomUUID()}`,
      agentId: record.agentId,
      title: title ?? record.title,
      state: "PENDING",
      waitReason: null,
      activeRunId: null,
      restartedFromTaskId: record.id,
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.tasks.set(successor.id, successor);
    this.transact(() => {
      this.saveRaw(successor);
    });
    return cloneTask(successor);
  }
}
