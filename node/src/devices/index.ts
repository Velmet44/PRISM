/**
 * Paired devices + automation tokens (§22.10).
 *
 * - Each paired device: DeviceId, name, public key, client class,
 *   created-at, last-seen, scopes (§58.12 vocabulary), status.
 * - Revocation immediately terminates the device's sessions, WebSocket
 *   tickets, and established sockets (within one heartbeat) and cancels any
 *   APPROVED, unconsumed approvals signed by that device. `revokeDevice()`
 *   returns per-class counts so callers can audit and enforce.
 * - Automation tokens: CLI/non-browser clients, created via Node Manager or
 *   Tier-4 approval, explicit scope list + mandatory expiry, shown once,
 *   stored only as a keyed verifier, recognizable prefix. They can never
 *   satisfy any approval (`canNeverSatisfyApproval() === true`).
 *
 * Crypto: `node:crypto` only (randomBytes, HMAC-SHA-256 verifier,
 * timingSafeEqual). No reversible storage of token secrets.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { ClientClass } from "../auth/index.js";

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export type DeviceStatus = "active" | "revoked";

export interface DeviceRecord {
  deviceId: string;
  name: string;
  /** Device public key: SPKI PEM (ECDSA P-256) as registered at pairing. */
  publicKeySpkiPem: string;
  clientClass: ClientClass;
  createdAtMs: number;
  lastSeenAtMs: number | null;
  scopes: string[];
  status: DeviceStatus;
  revokedAtMs: number | null;
}

export interface CreateDeviceInput {
  deviceId?: string;
  name: string;
  publicKeySpkiPem: string;
  clientClass?: ClientClass;
  scopes: string[];
  nowMs?: number;
}

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  create(input: CreateDeviceInput): DeviceRecord {
    if (input.name.length === 0) throw new Error("device name required");
    if (input.publicKeySpkiPem.length === 0) throw new Error("device public key required");
    if (input.scopes.length === 0) throw new Error("device scopes required");
    const deviceId = input.deviceId ?? randomBytes(16).toString("hex");
    if (deviceId.length === 0) throw new Error("deviceId required");
    if (this.devices.has(deviceId)) throw new Error("device already exists");
    const now = input.nowMs ?? this.now();
    const record: DeviceRecord = {
      deviceId,
      name: input.name,
      publicKeySpkiPem: input.publicKeySpkiPem,
      clientClass: input.clientClass ?? "bundled",
      createdAtMs: now,
      lastSeenAtMs: null,
      scopes: [...input.scopes],
      status: "active",
      revokedAtMs: null,
    };
    this.devices.set(deviceId, record);
    return { ...record, scopes: [...record.scopes] };
  }

  get(deviceId: string): DeviceRecord | null {
    const d = this.devices.get(deviceId);
    return d ? { ...d, scopes: [...d.scopes] } : null;
  }

  list(includeRevoked = true): DeviceRecord[] {
    const out: DeviceRecord[] = [];
    for (const d of this.devices.values()) {
      if (!includeRevoked && d.status === "revoked") continue;
      out.push({ ...d, scopes: [...d.scopes] });
    }
    out.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return out;
  }

  touchLastSeen(deviceId: string, nowMs?: number): boolean {
    const d = this.devices.get(deviceId);
    if (!d || d.status !== "active") return false;
    d.lastSeenAtMs = nowMs ?? this.now();
    return true;
  }

  isRevokedOrUnknown(deviceId: string): boolean {
    const d = this.devices.get(deviceId);
    return !d || d.status === "revoked";
  }

  revoke(deviceId: string, nowMs?: number): DeviceRecord | null {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    if (d.status === "revoked") return { ...d, scopes: [...d.scopes] };
    d.status = "revoked";
    d.revokedAtMs = nowMs ?? this.now();
    return { ...d, scopes: [...d.scopes] };
  }

  size(): number {
    return this.devices.size;
  }
}

// Revocation collaborators (sessions/tickets/approvals live outside this module).
export interface SessionRevoker {
  revokeDeviceSessions(deviceId: string): number | Promise<number>;
}

