// Display-cache store for PRISM Web (spec §4.2, §23.0).
//
// The Node is authoritative for agents, tasks, runs, messages, memory,
// files, artifacts, models, policies, schedules, browser sessions,
// resources, updates and audit history. This store holds ONLY a cached
// projection for responsiveness and MUST never be treated as canonical:
//   - every entry is a deep copy; readers receive copies, never live refs;
//   - all ordering/correctness comes from Node-assigned sequence numbers;
//   - a `resync_required` snapshot (header X-PRISM-SNAPSHOT) replaces the
//     projection wholesale and resubscribes from the snapshot sequence H.

export const SNAPSHOT_HEADER = "X-PRISM-SNAPSHOT";

export interface DisplayNode {
  readonly nodeId: string;
  readonly endpoint: string;
  readonly fingerprint: string;
  readonly status: string;
}

export interface DisplayAgent {
  readonly agentId: string;
  readonly name: string;
  readonly status: string;
}

export interface DisplayTask {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
}

export interface DisplayRun {
  readonly runId: string;
  readonly taskId: string;
  readonly status: string;
  readonly attempt: number;
}

export interface DisplayEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
  readonly aggregateId: string;
}

export interface ResyncRequired {
  readonly snapshotToken: string;
  readonly asOfSequence: number;
  readonly expiresAt: string;
}

export interface SnapshotProjection {
  readonly nodes: readonly DisplayNode[];
  readonly agents: readonly DisplayAgent[];
  readonly tasks: readonly DisplayTask[];
  readonly runs: readonly DisplayRun[];
}

function deepCopy<T>(value: T): T {
  // structuredClone is available in Node 22; fall back to JSON for plain data.
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface DisplayCacheSnapshot {
  readonly nodes: readonly DisplayNode[];
  readonly agents: readonly DisplayAgent[];
  readonly tasks: readonly DisplayTask[];
  readonly runs: readonly DisplayRun[];
  readonly cursor: number | null;
  readonly resyncRequired: boolean;
  readonly snapshotToken: string | null;
}

/**
 * Display-only projection cache. Gaps in observed sequences are normal
 * (events outside the subscription filter); the contract is "every matching
 * event after the cursor, in order" — never contiguity. Duplicates are
 * ignored by event_id.
 */
export class DisplayCacheStore {
  private nodes = new Map<string, DisplayNode>();
  private agents = new Map<string, DisplayAgent>();
  private tasks = new Map<string, DisplayTask>();
  private runs = new Map<string, DisplayRun>();
  private seenEventIds = new Set<string>();
  private cursor: number | null = null;
  private resync: ResyncRequired | null = null;

  /** This store is display-only; it never owns canonical state. */
  readonly isDisplayCacheOnly = true as const;

  getCursor(): number | null {
    return this.cursor;
  }

  needsResync(): boolean {
    return this.resync !== null;
  }

  getSnapshotToken(): string | null {
    return this.resync?.snapshotToken ?? null;
  }

  /** Headers for snapshot pagination reads (never URL/log/model context). */
  getSnapshotFetchHeaders(): Record<string, string> {
    const token = this.getSnapshotToken();
    return token === null ? {} : { [SNAPSHOT_HEADER]: token };
  }

  /**
   * Record a `resync_required{snapshot_token,as_of_sequence,expires_at}`
   * signal: mark the projection stale until `replaceProjectionFromSnapshot`
   * runs. The live projection is kept (stale) so the UI can show a
   * resync-required state rather than silently skipping events.
   */
  handleResyncRequired(info: ResyncRequired): void {
    this.resync = { ...info };
  }

  /**
   * Replace the whole projection with the materialized snapshot taken at H,
   * then resubscribe from H. Reads came from the stored snapshot via the
   * X-PRISM-SNAPSHOT header, never from live tables.
   */
  replaceProjectionFromSnapshot(
    projection: SnapshotProjection,
    asOfSequence: number,
  ): void {
    this.nodes = new Map(
      projection.nodes.map((n) => [n.nodeId, deepCopy(n)]),
    );
    this.agents = new Map(
      projection.agents.map((a) => [a.agentId, deepCopy(a)]),
    );
    this.tasks = new Map(
      projection.tasks.map((t) => [t.taskId, deepCopy(t)]),
    );
    this.runs = new Map(
      projection.runs.map((r) => [r.runId, deepCopy(r)]),
    );
    this.seenEventIds = new Set();
    this.cursor = asOfSequence;
    this.resync = null;
  }

  /**
   * Apply durable events with sequence > cursor, in order. Events at or
   * below the cursor and duplicate event_ids are ignored. Never mutates
   * the caller's event objects.
   */
  applyEvents(events: readonly DisplayEvent[]): number {
    let applied = 0;
    for (const event of events) {
      if (this.seenEventIds.has(event.eventId)) continue;
      if (this.cursor !== null && event.sequence <= this.cursor) continue;
      this.seenEventIds.add(event.eventId);
      this.cursor = event.sequence;
      applied += 1;
    }
    return applied;
  }

  upsertNodes(entries: readonly DisplayNode[]): void {
    for (const entry of entries) this.nodes.set(entry.nodeId, deepCopy(entry));
  }

  upsertAgents(entries: readonly DisplayAgent[]): void {
    for (const entry of entries)
      this.agents.set(entry.agentId, deepCopy(entry));
  }

  upsertTasks(entries: readonly DisplayTask[]): void {
    for (const entry of entries) this.tasks.set(entry.taskId, deepCopy(entry));
  }

  upsertRuns(entries: readonly DisplayRun[]): void {
    for (const entry of entries) this.runs.set(entry.runId, deepCopy(entry));
  }

  /** Readers get copies: mutating results never touches the cache. */
  dump(): DisplayCacheSnapshot {
    return {
      nodes: [...this.nodes.values()].map(deepCopy),
      agents: [...this.agents.values()].map(deepCopy),
      tasks: [...this.tasks.values()].map(deepCopy),
      runs: [...this.runs.values()].map(deepCopy),
      cursor: this.cursor,
      resyncRequired: this.resync !== null,
      snapshotToken: this.resync?.snapshotToken ?? null,
    };
  }
}
