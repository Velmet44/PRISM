/**
 * Stage 2 edge: WebSocket tickets + multiplex manager (spec §22.4, §23.0).
 *
 * - Tickets: `POST /v1/ws/tickets` issuance over an authenticated request,
 *   `prism.v1` redemption via `Sec-WebSocket-Protocol`, single-transaction
 *   consume, 60s ticket/nonce expiry, `CONFLICT` for the concurrent loser,
 *   HTTP fallback `401`, failed upgrades close with `4401`.
 * - Multiplex: one socket per Node carrying many subscriptions. `subscribe`
 *   replays durable events after the cursor, then goes live; ephemeral
 *   streams are live-only (never replayed); partial recovery re-fetches the
 *   partial snapshot and rejoins live; clients ack the highest applied
 *   sequence; a cursor outside retention yields `resync_required` with a
 *   snapshot token carried in `X-PRISM-SNAPSHOT` (never URL).
 * - Abuse controls (§22.8): token-bucket {@link RateLimiter} per source plus
 *   global, with exponential backoff on denial.
 *
 * Transport-agnostic: frames are returned/queued as data; the caller owns
 * the actual socket. Crypto: `node:crypto` only (randomBytes, SHA-256,
 * ECDSA P-256 verify via `ieee-p1363`).
 */
import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  HEADER_SNAPSHOT,
  WS_SUBPROTOCOL,
  packRedemption,
  parseRedemption,
} from "@prism/protocol";
import {
  WS_PROOF_PREFIX,
  WsRedemptionDoc,
  WsTicketIssuance,
  toCanonicalJson,
  type EventEnvelope,
  type SubscriptionFilter,
} from "@prism/schemas";
import type { SecurityAuditEvent, SecurityAuditSink } from "../pairing/index.js";

export { WS_SUBPROTOCOL, HEADER_SNAPSHOT, packRedemption, parseRedemption };

// ---------------------------------------------------------------------------
// Rate limiter (§22.8): token bucket per source + global, exponential backoff
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  readonly capacityPerSource?: number;
  readonly refillPerSecPerSource?: number;
  readonly capacityGlobal?: number;
  readonly refillPerSecGlobal?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly now?: () => number;
}

export type RateLimitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterMs: number };

interface Bucket {
  tokens: number;
  updatedMs: number;
  deniedStreak: number;
}

const DEFAULTS = {
  capacityPerSource: 10,
  refillPerSecPerSource: 1,
  capacityGlobal: 100,
  refillPerSecGlobal: 20,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
} as const;

/**
 * Token-bucket limiter with a per-source bucket and a shared global bucket.
 * A consume requires a token from both. Denials back off exponentially per
 * source (`base * 2^streak`, capped); any allowed consume clears the streak.
 */
export class RateLimiter {
  private readonly sources = new Map<string, Bucket>();
  private globalTokens: number;
  private globalUpdatedMs: number;
  private readonly now: () => number;
  private readonly opts: {
    capacityPerSource: number;
    refillPerSecPerSource: number;
    capacityGlobal: number;
    refillPerSecGlobal: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
  };

  constructor(opts?: RateLimiterOptions) {
    this.opts = {
      capacityPerSource: opts?.capacityPerSource ?? DEFAULTS.capacityPerSource,
      refillPerSecPerSource: opts?.refillPerSecPerSource ?? DEFAULTS.refillPerSecPerSource,
      capacityGlobal: opts?.capacityGlobal ?? DEFAULTS.capacityGlobal,
      refillPerSecGlobal: opts?.refillPerSecGlobal ?? DEFAULTS.refillPerSecGlobal,
      baseBackoffMs: opts?.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: opts?.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
    };
    this.now = opts?.now ?? Date.now;
    this.globalTokens = this.opts.capacityGlobal;
    this.globalUpdatedMs = this.now();
  }