export interface TicketRevoker {
  revokeDeviceTickets(deviceId: string): number | Promise<number>;
}

export interface ApprovalCanceller {
  /** Cancel APPROVED, unconsumed approvals signed by the device. */
  cancelDeviceApprovals(deviceId: string): number | Promise<number>;
}

export interface RevokeCollaborators {
  sessions?: SessionRevoker;
  tickets?: TicketRevoker;
  approvals?: ApprovalCanceller;
}

export interface RevokeDeviceResult {
  device: DeviceRecord;
  sessionsRevoked: number;
  ticketsRevoked: number;
  approvalsCancelled: number;
  alreadyRevoked: boolean;
}

/**
 * Revoke a device and fan out to sessions/tickets/approvals.
 * Returns per-class counts for audit. Unknown devices return null.
 */
export async function revokeDevice(
  registry: DeviceRegistry,
  deviceId: string,
  collaborators?: RevokeCollaborators,
  nowMs?: number,
): Promise<RevokeDeviceResult | null> {
  const before = registry.get(deviceId);
  if (!before) return null;
  const alreadyRevoked = before.status === "revoked";
  const device = registry.revoke(deviceId, nowMs);
  if (!device) return null;
  const [sessionsRevoked, ticketsRevoked, approvalsCancelled] = await Promise.all([
    collaborators?.sessions
      ? Promise.resolve(collaborators.sessions.revokeDeviceSessions(deviceId)).catch(() => 0)
      : Promise.resolve(0),
    collaborators?.tickets
      ? Promise.resolve(collaborators.tickets.revokeDeviceTickets(deviceId)).catch(() => 0)
      : Promise.resolve(0),
    collaborators?.approvals
      ? Promise.resolve(collaborators.approvals.cancelDeviceApprovals(deviceId)).catch(() => 0)
      : Promise.resolve(0),
  ]);
  return { device, sessionsRevoked, ticketsRevoked, approvalsCancelled, alreadyRevoked };
}

// ---------------------------------------------------------------------------
// Automation tokens (§22.10)
// ---------------------------------------------------------------------------

export const AUTOMATION_TOKEN_PREFIX = "prism_at" as const;
export const AUTOMATION_SECRET_BYTES = 32;

export interface AutomationTokenRecord {
  tokenId: string;
  verifierHex: string;
  pepperVer: number;
  algorithm: "hmac-sha256";
  scopes: string[];
  expiresAtMs: number;
  createdAtMs: number;
  revoked: boolean;
  revokedAtMs: number | null;
  label: string;
}

export interface CreatedAutomationToken {
  record: AutomationTokenRecord;
  /** Full `prism_at_<id>_<secret>_<checksum>` value; shown exactly once. */
  token: string;
}

function automationChecksum(tokenId: string, secretB64: string): string {
  return createHash("sha256")
    .update(`${AUTOMATION_TOKEN_PREFIX}_${tokenId}_${secretB64}`, "utf8")
    .digest("hex")
    .slice(0, 8);
}

export function parseAutomationToken(token: string): { tokenId: string; secretB64: string } {
  const parts = token.split("_");
  if (parts.length !== 5 || parts[0] !== "prism" || parts[1] !== "at") {
    throw new Error("invalid automation token format");
  }
  const tokenId = parts[2] as string;
  const secretB64 = parts[3] as string;
  const checksum = (parts[4] as string).toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(tokenId)) throw new Error("invalid automation token id");
  let raw: Buffer;
  try {
    raw = Buffer.from(secretB64, "base64");
  } catch {
    throw new Error("invalid automation token secret");
  }
  if (raw.length !== AUTOMATION_SECRET_BYTES) {
    throw new Error("invalid automation token secret length");
  }
  const expected = automationChecksum(tokenId, secretB64);
  const a = Buffer.from(checksum, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid automation token checksum");
  }
  return { tokenId, secretB64 };
}

/**
 * Automation tokens can never satisfy any approval (§22.10, §20.2).
 * This predicate exists so approval paths can branch explicitly and so
 * tests can assert the invariant without stringly-typed checks.
 */
export function canNeverSatisfyApproval(): true {
  return true;
}

