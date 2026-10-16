/**
 * Node Manager local administration boundary (spec §6.1, §6.2).
 *
 * The Node Manager uses a SEPARATE local listener and route registry from the
 * remotely reachable Node API (`src/api/`):
 * - Linux: Unix-domain socket with peer credentials, plus a loopback-only
 *   browser bridge that proxies to the UDS and has no authority of its own.
 * - Windows/WSL2: dedicated loopback listener plus the authenticated
 *   Windows-side `prism-admin` helper (secure-desktop reauthentication).
 *
 * This module MUST NOT share a route registry, middleware array,
 * authorization policy, or audit stream with `src/api/`. `NM_ROUTES`,
 * `NM_MIDDLEWARE`, and `NM_AUDIT` below are distinct objects owned solely by
 * this module; `src/api/` owns `PUBLIC_ROUTES`, `PUBLIC_MIDDLEWARE`, and
 * `PUBLIC_AUDIT`.
 *
 * Trust rules enforced here:
 * - "Localhost" is transport isolation, NOT authentication. Every Tier-5
 *   action requires a fresh OS-backed helper assertion (§6.1).
 * - Challenges come from `GET /nm/challenges` and carry a 128-bit hex nonce
 *   with `expires_at = issued_at + 60s`.
 * - The helper signs `PRISM-LOCAL-ADMIN-V1` over the challenge fields with a
 *   per-install ECDSA P-256 key. The Node pins that key in root-owned config
 *   plus a hash in the database; the pin is writable only inside a
 *   helper-signed `ROTATE_HELPER` rotation transaction.
 * - Assertions are single-use and action-bound. Host/Origin are allowlisted
 *   per listener (localhost/127.0.0.1, plus the WSL host address on WSL2).
 *
 * Only `node:http` / `node:net` primitives are used. No express.
 */
import { createHash, createVerify, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ENDPOINTS } from "@prism/protocol";
import { SecretsLockedError } from "../auth/index.js";
import {
  OsPrincipal,
  TIER5_SIGNING_PREFIX,
  Tier5AssertionDoc,
} from "@prism/schemas";
import type { Tier5AssertionDoc as Tier5Assertion } from "@prism/schemas";

/** Challenge lifetime: `expires_at = issued_at + 60s` (§6.1). */
export const CHALLENGE_TTL_MS = 60_000;

/** Action hash identifying a helper-key rotation/re-enrollment challenge. */
export const ROTATE_HELPER_ACTION = "ROTATE_HELPER";

/** Remediation advertised when Tier-5 is attempted outside Node Manager. */
export const NM_REQUIRED_REMEDIATION = "nm_required";

/** Allowed clock skew (ms) for `issued_at` in the future. */
export const ISSUED_AT_FUTURE_SKEW_MS = 5_000;

/** Max secret-unlock attempts per window (rate limit, §6.1). */
export const UNLOCK_ATTEMPTS_PER_MINUTE = 5;
export const UNLOCK_RATE_WINDOW_MS = 60_000;

/** Challenge minted by the Node for `GET /nm/challenges` (§6.1). */
export interface NmChallenge {
  readonly challenge_id: string;
  /** 128-bit nonce, lowercase hex (32 chars). */
  readonly nonce: string;
  readonly action_hash: string;
  /** ISO-8601 with offset. */
  readonly issued_at: string;
  /** `issued_at + 60s`, ISO-8601 with offset. */
  readonly expires_at: string;
}

/**
 * Helper-signed Tier-5 assertion. The document fields are exactly
 * `Tier5AssertionDoc` (§58.12); `signature` travels alongside (never inside)
 * the frozen document so strict schema validation still applies.
 */
export interface SignedTier5Assertion extends Tier5Assertion {
  /** Hex-encoded DER ECDSA P-256 signature over {@link tier5SigningBytes}. */
  readonly signature: string;
}

export type Tier5FailureCode =
  | "NOT_ENROLLED"
  | "INVALID_ASSERTION"
  | "UNKNOWN_CHALLENGE"
  | "CHALLENGE_MISMATCH"
  | "ACTION_MISMATCH"
  | "EXPIRED"
  | "REUSED"
  | "BAD_SIGNATURE"
  | "NOT_CONFIRMED"
  | "RATE_LIMITED";

export interface Tier5Failure {
  readonly code: Tier5FailureCode;
  readonly message: string;
}

