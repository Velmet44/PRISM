/**
 * Stage 2 agent worker — cognition-loop step dispatch/commit guard.
 *
 * Spec: §27.2–§27.3 (bounded execution lease; every dispatch and result
 * commit presents the current fencing token `epoch:counter`; a stale worker
 * is rejected from starting a new side effect or committing state; lease
 * expiry after a side effect started proves nothing — without a verifiable
 * receipt the step becomes SIDE_EFFECT_UNCERTAIN), §17.1 (cognition loop),
 * §53.2-8 (stale workers cannot commit).
 *
 * Security boundary: the worker holds only a run-scoped capability token —
 * an opaque secret derived for (Run, attempt) at issue time and shown once.
 * It is NEVER a database handle: validation runs against the narrow
 * `AgentLeaseReader` interface (one lookup by Run), implemented by the
 * control plane over the `leases` table. The stored verifier is
 * hex(SHA-256(token)); the secret itself is never persisted. The token
 * expires with the Run (`expiresAtSec <= runExpiresAtSec`).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { compareFencingToken } from "@prism/schemas";
import type { ErrorCode } from "@prism/schemas";

// ---------------------------------------------------------------------------
// Errors (§58.5)
// ---------------------------------------------------------------------------

export class AgentWorkerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly remediation?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; remediation?: string },
  ) {
    super(message);
    this.name = "AgentWorkerError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    if (opts?.remediation !== undefined) this.remediation = opts.remediation;
  }
}

// ---------------------------------------------------------------------------
// Lease + token model (mirrors the `leases` table, migrations/002_stage2.sql)
// ---------------------------------------------------------------------------

export interface AgentLease {
  leaseId: string;
  runId: string;
  /** The Run attempt this token was derived for. */
  attemptNo: number;
  /** Step attempt the lease currently covers; null = any attempt of the Run. */
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
export interface AgentLeaseReader {
  getLease(runId: string): AgentLease | null;
}

export interface IssueAgentTokenInput {
  runId: string;
  attemptNo: number;
  stepAttemptId?: string | null;
  fencingToken: string;
  runExpiresAtSec: number;
  /** Optional cap below the Run expiry; default is the Run expiry itself. */
  ttlSec?: number;
  nowSec?: number;
}

export interface AgentWorkerOp {
  /** Presented opaque capability token (`wtk_…`, shown once at issue). */
  token: string;
  runId: string;
  stepAttemptId: string;
  fencingToken: string;
  nowSec?: number;
}

export type AgentValidation =
  | { ok: true; lease: AgentLease }
  | { ok: false; code: ErrorCode; reason: string };

function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function assertFencingFormat(token: string): void {
  compareFencingToken(token, token);
}

/**
 * Issue a run-scoped capability token for (Run, attempt). Control-plane
 * side: persist the returned lease row (verifier only), hand the token to
 * the worker exactly once.
 */
export function issueAgentToken(input: IssueAgentTokenInput): {
  token: string;
  lease: AgentLease;
} {
  if (input.runId.length === 0) throw new AgentWorkerError("INVALID_ARGUMENT", "runId required");
  if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1) {
    throw new AgentWorkerError("INVALID_ARGUMENT", "attemptNo must be >= 1");
  }
  assertFencingFormat(input.fencingToken);
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (input.runExpiresAtSec <= now) {
    throw new AgentWorkerError("INVALID_ARGUMENT", "cannot issue a token for an expired run");
  }
  const ttl = input.ttlSec ?? input.runExpiresAtSec - now;
  if (ttl <= 0) throw new AgentWorkerError("INVALID_ARGUMENT", "ttlSec must be > 0");
  const expiresAtSec = Math.min(now + ttl, input.runExpiresAtSec);
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
      expiresAtSec,
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
 * fencing-token currency. Returns a result — never throws on worker fault
 * (throws only on caller misuse such as an empty runId).
 */
export function validateAgentOp(
  store: AgentLeaseReader,
  op: AgentWorkerOp,
): AgentValidation {
  if (op.runId.length === 0) {
    throw new AgentWorkerError("INVALID_ARGUMENT", "runId required");
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
// Cognition-loop dispatch/commit
// ---------------------------------------------------------------------------

export interface AgentDispatchTicket {
  runId: string;
  stepAttemptId: string;
  workerLease: string;
  fencingToken: string;
}

/**
 * Guard a cognition-loop side-effect dispatch: the step's StepAttemptId and
 * the worker's fencing token must validate against the durable lease
 * BEFORE the tool broker is touched. Throws the toll-free rejection the
 * broker converts to a stale-worker refusal.
 */
export function dispatchAgentStep(
  store: AgentLeaseReader,
  op: AgentWorkerOp,
): AgentDispatchTicket {
  const result = validateAgentOp(store, op);
  if (!result.ok) {
    throw new AgentWorkerError(result.code, `dispatch refused: ${result.reason}`, {
      retryable: false,
      remediation: "re-fetch the current lease; a fenced worker must stop, not retry",
    });
  }
  return {
    runId: op.runId,
    stepAttemptId: op.stepAttemptId,
    workerLease: result.lease.leaseId,
    fencingToken: result.lease.fencingToken,
  };
}

export interface AgentCommitReceipt {
  runId: string;
  stepAttemptId: string;
  fencingToken: string;
  committedAtSec: number;
}

/**
 * Guard a step-result commit. Only the current fencing token may commit;
 * lease expiry after a side effect started proves nothing about the side
 * effect — the caller marks the step SIDE_EFFECT_UNCERTAIN absent a
 * verifiable receipt (§27.2–§27.3).
 */
export function commitAgentStep(
  store: AgentLeaseReader,
  op: AgentWorkerOp,
): AgentCommitReceipt {
  const result = validateAgentOp(store, op);
  if (!result.ok) {
    throw new AgentWorkerError(result.code, `commit refused: ${result.reason}`, {
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