  private refill(bucket: Bucket, capacity: number, perSec: number, nowMs: number): void {
    const elapsedSec = Math.max(0, (nowMs - bucket.updatedMs) / 1000);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * perSec);
    bucket.updatedMs = nowMs;
  }

  private backoffMs(streak: number): number {
    return Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** streak);
  }

  tryConsume(source: string, nowMs?: number): RateLimitResult {
    const now = nowMs ?? this.now();
    const global: Bucket = {
      tokens: this.globalTokens,
      updatedMs: this.globalUpdatedMs,
      deniedStreak: 0,
    };
    this.refill(global, this.opts.capacityGlobal, this.opts.refillPerSecGlobal, now);
    let entry = this.sources.get(source);
    if (!entry) {
      entry = { tokens: this.opts.capacityPerSource, updatedMs: now, deniedStreak: 0 };
      this.sources.set(source, entry);
    }
    this.refill(entry, this.opts.capacityPerSource, this.opts.refillPerSecPerSource, now);
    if (global.tokens < 1 || entry.tokens < 1) {
      const retryAfterMs = this.backoffMs(entry.deniedStreak);
      entry.deniedStreak += 1;
      this.globalTokens = global.tokens;
      this.globalUpdatedMs = global.updatedMs;
      return { ok: false, retryAfterMs };
    }
    entry.tokens -= 1;
    entry.deniedStreak = 0;
    this.globalTokens = global.tokens - 1;
    this.globalUpdatedMs = global.updatedMs;
    return { ok: true };
  }

  /** Reset a source's backoff streak (e.g. after a successful authentication). */
  noteSuccess(source: string): void {
    const entry = this.sources.get(source);
    if (entry) entry.deniedStreak = 0;
  }
}

// ---------------------------------------------------------------------------
// WS tickets (§22.4, §58.12)
// ---------------------------------------------------------------------------

export const WS_TICKET_TTL_MS = 60_000;
export const WS_NONCE_BYTES = 16; // 128-bit nonce, hex-encoded (HEX32)

/** Scope vocabulary for WS tickets; no other values are permitted. */
export const WS_ALLOWED_SCOPES = [
  "streams:events",
  "streams:browser.frame",
  "streams:message.delta",
  "streams:resource.sample",
  "control:browser.control",
] as const;
export type WsScope = (typeof WS_ALLOWED_SCOPES)[number];

export function isWsScope(value: string): value is WsScope {
  return (WS_ALLOWED_SCOPES as readonly string[]).includes(value);
}

/** Stream → required ticket scope for subscriptions (fail closed on excess). */
export const STREAM_SCOPE: Record<string, WsScope> = {
  events: "streams:events",
  "browser.frame": "streams:browser.frame",
  "message.delta": "streams:message.delta",
  "resource.sample": "streams:resource.sample",
};

export function scopeForStream(stream: string): WsScope | null {
  return STREAM_SCOPE[stream] ?? null;
}

/** Close code for any failed WS upgrade (bad proof, expired, conflict). */
export const WS_UPGRADE_DENIED_CODE = 4401;
/** HTTP status for ticket-issuance fallback failures. */
export const WS_HTTP_FALLBACK_STATUS = 401;

export interface WsTicketRecord {
  readonly ticketId: string;
  readonly ticketSha256: string;
  readonly nonce: string;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly scopes: readonly string[];
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  consumed: boolean;
  revoked: boolean;
}

export interface IssueTicketInput {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly scopes: readonly string[];
  readonly nowMs?: number;
}

export interface RedeemTicketInput {
  /** Raw `Sec-WebSocket-Protocol` header value from the upgrade request. */
  readonly subprotocolHeader: string;
  /** Scopes the socket requests; must be ⊆ ticket scopes. */
  readonly requestedScopes: readonly string[];
  readonly nowMs?: number;
}

export type RedeemTicketResult =
  | { readonly ok: true; readonly ticket: WsTicketRecord }
  | {
      readonly ok: false;
      readonly code: "UNAUTHENTICATED" | "CONFLICT" | "EXPIRED" | "RATE_LIMITED";
      readonly reason: string;
      readonly retryAfterMs?: number;
    };

