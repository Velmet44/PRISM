/**
 * Stage 1 auth module: owner key, peppered verifier, lockout, sessions,
 * device-proof verification skeleton, and the DEK/KEK SecretStore.
 *
 * Spec: §22.1 + §6.3 (owner key `prism_ok_<id>_<secret>_<checksum>`, 256-bit
 * secret, shown once, HMAC verifier with DEK-wrapped pepper, constant-time),
 * §22.3 (regeneration revokes prior), §22.8 (rate limit, 5 fails/10m
 * lockout, constant-time), §22.10 (automation tokens live in devices/),
 * §21.1 (DEK/KEK envelope, rotation atomic, LOCKED → SECRETS_LOCKED),
 * §58.2 secretStore machine via `canTransition` from `@prism/schemas`,
 * §58.12 proof checks (revocation first, binding, 60s freshness, jti replay
 * via `proof_jti` table interface), sessions §58.12 (15m TTL, 24h max,
 * NodeId+DeviceId bound).
 *
 * Crypto: `node:crypto` only. Argon2id uses `hash-wasm` when available at
 * runtime; otherwise an injectable `PassphraseKdf` is required (tests inject
 * `fastTestKdf`). There is never a plaintext fallback.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { canTransition, ProofDoc, PROOF_SIGNING_PREFIX, toCanonicalJson } from "@prism/schemas";

// ---------------------------------------------------------------------------
// Error codes (mirror §58.5; values from @prism/schemas ERROR_CODES)
// ---------------------------------------------------------------------------

export const SECRETS_LOCKED = "SECRETS_LOCKED" as const;
export const UNAUTHENTICATED = "UNAUTHENTICATED" as const;
export const RATE_LIMITED = "RATE_LIMITED" as const;

export class SecretsLockedError extends Error {
  readonly code = SECRETS_LOCKED;
  readonly retryable = false as const;
  readonly remediation = "unlock via Node Manager" as const;
  constructor(message = "secret store is locked") {
    super(message);
    this.name = "SecretsLockedError";
  }
}

// ---------------------------------------------------------------------------
// Owner key (§22.1, §6.3)
// ---------------------------------------------------------------------------

export const OWNER_KEY_PREFIX = "prism_ok" as const;
export const OWNER_KEY_ID_BYTES = 8; // 16 hex chars, non-secret identifier
export const OWNER_SECRET_BYTES = 32; // 256 bits minimum (§22.3)
export const OWNER_CHECKSUM_HEX_LEN = 8; // 4 bytes, scanner hint only

export interface GeneratedOwnerKey {
  keyId: string;
  /** Standard base64 (44 chars for 32 bytes); no `_` so `_`-split parsing is safe. */
  secretB64: string;
  /** Full `prism_ok_<keyId>_<secretB64>_<checksum>` string, shown exactly once. */
  key: string;
  checksum: string;
}

export interface ParsedOwnerKey {
  keyId: string;
  secretB64: string;
  checksum: string;
}

function computeOwnerChecksum(keyId: string, secretB64: string): string {
  return createHash("sha256")
    .update(`${OWNER_KEY_PREFIX}_${keyId}_${secretB64}`, "utf8")
    .digest("hex")
    .slice(0, OWNER_CHECKSUM_HEX_LEN);
}

/**
 * Generate a high-entropy owner API key for bootstrap/recovery.
 * The full `key` is displayed exactly once; only a keyed verifier is stored.
 */
export function generateOwnerKey(): GeneratedOwnerKey {
  const keyId = randomBytes(OWNER_KEY_ID_BYTES).toString("hex");
  const secretB64 = randomBytes(OWNER_SECRET_BYTES).toString("base64");
  const checksum = computeOwnerChecksum(keyId, secretB64);
  const key = `${OWNER_KEY_PREFIX}_${keyId}_${secretB64}_${checksum}`;
  return { keyId, secretB64, key, checksum };
}

/** Parse and validate an owner key string (format + checksum, no secrets leaked). */
export function parseOwnerKey(key: string): ParsedOwnerKey {
  const parts = key.split("_");
  // ["prism","ok", keyId, secretB64, checksum]
  if (parts.length !== 5 || parts[0] !== "prism" || parts[1] !== "ok") {
    throw new Error("invalid owner key format");
  }
  const keyId = parts[2] as string;
  const secretB64 = parts[3] as string;
  const checksum = (parts[4] as string).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(keyId)) throw new Error("invalid owner key id");
  if (!/^[A-Za-z0-9+/=]+$/.test(secretB64))
    throw new Error("invalid owner key secret encoding");
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretB64, "base64");
  } catch {
    throw new Error("invalid owner key secret encoding");
  }
  if (secretBytes.length !== OWNER_SECRET_BYTES) {
    throw new Error("invalid owner key secret length");
  }
  if (!/^[0-9a-f]{8}$/.test(checksum))
    throw new Error("invalid owner key checksum format");
  const expected = computeOwnerChecksum(keyId, secretB64);
  const a = Buffer.from(checksum, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid owner key checksum");
  }
  return { keyId, secretB64, checksum };
}

// ---------------------------------------------------------------------------
// Peppered verifier (§6.3): HMAC-SHA-256 under a DEK-wrapped pepper.
// ---------------------------------------------------------------------------

export interface OwnerVerifierRecord {
  keyId: string;
  pepperVer: number;
  verifierHex: string;
  algorithm: "hmac-sha256";
}

function hmacSecret(
  pepper: Uint8Array,
  keyId: string,
  secretB64: string,
): Buffer {
  return createHmac("sha256", pepper)
    .update(`${keyId}:${secretB64}`, "utf8")
    .digest();
}

