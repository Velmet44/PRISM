/**
 * Stage 2 edge: QR/single-use pairing tokens + device-bound sessions
 * (spec §6.4, §22.2, §22.8, §22.10).
 *
 * - QR payloads carry `{token, endpoint, fingerprint}` — never the owner key.
 * - Pairing tokens are high-entropy, single-use, bound to Node + flow, with
 *   5-minute expiry, invalidated on success or explicit cancellation.
 * - Exchange registers the device P-256 public key and mints a short-lived,
 *   scoped, NodeId+DeviceId-bound session via the existing
 *   `SessionManager`/`DeviceRegistry` (imported, never reimplemented).
 * - Abuse controls (§22.8): exchange attempts share the token-bucket
 *   {@link RateLimiter}; owner-key bootstrap attempts feed the existing
 *   `KeyLockout` (5 fails / 10 minutes). Failures are recorded as
 *   `security_audit` events without secret material.
 * - Revocation (§22.10) fans out to sessions, tickets, sockets, and
 *   approvals in one call.
 *
 * Crypto: `node:crypto` only (randomBytes, SHA-256, timingSafeEqual,
 * P-256 SPKI validation).
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  KeyLockout,
  SessionManager,
  type ClientClass,
  type CreatedSession,
} from "../auth/index.js";
import {
  DeviceRegistry,
  revokeDevice,
  type DeviceRecord,
  type RevokeCollaborators,
} from "../devices/index.js";
import { RateLimiter } from "../ws/index.js";

export { KeyLockout };

// ---------------------------------------------------------------------------
// Security audit events (§22.8: failures recorded, never secret material)
// ---------------------------------------------------------------------------

export type SecurityAuditKind =
  | "pairing_failed"
  | "pairing_exchanged"
  | "pairing_cancelled"
  | "owner_key_failed"
  | "owner_key_locked"
  | "ws_ticket_denied"
  | "ws_redeem_failed"
  | "ws_sockets_revoked"
  | "device_revoked";

export interface SecurityAuditEvent {
  readonly at: string;
  readonly kind: SecurityAuditKind;
  readonly nodeId?: string;
  readonly deviceId?: string;
  /** Rate-limit / lockout source key (IP, session, or listener name). */
  readonly source?: string;
  readonly reason?: string;
  readonly retryAfterMs?: number;
  readonly counts?: Readonly<Record<string, number>>;
}

export type SecurityAuditSink = (event: SecurityAuditEvent) => void;

// ---------------------------------------------------------------------------
// Pairing tokens (§6.4)
// ---------------------------------------------------------------------------

export const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000;
export const PAIRING_TOKEN_BYTES = 32;
/** Wire path for the token↔device-key exchange (route wiring is Stage 2b). */
export const PAIRING_EXCHANGE_PATH = "/v1/pairing/exchange" as const;

/** Default scopes minted at pairing; Node Manager SHOULD pass explicit scopes. */
export const DEFAULT_PAIRING_SCOPES = [
  "agents:read",
  "tasks:read",
  "runs:read",
  "approvals:submit",
] as const;

export interface PairingTokenRecord {
  readonly tokenSha256: string;
  readonly nodeId: string;
  /** Intended pairing flow (e.g. `local`, `headless`, `recovery`). */
  readonly flow: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  consumed: boolean;
  cancelled: boolean;
}

export interface QrPayload {
  /** Single-use pairing token (opaque to the QR renderer). */
  readonly token: string;
  /** Current Node endpoint the client should reach. */
  readonly endpoint: string;
  /** Node identity fingerprint for out-of-band comparison (§22.9). */
  readonly fingerprint: string;
}

export interface ExchangeOptions {
  readonly deviceName?: string;
  readonly scopes?: readonly string[];
  readonly clientClass?: ClientClass;
  readonly nowMs?: number;
}

export interface ExchangeSuccess {
  readonly ok: true;
  readonly device: DeviceRecord;
  readonly session: CreatedSession["session"];
  /** Session bearer; shown once. Only its sha256 is stored. */
  readonly sessionToken: string;
}