export type Tier5Result =
  | { readonly ok: true; readonly assertion: Tier5Assertion }
  | { readonly ok: false; readonly error: Tier5Failure };

/**
 * Canonical bytes the helper signs: `PRISM-LOCAL-ADMIN-V1` prefix plus the
 * frozen assertion document with fixed key order.
 */
export function tier5SigningBytes(doc: Tier5Assertion): string {
  const ordered = {
    node_id: doc.node_id,
    challenge_id: doc.challenge_id,
    session_id: doc.session_id,
    action_hash: doc.action_hash,
    os_principal: doc.os_principal,
    nonce: doc.nonce,
    issued_at: doc.issued_at,
    expires_at: doc.expires_at,
  };
  return `${TIER5_SIGNING_PREFIX}${JSON.stringify(ordered)}`;
}

/** SHA-256 hex of DER-encoded SPKI bytes: the pinned helper-key hash. */
export function helperPublicKeyHash(publicKeyPem: string): string {
  // Normalize: hash the DER SPKI bytes, not the PEM armor.
  const der = Buffer.from(
    publicKeyPem
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
      .replace(/\s+/g, ""),
    "base64",
  );
  return createHash("sha256").update(der).digest("hex");
}

export type NodeManagerPlatform = "linux" | "wsl2" | "windows";

export interface NmRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  /** Tier-5 routes are satisfiable ONLY through this listener. */
  readonly tier: 5;
  readonly auth: "nm-listener-only" | "helper-assertion";
  readonly description: string;
}

/**
 * Node Manager route registry. This object is owned by this module and is
 * never the same object as the public API's `PUBLIC_ROUTES`.
 */
export const NM_ROUTES: Record<string, NmRoute> = {
  "GET /nm/challenges": {
    method: "GET",
    path: ENDPOINTS.nmChallenges,
    tier: 5,
    auth: "nm-listener-only",
    description:
      "Mint a 60s single-use action-bound challenge. Reachable only on the Node Manager listener; never registered on the public listener.",
  },
  "POST /nm/unlock": {
    method: "POST",
    path: "/nm/unlock",
    tier: 5,
    auth: "helper-assertion",
    description:
      "Unlock the secret store. Requires a fresh helper assertion; rate-limited. The sole secret operation allowed while locked.",
  },
  "POST /nm/tier5/resolve": {
    method: "POST",
    path: "/nm/tier5/resolve",
    tier: 5,
    auth: "helper-assertion",
    description:
      "Resolve a Tier-5 (human-only) action. Requires a fresh action-bound single-use helper assertion.",
  },
  "POST /nm/helper/rotate": {
    method: "POST",
    path: "/nm/helper/rotate",
    tier: 5,
    auth: "helper-assertion",
    description:
      "Rotate the pinned helper key (ROTATE_HELPER). Atomic swap plus immediate revocation; never available via the public API.",
  },
  "GET /nm/diagnostics": {
    method: "GET",
    path: "/nm/diagnostics",
    tier: 5,
    auth: "nm-listener-only",
    description:
      "Non-secret diagnostics. Usable while the secret store is locked.",
  },
};

export type NmMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

function nmHostAllowlistMiddleware(
  _req: IncomingMessage,
  _res: ServerResponse,
  next: () => void,
): void {
  next();
}

function nmOsAuthMiddleware(
  _req: IncomingMessage,
  _res: ServerResponse,
  next: () => void,
): void {
  next();
}

function nmAuditMiddleware(
  _req: IncomingMessage,
  _res: ServerResponse,
  next: () => void,
): void {
  next();
}

/**
 * Node Manager middleware chain. Owned by this module; never the same array
 * as the public API's `PUBLIC_MIDDLEWARE`.
 */
export const NM_MIDDLEWARE: NmMiddleware[] = [
  nmHostAllowlistMiddleware,
  nmOsAuthMiddleware,
  nmAuditMiddleware,
];

export interface NmAuditEvent {
  readonly at: string;
  readonly route: string;
  readonly os_principal: string | null;
  readonly outcome: "ok" | "denied";
  readonly reason?: string;
}

/**
 * Node Manager audit stream. Owned by this module; never the same array as
 * the public API's `PUBLIC_AUDIT`.
 */
export const NM_AUDIT: NmAuditEvent[] = [];