/** Create the stored verifier. The raw secret is never persisted. */
export function createOwnerVerifier(
  secretB64: string,
  pepper: Uint8Array,
  keyId: string,
  pepperVer = 1,
): OwnerVerifierRecord {
  if (pepper.length < 16) throw new Error("pepper must be >= 128 bits");
  if (keyId.length === 0) throw new Error("keyId required");
  const verifierHex = hmacSecret(pepper, keyId, secretB64).toString("hex");
  return { keyId, pepperVer, verifierHex, algorithm: "hmac-sha256" };
}

/**
 * Constant-time verification of a presented secret against a stored verifier.
 * Returns false (never throws) on mismatch; throws only on misuse.
 */
export function verifyOwnerKey(
  secretB64: string,
  pepper: Uint8Array,
  expectedVerifierHex: string,
  keyId: string,
): boolean {
  let expected: Buffer;
  try {
    if (!/^[0-9a-f]{64}$/i.test(expectedVerifierHex)) return false;
    expected = Buffer.from(expectedVerifierHex, "hex");
  } catch {
    return false;
  }
  let computed: Buffer;
  try {
    computed = hmacSecret(pepper, keyId, secretB64);
  } catch {
    return false;
  }
  if (computed.length !== expected.length) {
    // Lengths are fixed (32) in practice; dummy-compare to avoid early exit.
    const dummy = Buffer.alloc(Math.max(computed.length, 32));
    const other = Buffer.alloc(Math.max(expected.length, 32));
    timingSafeEqual(dummy, other);
    return false;
  }
  return timingSafeEqual(computed, expected);
}

/** Verify a full presented `prism_ok_*` string against a stored record. */
export function verifyOwnerKeyString(
  presentedKey: string,
  record: OwnerVerifierRecord,
  pepper: Uint8Array,
): boolean {
  let parsed: ParsedOwnerKey;
  try {
    parsed = parseOwnerKey(presentedKey);
  } catch {
    // Run a dummy HMAC so timing does not reveal parse failure vs mismatch.
    try {
      const dummy = hmacSecret(pepper, record.keyId, "0".repeat(44));
      timingSafeEqual(dummy, dummy);
    } catch {
      // ignore
    }
    return false;
  }
  if (parsed.keyId !== record.keyId) {
    // Dummy compare to keep timing uniform across keyId mismatch.
    try {
      const dummy = hmacSecret(pepper, record.keyId, parsed.secretB64);
      const exp = Buffer.from(record.verifierHex, "hex");
      if (dummy.length === exp.length) timingSafeEqual(dummy, exp);
    } catch {
      // ignore
    }
    return false;
  }
  return verifyOwnerKey(parsed.secretB64, pepper, record.verifierHex, parsed.keyId);
}

/**
 * Regenerate the owner key (§22.3): generates a fresh key and verifier and
 * revokes the prior verifier. Callers must additionally offer to revoke
 * every device/session established under the prior key.
 */
export function regenerateOwnerKey(
  pepper: Uint8Array,
  prior: OwnerVerifierRecord | null,
  pepperVer?: number,
): { key: GeneratedOwnerKey; verifier: OwnerVerifierRecord; revokedKeyId: string | null } {
  const key = generateOwnerKey();
  const verifier = createOwnerVerifier(
    key.secretB64,
    pepper,
    key.keyId,
    pepperVer ?? (prior?.pepperVer ?? 1),
  );
  return { key, verifier, revokedKeyId: prior?.keyId ?? null };
}

// ---------------------------------------------------------------------------
// Key lockout (§22.8): 5 failed owner-key attempts within 10 minutes.
// ---------------------------------------------------------------------------

export const LOCKOUT_MAX_FAILS = 5;
export const LOCKOUT_WINDOW_MS = 10 * 60 * 1000;
export const LOCKOUT_DURATION_MS = 10 * 60 * 1000;

export class KeyLockout {
  private failures: number[] = [];
  private lockedUntilMs: number | null = null;
  private readonly maxFails: number;
  private readonly windowMs: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;