export type ExchangeResult =
  | ExchangeSuccess
  | { readonly ok: false; readonly code: "UNAUTHENTICATED" | "RATE_LIMITED"; readonly reason: string; readonly retryAfterMs?: number };

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Normalize a presented device P-256 public key to SPKI PEM for the device
 * record. Accepts SPKI PEM or base64url of the 65-byte uncompressed point
 * (WebCrypto `exportKey("raw")`). Rejects non-P-256 keys.
 */
export function normalizeDeviceP256Key(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return assertP256Spki(trimmed);
  }
  let raw: Buffer;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw new Error("bad encoding");
    raw = Buffer.from(trimmed, "base64url");
  } catch {
    throw new Error("invalid device public key encoding");
  }
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("device public key must be a 65-byte uncompressed P-256 point");
  }
  const x = raw.subarray(1, 33).toString("base64url");
  const y = raw.subarray(33, 65).toString("base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" });
  return assertP256Spki(key.export({ format: "pem", type: "spki" }).toString());
}

function assertP256Spki(spkiPem: string): string {
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(spkiPem);
  } catch {
    throw new Error("invalid device public key");
  }
  if (key.asymmetricKeyType !== "ec") throw new Error("device key must be EC P-256");
  const details = key.asymmetricKeyDetails as { namedCurve?: string } | undefined;
  if (details?.namedCurve !== undefined && details.namedCurve !== "prime256v1") {
    throw new Error("device key must use P-256 (prime256v1)");
  }
  return spkiPem;
}

export interface PairingManagerOptions {
  readonly now?: () => number;
  readonly tokenTtlMs?: number;
  readonly limiter?: RateLimiter;
  readonly ownerLockout?: KeyLockout;
  readonly audit?: SecurityAuditSink | null;
}

/**
 * Issues and exchanges single-use pairing tokens. Bound to one Node id;
 * sessions and devices are created through the injected Stage 1
 * `SessionManager` / `DeviceRegistry` so TTL, binding, and revocation
 * semantics stay in exactly one place.
 */
export class PairingManager {
  private readonly nodeId: string;
  private readonly sessions: SessionManager;
  private readonly devices: DeviceRegistry;
  private readonly tokens = new Map<string, PairingTokenRecord>();
  private readonly limiter: RateLimiter;
  private readonly ownerLockout: KeyLockout;
  private readonly audit: SecurityAuditSink | null;
  private readonly now: () => number;
  private readonly tokenTtlMs: number;

  constructor(
    nodeId: string,
    sessions: SessionManager,
    devices: DeviceRegistry,
    opts?: PairingManagerOptions,
  ) {
    if (nodeId.length === 0) throw new Error("nodeId required");
    this.nodeId = nodeId;
    this.sessions = sessions;
    this.devices = devices;
    this.now = opts?.now ?? Date.now;
    this.tokenTtlMs = opts?.tokenTtlMs ?? PAIRING_TOKEN_TTL_MS;
    this.limiter = opts?.limiter ?? new RateLimiter({ now: this.now });
    this.ownerLockout = opts?.ownerLockout ?? new KeyLockout({ now: this.now });
    this.audit = opts?.audit ?? null;
  }

  /** High-entropy single-use token bound to this Node and the given flow. */
  createPairingToken(flow = "local", nowMs?: number): { token: string; record: PairingTokenRecord } {
    const now = nowMs ?? this.now();
    const token = randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
    const record: PairingTokenRecord = {
      tokenSha256: sha256Hex(token),
      nodeId: this.nodeId,
      flow,
      createdAtMs: now,
      expiresAtMs: now + this.tokenTtlMs,
      consumed: false,
      cancelled: false,
    };
    this.tokens.set(record.tokenSha256, record);
    return { token, record: { ...record } };
  }

  /**
   * QR payload: token + endpoint + identity fingerprint. The owner key is
   * never representable here — the type carries exactly these three fields.
   */
  qrPayload(token: string, endpoint: string, fingerprint: string): QrPayload {
    if (token.length === 0) throw new Error("token required");
    if (endpoint.length === 0) throw new Error("endpoint required");
    if (!/^[0-9a-f]{64}$/i.test(fingerprint)) throw new Error("fingerprint must be 32-byte hex");
    return { token, endpoint, fingerprint: fingerprint.toLowerCase() };
  }

