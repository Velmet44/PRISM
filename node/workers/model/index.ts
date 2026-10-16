/**
 * Stage 2 model worker — inference dispatch/commit guard.
 *
 * Spec: §31 (Model Manager owns inference; the worker never touches model
 * weights or runtime endpoints directly — it dispatches through the granted
 * adapter), §27.2–§27.3 (bounded execution lease; every dispatch and result
 * commit presents the current fencing token; stale workers rejected),
 * §30.1 (the final model/provider selection is recorded in run metadata —
 * the dispatch grant carries the resolved selection through).
 *
 * Security boundary (shared with the agent/task workers): the worker holds
 * only a run-scoped capability token derived for (Run, attempt) — an opaque
 * secret shown once at issue, stored as hex(SHA-256(token)). It is NEVER a
 * database handle: validation runs against the narrow `ModelLeaseReader`
 * interface implemented by the control plane over the `leases` table. The
 * token expires with the Run.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { compareFencingToken } from "@prism/schemas";
import type { ErrorCode } from "@prism/schemas";

// ---------------------------------------------------------------------------
// Errors (§58.5)
// ---------------------------------------------------------------------------

export class ModelWorkerError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly remediation?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { retryable?: boolean; remediation?: string },
  ) {
    super(message);
    this.name = "ModelWorkerError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    if (opts?.remediation !== undefined) this.remediation = opts.remediation;
  }
}

// ---------------------------------------------------------------------------
// Lease + token model (mirrors the `leases` table, migrations/002_stage2.sql)
// ---------------------------------------------------------------------------

export interface ModelLease {
  leaseId: string;
  runId: string;
  /** The Run attempt this token was derived for. */
  attemptNo: number;
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
export interface ModelLeaseReader {
  getLease(runId: string): ModelLease | null;
}

export interface IssueModelTokenInput {
  runId: string;
  attemptNo: number;
  stepAttemptId?: string | null;
  fencingToken: string;
  runExpiresAtSec: number;
  ttlSec?: number;
  nowSec?: number;
}

export interface ModelWorkerOp {
  /** Presented opaque capability token (`wtk_…`, shown once at issue). */
  token: string;
  runId: string;
  stepAttemptId: string;
  fencingToken: string;
  nowSec?: number;
}

export type ModelValidation =
  | { ok: true; lease: ModelLease }
  | { ok: false; code: ErrorCode; reason: string };

function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Issue a run-scoped capability token for (Run, attempt). Control-plane
 * side: persist the returned lease row (verifier only), hand the token to
 * the worker exactly once.
 */
export function issueModelToken(input: IssueModelTokenInput): {
  token: string;
  lease: ModelLease;
} {
  if (input.runId.length === 0) throw new ModelWorkerError("INVALID_ARGUMENT", "runId required");
  if (!Number.isInteger(input.attemptNo) || input.attemptNo < 1) {
    throw new ModelWorkerError("INVALID_ARGUMENT", "attemptNo must be >= 1");
  }
  compareFencingToken(input.fencingToken, input.fencingToken);
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (input.runExpiresAtSec <= now) {
    throw new ModelWorkerError("INVALID_ARGUMENT", "cannot issue a token for an expired run");
  }
  const ttl = input.ttlSec ?? input.runExpiresAtSec - now;
  if (ttl <= 0) throw new ModelWorkerError("INVALID_ARGUMENT", "ttlSec must be > 0");
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
      expiresAtSec: Math.min(now + ttl, input.runExpiresAtSec),
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
 * fencing-token currency.
 */
export function validateModelOp(
  store: ModelLeaseReader,
  op: ModelWorkerOp,
): ModelValidation {
  if (op.runId.length === 0) {
    throw new ModelWorkerError("INVALID_ARGUMENT", "runId required");
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
// Inference dispatch/commit
// ---------------------------------------------------------------------------

export interface InferenceGrant {
  runId: string;
  stepAttemptId: string;
  /** Final §30.1 selection, carried through to run metadata. */
  modelId: string;
  family: string;
  runtimeRef: string;
  workerLease: string;
  fencingToken: string;
}

/**
 * Guard an inference dispatch: validate StepAttemptId + fencing token
 * against the durable lease BEFORE the model call is issued. The worker
 * invokes inference through the Model Manager adapter named in the grant —
 * never via a runtime endpoint of its own.
 */
export function dispatchInference(
  store: ModelLeaseReader,
  op: ModelWorkerOp,
  selection: { modelId: string; family: string; runtimeRef: string },
): InferenceGrant {
  const result = validateModelOp(store, op);
  if (!result.ok) {
    throw new ModelWorkerError(result.code, `inference dispatch refused: ${result.reason}`, {
      retryable: false,
      remediation: "re-fetch the current lease; a fenced worker must stop, not retry",
    });
  }
  if (selection.modelId.length === 0 || selection.runtimeRef.length === 0) {
    throw new ModelWorkerError("INVALID_ARGUMENT", "resolved model selection required");
  }
  return {
    runId: op.runId,
    stepAttemptId: op.stepAttemptId,
    modelId: selection.modelId,
    family: selection.family,
    runtimeRef: selection.runtimeRef,
    workerLease: result.lease.leaseId,
    fencingToken: result.lease.fencingToken,
  };
}

export interface UsageReceipt {
  runId: string;
  stepAttemptId: string;
  fencingToken: string;
  promptTokens: number | null;
  completionTokens: number | null;
  committedAtSec: number;
}

/**
 * Guard the usage commit that reconciles a model call (token counts feed
 * Stage 6 cost control; self-hosted inference consumes Node resources, not
 * provider spend — §30.1). Only the current fencing token may commit.
 */
export function commitInferenceUsage(
  store: ModelLeaseReader,
  op: ModelWorkerOp,
  usage: { promptTokens?: number | null; completionTokens?: number | null },
): UsageReceipt {
  const result = validateModelOp(store, op);
  if (!result.ok) {
    throw new ModelWorkerError(result.code, `usage commit refused: ${result.reason}`, {
      retryable: false,
      remediation:
        "do not assume success or failure; reconcile via receipt or mark SIDE_EFFECT_UNCERTAIN",
    });
  }
  for (const [name, value] of [
    ["promptTokens", usage.promptTokens],
    ["completionTokens", usage.completionTokens],
  ] as const) {
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new ModelWorkerError("INVALID_ARGUMENT", `${name} must be >= 0`);
    }
  }
  return {
    runId: op.runId,
    stepAttemptId: op.stepAttemptId,
    fencingToken: result.lease.fencingToken,
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    committedAtSec: op.nowSec ?? Math.floor(Date.now() / 1000),
  };
}