  constructor(opts?: {
    maxFails?: number;
    windowMs?: number;
    lockoutMs?: number;
    now?: () => number;
  }) {
    this.maxFails = opts?.maxFails ?? LOCKOUT_MAX_FAILS;
    this.windowMs = opts?.windowMs ?? LOCKOUT_WINDOW_MS;
    this.lockoutMs = opts?.lockoutMs ?? LOCKOUT_DURATION_MS;
    this.now = opts?.now ?? Date.now;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  recordFailure(nowMs?: number): void {
    const now = nowMs ?? this.now();
    this.prune(now);
    this.failures.push(now);
    if (this.failures.length >= this.maxFails) {
      this.lockedUntilMs = now + this.lockoutMs;
    }
  }

  recordSuccess(): void {
    this.failures = [];
    this.lockedUntilMs = null;
  }

  isLocked(nowMs?: number): boolean {
    if (this.lockedUntilMs === null) return false;
    const now = nowMs ?? this.now();
    if (now >= this.lockedUntilMs) {
      this.lockedUntilMs = null;
      this.prune(now);
      return false;
    }
    return true;
  }

  getLockoutUntil(): number | null {
    return this.lockedUntilMs;
  }

  remainingMs(nowMs?: number): number {
    if (this.lockedUntilMs === null) return 0;
    const now = nowMs ?? this.now();
    return Math.max(0, this.lockedUntilMs - now);
  }

  failureCount(nowMs?: number): number {
    this.prune(nowMs ?? this.now());
    return this.failures.length;
  }
}

// ---------------------------------------------------------------------------
// Sessions (§58.12: 15m TTL, refresh via fresh proof, 24h max, re-pair after)
// ---------------------------------------------------------------------------

export const SESSION_TTL_MS = 15 * 60 * 1000;
export const SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type ClientClass = "bundled" | "public_static";

export interface SessionRecord {
  sessionId: string;
  nodeId: string;
  deviceId: string;
  clientClass: ClientClass;
  scopes: string[];
  issuedAtMs: number;
  expiresAtMs: number;
  maxExpiresAtMs: number;
  revoked: boolean;
  tokenSha256: string;
}

export interface CreatedSession {
  session: SessionRecord;
  /** Opaque bearer; shown once. Only sha256 is stored. */
  token: string;
}

function sha256HexString(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function newSessionId(): string {
  return randomBytes(16).toString("hex");
}

function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export class SessionManager {
  private readonly nodeId: string;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ttlMs: number;
  private readonly maxLifetimeMs: number;
  private readonly now: () => number;

  constructor(
    nodeId: string,
    opts?: { ttlMs?: number; maxLifetimeMs?: number; now?: () => number },
  ) {
    if (nodeId.length === 0) throw new Error("nodeId required");
    this.nodeId = nodeId;
    this.ttlMs = opts?.ttlMs ?? SESSION_TTL_MS;
    this.maxLifetimeMs = opts?.maxLifetimeMs ?? SESSION_MAX_LIFETIME_MS;
    this.now = opts?.now ?? Date.now;
  }

  createSession(
    deviceId: string,
    scopes: string[],
    clientClass: ClientClass = "bundled",
  ): CreatedSession {
    if (deviceId.length === 0) throw new Error("deviceId required");
    const now = this.now();
    const sessionId = newSessionId();
    const token = newSessionToken();
    const session: SessionRecord = {
      sessionId,
      nodeId: this.nodeId,
      deviceId,
      clientClass,
      scopes: [...scopes],
      issuedAtMs: now,
      expiresAtMs: now + this.ttlMs,
      maxExpiresAtMs: now + this.maxLifetimeMs,
      revoked: false,
      tokenSha256: sha256HexString(token),
    };
    this.sessions.set(sessionId, session);
    return { session: { ...session }, token };
  }

  getSession(sessionId: string): SessionRecord | null {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : null;
  }

  /** Bearer-token check: constant-time digest compare + expiry/revocation. */
  verifySessionToken(token: string, sessionId: string): SessionRecord | null {
    const s = this.sessions.get(sessionId);
    if (!s || s.revoked) return null;
    if (s.nodeId !== this.nodeId) return null;
    const now = this.now();
    if (now >= s.expiresAtMs || now >= s.maxExpiresAtMs) return null;
    const presented = sha256HexString(token);
    const a = Buffer.from(presented, "hex");
    const b = Buffer.from(s.tokenSha256, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { ...s };
  }

  /**
   * Refresh via a fresh device proof. Extends TTL but never past the
   * 24h max; after max lifetime the client must re-pair.
   */
  refreshSession(sessionId: string, freshProof: boolean): SessionRecord | null {
    if (!freshProof) return null;
    const s = this.sessions.get(sessionId);
    if (!s || s.revoked) return null;
    const now = this.now();
    if (now >= s.maxExpiresAtMs) return null;
    s.expiresAtMs = Math.min(now + this.ttlMs, s.maxExpiresAtMs);
    this.sessions.set(sessionId, s);
    return { ...s };
  }

  revokeSession(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.revoked = true;
    this.sessions.set(sessionId, s);
    return true;
  }

  revokeDeviceSessions(deviceId: string): number {
    let count = 0;
    for (const s of this.sessions.values()) {
      if (s.deviceId === deviceId && !s.revoked) {
        s.revoked = true;
        count += 1;
      }
    }
    return count;
  }

  pruneExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [id, s] of this.sessions) {
      if (now >= s.maxExpiresAtMs) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.sessions.size;
  }
}

// ---------------------------------------------------------------------------
// Device-proof verification skeleton (§58.12)
// ---------------------------------------------------------------------------

export const PROOF_FRESHNESS_SEC = 60;

export interface ProofJtiStore {
  has(jti: string): boolean | Promise<boolean>;
  insert(jti: string, expiresAtMs: number): void | Promise<void>;
  prune(nowMs: number): void | Promise<void>;
}

/** Volatile fallback. Production MUST use SQLite `proof_jti(jti PRIMARY KEY, expires_at)`. */
export class MemoryProofJtiStore implements ProofJtiStore {
  private readonly seen = new Map<string, number>();

  has(jti: string): boolean {
    const exp = this.seen.get(jti.toLowerCase());
    if (exp === undefined) return false;
    if (Date.now() >= exp) {
      this.seen.delete(jti.toLowerCase());
      return false;
    }
    return true;
  }

  insert(jti: string, expiresAtMs: number): void {
    this.seen.set(jti.toLowerCase(), expiresAtMs);
  }

  prune(nowMs: number): void {
    for (const [jti, exp] of this.seen) {
      if (nowMs >= exp) this.seen.delete(jti);
    }
  }

  size(): number {
    return this.seen.size;
  }
}

export type ProofFailureCode = typeof UNAUTHENTICATED | typeof SECRETS_LOCKED;

export interface DeviceProofInput {
  /** Parsed proof document (must satisfy ProofDoc: exactly the frozen keys). */
  proof: Record<string, unknown>;
  /** Base64url P-1363 ES256 signature from `X-PRISM-POP`. */
  signatureB64Url: string;
  /** Raw presented session bearer token (for token_sha256 binding). */
  presentedToken: string;
  /** Expected canonical request binding. */
  expectedMethod: string;
  expectedTarget: string;
  expectedBodySha256: string;
  nowSec?: number;
  secretsLocked?: boolean;
}

export interface DeviceProofDeps {
  /** MUST be consulted before signature verification. */
  isDeviceRevokedOrUnknown: (deviceId: string) => boolean | Promise<boolean>;
  getSession: (sessionId: string) => SessionRecord | null | Promise<SessionRecord | null>;
  /** Device public key for ES256 verification (SPKI PEM or raw 32-byte JWK x). */
  getDevicePublicKey?: (
    deviceId: string,
  ) => string | Uint8Array | null | Promise<string | Uint8Array | null>;
  verifySignature?: (
    publicKey: string | Uint8Array,
    signingInput: Uint8Array,
    signature: Uint8Array,
  ) => boolean | Promise<boolean>;
  jtiStore: ProofJtiStore;
}

export type ProofVerifyResult =
  | { ok: true; session: SessionRecord }
  | { ok: false; code: ProofFailureCode; reason: string };

function base64UrlDecode(input: string): Buffer | null {
  try {
    if (input.length === 0 || input.length > 4096) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(input)) return null;
    return Buffer.from(input, "base64url");
  } catch {
    return null;
  }
}

/**
 * Verify a §58.12 device proof-of-possession.
 * Order: secrets-locked → shape → revocation (first security check) →
 * binding → freshness → replay → signature. Fails closed with
 * UNAUTHENTICATED; secret-dependent work while LOCKED yields SECRETS_LOCKED.
 */
export async function verifyDeviceProof(
  input: DeviceProofInput,
  deps: DeviceProofDeps,
): Promise<ProofVerifyResult> {
  if (input.secretsLocked === true) {
    return { ok: false, code: SECRETS_LOCKED, reason: "secrets_locked" };
  }
  const parsed = ProofDoc.safeParse(input.proof);
  if (!parsed.success) {
    return { ok: false, code: UNAUTHENTICATED, reason: "malformed_proof" };
  }
  const proof = parsed.data;
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);