export interface WsTicketDeps {
  isDeviceRevokedOrUnknown: (deviceId: string) => boolean | Promise<boolean>;
  getDevicePublicKey: (
    deviceId: string,
  ) => string | null | Promise<string | null>;
  verifySignature?: (
    publicKeySpkiPem: string,
    signingInput: Uint8Array,
    signature: Uint8Array,
  ) => boolean | Promise<boolean>;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function base64UrlDecode(input: string): Buffer | null {
  try {
    if (input.length === 0 || input.length > 4096) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
    return Buffer.from(input, "base64url");
  } catch {
    return null;
  }
}

/** Default ES256 (ECDSA P-256 + SHA-256) verifier over SPKI PEM, P-1363 encoding. */
export async function verifyEs256P1363(
  publicKeySpkiPem: string,
  signingInput: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    if (signature.length !== 64) return false;
    const key = createPublicKey(publicKeySpkiPem);
    if (key.asymmetricKeyType !== "ec") return false;
    const verifier = createVerify("sha256");
    verifier.update(signingInput);
    verifier.end();
    return verifier.verify({ key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

export function wsRedemptionSigningBytes(doc: Record<string, unknown>): Buffer {
  return Buffer.from(WS_PROOF_PREFIX + toCanonicalJson(doc), "utf8");
}

/**
 * In-memory WS ticket store. Production MUST back this with SQLite and
 * consume the ticket row in the same transaction as upgrade success; the
 * in-process consume step below is synchronous (no awaits between the
 * re-check and the flag) so concurrent redeems serialize on the event loop
 * and the loser observes `CONFLICT`.
 */
export class WsTicketStore {
  private readonly tickets = new Map<string, WsTicketRecord>();
  private readonly bySha = new Map<string, string>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  issue(input: IssueTicketInput): WsTicketIssuance {
    if (input.nodeId.length === 0) throw new Error("nodeId required");
    if (input.sessionId.length === 0) throw new Error("sessionId required");
    if (input.deviceId.length === 0) throw new Error("deviceId required");
    if (input.scopes.length === 0) throw new Error("ticket requires scopes");
    for (const scope of input.scopes) {
      if (!isWsScope(scope)) throw new Error(`forbidden ticket scope: ${scope}`);
    }
    const now = input.nowMs ?? this.now();
    const secret = randomBytes(32);
    const ticketSecret = secret.toString("base64url");
    const ticketSha256 = sha256Hex(secret);
    const ticket: WsTicketRecord = {
      ticketId: randomBytes(16).toString("hex"),
      ticketSha256,
      nonce: randomBytes(WS_NONCE_BYTES).toString("hex"),
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      deviceId: input.deviceId,
      scopes: [...input.scopes],
      issuedAtMs: now,
      expiresAtMs: now + WS_TICKET_TTL_MS,
      consumed: false,
      revoked: false,
    };
    this.tickets.set(ticket.ticketId, ticket);
    this.bySha.set(ticketSha256, ticket.ticketId);
    const issuance = {
      ticket_id: ticket.ticketId,
      ticket_secret: ticketSecret,
      ticket_sha256: ticketSha256,
      nonce: ticket.nonce,
      expires_at: new Date(ticket.expiresAtMs).toISOString(),
      scopes: [...ticket.scopes],
    };
    const parsed = WsTicketIssuance.safeParse(issuance);
    if (!parsed.success) throw new Error("ticket issuance failed validation");
    return parsed.data;
  }

  private findBySecret(ticketSecretB64: string): WsTicketRecord | null {
    const raw = base64UrlDecode(ticketSecretB64);
    if (!raw) return null;
    const digest = sha256Hex(raw);
    const a = Buffer.from(digest, "hex");
    // Constant-time lookup across stored digests.
    let found: WsTicketRecord | null = null;
    for (const ticket of this.tickets.values()) {
      let b: Buffer;
      try {
        b = Buffer.from(ticket.ticketSha256, "hex");
      } catch {
        continue;
      }
      if (a.length === b.length && timingSafeEqual(a, b)) found = ticket;
    }
    return found;
  }

  /**
   * Redeem a ticket during the WS upgrade. Verifies the `PRISM-WS-POP-V1`
   * proof, then consumes the ticket atomically (synchronous check+set).
   */
  async redeem(input: RedeemTicketInput, deps: WsTicketDeps): Promise<RedeemTicketResult> {
    let pair: { ticketSecretB64: string; signatureB64: string };
    try {
      pair = parseRedemption(input.subprotocolHeader);
    } catch {
      return { ok: false, code: "UNAUTHENTICATED", reason: "malformed_redemption" };
    }
    const ticket = this.findBySecret(pair.ticketSecretB64);
    // Unknown or revoked tickets fail closed here. Consumed tickets are NOT
    // rejected yet: after proof verification the atomic consume below yields
    // CONFLICT for the concurrent loser (§22.4).
    if (!ticket || ticket.revoked) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "unknown_or_revoked_ticket" };
    }
    const now = input.nowMs ?? this.now();
    if (now >= ticket.expiresAtMs) {
      return { ok: false, code: "EXPIRED", reason: "ticket_expired" };
    }
    for (const scope of input.requestedScopes) {
      if (!ticket.scopes.includes(scope)) {
        return { ok: false, code: "UNAUTHENTICATED", reason: "scope_exceeds_ticket" };
      }
    }
    let revokedOrUnknown: boolean;
    try {
      revokedOrUnknown = await deps.isDeviceRevokedOrUnknown(ticket.deviceId);
    } catch {
      return { ok: false, code: "UNAUTHENTICATED", reason: "revocation_check_failed" };
    }
    if (revokedOrUnknown) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "revoked_or_unknown_device" };
    }
    const doc = {
      node_id: ticket.nodeId,
      session_id: ticket.sessionId,
      device_id: ticket.deviceId,
      ticket_sha256: ticket.ticketSha256,
      nonce: ticket.nonce,
      requested_scopes: [...input.requestedScopes],
    };
    if (!WsRedemptionDoc.safeParse(doc).success) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "malformed_redemption_doc" };
    }
    const sig = base64UrlDecode(pair.signatureB64);
    if (!sig || sig.length !== 64) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "bad_signature_encoding" };
    }
    let pubkey: string | null;
    try {
      pubkey = await deps.getDevicePublicKey(ticket.deviceId);
    } catch {
      return { ok: false, code: "UNAUTHENTICATED", reason: "pubkey_lookup_failed" };
    }
    if (!pubkey) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "unknown_device_key" };
    }
    const verify = deps.verifySignature ?? verifyEs256P1363;
    let sigOk = false;
    try {
      sigOk = await verify(pubkey, wsRedemptionSigningBytes(doc), sig);
    } catch {
      return { ok: false, code: "UNAUTHENTICATED", reason: "verify_failed" };
    }
    if (!sigOk) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "bad_signature" };
    }
    // Atomic consume: no await between re-check and flag (same-transaction
    // semantics in production SQLite). The concurrent loser lands here.
    const live = this.tickets.get(ticket.ticketId);
    if (!live || live.consumed || live.revoked) {
      return { ok: false, code: "CONFLICT", reason: "ticket_already_consumed" };
    }
    if (now >= live.expiresAtMs) {
      return { ok: false, code: "EXPIRED", reason: "ticket_expired" };
    }
    live.consumed = true;
    return { ok: true, ticket: { ...live, scopes: [...live.scopes] } };
  }

  /** Revoke every unconsumed ticket of a device (revocation fan-out). */
  revokeDeviceTickets(deviceId: string): number {
    let count = 0;
    for (const ticket of this.tickets.values()) {
      if (ticket.deviceId === deviceId && !ticket.consumed && !ticket.revoked) {
        ticket.revoked = true;
        count += 1;
      }
    }
    return count;
  }

  pruneExpired(nowMs?: number): number {
    const now = nowMs ?? this.now();
    let removed = 0;
    for (const [id, ticket] of this.tickets) {
      if (now >= ticket.expiresAtMs + WS_TICKET_TTL_MS) {
        this.tickets.delete(id);
        this.bySha.delete(ticket.ticketSha256);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.tickets.size;
  }
}

/** Map any failed redemption to its WS close / HTTP fallback outcome. */
export function upgradeDenial(result: RedeemTicketResult): {
  wsCloseCode: number;
  reason: string;
  httpStatus: number;
} {
  if (result.ok) throw new Error("upgradeDenial only for failed redemptions");
  return {
    wsCloseCode: WS_UPGRADE_DENIED_CODE,
    reason: result.code === "CONFLICT" ? "CONFLICT: ticket_already_consumed" : result.reason,
    httpStatus: WS_HTTP_FALLBACK_STATUS,
  };
}

/** Rate-limited ticket issuance wrapper (per-source + global backoff). */
export class WsTicketIssuer {
  constructor(
    private readonly store: WsTicketStore,
    private readonly limiter: RateLimiter,
    private readonly audit: SecurityAuditSink | null = null,
  ) {}

  issueTicket(source: string, input: IssueTicketInput):
    | { readonly ok: true; readonly issuance: WsTicketIssuance }
    | { readonly ok: false; readonly code: "RATE_LIMITED"; readonly retryAfterMs: number } {
    const check = this.limiter.tryConsume(source);
    if (!check.ok) {
      this.audit?.({
        at: new Date().toISOString(),
        kind: "ws_ticket_denied",
        nodeId: input.nodeId,
        deviceId: input.deviceId,
        source,
        reason: "rate_limited",
      } satisfies SecurityAuditEvent);
      return { ok: false, code: "RATE_LIMITED", retryAfterMs: check.retryAfterMs };
    }
    return { ok: true, issuance: this.store.issue(input) };
  }
}

// ---------------------------------------------------------------------------
// Multiplex manager: one socket per Node, many subscriptions (§23.0)
// ---------------------------------------------------------------------------

export interface WsSocketBinding {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly scopes: readonly string[];
}

export interface WsConnection extends WsSocketBinding {
  readonly connectionId: string;
  connectedAtMs: number;
  closed: boolean;
  closeReason: string | null;
}

export interface SubscriptionState {
  readonly subscriptionId: string;
  readonly connectionId: string;
  readonly stream: string | null;
  readonly filter: SubscriptionFilter;
  cursor: number;
  acked: number;
  live: boolean;
  ephemeralCounter: number;
}

export type ServerFrame =
  | { readonly kind: "durable"; readonly subscriptionId: string; readonly events: EventEnvelope[] }
  | {
      readonly kind: "ephemeral";
      readonly subscriptionId: string;
      readonly stream: string;
      readonly counter: number;
      readonly payload: unknown;
    }
  | {
      readonly kind: "resync_required";
      readonly subscriptionId: string;
      readonly snapshotToken: string;
      readonly asOfSequence: number;
      readonly expiresAt: string;
    };

export type SnapshotPageResult =
  | { readonly ok: true; readonly events: EventEnvelope[]; readonly asOfSequence: number }
  | { readonly ok: false; readonly code: "RESYNC_REQUIRED"; readonly reason: string };

export interface SnapshotTokenRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly sessionId: string;
  readonly filterHash: string;
  readonly filter: SubscriptionFilter;
  readonly H: number;
  readonly expiresAtMs: number;
  readonly events: EventEnvelope[];
}