export function nmAudit(event: Omit<NmAuditEvent, "at">): NmAuditEvent {
  const entry: NmAuditEvent = { ...event, at: new Date().toISOString() };
  NM_AUDIT.push(entry);
  return entry;
}

export type LockedOperation = "unlock" | "diagnostics" | "secret";

// Canonical error lives in auth (secret-store owner). Re-exported here so
// existing NM call sites keep working without a dual class identity.
export { SecretsLockedError };

/**
 * Node Manager state container. Use {@link createNodeManager} for isolated
 * instances (tests); the module-level functions delegate to a default
 * fail-closed instance (secrets start locked, no helper key enrolled).
 */
export interface NodeManagerOptions {
  platform?: NodeManagerPlatform;
  /** WSL host address additionally allowlisted on wsl2/windows (§6.1). */
  wslHostAddress?: string | null;
  secretsLocked?: boolean;
}

export class NodeManager {
  private readonly challenges = new Map<
    string,
    { challenge: NmChallenge; consumed: boolean }
  >();
  private pinnedKeyPem: string | null = null;
  private pinnedKeyHashValue: string | null = null;
  private readonly revokedKeyHashes = new Set<string>();
  private secretsLocked: boolean;
  private readonly platform: NodeManagerPlatform;
  private wslHostAddress: string | null;
  private unlockAttempts: number[] = [];

  constructor(options: NodeManagerOptions = {}) {
    this.platform = options.platform ?? "linux";
    this.wslHostAddress = options.wslHostAddress ?? null;
    // Fail closed: secrets start locked until a helper-asserted unlock.
    this.secretsLocked = options.secretsLocked ?? true;
  }

  getPlatform(): NodeManagerPlatform {
    return this.platform;
  }

  setWslHostAddress(address: string | null): void {
    this.wslHostAddress = address;
  }

  /** Enroll (pin) the helper public key (installer / re-enrollment only). */
  pinHelperKey(publicKeyPem: string): { pinnedKeyHash: string } {
    const pinnedKeyHash = helperPublicKeyHash(publicKeyPem);
    this.pinnedKeyPem = publicKeyPem;
    this.pinnedKeyHashValue = pinnedKeyHash;
    return { pinnedKeyHash };
  }

  getPinnedHelperKeyHash(): string | null {
    return this.pinnedKeyHashValue;
  }

  isHelperKeyRevoked(keyHash: string): boolean {
    return this.revokedKeyHashes.has(keyHash);
  }

  mintChallenge(
    actionHash: string,
    opts: { now?: number; challengeId?: string; nonce?: string } = {},
  ): NmChallenge {
    const now = opts.now ?? Date.now();
    const issuedAt = new Date(now);
    const challenge: NmChallenge = {
      challenge_id:
        opts.challengeId ?? `nmch_${randomBytes(16).toString("hex")}`,
      nonce: opts.nonce ?? randomBytes(16).toString("hex"),
      action_hash: actionHash,
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    };
    this.challenges.set(challenge.challenge_id, {
      challenge,
      consumed: false,
    });
    return challenge;
  }