export class AutomationTokenStore {
  private readonly tokens = new Map<string, AutomationTokenRecord>();
  private readonly pepper: () => { pepper: Buffer; ver: number };
  private readonly now: () => number;

  /**
   * @param pepperProvider supplies the DEK-wrapped pepper (SecretStore.getPepper).
   * The store keeps only HMAC verifiers, never token secrets.
   */
  constructor(
    pepperProvider: () => { pepper: Buffer; ver: number },
    opts?: { now?: () => number },
  ) {
    this.pepper = pepperProvider;
    this.now = opts?.now ?? Date.now;
  }

  create(
    scopes: string[],
    expiresAtMs: number,
    label = "",
  ): CreatedAutomationToken {
    if (scopes.length === 0) throw new Error("automation token requires explicit scopes");
    const now = this.now();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      throw new Error("automation token requires a future mandatory expiry");
    }
    const tokenId = randomBytes(8).toString("hex");
    const secretB64 = randomBytes(AUTOMATION_SECRET_BYTES).toString("base64");
    const checksum = automationChecksum(tokenId, secretB64);
    const token = `${AUTOMATION_TOKEN_PREFIX}_${tokenId}_${secretB64}_${checksum}`;
    const { pepper, ver } = this.pepper();
    const verifierHex = createHmac("sha256", pepper)
      .update(`${tokenId}:${secretB64}`, "utf8")
      .digest("hex");
    const record: AutomationTokenRecord = {
      tokenId,
      verifierHex,
      pepperVer: ver,
      algorithm: "hmac-sha256",
      scopes: [...scopes],
      expiresAtMs,
      createdAtMs: now,
      revoked: false,
      revokedAtMs: null,
      label,
    };
    this.tokens.set(tokenId, record);
    return { record: { ...record, scopes: [...record.scopes] }, token };
  }

  /**
   * Verify a presented token (constant-time). Returns the record copy on
   * success, null on unknown/revoked/expired/mismatch. Never throws for
   * attacker-controlled input.
   */
  verify(presentedToken: string): AutomationTokenRecord | null {
    let parsed: { tokenId: string; secretB64: string };
    try {
      parsed = parseAutomationToken(presentedToken);
    } catch {
      return null;
    }
    const stored = this.tokens.get(parsed.tokenId);
    if (!stored || stored.revoked) return null;
    if (this.now() >= stored.expiresAtMs) return null;
    let pepper: Buffer;
    try {
      pepper = this.pepper().pepper;
    } catch {
      return null;
    }
    const computed = createHmac("sha256", pepper)
      .update(`${parsed.tokenId}:${parsed.secretB64}`, "utf8")
      .digest();
    let expected: Buffer;
    try {
      expected = Buffer.from(stored.verifierHex, "hex");
    } catch {
      return null;
    }
    if (computed.length !== expected.length || !timingSafeEqual(computed, expected)) {
      return null;
    }
    return { ...stored, scopes: [...stored.scopes] };
  }

  /**
   * Approval gate: automation tokens are never sufficient, even when the
   * token itself is valid. Callers must surface an approval-required error.
   */
  canSatisfyApproval(_tokenId: string): false {
    void canNeverSatisfyApproval();
    return false;
  }

  revoke(tokenId: string): boolean {
    const t = this.tokens.get(tokenId);
    if (!t) return false;
    if (t.revoked) return true;
    t.revoked = true;
    t.revokedAtMs = this.now();
    return true;
  }

  revokeDeviceTokens(_deviceId: string): number {
    // Automation tokens are not device-bound; device revocation does not
    // implicitly revoke them (independent per §22.3/§22.10). Kept for
    // collaborator symmetry; always 0.
    return 0;
  }

  list(): Array<Omit<AutomationTokenRecord, "verifierHex">> {
    const out: Array<Omit<AutomationTokenRecord, "verifierHex">> = [];
    for (const t of this.tokens.values()) {
      const { verifierHex: _dropped, ...rest } = t;
      void _dropped;
      out.push({ ...rest, scopes: [...rest.scopes] });
    }
    out.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return out;
  }

  size(): number {
    return this.tokens.size;
  }
}