  // 1. Revocation before signature verification (§58.12).
  let revokedOrUnknown: boolean;
  try {
    revokedOrUnknown = await deps.isDeviceRevokedOrUnknown(proof.device_id);
  } catch {
    return { ok: false, code: UNAUTHENTICATED, reason: "revocation_check_failed" };
  }
  if (revokedOrUnknown) {
    return { ok: false, code: UNAUTHENTICATED, reason: "revoked_or_unknown_device" };
  }

  // 2. Session binding: session must exist, match node/device, be live.
  let session: SessionRecord | null;
  try {
    session = await deps.getSession(proof.session_id);
  } catch {
    return { ok: false, code: UNAUTHENTICATED, reason: "session_lookup_failed" };
  }
  if (!session || session.revoked) {
    return { ok: false, code: UNAUTHENTICATED, reason: "unknown_or_revoked_session" };
  }
  if (session.nodeId !== proof.node_id || proof.node_id.length === 0) {
    return { ok: false, code: UNAUTHENTICATED, reason: "node_binding_mismatch" };
  }
  if (session.deviceId !== proof.device_id) {
    return { ok: false, code: UNAUTHENTICATED, reason: "device_binding_mismatch" };
  }
  const nowMs = nowSec * 1000;
  if (nowMs >= session.expiresAtMs || nowMs >= session.maxExpiresAtMs) {
    return { ok: false, code: UNAUTHENTICATED, reason: "session_expired" };
  }

  // 3. Token digest binding (constant-time).
  const presentedDigest = sha256HexString(input.presentedToken);
  const a = Buffer.from(presentedDigest, "hex");
  const b = Buffer.from(proof.token_sha256, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: UNAUTHENTICATED, reason: "token_mismatch" };
  }
  const stored = Buffer.from(session.tokenSha256, "hex");
  if (stored.length !== a.length || !timingSafeEqual(stored, a)) {
    return { ok: false, code: UNAUTHENTICATED, reason: "token_mismatch" };
  }

  // 4. Request binding: exact method/target/body.
  if (proof.method !== input.expectedMethod) {
    return { ok: false, code: UNAUTHENTICATED, reason: "method_mismatch" };
  }
  if (proof.target !== input.expectedTarget) {
    return { ok: false, code: UNAUTHENTICATED, reason: "target_mismatch" };
  }
  const bodyA = Buffer.from(proof.body_sha256.toLowerCase(), "hex");
  const bodyB = Buffer.from(input.expectedBodySha256.toLowerCase(), "hex");
  if (bodyA.length !== bodyB.length || !timingSafeEqual(bodyA, bodyB)) {
    return { ok: false, code: UNAUTHENTICATED, reason: "body_mismatch" };
  }

  // 5. Freshness: reject proofs older than 60s or far-future (clock skew).
  if (!Number.isInteger(proof.iat) || proof.iat < 0) {
    return { ok: false, code: UNAUTHENTICATED, reason: "bad_iat" };
  }
  const age = nowSec - proof.iat;
  if (age > PROOF_FRESHNESS_SEC || age < -30) {
    return { ok: false, code: UNAUTHENTICATED, reason: "stale_proof" };
  }

  // 6. Replay: single-use jti, persisted (SQLite in production).
  try {
    await deps.jtiStore.prune(nowMs);
    const seen = await deps.jtiStore.has(proof.jti);
    if (seen) {
      return { ok: false, code: UNAUTHENTICATED, reason: "replay" };
    }
  } catch {
    return { ok: false, code: UNAUTHENTICATED, reason: "jti_store_failed" };
  }

  // 7. Signature over the canonical proof (ES256 P-1363, JCS per RFC 8785).
  // Canonical form is delegated to the caller-supplied verifier so this
  // module never invents a local canonicalization variant.
  const sig = base64UrlDecode(input.signatureB64Url);
  if (!sig || sig.length !== 64) {
    return { ok: false, code: UNAUTHENTICATED, reason: "bad_signature_encoding" };
  }
  if (!deps.getDevicePublicKey || !deps.verifySignature) {
    return { ok: false, code: UNAUTHENTICATED, reason: "no_verifier" };
  }
  let pubkey: string | Uint8Array | null;
  try {
    pubkey = await deps.getDevicePublicKey(proof.device_id);
  } catch {
    return { ok: false, code: UNAUTHENTICATED, reason: "pubkey_lookup_failed" };
  }
  if (!pubkey) {
    return { ok: false, code: UNAUTHENTICATED, reason: "unknown_device_key" };
  }
  // Signing input is UTF-8("PRISM-HTTP-POP-V1\n" || JCS(proof)); the JCS
  // serialization lives in @prism/schemas (`toCanonicalJson`). Rebuild here
  // so verifiers cannot drift from the frozen schema.
  let signingInput: Buffer;
  try {
    signingInput = Buffer.from(
      PROOF_SIGNING_PREFIX + toCanonicalJson(proof),
      "utf8",
    );
  } catch {
    return { ok: false, code: UNAUTHENTICATED, reason: "canonicalize_failed" };
  }
  let sigOk = false;
  try {
    sigOk = await deps.verifySignature(pubkey, signingInput, sig);
  } catch {
    return { ok: false, code: UNAUTHENTICATED, reason: "verify_failed" };
  }
  if (!sigOk) {
    return { ok: false, code: UNAUTHENTICATED, reason: "bad_signature" };
  }

  // 8. Consume jti in the same authentication step (caller must fold this
  // into the same DB transaction as session use in production).
  try {
    await deps.jtiStore.insert(proof.jti, (proof.iat + PROOF_FRESHNESS_SEC) * 1000);
  } catch {
    return { ok: false, code: UNAUTHENTICATED, reason: "jti_consume_failed" };
  }

  return { ok: true, session };
}

