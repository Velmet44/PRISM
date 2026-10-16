/**
 * Stage 2 Agent lifecycle (PRISM V1 §17, §27.5, §58.2).
 *
 * - Agent states are the `agent` machine from `@prism/schemas`; every
 *   transition goes through `canTransition` and illegal edges throw.
 * - Stage 2 supports the Main Agent only: creating a specialist rejects
 *   with `UNSUPPORTED`. The single Main Agent carries the privileged flag
 *   (`isMain`) and can never be deleted (`POLICY_DENIED`).
 * - Deletion writes a tombstone (`DELETING -> DELETED`, retained record);
 *   rows are never removed so audit history survives (§35.2).
 * - Mutating lifecycle calls require an unlocked `SecretStore` when one is
 *   provided (guard from `../auth/index.js`); reads never do.
 * - Persistence is write-through: in-memory Maps are the source of truth and
 *   every mutation is journaled to SQLite via `withTransaction` from
 *   `../storage/index.js` (BEGIN IMMEDIATE) when a `DatabaseSync` is given.
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canTransition } from "@prism/schemas";
import type { ErrorCode } from "@prism/schemas";
import type { SecretStore } from "../auth/index.js";
import { withTransaction } from "../storage/index.js";

export const AGENT_MACHINE = "agent" as const;

export type AgentKind = "main" | "specialist";

export type AgentState =
  | "CREATING"
  | "READY"
  | "PAUSED"
  | "STOPPED"
  | "DELETING"
  | "DELETED"
  | "RECOVERING"
  | "RESETTING"
  | "FAILED";

export interface AgentRecord {
  readonly id: string;
  readonly kind: AgentKind;
  /** Privileged flag: true only for the Stage 2 Main Agent. */
  readonly isMain: boolean;
  name: string;
  ownerId: string | null;
  state: AgentState;
  /** True once deleted; the row is retained and never removed. */
  tombstone: boolean;
  readonly createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CreateAgentInput {
  name: string;
  /** Defaults to `"main"`. Any other value rejects with `UNSUPPORTED`. */
  kind?: AgentKind;
  ownerId?: string;
}

export interface AgentManagerOptions {
  db?: DatabaseSync;
  /** When set, lifecycle mutations throw `SECRETS_LOCKED` while locked. */
  secretStore?: SecretStore;
  now?: () => number;
}

export class AgentError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

const TABLE = "stage2_agents";

function cloneAgent(record: AgentRecord): AgentRecord {
  return { ...record };
}

export class AgentManager {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly db: DatabaseSync | null;
  private readonly secretStore: SecretStore | null;
  private readonly now: () => number;

