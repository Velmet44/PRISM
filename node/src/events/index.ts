/**
 * Stage 2 event bus — durable Node event log with transactional outbox,
 * cursor replay, retention resync, and live-only ephemeral streams.
 *
 * Spec: §23.0 (durable vs ephemeral, Node-monotonic sequence assigned inside
 * the committing transaction, published only after commit, cursor replay,
 * retention + resync_required with 32/Node + 4/session snapshot caps),
 * §58.3 (envelope, snapshots table, X-PRISM-SNAPSHOT reads), §58.10
 * (subscribe with filter + cursor, replay sequence > cursor in order, live
 * delivery, dedupe by event_id, ephemeral streams never replayed,
 * partial-message recovery via snapshot re-fetch + rejoin).
 *
 * Ordering: every public method is synchronous. Because `node:sqlite` calls
 * are synchronous, `subscribe()` replay-then-register is atomic with respect
 * to `appendEvent()` — no event can slip between the replay SELECT and the
 * live registration on the same thread.
 *
 * Durability: `withTransaction` (BEGIN IMMEDIATE) from `../storage/index.js`
 * serializes writers so the Node-monotonic sequence has no duplicates.
 */

import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  EPHEMERAL_STREAMS,
  EventEnvelope,
  isEphemeralStream,
  ResyncRequired,
  SubscriptionFilter,
} from "@prism/schemas";
import type {
  AgentId,
  EphemeralStream,
  ErrorCode,
  EventId,
  NodeId,
  OwnerId,
  RunId,
  StepAttemptId,
  StepId,
  TaskId,
} from "@prism/schemas";
import { withTransaction } from "../storage/index.js";

// ---------------------------------------------------------------------------
// Errors (§58.5)
// ---------------------------------------------------------------------------

export class EventBusError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly remediation?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; remediation?: string },
  ) {
    super(message);
    this.name = "EventBusError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    if (opts?.remediation !== undefined) this.remediation = opts.remediation;
  }
}

// ---------------------------------------------------------------------------
// Limits (§23.0 retention + resync caps; §53 invariants 49 / §53.1 inv. 23)
// ---------------------------------------------------------------------------

/** `resync_required.expires_at = now + 5min` (§23.0). Never extended. */
export const SNAPSHOT_TTL_SEC = 300;
/** Active snapshot-token caps with LRU eviction (§23.0). */
export const MAX_SNAPSHOTS_PER_NODE = 32;
export const MAX_SNAPSHOTS_PER_SESSION = 4;
/** Explicit per-Node retention defaults (time AND size, §23.0). */
export const DEFAULT_RETENTION_MAX_EVENTS = 20_000;
export const DEFAULT_RETENTION_MAX_AGE_SEC = 7 * 24 * 3600;
/** `resync_required` initiation is rate-limited per session (§23.0). */
export const RESYNC_RATE_LIMIT_PER_MIN = 30;
/** Replay page ceiling so one subscribe cannot OOM the Node. */
export const MAX_REPLAY_LIMIT = 5_000;
/** Snapshot payload row ceiling across the covered tables. */
export const MAX_SNAPSHOT_ROWS = 2_000;
/** Snapshot page size for X-PRISM-SNAPSHOT reads. */
export const DEFAULT_SNAPSHOT_PAGE_SIZE = 200;

export { EPHEMERAL_STREAMS };

// ---------------------------------------------------------------------------
// Row types (mirror migrations/002_stage2.sql: opaque TEXT PKs, INTEGER
// sequence/expiries, canonical JSON TEXT payloads)
// ---------------------------------------------------------------------------

interface EventRow {
  event_id: string;
  sequence: number;
  event_type: string;
  event_version: number;
  node_id: string;
  owner_id: string;
  agent_id: string | null;
  task_id: string | null;
  run_id: string | null;
  step_id: string | null;
  step_attempt_id: string | null;
  causation_id: string | null;
  correlation_id: string;
  occurred_at: string;
  payload_ref: string;
  payload_json: string;
  security_class: string;
  created_at: number;
}

interface OutboxRow {
  event_id: string;
  sequence: number;
  envelope_json: string;
  created_at: number;
  published_at: number | null;
}

interface SnapshotRowDb {
  id: string;
  node_id: string;
  session_id: string;
  h: number;
  filter_hash: string;
  expires_at: number;
  payload_ref: string;
  payload_json: string;
  created_at: number;
}

/** DDL subset owned by this module; identical to migrations/002_stage2.sql. */
const EVENTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  node_id TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT,
  task_id TEXT,
  run_id TEXT,
  step_id TEXT,
  step_attempt_id TEXT,
  causation_id TEXT,
  correlation_id TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT '',
  payload_ref TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  security_class TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_sequence ON events(sequence);
CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_agent_seq ON events(agent_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  envelope_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
  ON outbox(published_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_sequence ON outbox(sequence);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  h INTEGER NOT NULL,
  filter_hash TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  payload_ref TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_node ON snapshots(node_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_expiry ON snapshots(expires_at);
`;

/** Idempotent DDL for the log tables (safe to call on every open). */
export function ensureEventSchema(db: DatabaseSync): void {
  db.exec(EVENTS_SCHEMA_SQL);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AppendEventInput {
  event_id?: string;
  event_type: string;
  event_version?: number;
  node_id: string;
  owner_id: string;
  agent_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  step_id?: string | null;
  step_attempt_id?: string | null;
  causation_id?: string | null;
  correlation_id?: string;
  occurred_at?: string;
  /** Opaque payload reference; defaults to `inline:<event_id>`. */
  payload_ref?: string;
  /** Inline payload body, stored as canonical JSON beside the reference. */
  payload?: unknown;
  security_class?: "normal" | "sensitive" | "security_audit";
}

export interface EventBusOptions {
  nodeId: string;
  retentionMaxEvents?: number;
  retentionMaxAgeSec?: number;
  snapshotTtlSec?: number;
  maxSnapshotsPerNode?: number;
  maxSnapshotsPerSession?: number;
  resyncRateLimitPerMin?: number;
  nowSec?: () => number;
}

export interface ReplayResult {
  events: EventEnvelope[];
  head: number;
}

export type ExternalPublisher = (envelope: EventEnvelope) => void;

interface LiveSubscription {
  id: string;
  filter: SubscriptionFilter;
  lastDelivered: number;
  seenIds: Set<string>;
  listener: (envelope: EventEnvelope) => void;
}

export interface SubscriptionHandle {
  readonly id: string;
  /** Highest sequence the subscriber has applied; advances on ack. */
  cursor(): number;
  acknowledge(sequence: number): void;
  unsubscribe(): void;
}

export type SubscribeResult =
  | {
      kind: "live";
      events: EventEnvelope[];
      head: number;
      subscription: SubscriptionHandle;
    }
  | {
      kind: "resync_required";
      snapshot_token: string;
      as_of_sequence: number;
      expires_at: string;
    };

export interface SnapshotPageEntry {
  table: string;
  row: Record<string, unknown>;
}

export interface SnapshotPage {
  snapshot_token: string;
  as_of_sequence: number;
  expires_at: string;
  entries: SnapshotPageEntry[];
  nextCursor: number;
  hasMore: boolean;
}

export interface EphemeralMessage {
  stream: EphemeralStream;
  /** Per-subscription counter; clients detect gaps from missing integers. */
  counter: number;
  run_id: string | null;
  payload: unknown;
  at: string;
}

export interface PartialMessageSnapshot {
  run_id: string;
  /** Opaque reference the client re-fetches over the API (§23.0). */
  ref: string;
  updated_at_sec: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    event_id: row.event_id as EventId,
    sequence: row.sequence,
    event_type: row.event_type,
    event_version: row.event_version,
    node_id: row.node_id as NodeId,
    owner_id: row.owner_id as OwnerId,
    agent_id: (row.agent_id ?? null) as AgentId | null,
    task_id: (row.task_id ?? null) as TaskId | null,
    run_id: (row.run_id ?? null) as RunId | null,
    step_id: (row.step_id ?? null) as StepId | null,
    step_attempt_id: (row.step_attempt_id ?? null) as StepAttemptId | null,
    causation_id: (row.causation_id ?? null) as EventId | null,
    correlation_id: row.correlation_id,
    occurred_at: row.occurred_at,
    payload_ref: row.payload_ref,
    security_class:
      row.security_class === "sensitive" || row.security_class === "security_audit"
        ? row.security_class
        : "normal",
  };
}

function matchesFilter(filter: SubscriptionFilter, env: EventEnvelope): boolean {
  if (filter.node_id !== undefined && env.node_id !== filter.node_id) return false;
  if (filter.agent_id !== undefined && env.agent_id !== filter.agent_id) return false;
  if (filter.task_id !== undefined && env.task_id !== filter.task_id) return false;
  if (filter.run_id !== undefined && env.run_id !== filter.run_id) return false;
  return true;
}

/** Canonical binding of a subscription filter (§23.0 `filter_hash`). */
export function filterHash(filter: SubscriptionFilter): string {
  const canon: Record<string, string> = {};
  if (filter.node_id !== undefined) canon["node_id"] = filter.node_id;
  if (filter.agent_id !== undefined) canon["agent_id"] = filter.agent_id;
  if (filter.task_id !== undefined) canon["task_id"] = filter.task_id;
  if (filter.run_id !== undefined) canon["run_id"] = filter.run_id;
  return createHash("sha256").update(JSON.stringify(canon), "utf8").digest("hex");
}

function buildFilterWhere(
  filter: SubscriptionFilter,
): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (filter.node_id !== undefined) {
    parts.push("node_id = ?");
    params.push(filter.node_id);
  }
  if (filter.agent_id !== undefined) {
    parts.push("agent_id = ?");
    params.push(filter.agent_id);
  }
  if (filter.task_id !== undefined) {
    parts.push("task_id = ?");
    params.push(filter.task_id);
  }
  if (filter.run_id !== undefined) {
    parts.push("run_id = ?");
    params.push(filter.run_id);
  }
  return { clause: parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "", params };
}

/**
 * Delivery-layer redaction (§23.0): `security_audit` events reach only
 * sessions holding the audit-read scope. Sensitive payloads stay behind
 * `payload_ref`; this layer filters, it never rewrites classifications.
 */
export function redactForSession(
  events: EventEnvelope[],
  scopes: string[],
): EventEnvelope[] {
  if (scopes.includes("audit:read")) return [...events];
  return events.filter((e) => e.security_class !== "security_audit");
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export class EventBus {
  private readonly db: DatabaseSync;
  private readonly nodeId: string;
  private readonly retentionMaxEvents: number;
  private readonly retentionMaxAgeSec: number;
  private readonly snapshotTtlSec: number;
  private readonly maxSnapshotsPerNode: number;
  private readonly maxSnapshotsPerSession: number;
  private readonly resyncRateLimitPerMin: number;
  private readonly nowSec: () => number;
  private readonly live = new Map<string, LiveSubscription>();
  private readonly publishers = new Set<ExternalPublisher>();
  private readonly resyncMarks = new Map<string, number[]>();
  private readonly partials = new Map<string, PartialMessageSnapshot>();
  private readonly ephemeralSubs = new Map<
    string,
    {
      stream: EphemeralStream;
      runId: string | null;
      nextCounter: number;
      listener: (message: EphemeralMessage) => void;
    }
  >();

  constructor(db: DatabaseSync, opts: EventBusOptions) {
    if (opts.nodeId.length === 0) throw new Error("EventBus: nodeId required");
    this.db = db;
    this.nodeId = opts.nodeId;
    this.retentionMaxEvents = opts.retentionMaxEvents ?? DEFAULT_RETENTION_MAX_EVENTS;
    this.retentionMaxAgeSec = opts.retentionMaxAgeSec ?? DEFAULT_RETENTION_MAX_AGE_SEC;
    this.snapshotTtlSec = opts.snapshotTtlSec ?? SNAPSHOT_TTL_SEC;
    this.maxSnapshotsPerNode = opts.maxSnapshotsPerNode ?? MAX_SNAPSHOTS_PER_NODE;
    this.maxSnapshotsPerSession =
      opts.maxSnapshotsPerSession ?? MAX_SNAPSHOTS_PER_SESSION;
    this.resyncRateLimitPerMin = opts.resyncRateLimitPerMin ?? RESYNC_RATE_LIMIT_PER_MIN;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
    ensureEventSchema(db);
  }

  // -- publishing ----------------------------------------------------------

  /**
   * Append a durable event. The Node-monotonic sequence is assigned inside
   * the committing transaction (BEGIN IMMEDIATE) and the envelope is
   * published to subscribers only after commit via the outbox (§23.0).
   * Re-appending a known `event_id` returns the original envelope with its
   * original sequence (dedupe by event_id, §58.10).
   */
  appendEvent(input: AppendEventInput): EventEnvelope {
    if (isEphemeralStream(input.event_type)) {
      throw new EventBusError(
        "INVALID_ARGUMENT",
        `ephemeral stream "${input.event_type}" is never stored or replayed; use publishEphemeral()`,
      );
    }
    if (input.event_type.length === 0) {
      throw new EventBusError("INVALID_ARGUMENT", "event_type required");
    }
    const eventId = input.event_id ?? `evt_${randomBytes(16).toString("hex")}`;
    const existing = this.db
      .prepare("SELECT * FROM events WHERE event_id = ?;")
      .get(eventId) as unknown as EventRow | null;
    if (existing !== null && existing !== undefined) {
      return rowToEnvelope(existing);
    }
    const now = this.nowSec();
    const envelope = withTransaction(this.db, (tx) => {
      const headRow = tx
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS head FROM events;")
        .get() as unknown as { head: number };
      const sequence = Number(headRow.head) + 1;
      const candidate: Record<string, unknown> = {
        event_id: eventId,
        sequence,
        event_type: input.event_type,
        event_version: input.event_version ?? 1,
        node_id: input.node_id,
        owner_id: input.owner_id,
        agent_id: input.agent_id ?? null,
        task_id: input.task_id ?? null,
        run_id: input.run_id ?? null,
        step_id: input.step_id ?? null,
        step_attempt_id: input.step_attempt_id ?? null,
        causation_id: input.causation_id ?? null,
        correlation_id: input.correlation_id ?? eventId,
        occurred_at: input.occurred_at ?? new Date(now * 1000).toISOString(),
        payload_ref: input.payload_ref ?? `inline:${eventId}`,
        security_class: input.security_class ?? "normal",
      };
      const parsed = EventEnvelope.parse(candidate);
      const payloadJson = JSON.stringify(input.payload ?? {});
      tx.prepare(
        `INSERT INTO events(event_id, sequence, event_type, event_version, node_id,
          owner_id, agent_id, task_id, run_id, step_id, step_attempt_id,
          causation_id, correlation_id, occurred_at, payload_ref, payload_json,
          security_class, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      ).run(
        parsed.event_id,
        parsed.sequence,
        parsed.event_type,
        parsed.event_version,
        parsed.node_id,
        parsed.owner_id,
        parsed.agent_id,
        parsed.task_id,
        parsed.run_id,
        parsed.step_id,
        parsed.step_attempt_id,
        parsed.causation_id,
        parsed.correlation_id,
        parsed.occurred_at,
        parsed.payload_ref,
        payloadJson,
        parsed.security_class,
        now,
      );
      tx.prepare(
        `INSERT INTO outbox(event_id, sequence, envelope_json, created_at, published_at)
         VALUES (?, ?, ?, ?, NULL);`,
      ).run(parsed.event_id, parsed.sequence, JSON.stringify(parsed), now);
      return parsed;
    });
    // Publish-after-commit: a crash before this loop leaves the outbox row
    // for drainOutbox(); live subscribers dedupe redelivery by sequence.
    this.flushOutbox();
    return envelope;
  }

  /**
   * Register an external publisher (e.g. the WebSocket fan-out). Delivery is
   * at-least-once; consumers dedupe by `event_id`. A throwing publisher
   * keeps its row queued for the next drain without blocking other rows.
   */
  onPublish(publisher: ExternalPublisher): () => void {
    this.publishers.add(publisher);
    return () => {
      this.publishers.delete(publisher);
    };
  }

  /**
   * Publish every queued outbox row in sequence order, then delete it.
   * Call at boot to republish rows orphaned by a crash between commit and
   * publish-after-commit. Returns the number of rows published.
   */
  drainOutbox(batchLimit = 1000): number {
    return this.flushOutbox(batchLimit);
  }

  private flushOutbox(batchLimit = 1000): number {
    const rows = this.db
      .prepare("SELECT * FROM outbox ORDER BY sequence ASC LIMIT ?;")
      .all(batchLimit) as unknown as OutboxRow[];
    let published = 0;
    for (const row of rows) {
      let envelope: EventEnvelope;
      try {
        envelope = EventEnvelope.parse(JSON.parse(row.envelope_json));
      } catch {
        // Corrupt envelope bodies are dropped, never delivered half-formed.
        this.db.prepare("DELETE FROM outbox WHERE event_id = ?;").run(row.event_id);
        published += 1;
        continue;
      }
      this.deliverToLive(envelope);
      let failed = false;
      for (const publisher of this.publishers) {
        try {
          publisher(envelope);
        } catch {
          failed = true;
          break;
        }
      }
      if (failed) break;
      this.db.prepare("DELETE FROM outbox WHERE event_id = ?;").run(row.event_id);
      published += 1;
    }
    return published;
  }

  private deliverToLive(envelope: EventEnvelope): void {
    for (const sub of this.live.values()) {
      if (!matchesFilter(sub.filter, envelope)) continue;
      if (envelope.sequence <= sub.lastDelivered) continue;
      if (sub.seenIds.has(envelope.event_id)) continue;
      try {
        sub.listener(envelope);
      } catch {
        // A throwing subscriber must not break fan-out to the rest.
        continue;
      }
      sub.lastDelivered = envelope.sequence;
      sub.seenIds.add(envelope.event_id);
      if (sub.seenIds.size > 1000) {
        const oldest = sub.seenIds.values().next();
        if (!oldest.done) sub.seenIds.delete(oldest.value);
      }
    }
  }

  // -- replay + subscribe (§58.10) ------------------------------------------

  /** Current committed event head `H` (0 when the log is empty). */
  getHeadSequence(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS head FROM events;")
      .get() as unknown as { head: number };
    return Number(row.head);
  }

  /**
   * Lowest retained sequence (0 when the log is empty). Because sequences
   * are assigned gaplessly (`MAX(sequence)+1` inside `BEGIN IMMEDIATE`),
   * every integer in `[1, head]` existed at some point — so a cursor has
   * fallen outside retention exactly when `cursor + 1 < watermark`, i.e.
   * there is at least one vanished sequence after the cursor. A fresh
   * subscriber with cursor `0` on an uncompacted log (`watermark <= 1`)
   * replays from the start without a spurious resync.
   */
  getRetentionWatermark(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MIN(sequence), 0) AS floor, COUNT(*) AS n FROM events;",
      )
      .get() as unknown as { floor: number; n: number };
    if (Number(row.n) === 0) return 0;
    return Number(row.floor);
  }

  /** Matching durable events with `sequence > cursor`, in order. */
  readEvents(
    filter: SubscriptionFilter,
    cursor: number,
    limit = 500,
  ): ReplayResult {
    const parsed = this.parseFilter(filter);
    this.requireCursor(cursor);
    const capped = Math.min(Math.max(Math.trunc(limit), 1), MAX_REPLAY_LIMIT);
    const { clause, params } = buildFilterWhere(parsed);
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE sequence > ?${clause} ORDER BY sequence ASC LIMIT ?;`,
      )
      .all(cursor, ...params, capped) as unknown as EventRow[];
    return { events: rows.map(rowToEnvelope), head: this.getHeadSequence() };
  }

  /**
   * Subscribe with a filter and last-applied cursor (§58.10): replay all
   * matching events with `sequence > cursor` in order, then switch to live
   * delivery. Gaps in the delivered sequence are normal (events outside the
   * filter) and are not errors. When the cursor has fallen outside
   * retention, materialize a snapshot and return `resync_required` instead.
   */
  subscribe(
    filter: SubscriptionFilter,
    cursor: number,
    listener: (envelope: EventEnvelope) => void,
    opts?: { sessionId?: string; replayLimit?: number },
  ): SubscribeResult {
    const parsed = this.parseFilter(filter);
    this.requireCursor(cursor);
    const head = this.getHeadSequence();
    const watermark = this.getRetentionWatermark();
    if (cursor + 1 < watermark) {
      const sessionId = opts?.sessionId ?? "";
      this.checkResyncRateLimit(sessionId);
      const resync = this.materializeSnapshot(parsed, sessionId);
      return {
        kind: "resync_required",
        snapshot_token: resync.snapshot_token,
        as_of_sequence: resync.as_of_sequence,
        expires_at: resync.expires_at,
      };
    }
    const replay = this.readEvents(parsed, cursor, opts?.replayLimit ?? 500);
    const id = `sub_${randomBytes(8).toString("hex")}`;
    const sub: LiveSubscription = {
      id,
      filter: parsed,
      lastDelivered: Math.max(head, cursor),
      seenIds: new Set(replay.events.map((e) => e.event_id)),
      listener,
    };
    // Seed lastDelivered from replayed events so a concurrent append that
    // committed after the replay SELECT is still delivered live.
    for (const env of replay.events) {
      if (env.sequence > sub.lastDelivered) sub.lastDelivered = env.sequence;
    }
    this.live.set(id, sub);
    const bus = this;
    return {
      kind: "live",
      events: replay.events,
      head: replay.head,
      subscription: {
        id,
        cursor: () => sub.lastDelivered,
        acknowledge(sequence: number): void {
          if (Number.isInteger(sequence) && sequence > sub.lastDelivered) {
            sub.lastDelivered = sequence;
          }
        },
        unsubscribe(): void {
          bus.live.delete(id);
        },
      },
    };
  }

  activeSubscriptionCount(): number {
    return this.live.size;
  }

  // -- resync snapshots (§23.0) ----------------------------------------------

  private checkResyncRateLimit(sessionId: string): void {
    if (sessionId.length === 0) return;
    const nowMs = this.nowSec() * 1000;
    const windowStart = nowMs - 60_000;
    const marks = (this.resyncMarks.get(sessionId) ?? []).filter((t) => t > windowStart);
    if (marks.length >= this.resyncRateLimitPerMin) {
      throw new EventBusError("RATE_LIMITED", "resync initiation rate-limited", {
        retryable: true,
        remediation: "back off and retry; live subscription continues from head",
      });
    }
    marks.push(nowMs);
    this.resyncMarks.set(sessionId, marks);
  }

  /**
   * Materialize a resync snapshot in the same transaction that reads the
   * current committed head `H`. Covered Stage 2 tables
   * (agents,tasks,runs,steps,step_attempts) are dumped in deterministic
   * PK order for the filter scope; later stages extend this to
   * approvals/artifacts/memory/schedules. Pagination reads from the stored
   * row, never live tables. Caps (32/Node, 4/session) evict oldest-first.
   */
  materializeSnapshot(
    filter: SubscriptionFilter,
    sessionId = "",
  ): { snapshot_token: string; as_of_sequence: number; expires_at: string } {
    const parsed = this.parseFilter(filter);
    const now = this.nowSec();
    const result = withTransaction(this.db, (tx) => {
      const headRow = tx
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS head FROM events;")
        .get() as unknown as { head: number };
      const h = Number(headRow.head);
      const payload = this.buildSnapshotPayload(tx, parsed);
      const id = `snap_${randomBytes(12).toString("hex")}`;
      const hash = filterHash(parsed);
      const expiresAt = now + this.snapshotTtlSec;
      tx.prepare(
        `INSERT INTO snapshots(id, node_id, session_id, h, filter_hash, expires_at,
          payload_ref, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      ).run(
        id,
        this.nodeId,
        sessionId,
        h,
        hash,
        expiresAt,
        `snapshot:${id}`,
        JSON.stringify(payload),
        now,
      );
      // LRU eviction: 32 per Node, 4 per session — expiry never extended.
      // rowid order breaks created_at ties deterministically (newest wins).
      tx.prepare(
        `DELETE FROM snapshots WHERE node_id = ? AND id NOT IN (
           SELECT id FROM snapshots WHERE node_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?
         );`,
      ).run(this.nodeId, this.nodeId, this.maxSnapshotsPerNode);
      if (sessionId.length > 0) {
        tx.prepare(
          `DELETE FROM snapshots WHERE session_id = ? AND id NOT IN (
             SELECT id FROM snapshots WHERE session_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?
           );`,
        ).run(sessionId, sessionId, this.maxSnapshotsPerSession);
      }
      return { id, h, expiresAt };
    });
    const resync = {
      snapshot_token: result.id,
      as_of_sequence: result.h,
      expires_at: new Date(result.expiresAt * 1000).toISOString(),
    };
    return ResyncRequired.parse(resync);
  }

  private buildSnapshotPayload(
    tx: DatabaseSync,
    filter: SubscriptionFilter,
  ): Record<string, unknown> {
    const select = (
      table: string,
      where: string,
      params: string[],
      orderBy: string,
    ): Record<string, unknown>[] => {
      try {
        return tx.prepare(
          `SELECT * FROM ${table} WHERE ${where} ORDER BY ${orderBy} LIMIT ?;`,
        ).all(...params, MAX_SNAPSHOT_ROWS) as unknown as Record<string, unknown>[];
      } catch {
        // Table from a not-yet-applied migration: snapshot what exists.
        return [];
      }
    };
    if (filter.run_id !== undefined) {
      const runs = select("runs", "run_id = ?", [filter.run_id], "run_id");
      const taskIds = new Set<string>();
      for (const r of runs) {
        if (typeof r["task_id"] === "string") taskIds.add(r["task_id"]);
      }
      const tasks = select(
        "tasks",
        taskIds.size > 0
          ? `task_id IN (${[...taskIds].map(() => "?").join(",")})`
          : "1 = 0",
        [...taskIds],
        "task_id",
      );
      const agentIds = new Set<string>();
      for (const r of runs) {
        if (typeof r["agent_id"] === "string") agentIds.add(r["agent_id"]);
      }
      for (const t of tasks) {
        if (typeof t["agent_id"] === "string") agentIds.add(t["agent_id"]);
      }
      return {
        scope: { run_id: filter.run_id },
        agents: select(
          "agents",
          agentIds.size > 0
            ? `agent_id IN (${[...agentIds].map(() => "?").join(",")})`
            : "1 = 0",
          [...agentIds],
          "agent_id",
        ),
        tasks,
        runs,
        steps: select("steps", "run_id = ?", [filter.run_id], "step_id"),
        step_attempts: select(
          "step_attempts",
          "run_id = ?",
          [filter.run_id],
          "step_attempt_id",
        ),
      };
    }
    if (filter.task_id !== undefined) {
      const tasks = select("tasks", "task_id = ?", [filter.task_id], "task_id");
      const runs = select("runs", "task_id = ?", [filter.task_id], "run_id");
      const runIds = runs
        .map((r) => r["run_id"])
        .filter((v): v is string => typeof v === "string");
      const agentIds = new Set<string>();
      for (const t of tasks) {
        if (typeof t["agent_id"] === "string") agentIds.add(t["agent_id"]);
      }
      return {
        scope: { task_id: filter.task_id },
        agents: select(
          "agents",
          agentIds.size > 0
            ? `agent_id IN (${[...agentIds].map(() => "?").join(",")})`
            : "1 = 0",
          [...agentIds],
          "agent_id",
        ),
        tasks,
        runs,
        steps: select(
          "steps",
          runIds.length > 0
            ? `run_id IN (${runIds.map(() => "?").join(",")})`
            : "1 = 0",
          runIds,
          "step_id",
        ),
        step_attempts: select(
          "step_attempts",
          runIds.length > 0
            ? `run_id IN (${runIds.map(() => "?").join(",")})`
            : "1 = 0",
          runIds,
          "step_attempt_id",
        ),
      };
    }
    if (filter.agent_id !== undefined) {
      const agents = select("agents", "agent_id = ?", [filter.agent_id], "agent_id");
      const tasks = select("tasks", "agent_id = ?", [filter.agent_id], "task_id");
      const taskIds = tasks
        .map((t) => t["task_id"])
        .filter((v): v is string => typeof v === "string");
      const runs = select(
        "runs",
        taskIds.length > 0
          ? `task_id IN (${taskIds.map(() => "?").join(",")})`
          : "agent_id = ?",
        taskIds.length > 0 ? taskIds : [filter.agent_id],
        "run_id",
      );
      const runIds = runs
        .map((r) => r["run_id"])
        .filter((v): v is string => typeof v === "string");
      return {
        scope: { agent_id: filter.agent_id },
        agents,
        tasks,
        runs,
        steps: select(
          "steps",
          runIds.length > 0
            ? `run_id IN (${runIds.map(() => "?").join(",")})`
            : "1 = 0",
          runIds,
          "step_id",
        ),
        step_attempts: select(
          "step_attempts",
          runIds.length > 0
            ? `run_id IN (${runIds.map(() => "?").join(",")})`
            : "1 = 0",
          runIds,
          "step_attempt_id",
        ),
      };
    }
    // Node-wide (or empty) filter: bounded full dump in deterministic order.
    return {
      scope: {},
      agents: select("agents", "1 = 1", [], "agent_id"),
      tasks: select("tasks", "1 = 1", [], "task_id"),
      runs: select("runs", "1 = 1", [], "run_id"),
      steps: select("steps", "1 = 1", [], "step_id"),
      step_attempts: select("step_attempts", "1 = 1", [], "step_attempt_id"),
    };
  }

  /**
   * Read a stored snapshot page (`X-PRISM-SNAPSHOT: id`, §58.7). Pages come
   * from the stored row with the original `H`/expiry — never live tables,
   * never extended. Expired, unknown, or filter-mismatched tokens raise
   * `RESYNC_REQUIRED` with instructions to begin a new resynchronization.
   */
  readSnapshot(
    snapshotToken: string,
    filter?: SubscriptionFilter,
    opts?: { cursor?: number; limit?: number },
  ): SnapshotPage {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE id = ?;")
      .get(snapshotToken) as unknown as SnapshotRowDb | null;
    if (row === null || row === undefined) {
      throw new EventBusError("RESYNC_REQUIRED", "unknown snapshot token", {
        retryable: false,
        remediation: "begin a new resynchronization (subscribe from head)",
      });
    }
    const now = this.nowSec();
    if (now >= row.expires_at) {
      this.db.prepare("DELETE FROM snapshots WHERE id = ?;").run(snapshotToken);
      throw new EventBusError("RESYNC_REQUIRED", "snapshot token expired", {
        retryable: false,
        remediation: "begin a new resynchronization (subscribe from head)",
      });
    }
    if (filter !== undefined && filterHash(this.parseFilter(filter)) !== row.filter_hash) {
      throw new EventBusError("RESYNC_REQUIRED", "snapshot filter mismatch", {
        retryable: false,
        remediation: "filter change requires a new resynchronization",
      });
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      throw new EventBusError("RESYNC_REQUIRED", "snapshot payload unreadable", {
        retryable: false,
        remediation: "begin a new resynchronization (subscribe from head)",
      });
    }
    const entries: SnapshotPageEntry[] = [];
    for (const table of ["agents", "tasks", "runs", "steps", "step_attempts"]) {
      const rows = payload[table];
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        entries.push({
          table,
          row: (r as Record<string, unknown>) ?? {},
        });
      }
    }
    const cursor = opts?.cursor ?? 0;
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new EventBusError("INVALID_ARGUMENT", "snapshot cursor must be >= 0");
    }
    const limit = Math.min(
      Math.max(Math.trunc(opts?.limit ?? DEFAULT_SNAPSHOT_PAGE_SIZE), 1),
      MAX_SNAPSHOT_ROWS,
    );
    const page = entries.slice(cursor, cursor + limit);
    return {
      snapshot_token: row.id,
      as_of_sequence: row.h,
      expires_at: new Date(row.expires_at * 1000).toISOString(),
      entries: page,
      nextCursor: cursor + page.length,
      hasMore: cursor + page.length < entries.length,
    };
  }

  // -- retention (§23.0) ------------------------------------------------------

  /**
   * Enforce explicit time + size retention. Expired snapshots are deleted.
   * The security-audit hash chain lives in a separate table and is never
   * compacted here. Returns deletion counts for audit logging.
   */
  pruneRetention(nowSec?: number): { deletedEvents: number; deletedSnapshots: number } {
    const now = nowSec ?? this.nowSec();
    const cutoff = now - this.retentionMaxAgeSec;
    const aged = this.db
      .prepare("DELETE FROM events WHERE created_at < ?;")
      .run(cutoff);
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM events;")
      .get() as unknown as { n: number };
    let oversize = 0;
    const over = Number(countRow.n) - this.retentionMaxEvents;
    if (over > 0) {
      const res = this.db
        .prepare(
          `DELETE FROM events WHERE event_id IN (
             SELECT event_id FROM events ORDER BY sequence ASC LIMIT ?
           );`,
        )
        .run(over);
      oversize = Number(res.changes ?? 0);
    }
    const snaps = this.db
      .prepare("DELETE FROM snapshots WHERE expires_at <= ?;")
      .run(now);
    return {
      deletedEvents: Number(aged.changes ?? 0) + oversize,
      deletedSnapshots: Number(snaps.changes ?? 0),
    };
  }

  // -- ephemeral streams (live only, never stored/replayed) --------------------

  /**
   * Publish an ephemeral frame (`message.delta`, `browser.frame`,
   * `resource.sample`). Live-only: never written to the log, never
   * replayed, never in the outbox. Each subscriber gets its own counter so
   * it can detect gaps after a reconnect.
   */
  publishEphemeral(
    stream: EphemeralStream,
    payload: unknown,
    runId: string | null = null,
  ): EphemeralMessage {
    if (!isEphemeralStream(stream)) {
      throw new EventBusError(
        "INVALID_ARGUMENT",
        `unknown ephemeral stream "${String(stream)}"`,
      );
    }
    const at = new Date(this.nowSec() * 1000).toISOString();
    let delivered = 0;
    for (const sub of this.ephemeralSubs.values()) {
      if (sub.stream !== stream) continue;
      if (sub.runId !== null && runId !== sub.runId) continue;
      const message: EphemeralMessage = {
        stream,
        counter: sub.nextCounter,
        run_id: runId,
        payload,
        at,
      };
      sub.nextCounter += 1;
      try {
        sub.listener(message);
        delivered += 1;
      } catch {
        // A throwing stream consumer must not break the fan-out.
      }
    }
    void delivered;
    return { stream, counter: -1, run_id: runId, payload, at };
  }

  /**
   * Join a live ephemeral stream. There is no replay and no cursor: after a
   * reconnect the client re-obtains state from the API (partial-message
   * snapshot) and rejoins here. Returns an unsubscribe handle.
   */
  subscribeEphemeral(
    stream: EphemeralStream,
    listener: (message: EphemeralMessage) => void,
    opts?: { runId?: string },
  ): () => void {
    if (!isEphemeralStream(stream)) {
      throw new EventBusError(
        "INVALID_ARGUMENT",
        `unknown ephemeral stream "${String(stream)}"`,
      );
    }
    const id = `eph_${randomBytes(8).toString("hex")}`;
    this.ephemeralSubs.set(id, {
      stream,
      runId: opts?.runId ?? null,
      nextCounter: 1,
      listener,
    });
    return () => {
      this.ephemeralSubs.delete(id);
    };
  }

  // -- partial-message recovery (§23.0) ----------------------------------------

  /**
   * Record the latest durable partial-message snapshot for a Run. The
   * in-progress message is exposed as Run state obtainable over the API;
   * deltas themselves stay ephemeral.
   */
  savePartialMessage(runId: string, ref: string): PartialMessageSnapshot {
    if (runId.length === 0 || ref.length === 0) {
      throw new EventBusError("INVALID_ARGUMENT", "runId and ref required");
    }
    const snapshot: PartialMessageSnapshot = {
      run_id: runId,
      ref,
      updated_at_sec: this.nowSec(),
    };
    this.partials.set(runId, snapshot);
    return snapshot;
  }

  getPartialMessage(runId: string): PartialMessageSnapshot | null {
    return this.partials.get(runId) ?? null;
  }

  clearPartialMessage(runId: string): void {
    this.partials.delete(runId);
  }

  /**
   * Reconnect recovery for an in-progress message: re-fetch the durable
   * partial snapshot first, then rejoin the live `message.delta` stream.
   * Deltas are never backfilled — anything missed during the gap is covered
   * by the snapshot plus the final `message.created` durable event.
   */
  recoverPartialMessage(runId: string): {
    snapshot: PartialMessageSnapshot;
    rejoin: { streams: EphemeralStream[]; from_ref: string };
  } {
    const snapshot = this.partials.get(runId);
    if (!snapshot) {
      throw new EventBusError("NOT_FOUND", `no partial message for run ${runId}`, {
        retryable: false,
        remediation: "re-obtain run state from the API and join live streams",
      });
    }
    return {
      snapshot,
      rejoin: { streams: ["message.delta"], from_ref: snapshot.ref },
    };
  }

  // -- validation -------------------------------------------------------------

  private parseFilter(filter: SubscriptionFilter): SubscriptionFilter {
    try {
      return SubscriptionFilter.parse(filter);
    } catch {
      throw new EventBusError("INVALID_ARGUMENT", "invalid subscription filter");
    }
  }

  private requireCursor(cursor: number): void {
    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new EventBusError(
        "INVALID_ARGUMENT",
        "cursor must be an integer >= 0 (consumers persist the last applied sequence)",
      );
    }
  }
}