  /** Explicit cancellation invalidates the token without exchange. */
  cancelPairingToken(token: string): boolean {
    const record = this.findToken(token);
    if (!record || record.consumed || record.cancelled) return false;
    record.cancelled = true;
    this.audit?.({ at: new Date().toISOString(), kind: "pairing_cancelled", nodeId: this.nodeId });
    return true;
  }

  private findToken(token: string): PairingTokenRecord | null {
    let digest: Buffer;
    try {
      digest = Buffer.from(sha256Hex(token), "hex");
    } catch {
      return null;
    }
    for (const record of this.tokens.values()) {
      let expected: Buffer;
      try {
        expected = Buffer.from(record.tokenSha256, "hex");
      } catch {
        continue;
      }
      if (digest.length === expected.length && timingSafeEqual(digest, expected)) return record;
    }
    return null;
  }

  private consumeValidToken(token: string, now: number): PairingTokenRecord | null {
    const record = this.findToken(token);
    if (!record || record.consumed || record.cancelled) return null;
    if (record.nodeId !== this.nodeId) return null;
    if (now >= record.expiresAtMs) return null;
    return record;
  }

  private mintDeviceSession(devicePubkey: string, opts?: ExchangeOptions): ExchangeSuccess {
    const now = opts?.nowMs ?? this.now();
    void now;
    const publicKeySpkiPem = normalizeDeviceP256Key(devicePubkey);
    const clientClass = opts?.clientClass ?? "bundled";
    const scopes = opts?.scopes ? [...opts.scopes] : [...DEFAULT_PAIRING_SCOPES];
    if (scopes.length === 0) throw new Error("pairing requires scopes");
    const device = this.devices.create({
      name: opts?.deviceName ?? `device-${new Date().toISOString()}`,
      publicKeySpkiPem,
      clientClass,
      scopes,
    });
    const created = this.sessions.createSession(device.deviceId, scopes, clientClass);
    this.audit?.({
      at: new Date().toISOString(),
      kind: "pairing_exchanged",
      nodeId: this.nodeId,
      deviceId: device.deviceId,
    });
    return { ok: true, device, session: created.session, sessionToken: created.token };
  }

  /**
   * Exchange a single-use pairing token plus the device P-256 public key
   * for a scoped, device-bound session. The token is invalidated whether
   * the exchange succeeds or the key is malformed (single use).
   */
  exchangePairingToken(token: string, devicePubkey: string, opts?: ExchangeOptions): ExchangeResult {
    const now = opts?.nowMs ?? this.now();
    const record = this.consumeValidToken(token, now);
    if (!record) {
      this.audit?.({
        at: new Date().toISOString(),
        kind: "pairing_failed",
        nodeId: this.nodeId,
        reason: "unknown_consumed_cancelled_or_expired_token",
      });
      return { ok: false, code: "UNAUTHENTICATED", reason: "invalid_or_expired_pairing_token" };
    }
    record.consumed = true;
    try {
      return this.mintDeviceSession(devicePubkey, opts);
    } catch (err) {
      this.audit?.({
        at: new Date().toISOString(),
        kind: "pairing_failed",
        nodeId: this.nodeId,
        reason: err instanceof Error ? err.message : "device_key_rejected",
      });
      return { ok: false, code: "UNAUTHENTICATED", reason: "device_key_rejected" };
    }
  }

  /** Rate-limited variant for remotely reachable exchange endpoints. */
  exchangeWithRateLimit(
    source: string,
    token: string,
    devicePubkey: string,
    opts?: ExchangeOptions,
  ): ExchangeResult {
    const check = this.limiter.tryConsume(source);
    if (!check.ok) {
      this.audit?.({
        at: new Date().toISOString(),
        kind: "pairing_failed",
        nodeId: this.nodeId,
        source,
        reason: "rate_limited",
        retryAfterMs: check.retryAfterMs,
      });
      return { ok: false, code: "RATE_LIMITED", reason: "rate_limited", retryAfterMs: check.retryAfterMs };
    }
    return this.exchangePairingToken(token, devicePubkey, opts);
  }