// ---------------------------------------------------------------------------
// SecretStore (§21.1): DEK/KEK envelope, states, rotation, LOCKED semantics.
// ---------------------------------------------------------------------------

/**
 * Production Argon2id floors (§21.1): m=256MiB, t=3, p=4, 16-byte salt,
 * 256-bit KEK. `m_bytes` is bytes in the envelope; the hash-wasm call uses
 * KiB (m_bytes / 1024 = 262144).
 */
export const PRODUCTION_KDF_PARAMS = {
  algo: "argon2id",
  m_bytes: 256 * 1024 * 1024,
  t: 3,
  p: 4,
  salt_bytes: 16,
  out_bytes: 32,
  kek_ver: 1,
} as const;

export interface KdfParams {
  mBytes: number;
  t: number;
  p: number;
  outLen: number;
}

/** Injectable KDF. Production MUST be Argon2id at the floors above. */
export type PassphraseKdf = (
  passphrase: Uint8Array | string,
  salt: Uint8Array,
  params?: KdfParams,
) => Promise<Buffer>;

/**
 * Production passphrase KDF via hash-wasm Argon2id (m=262144 KiB, t=3, p=4).
 * Throws when hash-wasm is unavailable — never falls back to plaintext.
 */
export async function productionPassphraseKdf(
  passphrase: Uint8Array | string,
  salt: Uint8Array,
  params?: KdfParams,
): Promise<Buffer> {
  const mBytes = params?.mBytes ?? PRODUCTION_KDF_PARAMS.m_bytes;
  const t = params?.t ?? PRODUCTION_KDF_PARAMS.t;
  const p = params?.p ?? PRODUCTION_KDF_PARAMS.p;
  const outLen = params?.outLen ?? PRODUCTION_KDF_PARAMS.out_bytes;
  if (mBytes < PRODUCTION_KDF_PARAMS.m_bytes) {
    throw new Error("kdf memory below production floor m=256MiB");
  }
  if (t < PRODUCTION_KDF_PARAMS.t || p < PRODUCTION_KDF_PARAMS.p) {
    throw new Error("kdf time/parallelism below production floors t=3 p=4");
  }
  // hash-wasm is an optional runtime dependency: dynamic import so a missing
  // install fails closed here instead of at module load.
  // @ts-ignore - hash-wasm types resolve after pnpm install; runtime throw otherwise
  const mod = await import("hash-wasm");
  const argon2id = (mod as { argon2id: (opts: unknown) => Promise<unknown> }).argon2id;
  if (typeof argon2id !== "function") throw new Error("hash-wasm argon2id unavailable");
  const passwordInput =
    typeof passphrase === "string" ? passphrase : Buffer.from(passphrase);
  const out = await argon2id({
    password: passwordInput,
    salt,
    parallelism: p,
    iterations: t,
    memorySize: Math.floor(mBytes / 1024), // hash-wasm expects KiB
    hashLengthBytes: outLen,
    outputType: "binary",
  });
  if (out instanceof Uint8Array) return Buffer.from(out);
  if (typeof out === "string") return Buffer.from(out, "hex");
  throw new Error("unexpected hash-wasm output");
}

/**
 * Fast KDF for unit tests ONLY (scrypt with trivial params). Production must
 * use `productionPassphraseKdf` (Argon2id floors). Never use this outside tests.
 */
export async function fastTestKdf(
  passphrase: Uint8Array | string,
  salt: Uint8Array,
): Promise<Buffer> {
  const pw = typeof passphrase === "string" ? Buffer.from(passphrase, "utf8") : Buffer.from(passphrase);
  return scryptSync(pw, salt, 32, { N: 1024, r: 8, p: 1 });
}

/** OS-backed KEK provider. Default in CI is unavailable → passphrase path. */
export interface OsKekProvider {
  readonly kind: string;
  available(): boolean | Promise<boolean>;
  wrapDek?(dek: Buffer): Promise<{ kekVer: number; wrappedHex: string }>;
  unwrapDek?(wrappedHex: string, kekVer: number): Promise<Buffer>;
}

export class UnavailableOsKekProvider implements OsKekProvider {
  readonly kind = "unavailable";
  available(): boolean {
    return false;
  }
}

/** Honest unlock mode for the support manifest (§8, §21.1). */
export type SecretUnlockMode = "os-backed" | "passphrase";

export function getSecretUnlockMode(osAvailable: boolean): SecretUnlockMode {
  return osAvailable ? "os-backed" : "passphrase";
}

export async function resolveSecretUnlockMode(
  provider: OsKekProvider,
): Promise<SecretUnlockMode> {
  return getSecretUnlockMode(await provider.available());
}