export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const MAX_SNAPSHOTS_PER_NODE = 32;
export const MAX_SNAPSHOTS_PER_SESSION = 4;
export const WS_EVENT_RETENTION = 10_000;

function filterHash(filter: SubscriptionFilter): string {
  return sha256Hex(toCanonicalJson(filter));
}

/**
 * In-memory multiplex core. Durable events are appended to a bounded
 * per-Node log (oldest retained sequence = retention floor); publishes fan
 * out to matching live subscriptions in order. Ephemeral payloads are
 * never stored. Snapshot tokens pin the matching events at head `H` and are
 * served from that frozen copy, never live tables.
 */
export class WsMultiplexManager {
  private readonly connections = new Map<string, WsConnection & { outbox: ServerFrame[] }>();
  private readonly subscriptions = new Map<string, SubscriptionState>();
  private readonly log = new Map<string, EventEnvelope[]>();
  private readonly heads = new Map<string, number>();
  private readonly snapshots = new Map<string, SnapshotTokenRecord>();
  private readonly audit: SecurityAuditSink | null;
  private readonly now: () => number;

  constructor(opts?: { audit?: SecurityAuditSink | null; now?: () => number }) {
    this.audit = opts?.audit ?? null;
    this.now = opts?.now ?? Date.now;
  }