  // -- owner-key bootstrap (§22.8: 5 fails / 10 min via KeyLockout) ----------

  isOwnerKeyLockedOut(nowMs?: number): boolean {
    return this.ownerLockout.isLocked(nowMs);
  }

  /**
   * Recovery bootstrap: the caller verifies the presented owner key against
   * the Stage 1 verifier and passes only the boolean here, so raw key
   * material never enters this module (or its audit events). Gated by the
   * shared `KeyLockout`; Node-Manager-issued token pairing still works
   * during lockout.
   */
  exchangeWithOwnerKey(
    ownerKeyValid: boolean,
    devicePubkey: string,
    opts?: ExchangeOptions,
    nowMs?: number,
  ): ExchangeResult {
    const now = nowMs ?? this.now();
    if (this.ownerLockout.isLocked(now)) {
      return { ok: false, code: "RATE_LIMITED", reason: "owner_key_locked_out", retryAfterMs: this.ownerLockout.remainingMs(now) };
    }
    if (!ownerKeyValid) {
      this.ownerLockout.recordFailure(now);
      this.audit?.({
        at: new Date().toISOString(),
        kind: "owner_key_failed",
        nodeId: this.nodeId,
        reason: "owner_key_mismatch",
      });
      if (this.ownerLockout.isLocked(now)) {
        this.audit?.({
          at: new Date().toISOString(),
          kind: "owner_key_locked",
          nodeId: this.nodeId,
          reason: "too_many_failed_attempts",
          retryAfterMs: this.ownerLockout.remainingMs(now),
        });
      }
      return { ok: false, code: "UNAUTHENTICATED", reason: "owner_key_mismatch" };
    }
    this.ownerLockout.recordSuccess();
    try {
      return this.mintDeviceSession(devicePubkey, opts);
    } catch {
      return { ok: false, code: "UNAUTHENTICATED", reason: "device_key_rejected" };
    }
  }

  pruneExpired(nowMs?: number): number {
    const now = nowMs ?? this.now();
    let removed = 0;
    for (const [digest, record] of this.tokens) {
      if (record.consumed || record.cancelled || now >= record.expiresAtMs) {
        this.tokens.delete(digest);
        removed += 1;
      }
    }
    return removed;
  }

  pendingCount(): number {
    return this.tokens.size;
  }
}

// ---------------------------------------------------------------------------
// Revocation fan-out (§22.10)
// ---------------------------------------------------------------------------

export interface SocketRevoker {
  /** Close every established socket of the device (within one heartbeat). */
  revokeDeviceSockets(deviceId: string): number | Promise<number>;
}

export interface RevokeEverywhereCollaborators extends RevokeCollaborators {
  sockets?: SocketRevoker;
}

export interface RevokeEverywhereResult {
  readonly device: DeviceRecord;
  readonly sessionsRevoked: number;
  readonly ticketsRevoked: number;
  readonly socketsClosed: number;
  readonly approvalsCancelled: number;
  readonly alreadyRevoked: boolean;
}

/**
 * Revoke a device and terminate everything it holds: sessions, WS tickets,
 * established sockets, plus APPROVED unconsumed approvals it signed.
 * Returns per-class counts for audit. Unknown devices return null.
 */
export async function revokeDeviceEverywhere(
  registry: DeviceRegistry,
  deviceId: string,
  collaborators?: RevokeEverywhereCollaborators,
  nowMs?: number,
  audit?: SecurityAuditSink | null,
): Promise<RevokeEverywhereResult | null> {
  const revoked = await revokeDevice(registry, deviceId, collaborators, nowMs);
  if (!revoked) return null;
  let socketsClosed = 0;
  if (collaborators?.sockets) {
    try {
      socketsClosed = await collaborators.sockets.revokeDeviceSockets(deviceId);
    } catch {
      socketsClosed = 0;
    }
  }
  audit?.({
    at: new Date().toISOString(),
    kind: "device_revoked",
    deviceId,
    counts: {
      sessions: revoked.sessionsRevoked,
      tickets: revoked.ticketsRevoked,
      sockets: socketsClosed,
      approvals: revoked.approvalsCancelled,
    },
  });
  return { ...revoked, socketsClosed };
}