export type SecretStoreState =
  | "INITIALIZING"
  | "LOCKED"
  | "UNLOCKED"
  | "ROTATING"
  | "FAILED";

export interface SecretEnvelopeKdf {
  algo: "argon2id";
  m_bytes: number;
  t: number;
  p: number;
  salt_hex: string;
}

export interface SecretEnvelopeAead {
  algo: "aes-256-gcm" | "xchacha20-poly1305";
  nonce_hex: string;
}

/**
 * Envelope `{kek_ver,dek_ver,kdf,aead,wrapped_dek_hex}` (§21.1).
 * `kdf` is null for the unattended OS-backed path (no passphrase KDF);
 * passphrase envelopes always carry Argon2id params at/above the floors.
 */
export interface SecretEnvelope {
  kek_ver: number;
  dek_ver: number;
  kdf: SecretEnvelopeKdf | null;
  aead: SecretEnvelopeAead;
  wrapped_dek_hex: string;
}

export interface EncryptedField {
  dek_ver: number;
  nonce_hex: string;
  ct_hex: string;
}

const SECRET_STORE_MACHINE = "secretStore";

function transitionStore(from: SecretStoreState, to: SecretStoreState): void {
  if (!canTransition(SECRET_STORE_MACHINE, from, to)) {
    throw new Error(`illegal secretStore transition: ${from} -> ${to}`);
  }
}