  constructor(opts: AgentManagerOptions = {}) {
    const db = opts.db ?? null;
    this.db = db;
    this.secretStore = opts.secretStore ?? null;
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
        const parsed = JSON.parse(row.data) as AgentRecord;
        this.agents.set(parsed.id, parsed);
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

  private saveRaw(record: AgentRecord): void {
    const db = this.db;
    if (db === null) return;
    db.prepare(
      `INSERT OR REPLACE INTO ${TABLE}(id, state, data, updated_at) VALUES (?, ?, ?, ?);`,
    ).run(record.id, record.state, JSON.stringify(record), record.updatedAt);
  }

  private requireGuard(): void {
    if (this.secretStore !== null) this.secretStore.assertUnlocked();
  }

  private require(id: string): AgentRecord {
    const record = this.agents.get(id);
    if (record === undefined) {
      throw new AgentError("NOT_FOUND", `agent not found: ${id}`);
    }
    return record;
  }

  private applyTransition(record: AgentRecord, to: AgentState): void {
    const from = record.state;
    if (!canTransition(AGENT_MACHINE, from, to)) {
      throw new AgentError(
        "INVALID_ARGUMENT",
        `illegal transition: agent ${from} -> ${to}`,
      );
    }
    record.state = to;
    record.updatedAt = this.now();
  }

  /**
   * Create an Agent. Stage 2 admits the Main Agent only; requesting a
   * specialist throws `UNSUPPORTED`. The record passes `CREATING -> READY`.
   */
  create(input: CreateAgentInput): AgentRecord {
    this.requireGuard();
    if (typeof input.name !== "string" || input.name.length === 0) {
      throw new AgentError("INVALID_ARGUMENT", "agent name is required");
    }
    const kind = input.kind ?? "main";
    if (kind !== "main") {
      throw new AgentError(
        "UNSUPPORTED",
        "Stage 2 supports only the Main Agent; specialist creation is unsupported",
      );
    }
    for (const existing of this.agents.values()) {
      if (existing.isMain && !existing.tombstone) {
        throw new AgentError("CONFLICT", "the Main Agent already exists");
      }
    }
    const now = this.now();
    const record: AgentRecord = {
      id: `agent_${randomUUID()}`,
      kind,
      isMain: true,
      name: input.name,
      ownerId: input.ownerId ?? null,
      state: "CREATING",
      tombstone: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.agents.set(record.id, record);
    this.transact(() => {
      this.applyTransition(record, "READY");
      this.saveRaw(record);
    });
    return cloneAgent(record);
  }

  get(id: string): AgentRecord | null {
    const record = this.agents.get(id);
    return record === undefined ? null : cloneAgent(record);
  }

  list(opts?: { includeDeleted?: boolean }): AgentRecord[] {
    const includeDeleted = opts?.includeDeleted ?? false;
    const out: AgentRecord[] = [];
    for (const record of this.agents.values()) {
      if (!includeDeleted && record.tombstone) continue;
      out.push(cloneAgent(record));
    }
    return out;
  }

  getMain(): AgentRecord | null {
    for (const record of this.agents.values()) {
      if (record.isMain && !record.tombstone) return cloneAgent(record);
    }
    return null;
  }

  pause(id: string): AgentRecord {
    this.requireGuard();
    const record = this.require(id);
    let out: AgentRecord | null = null;
    this.transact(() => {
      this.applyTransition(record, "PAUSED");
      this.saveRaw(record);
      out = cloneAgent(record);
    });
    if (out === null) throw new AgentError("WORKER_FAILURE", "pause failed");
    return out;
  }

  resume(id: string): AgentRecord {
    this.requireGuard();
    const record = this.require(id);
    let out: AgentRecord | null = null;
    this.transact(() => {
      this.applyTransition(record, "READY");
      this.saveRaw(record);
      out = cloneAgent(record);
    });
    if (out === null) throw new AgentError("WORKER_FAILURE", "resume failed");
    return out;
  }

  /** Cancel an Agent's activity: `READY|PAUSED -> STOPPED`. */
  cancel(id: string): AgentRecord {
    this.requireGuard();
    const record = this.require(id);
    let out: AgentRecord | null = null;
    this.transact(() => {
      this.applyTransition(record, "STOPPED");
      this.saveRaw(record);
      out = cloneAgent(record);
    });
    if (out === null) throw new AgentError("WORKER_FAILURE", "cancel failed");
    return out;
  }

  stop(id: string): AgentRecord {
    return this.cancel(id);
  }

  /** Reset an Agent: `READY|PAUSED -> RESETTING -> READY`. */
  reset(id: string): AgentRecord {
    this.requireGuard();
    const record = this.require(id);
    let out: AgentRecord | null = null;
    this.transact(() => {
      this.applyTransition(record, "RESETTING");
      this.applyTransition(record, "READY");
      this.saveRaw(record);
      out = cloneAgent(record);
    });
    if (out === null) throw new AgentError("WORKER_FAILURE", "reset failed");
    return out;
  }

  markFailed(id: string): AgentRecord {
    this.requireGuard();
    const record = this.require(id);
    let out: AgentRecord | null = null;
    this.transact(() => {
      this.applyTransition(record, "FAILED");
      this.saveRaw(record);
      out = cloneAgent(record);
    });
    if (out === null) throw new AgentError("WORKER_FAILURE", "markFailed failed");
    return out;
  }

  beginRecovery(id: string): AgentRecord {
    this.requireGuard();
    const record = this.require(id);
    let out: AgentRecord | null = null;
    this.transact(() => {
      this.applyTransition(record, "RECOVERING");
      this.saveRaw(record);
      out = cloneAgent(record);
    });
    if (out === null) {
      throw new AgentError("WORKER_FAILURE", "beginRecovery failed");
    }
    return out;
  }

  completeRecovery(id: string): AgentRecord {
    this.requireGuard();
    const record = this.require(id);
    let out: AgentRecord | null = null;
    this.transact(() => {
      this.applyTransition(record, "READY");
      this.saveRaw(record);
      out = cloneAgent(record);
    });
    if (out === null) {
      throw new AgentError("WORKER_FAILURE", "completeRecovery failed");
    }
    return out;
  }

  /**
   * Delete an Agent. The Main Agent can never be deleted. Other Agents move
   * `READY|PAUSED|STOPPED -> DELETING -> DELETED` and the row is retained as
   * a tombstone (never removed).
   */
  delete(id: string): AgentRecord {
    this.requireGuard();
    const record = this.require(id);
    if (record.isMain) {
      throw new AgentError(
        "POLICY_DENIED",
        "the Main Agent cannot be deleted",
      );
    }
    if (record.tombstone) return cloneAgent(record);
    let out: AgentRecord | null = null;
    this.transact(() => {
      this.applyTransition(record, "DELETING");
      this.applyTransition(record, "DELETED");
      record.tombstone = true;
      record.deletedAt = this.now();
      this.saveRaw(record);
      out = cloneAgent(record);
    });
    if (out === null) throw new AgentError("WORKER_FAILURE", "delete failed");
    return out;
  }
}