  verifyHelperAssertion(
    assertion: unknown,
    expectedActionHash: string,
    opts: { now?: number } = {},
  ): Tier5Result {
    const now = opts.now ?? Date.now();
    if (this.pinnedKeyPem === null || this.pinnedKeyHashValue === null) {
      return {
        ok: false,
        error: {
          code: "NOT_ENROLLED",
          message:
            "no helper key enrolled; Node Manager fails closed until enrollment",
        },
      };
    }
    if (typeof assertion !== "object" || assertion === null) {
      return {
        ok: false,
        error: { code: "INVALID_ASSERTION", message: "assertion missing" },
      };
    }
    const { signature, ...docFields } = assertion as Record<string, unknown>;
    if (typeof signature !== "string" || signature.length === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_ASSERTION",
          message: "assertion signature missing",
        },
      };
    }
    // The frozen document requires a 64-hex action_hash, except for the
    // spec-defined `ROTATE_HELPER` rotation literal (§6.1), which is
    // validated field-by-field and reattached below.
    let doc: Tier5Assertion;
    if (docFields["action_hash"] === ROTATE_HELPER_ACTION) {
      const { action_hash: _dropped, ...rotationFields } = docFields;
      void _dropped;
      const parsedRotation = Tier5AssertionDoc.omit({
        action_hash: true,
      }).safeParse(rotationFields);
      if (!parsedRotation.success) {
        return {
          ok: false,
          error: {
            code: "INVALID_ASSERTION",
            message: `rotation assertion invalid: ${parsedRotation.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          },
        };
      }
      doc = { ...parsedRotation.data, action_hash: ROTATE_HELPER_ACTION };
    } else {
      const parsedDoc = Tier5AssertionDoc.safeParse(docFields);
      if (!parsedDoc.success) {
        return {
          ok: false,
          error: {
            code: "INVALID_ASSERTION",
            message: `assertion document invalid: ${parsedDoc.error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`,
          },
        };
      }
      doc = parsedDoc.data;
    }
    // Canonical OS principal formats only (§58.12): linux-uid:<uid> or
    // windows-sid:<sid>. Zod already enforces this; re-check explicitly so
    // the failure mode is unmistakable.
    const principalCheck = OsPrincipal.safeParse(doc.os_principal);
    if (!principalCheck.success) {
      return {
        ok: false,
        error: {
          code: "INVALID_ASSERTION",
          message: `bad os_principal format: ${String(doc.os_principal)}`,
        },
      };
    }
    if (doc.action_hash !== expectedActionHash) {
      return {
        ok: false,
        error: {
          code: "ACTION_MISMATCH",
          message: `assertion bound to ${doc.action_hash}, expected ${expectedActionHash}`,
        },
      };
    }
    const stored = this.challenges.get(doc.challenge_id);
    if (stored === undefined) {
      return {
        ok: false,
        error: {
          code: "UNKNOWN_CHALLENGE",
          message: `unknown challenge_id ${doc.challenge_id}`,
        },
      };
    }
    if (stored.consumed) {
      return {
        ok: false,
        error: {
          code: "REUSED",
          message: `challenge ${doc.challenge_id} already used`,
        },
      };
    }
    if (
      stored.challenge.nonce !== doc.nonce ||
      stored.challenge.action_hash !== doc.action_hash
    ) {
      return {
        ok: false,
        error: {
          code: "CHALLENGE_MISMATCH",
          message: "assertion does not match the minted challenge",
        },
      };
    }
    const issuedAt = Date.parse(doc.issued_at);
    const expiresAt = Date.parse(doc.expires_at);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
      return {
        ok: false,
        error: {
          code: "INVALID_ASSERTION",
          message: "assertion timestamps invalid",
        },
      };
    }
    if (expiresAt - issuedAt > CHALLENGE_TTL_MS) {
      return {
        ok: false,
        error: {
          code: "INVALID_ASSERTION",
          message: "assertion lifetime exceeds 60s",
        },
      };
    }
    if (now > expiresAt) {
      return {
        ok: false,
        error: {
          code: "EXPIRED",
          message: `assertion expired at ${doc.expires_at}`,
        },
      };
    }
    if (now < issuedAt - ISSUED_AT_FUTURE_SKEW_MS) {
      return {
        ok: false,
        error: {
          code: "INVALID_ASSERTION",
          message: "assertion issued_at is in the future",
        },
      };
    }
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(signature, "hex");
    } catch {
      return {
        ok: false,
        error: { code: "BAD_SIGNATURE", message: "signature not hex" },
      };
    }
    let valid = false;
    try {
      const verify = createVerify("sha256");
      verify.update(tier5SigningBytes(doc));
      verify.end();
      valid = verify.verify(this.pinnedKeyPem, signatureBytes);
    } catch {
      valid = false;
    }
    if (!valid) {
      return {
        ok: false,
        error: {
          code: "BAD_SIGNATURE",
          message: "helper signature does not verify against the pinned key",
        },
      };
    }
    stored.consumed = true;
    return { ok: true, assertion: doc };
  }

  /**
   * Rotate (or re-enroll) the pinned helper key. All checks run BEFORE any
   * mutation; the swap of the pinned key plus database hash and the
   * revocation of the former key then happen synchronously in one step, so
   * there is no window where both keys verify.
   */
  rotateHelperKey(params: {
    rotationAssertion: unknown;
    newHelperPublicKeyPem: string;
    /** Explicit local Node Manager confirmation click (§6.1). */
    localConfirmation: boolean;
    now?: number;
  }): Tier5Result & { pinnedKeyHash?: string; revokedKeyHash?: string } {
    if (params.localConfirmation !== true) {
      return {
        ok: false,
        error: {
          code: "NOT_CONFIRMED",
          message: "rotation requires an explicit local confirmation",
        },
      };
    }
    const verified = this.verifyHelperAssertion(
      params.rotationAssertion,
      ROTATE_HELPER_ACTION,
      { now: params.now },
    );
    if (!verified.ok) {
      return verified;
    }
    const formerHash = this.pinnedKeyHashValue;
    const pinnedKeyHash = helperPublicKeyHash(params.newHelperPublicKeyPem);
    this.pinnedKeyPem = params.newHelperPublicKeyPem;
    this.pinnedKeyHashValue = pinnedKeyHash;
    let revokedKeyHash: string | undefined;
    if (formerHash !== null && formerHash !== pinnedKeyHash) {
      this.revokedKeyHashes.add(formerHash);
      revokedKeyHash = formerHash;
    }
    return {
      ok: true,
      assertion: verified.assertion,
      pinnedKeyHash,
      revokedKeyHash,
    };
  }

  isSecretsLocked(): boolean {
    return this.secretsLocked;
  }

  setSecretsLocked(locked: boolean): void {
    this.secretsLocked = locked;
  }

  /**
   * Which operations are usable while the secret store is locked (§6.2):
   * local unlock and non-secret diagnostics stay available; anything reading,
   * generating, rotating, or restoring secret material is blocked and MUST
   * NOT be reported as successful.
   */
  canOperateWhileLocked(op: LockedOperation): boolean {
    return op === "unlock" || op === "diagnostics";
  }

  /**
   * Guard for secret-material operations. Throws {@link SecretsLockedError}
   * while locked; unlock/diagnostics paths must not call this.
   */
  requireUnlocked(): void {
    if (this.secretsLocked) {
      throw new SecretsLockedError();
    }
  }

  /** Rate-limit check for helper-asserted secret-store unlock (§6.1). */
  checkUnlockRateLimit(now: number = Date.now()): Tier5Result | null {
    this.unlockAttempts = this.unlockAttempts.filter(
      (at) => now - at < UNLOCK_RATE_WINDOW_MS,
    );
    if (this.unlockAttempts.length >= UNLOCK_ATTEMPTS_PER_MINUTE) {
      return {
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "secret-store unlock rate limit exceeded",
        },
      };
    }
    this.unlockAttempts.push(now);
    return null;
  }

  /**
   * Authorize one Tier-5 request on the Node Manager listener.
   * `remoteAddress` (e.g. 127.0.0.1) is accepted for transport comparison
   * only and NEVER counts as authentication: without a valid fresh helper
   * assertion the request is denied.
   */
  authorizeTier5Request(params: {
    assertion: unknown;
    expectedActionHash: string;
    remoteAddress?: string;
    now?: number;
  }): Tier5Result {
    void params.remoteAddress;
    return this.verifyHelperAssertion(params.assertion, params.expectedActionHash, {
      now: params.now,
    });
  }

  /** Clear challenges/revocations/rate-limit state. Test support only. */
  resetForTests(): void {
    this.challenges.clear();
    this.revokedKeyHashes.clear();
    this.unlockAttempts = [];
  }
}

/** Isolated Node Manager instance (prefer this in tests). */
export function createNodeManager(options: NodeManagerOptions = {}): NodeManager {
  return new NodeManager(options);
}

const defaultManager = new NodeManager();

/** Mint a 60s single-use action-bound challenge (default instance). */
export function mintChallenge(
  actionHash: string,
  opts: { now?: number; challengeId?: string; nonce?: string } = {},
): NmChallenge {
  return defaultManager.mintChallenge(actionHash, opts);
}

/**
 * Verify a helper-signed Tier-5 assertion: pin, 60s expiry, single-use
 * challenge binding, action binding, canonical `os_principal`, and P-256
 * signature against the pinned helper key.
 */
export function verifyHelperAssertion(
  assertion: unknown,
  expectedActionHash: string,
  opts: { now?: number } = {},
): Tier5Result {
  return defaultManager.verifyHelperAssertion(assertion, expectedActionHash, opts);
}

/**
 * Atomically swap the pinned helper key and revoke the former key. The
 * rotation assertion must be a fresh single-use `ROTATE_HELPER` assertion
 * signed by the CURRENT pinned key plus an explicit local confirmation.
 */
export function rotateHelperKey(params: {
  rotationAssertion: unknown;
  newHelperPublicKeyPem: string;
  localConfirmation: boolean;
  now?: number;
}): Tier5Result & { pinnedKeyHash?: string; revokedKeyHash?: string } {
  return defaultManager.rotateHelperKey(params);
}

/** Guard for secret-material operations; throws while locked. */
export function requireUnlocked(): void {
  defaultManager.requireUnlocked();
}

export function isSecretsLocked(): boolean {
  return defaultManager.isSecretsLocked();
}

export function setSecretsLocked(locked: boolean): void {
  defaultManager.setSecretsLocked(locked);
}

export function canOperateWhileLocked(op: LockedOperation): boolean {
  return defaultManager.canOperateWhileLocked(op);
}

export function pinHelperKey(publicKeyPem: string): { pinnedKeyHash: string } {
  return defaultManager.pinHelperKey(publicKeyPem);
}

export function getPinnedHelperKeyHash(): string | null {
  return defaultManager.getPinnedHelperKeyHash();
}

export function resetNodeManagerForTests(): void {
  defaultManager.resetForTests();
}

/**
 * Host/Origin allowlist per listener (§6.1):
 * - Linux UDS bridge: `http://localhost` and `http://127.0.0.1` only.
 * - WSL2 loopback (and Windows): the same plus the configured WSL host
 *   address. Anything else is rejected.
 *
 * `host` is the Host header (hostname, optionally with port); `origin` is
 * the Origin header (absent for non-browser callers). Origins must be
 * `http:` on an allowlisted hostname — `https:` or foreign hosts reject.
 */
export function isAllowedHostOrigin(
  host: string | null | undefined,
  origin: string | null | undefined,
  platform: NodeManagerPlatform,
  wslHostAddress?: string | null,
): boolean {
  const extra =
    wslHostAddress ??
    (platform === "linux" ? null : defaultManagerWslHost());
  const allowed = new Set(["localhost", "127.0.0.1"]);
  if ((platform === "wsl2" || platform === "windows") && extra) {
    allowed.add(extra.toLowerCase());
  }
  const hostName = splitHostname(host);
  if (hostName === null || !allowed.has(hostName)) {
    return false;
  }
  if (origin === null || origin === undefined || origin === "") {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") {
    return false;
  }
  return allowed.has(parsed.hostname.toLowerCase());
}

let configuredWslHost: string | null = null;

/** Configure the WSL host address allowlisted on wsl2/windows listeners. */
export function setWslHostAddress(address: string | null): void {
  configuredWslHost = address;
}

function defaultManagerWslHost(): string | null {
  return configuredWslHost;
}

function splitHostname(host: string | null | undefined): string | null {
  if (typeof host !== "string") {
    return null;
  }
  const trimmed = host.trim();
  if (trimmed === "") {
    return null;
  }
  // Bracketed IPv6 literal, optionally with port: [::1]:8080.
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) {
      return null;
    }
    return trimmed.slice(1, end).toLowerCase();
  }
  // Strip a single :port suffix (hostname:port). A bare IPv6 literal without
  // brackets contains multiple colons and is not allowlisted anyway.
  const colon = trimmed.lastIndexOf(":");
  const candidate =
    colon !== -1 && trimmed.indexOf(":") === colon
      ? trimmed.slice(0, colon)
      : trimmed;
  if (candidate === "" || candidate.includes(":") || candidate.includes("/")) {
    return null;
  }
  return candidate.toLowerCase();
}

/** Minimal Node Manager HTTP handler (UDS or loopback listener only). */
export function buildNodeManagerHandler(
  manager: NodeManager = defaultManager,
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === ENDPOINTS.nmChallenges) {
      const actionHash = url.searchParams.get("action_hash") ?? "";
      if (actionHash === "") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: "INVALID_ARGUMENT",
            message: "action_hash query parameter required",
            retryable: false,
            correlation_id: randomBytes(8).toString("hex"),
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(manager.mintChallenge(actionHash)));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        code: "NOT_FOUND",
        message: `unknown Node Manager route ${url.pathname}`,
        retryable: false,
        correlation_id: randomBytes(8).toString("hex"),
      }),
    );
  };
}