  // -- sockets ------------------------------------------------------------

  attachSocket(binding: WsSocketBinding): WsConnection {
    const connection: WsConnection & { outbox: ServerFrame[] } = {
      ...binding,
      scopes: [...binding.scopes],
      connectionId: randomBytes(16).toString("hex"),
      connectedAtMs: this.now(),
      closed: false,
      closeReason: null,
      outbox: [],
    };
    this.connections.set(connection.connectionId, connection);
    return { ...connection, scopes: [...connection.scopes] };
  }

  getConnection(connectionId: string): WsConnection | null {
    const conn = this.connections.get(connectionId);
    return conn ? { ...conn, scopes: [...conn.scopes] } : null;
  }

  closeSocket(connectionId: string, reason = "closed"): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.closed) return false;
    conn.closed = true;
    conn.closeReason = reason;
    for (const sub of this.subscriptions.values()) {
      if (sub.connectionId === connectionId) sub.live = false;
    }
    return true;
  }

  /** Close every socket of a device within one heartbeat (revocation path). */
  revokeDeviceSockets(deviceId: string): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.deviceId === deviceId && !conn.closed) {
        conn.closed = true;
        conn.closeReason = "device_revoked";
        count += 1;
      }
    }
    for (const sub of this.subscriptions.values()) {
      const conn = this.connections.get(sub.connectionId);
      if (conn?.closed) sub.live = false;
    }
    if (count > 0) {
      this.audit?.({
        at: new Date().toISOString(),
        kind: "ws_sockets_revoked",
        deviceId,
        reason: "device_revoked",
      });
    }
    return count;
  }

  /** Frames queued for a connection (transport drains and sends them). */
  drainOutbox(connectionId: string): ServerFrame[] {
    const conn = this.connections.get(connectionId);
    if (!conn) return [];
    return conn.outbox.splice(0, conn.outbox.length);
  }

  // -- durable publish / subscribe -----------------------------------------

  private nodeLog(nodeId: string): EventEnvelope[] {
    let entries = this.log.get(nodeId);
    if (!entries) {
      entries = [];
      this.log.set(nodeId, entries);
    }
    return entries;
  }

  /** Current committed head `H` for a Node (0 when empty). */
  head(nodeId: string): number {
    return this.heads.get(nodeId) ?? 0;
  }

  /** Oldest retained sequence; cursors below it require resync. */
  retentionFloor(nodeId: string): number {
    const entries = this.log.get(nodeId);
    if (!entries || entries.length === 0) return this.head(nodeId);
    const first = entries[0] as EventEnvelope | undefined;
    return first?.sequence ?? this.head(nodeId);
  }

  publishDurable(event: EventEnvelope): void {
    const entries = this.nodeLog(event.node_id);
    this.heads.set(event.node_id, event.sequence);
    entries.push(event);
    while (entries.length > WS_EVENT_RETENTION) entries.shift();
    for (const sub of this.subscriptions.values()) {
      if (!sub.live || sub.stream !== null) continue;
      const conn = this.connections.get(sub.connectionId);
      if (!conn || conn.closed || conn.nodeId !== event.node_id) continue;
      if (!filterMatches(sub.filter, event)) continue;
      if (event.sequence <= sub.cursor) continue;
      sub.cursor = event.sequence;
      conn.outbox.push({ kind: "durable", subscriptionId: sub.subscriptionId, events: [event] });
    }
  }

  subscribe(
    connectionId: string,
    filter: SubscriptionFilter,
    cursor: number,
  ):
    | { readonly ok: true; readonly subscription: SubscriptionState; readonly replay: EventEnvelope[] }
    | { readonly ok: false; readonly code: "UNAUTHENTICATED" | "RESYNC_REQUIRED"; readonly reason: string; readonly resync?: { readonly snapshotToken: string; readonly asOfSequence: number; readonly expiresAt: string } } {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.closed) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "unknown_or_closed_socket" };
    }
    if (cursor < this.retentionFloor(conn.nodeId)) {
      const resync = this.createSnapshot(conn, filter);
      conn.outbox.push({
        kind: "resync_required",
        subscriptionId: "",
        snapshotToken: resync.id,
        asOfSequence: resync.H,
        expiresAt: new Date(resync.expiresAtMs).toISOString(),
      });
      return {
        ok: false,
        code: "RESYNC_REQUIRED",
        reason: "cursor_outside_retention",
        resync: {
          snapshotToken: resync.id,
          asOfSequence: resync.H,
          expiresAt: new Date(resync.expiresAtMs).toISOString(),
        },
      };
    }
    const subscription: SubscriptionState = {
      subscriptionId: randomBytes(16).toString("hex"),
      connectionId,
      stream: null,
      filter: { ...filter },
      cursor,
      acked: cursor,
      live: true,
      ephemeralCounter: 0,
    };
    const replay = this.nodeLog(conn.nodeId).filter(
      (event) => event.sequence > cursor && filterMatches(filter, event),
    );
    for (const event of replay) subscription.cursor = Math.max(subscription.cursor, event.sequence);
    this.subscriptions.set(subscription.subscriptionId, subscription);
    return { ok: true, subscription: { ...subscription }, replay };
  }

  /** Subscribe to a live-only ephemeral stream (never replayed, §23.0). */
  subscribeEphemeral(
    connectionId: string,
    stream: string,
    filter: SubscriptionFilter,
  ): { readonly ok: true; readonly subscription: SubscriptionState } | { readonly ok: false; readonly code: "UNAUTHORIZED"; readonly reason: string } {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.closed) {
      return { ok: false, code: "UNAUTHORIZED", reason: "unknown_or_closed_socket" };
    }
    const required = scopeForStream(stream);
    if (!required || !conn.scopes.includes(required)) {
      return { ok: false, code: "UNAUTHORIZED", reason: "stream_scope_not_granted" };
    }
    const subscription: SubscriptionState = {
      subscriptionId: randomBytes(16).toString("hex"),
      connectionId,
      stream,
      filter: { ...filter },
      cursor: this.head(conn.nodeId),
      acked: this.head(conn.nodeId),
      live: true,
      ephemeralCounter: 0,
    };
    this.subscriptions.set(subscription.subscriptionId, subscription);
    return { ok: true, subscription: { ...subscription } };
  }

  /** Live-only fan-out with a per-subscription gap counter; nothing stored. */
  publishEphemeral(nodeId: string, stream: string, payload: unknown, filter?: SubscriptionFilter): number {
    let delivered = 0;
    for (const sub of this.subscriptions.values()) {
      if (!sub.live || sub.stream !== stream) continue;
      const conn = this.connections.get(sub.connectionId);
      if (!conn || conn.closed || conn.nodeId !== nodeId) continue;
      if (filter && !filterMatchesLoose(sub.filter, filter)) continue;
      sub.ephemeralCounter += 1;
      conn.outbox.push({
        kind: "ephemeral",
        subscriptionId: sub.subscriptionId,
        stream,
        counter: sub.ephemeralCounter,
        payload,
      });
      delivered += 1;
    }
    return delivered;
  }

  /**
   * Partial recovery: the client re-fetches the partial-message snapshot
   * over the API (`fetchPartial`), then rejoins the live delta stream from
   * the returned baseline counter.
   */
  rejoinLive(
    subscriptionId: string,
    fetchPartial: () => { readonly baselineCounter: number },
  ): { readonly ok: true; readonly baselineCounter: number } | { readonly ok: false; readonly reason: string } {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub || sub.stream === null) return { ok: false, reason: "unknown_ephemeral_subscription" };
    const conn = this.connections.get(sub.connectionId);
    if (!conn || conn.closed) return { ok: false, reason: "socket_closed" };
    const partial = fetchPartial();
    sub.ephemeralCounter = partial.baselineCounter;
    sub.live = true;
    return { ok: true, baselineCounter: partial.baselineCounter };
  }

  /** Advance the highest applied sequence; never moves backwards. */
  ack(subscriptionId: string, sequence: number): boolean {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return false;
    if (sequence > sub.acked) {
      sub.acked = sequence;
      if (sequence > sub.cursor) sub.cursor = sequence;
    }
    return true;
  }

  unsubscribe(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  // -- snapshots / resync (§23.0) ------------------------------------------

  private createSnapshot(conn: WsConnection, filter: SubscriptionFilter): SnapshotTokenRecord {
    const now = this.now();
    const H = this.head(conn.nodeId);
    const events = this.nodeLog(conn.nodeId).filter((event) => filterMatches(filter, event));
    const record: SnapshotTokenRecord = {
      id: randomBytes(24).toString("base64url"),
      nodeId: conn.nodeId,
      sessionId: conn.sessionId,
      filterHash: filterHash(filter),
      filter: { ...filter },
      H,
      expiresAtMs: now + SNAPSHOT_TTL_MS,
      events: [...events],
    };
    this.evictSnapshots(conn.nodeId, conn.sessionId);
    this.snapshots.set(record.id, record);
    // LRU touch: re-insert to mark most-recent.
    const stored = this.snapshots.get(record.id) as SnapshotTokenRecord;
    this.snapshots.delete(record.id);
    this.snapshots.set(record.id, stored);
    return record;
  }

  private evictSnapshots(nodeId: string, sessionId: string): void {
    const forNode = [...this.snapshots.values()].filter((s) => s.nodeId === nodeId);
    while (forNode.length >= MAX_SNAPSHOTS_PER_NODE) {
      const oldest = forNode.shift() as SnapshotTokenRecord | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest.id);
    }
    const forSession = [...this.snapshots.values()].filter(
      (s) => s.nodeId === nodeId && s.sessionId === sessionId,
    );
    while (forSession.length >= MAX_SNAPSHOTS_PER_SESSION) {
      const oldest = forSession.shift() as SnapshotTokenRecord | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest.id);
    }
  }

  /**
   * Serve one snapshot page from the frozen copy. The token MUST arrive via
   * the `X-PRISM-SNAPSHOT` header (or an authenticated WS control frame),
   * never URL/log/event/model context — enforced by the caller, which
   * passes only the header value here.
   */
  getSnapshotPage(
    snapshotToken: string,
    filter: SubscriptionFilter,
    cursor: number,
    limit: number,
  ): SnapshotPageResult {
    const record = this.snapshots.get(snapshotToken);
    const now = this.now();
    if (!record || now >= record.expiresAtMs) {
      return { ok: false, code: "RESYNC_REQUIRED", reason: "snapshot_expired_or_unknown" };
    }
    if (filterHash(filter) !== record.filterHash) {
      return { ok: false, code: "RESYNC_REQUIRED", reason: "filter_changed_requires_new_resync" };
    }
    const page = record.events
      .filter((event) => event.sequence > cursor)
      .sort((a, b) => a.sequence - b.sequence || (a.event_id < b.event_id ? -1 : 1))
      .slice(0, Math.max(1, Math.min(200, limit)));
    return { ok: true, events: page, asOfSequence: record.H };
  }

  snapshotCount(): number {
    return this.snapshots.size;
  }
}

function filterMatches(filter: SubscriptionFilter, event: EventEnvelope): boolean {
  if (filter.node_id !== undefined && event.node_id !== filter.node_id) return false;
  if (filter.agent_id !== undefined && event.agent_id !== filter.agent_id) return false;
  if (filter.task_id !== undefined && event.task_id !== filter.task_id) return false;
  if (filter.run_id !== undefined && event.run_id !== filter.run_id) return false;
  return true;
}

/** Loose match between a subscription filter and a publish-time filter hint. */
function filterMatchesLoose(sub: SubscriptionFilter, hint: SubscriptionFilter): boolean {
  for (const key of ["node_id", "agent_id", "task_id", "run_id"] as const) {
    const a = sub[key];
    const b = hint[key];
    if (a !== undefined && b !== undefined && a !== b) return false;
  }
  return true;
}

// Re-exported for route layers that audit through the pairing sink type.
export type { SecurityAuditEvent, SecurityAuditSink } from "../pairing/index.js";