function aesGcmEncrypt(key32: Uint8Array, plaintext: Uint8Array): { nonce: Buffer; ctAndTag: Buffer } {
  if (key32.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  const nonce = randomBytes(12); // 96-bit nonce (§21.1)
  const cipher = createCipheriv("aes-256-gcm", key32, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { nonce, ctAndTag: Buffer.concat([ct, tag]) };
}

function aesGcmDecrypt(key32: Uint8Array, nonce: Uint8Array, ctAndTag: Uint8Array): Buffer {
  if (key32.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
  if (nonce.length !== 12) throw new Error("AES-256-GCM nonce must be 12 bytes");
  if (ctAndTag.length < 16) throw new Error("ciphertext too short");
  const ct = ctAndTag.subarray(0, ctAndTag.length - 16);
  const tag = ctAndTag.subarray(ctAndTag.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key32, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

export interface SecretStoreOptions {
  osProvider?: OsKekProvider;
  kdf?: PassphraseKdf;
  dekVerStart?: number;
}

/**
 * In-memory SecretStore with envelope persistence delegated to the caller
 * (SQLite/file). Holds the unwrapped DEK only while UNLOCKED/ROTATING; the
 * KEK and unwrapped DEK are never exposed to workers (§21.1).
 */
export class SecretStore {
  private state: SecretStoreState = "INITIALIZING";
  private dek: Buffer | null = null;
  private dekVer = 0;
  private kekVer = 1;
  private pepper: Buffer | null = null;
  private pepperVer = 1;
  private encryptedPepper: EncryptedField | null = null;
  private activeEnvelope: SecretEnvelope | null = null;
  private previousEnvelope: SecretEnvelope | null = null;
  private unlockMode: SecretUnlockMode = "passphrase";
  private readonly osProvider: OsKekProvider;
  private readonly kdf: PassphraseKdf | null;

  constructor(opts?: SecretStoreOptions) {
    this.osProvider = opts?.osProvider ?? new UnavailableOsKekProvider();
    this.kdf = opts?.kdf ?? null;
    this.dekVer = opts?.dekVerStart ?? 0;
  }

  getState(): SecretStoreState {
    return this.state;
  }

  /** Honest mode for the support manifest: os-backed iff the provider is available. */
  getUnlockMode(): SecretUnlockMode {
    return this.unlockMode;
  }

  getEnvelope(): SecretEnvelope | null {
    return this.activeEnvelope ? { ...this.activeEnvelope } : null;
  }

  getDekVer(): number {
    return this.dekVer;
  }

  getPepperVer(): number {
    return this.pepperVer;
  }

  private setState(to: SecretStoreState): void {
    transitionStore(this.state, to);
    this.state = to;
  }

  private requireUnlockedForCrypto(): Buffer {
    if (this.state === "LOCKED" || this.state === "INITIALIZING" || this.state === "FAILED") {
      throw new SecretsLockedError();
    }
    if (!this.dek) throw new SecretsLockedError();
    return this.dek;
  }

  /** First-run creation via passphrase. Moves INITIALIZING → UNLOCKED. */
  async createWithPassphrase(passphrase: string): Promise<SecretEnvelope> {
    if (this.state !== "INITIALIZING") {
      throw new Error(`createWithPassphrase only from INITIALIZING (now ${this.state})`);
    }
    if (!passphrase) throw new Error("passphrase required");
    const kdf = this.kdf;
    if (!kdf) {
      // Never fall back to plaintext: fail closed and mark FAILED.
      this.state = "FAILED";
      throw new Error("no KDF available; refusing plaintext fallback");
    }
    const osAvailable = await this.osProvider.available();
    if (osAvailable) {
      throw new Error("OS KEK available; use unlockWithOs instead of passphrase");
    }
    this.unlockMode = "passphrase";
    const salt = randomBytes(PRODUCTION_KDF_PARAMS.salt_bytes);
    const kek = await kdf(passphrase, salt, {
      mBytes: PRODUCTION_KDF_PARAMS.m_bytes,
      t: PRODUCTION_KDF_PARAMS.t,
      p: PRODUCTION_KDF_PARAMS.p,
      outLen: PRODUCTION_KDF_PARAMS.out_bytes,
    });
    try {
      const dek = randomBytes(32);
      const { nonce, ctAndTag } = aesGcmEncrypt(kek, dek);
      const envelope: SecretEnvelope = {
        kek_ver: PRODUCTION_KDF_PARAMS.kek_ver,
        dek_ver: this.dekVer + 1,
        kdf: {
          algo: "argon2id",
          m_bytes: PRODUCTION_KDF_PARAMS.m_bytes,
          t: PRODUCTION_KDF_PARAMS.t,
          p: PRODUCTION_KDF_PARAMS.p,
          salt_hex: salt.toString("hex"),
        },
        aead: { algo: "aes-256-gcm", nonce_hex: nonce.toString("hex") },
        wrapped_dek_hex: ctAndTag.toString("hex"),
      };
      // Verify by unwrapping in memory before marking active (§21.1).
      const check = aesGcmDecrypt(
        kek,
        Buffer.from(envelope.aead.nonce_hex, "hex"),
        Buffer.from(envelope.wrapped_dek_hex, "hex"),
      );
      if (check.length !== dek.length || !timingSafeEqual(check, dek)) {
        throw new Error("envelope verify failed");
      }
      this.dek = dek;
      this.dekVer = envelope.dek_ver;
      this.kekVer = envelope.kek_ver;
      this.activeEnvelope = envelope;
      kek.fill(0);
      this.setState("UNLOCKED");
      this.pepper = randomBytes(32);
      this.pepperVer = 1;
      this.encryptedPepper = this.encryptRaw(this.pepper);
      return { ...envelope };
    } catch (err) {
      this.dek = null;
      this.pepper = null;
      try {
        this.setState("FAILED");
      } catch {
        this.state = "FAILED";
      }
      throw err;
    }
  }

  /** Unlock with the owner passphrase against a stored envelope. LOCKED → UNLOCKED. */
  async unlockWithPassphrase(
    passphrase: string,
    envelope: SecretEnvelope,
  ): Promise<void> {
    if (this.state !== "LOCKED" && this.state !== "INITIALIZING" && this.state !== "FAILED") {
      throw new Error(`unlockWithPassphrase illegal from ${this.state}`);
    }
    if (!envelope.kdf) throw new Error("passphrase unlock requires a kdf envelope");
    if (envelope.kdf.m_bytes < PRODUCTION_KDF_PARAMS.m_bytes) {
      throw new Error("envelope KDF below production floor");
    }
    const kdf = this.kdf;
    if (!kdf) throw new SecretsLockedError("no KDF available; refusing plaintext fallback");
    const from = this.state;
    const kek = await kdf(passphrase, Buffer.from(envelope.kdf.salt_hex, "hex"), {
      mBytes: envelope.kdf.m_bytes,
      t: envelope.kdf.t,
      p: envelope.kdf.p,
      outLen: 32,
    });
    try {
      const dek = aesGcmDecrypt(
        kek,
        Buffer.from(envelope.aead.nonce_hex, "hex"),
        Buffer.from(envelope.wrapped_dek_hex, "hex"),
      );
      if (from === "INITIALIZING") transitionStore("INITIALIZING", "UNLOCKED");
      else if (from === "LOCKED") transitionStore("LOCKED", "UNLOCKED");
      else transitionStore("FAILED", "INITIALIZING");
      if (from === "FAILED") {
        this.setState("INITIALIZING");
        this.setState("UNLOCKED");
      } else {
        this.setState("UNLOCKED");
      }
      this.dek = dek;
      this.dekVer = envelope.dek_ver;
      this.kekVer = envelope.kek_ver;
      this.activeEnvelope = { ...envelope };
      this.unlockMode = "passphrase";
      // Pepper is re-hydrated lazily via restorePepper(); without it the
      // store stays UNLOCKED but owner verification waits for pepper restore.
      kek.fill(0);
    } catch (err) {
      kek.fill(0);
      throw err;
    }
  }

  /** Mark the store LOCKED after boot when no unattended KEK exists. */
  markLockedFromInitializing(): void {
    this.dek = null;
    this.pepper = null;
    this.setState("LOCKED");
    this.unlockMode = "passphrase";
  }

  /** Transition UNLOCKED → LOCKED, zeroing in-memory key material. */
  lock(): void {
    if (this.state !== "UNLOCKED") {
      throw new Error(`lock() only from UNLOCKED (now ${this.state})`);
    }
    this.setState("LOCKED");
    if (this.dek) {
      this.dek.fill(0);
      this.dek = null;
    }
    if (this.pepper) {
      this.pepper.fill(0);
      this.pepper = null;
    }
  }

  /** Restore a persisted envelope without unlocking (boot path). */
  loadEnvelopeLocked(envelope: SecretEnvelope): void {
    if (this.state !== "INITIALIZING") throw new Error("loadEnvelopeLocked only from INITIALIZING");
    this.activeEnvelope = { ...envelope };
    this.dekVer = envelope.dek_ver;
    this.kekVer = envelope.kek_ver;
    this.unlockMode = envelope.kdf ? "passphrase" : "os-backed";
    this.setState("LOCKED");
  }

  /** Restore the DEK-wrapped pepper blob after unlock (pepper never stored raw). */
  restorePepper(blob: EncryptedField, pepperVer: number): void {
    const dek = this.requireUnlockedForCrypto();
    if (blob.dek_ver !== this.dekVer) {
      throw new Error("pepper blob dek_ver mismatch; rotate instead");
    }
    const raw = aesGcmDecrypt(
      dek,
      Buffer.from(blob.nonce_hex, "hex"),
      Buffer.from(blob.ct_hex, "hex"),
    );
    if (this.pepper) this.pepper.fill(0);
    this.pepper = raw;
    this.pepperVer = pepperVer;
    this.encryptedPepper = { ...blob };
  }

  /** Current pepper for owner/automation verifiers; throws SECRETS_LOCKED when locked. */
  getPepper(): { pepper: Buffer; ver: number } {
    const dek = this.requireUnlockedForCrypto();
    void dek;
    if (!this.pepper) throw new SecretsLockedError("pepper not available while locked");
    return { pepper: Buffer.from(this.pepper), ver: this.pepperVer };
  }

  exportPepperBlob(): EncryptedField | null {
    return this.encryptedPepper ? { ...this.encryptedPepper } : null;
  }

  private encryptRaw(plaintext: Uint8Array): EncryptedField {
    const dek = this.requireUnlockedForCrypto();
    if (this.state === "ROTATING") {
      throw new Error("writes blocked during ROTATING; reads served from old envelope");
    }
    const { nonce, ctAndTag } = aesGcmEncrypt(dek, Buffer.from(plaintext));
    return {
      dek_ver: this.dekVer,
      nonce_hex: nonce.toString("hex"),
      ct_hex: ctAndTag.toString("hex"),
    };
  }

  /** Encrypt a secret field under the active DEK (blocked while ROTATING). */
  encryptField(plaintext: Uint8Array | string): EncryptedField {
    const bytes = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
    const out = this.encryptRaw(bytes);
    bytes.fill(0);
    return out;
  }

  /** Decrypt; while ROTATING, reads are served from the old envelope only. */
  decryptField(blob: EncryptedField): Buffer {
    // During ROTATING this.dek is still the old DEK until commit.
    const dek = this.requireUnlockedForCrypto();
    return aesGcmDecrypt(
      dek,
      Buffer.from(blob.nonce_hex, "hex"),
      Buffer.from(blob.ct_hex, "hex"),
    );
  }

  /**
   * Rotate the DEK (§21.1): UNLOCKED → ROTATING → UNLOCKED. Writes are
   * blocked while ROTATING; reads use the old envelope. The new envelope is
   * verified by unwrapping in memory before it becomes active; on crash the
   * caller recovers to the last verified envelope via `recoverToVerified()`.
   */
  async rotateDek(passphrase?: string): Promise<{ active: SecretEnvelope; previous: SecretEnvelope }> {
    if (this.state !== "UNLOCKED") throw new Error(`rotateDek only from UNLOCKED (now ${this.state})`);
    this.setState("ROTATING");
    const oldDek = this.dek ? Buffer.from(this.dek) : null;
    const oldEnvelope = this.activeEnvelope ? { ...this.activeEnvelope } : null;
    try {
      const newDek = randomBytes(32);
      let newEnvelope: SecretEnvelope;
      if (this.unlockMode === "passphrase") {
        if (!this.activeEnvelope?.kdf) throw new Error("missing kdf envelope for rotation");
        if (passphrase === undefined || !this.kdf) {
          throw new Error("passphrase + KDF required to rewrap DEK");
        }
        const kdfDesc = this.activeEnvelope.kdf;
        const kek = await (this.kdf as PassphraseKdf)(passphrase, Buffer.from(kdfDesc.salt_hex, "hex"), {
          mBytes: kdfDesc.m_bytes,
          t: kdfDesc.t,
          p: kdfDesc.p,
          outLen: 32,
        });
        try {
          const { nonce, ctAndTag } = aesGcmEncrypt(kek, newDek);
          newEnvelope = {
            kek_ver: this.kekVer,
            dek_ver: this.dekVer + 1,
            kdf: { ...kdfDesc },
            aead: { algo: "aes-256-gcm", nonce_hex: nonce.toString("hex") },
            wrapped_dek_hex: ctAndTag.toString("hex"),
          };
          const check = aesGcmDecrypt(kek, nonce, ctAndTag);
          if (!timingSafeEqual(check, newDek)) throw new Error("rotation verify failed");
        } finally {
          kek.fill(0);
        }
      } else {
        if (!this.osProvider.wrapDek) throw new Error("OS provider cannot wrap");
        const wrapped = await this.osProvider.wrapDek(newDek);
        newEnvelope = {
          kek_ver: wrapped.kekVer,
          dek_ver: this.dekVer + 1,
          kdf: null,
          aead: { algo: "aes-256-gcm", nonce_hex: randomBytes(12).toString("hex") },
          wrapped_dek_hex: wrapped.wrappedHex,
        };
      }
      // Atomically mark active only after in-memory verify.
      this.previousEnvelope = oldEnvelope;
      this.activeEnvelope = newEnvelope;
      if (this.dek) this.dek.fill(0);
      this.dek = newDek;
      this.dekVer = newEnvelope.dek_ver;
      // Re-wrap the pepper under the new DEK so old key material can be destroyed.
      if (this.pepper) {
        const fresh = Buffer.from(this.pepper);
        const rewrapped = (() => {
          const { nonce, ctAndTag } = aesGcmEncrypt(this.dek as Buffer, fresh);
          return {
            dek_ver: this.dekVer,
            nonce_hex: nonce.toString("hex"),
            ct_hex: ctAndTag.toString("hex"),
          };
        })();
        fresh.fill(0);
        this.encryptedPepper = rewrapped;
      }
      if (oldDek) oldDek.fill(0);
      this.setState("UNLOCKED");
      if (!this.activeEnvelope || !this.previousEnvelope) throw new Error("rotation state missing");
      return { active: { ...this.activeEnvelope }, previous: { ...this.previousEnvelope } };
    } catch (err) {
      // Recover to the last verified envelope, never a mix.
      if (oldEnvelope) this.activeEnvelope = oldEnvelope;
      if (this.dek) this.dek.fill(0);
      this.dek = oldDek;
      try {
        this.setState("UNLOCKED");
      } catch {
        this.state = "FAILED";
      }
      throw err;
    }
  }

  /**
   * Crash recovery: return the last verified envelope (the active one),
   * discarding any unverified pending envelope. Never returns a mix.
   */
  recoverToVerified(): SecretEnvelope | null {
    return this.activeEnvelope ? { ...this.activeEnvelope } : null;
  }

  /** Guard for secret-dependent routes: throws SecretsLockedError while locked. */
  assertUnlocked(): void {
    this.requireUnlockedForCrypto();
  }
}
