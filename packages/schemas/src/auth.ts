import { z } from "zod";
import {
  ChallengeId,
  DeviceId,
  NodeId,
  SessionId,
} from "./ids.js";

const HEX64 = z.string().regex(/^[0-9a-f]{64}$/);
const HEX32 = z.string().regex(/^[0-9a-f]{32}$/);

/**
 * Frozen device proof document (§58.12). Exactly these keys; no extras.
 * `v` is the proof format version, currently 1.
 */
export const ProofDoc = z
  .object({
    v: z.literal(1),
    node_id: NodeId,
    session_id: SessionId,
    device_id: DeviceId,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    target: z.string().min(1),
    body_sha256: HEX64,
    content_type: z.string(),
    content_encoding: z.enum(["identity", "gzip", "br"]),
    iat: z.number().int().nonnegative(),
    jti: HEX32,
    token_sha256: HEX64,
  })
  .strict();
export type ProofDoc = z.infer<typeof ProofDoc>;

export const PROOF_SIGNING_PREFIX = "PRISM-HTTP-POP-V1\n";
export const WS_PROOF_PREFIX = "PRISM-WS-POP-V1\n";
export const APPROVAL_SIGNING_PREFIX = "PRISM-APPROVAL-V1\n";
export const TIER5_SIGNING_PREFIX = "PRISM-LOCAL-ADMIN-V1\n";

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

export class InvalidTargetError extends Error {
  constructor(reason: string) {
    super(`invalid request target: ${reason}`);
    this.name = "InvalidTargetError";
  }
}

function normalizeEscapes(segment: string): string {
  return segment.replace(/%[0-9a-fA-F]{2}/g, (match) => {
    const upper = match.toUpperCase();
    const char = String.fromCharCode(parseInt(upper.slice(1), 16));
    return UNRESERVED.test(char) ? char : upper;
  });
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) throw new InvalidTargetError("path must be absolute");
  if (/%00/i.test(path)) throw new InvalidTargetError("NUL escape rejected");
  const hasTrailingSlash = path.length > 1 && path.endsWith("/");
  const out: string[] = [];
  for (const rawSegment of path.split("/").slice(1)) {
    if (/%(?![0-9a-fA-F]{2})/.test(rawSegment)) {
      throw new InvalidTargetError("dangling percent escape");
    }
    for (const ch of rawSegment) {
      if (!/[A-Za-z0-9\-._~!$&'()*+,;=:@]|%/.test(ch)) {
        throw new InvalidTargetError(`illegal path character ${JSON.stringify(ch)}`);
      }
    }
    const segment = normalizeEscapes(rawSegment);
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      if (out.length === 0) throw new InvalidTargetError("path escapes root");
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const normalized = `/${out.join("/")}`;
  return hasTrailingSlash && out.length > 0 ? `${normalized}/` : normalized;
}

function normalizeQuery(query: string): string {
  if (query.includes("#")) throw new InvalidTargetError("fragment rejected");
  return query
    .split("&")
    .map((pair) => {
      if (pair === "") return pair;
      const index = pair.indexOf("=");
      const name = index === -1 ? pair : pair.slice(0, index);
      const value = index === -1 ? undefined : pair.slice(index + 1);
      if (/%00/i.test(name) || (value !== undefined && /%00/i.test(value))) {
        throw new InvalidTargetError("NUL escape rejected");
      }
      if (/%(?![0-9a-fA-F]{2})/.test(name)) {
        throw new InvalidTargetError("dangling percent escape in query name");
      }
      if (value !== undefined && /%(?![0-9a-fA-F]{2})/.test(value)) {
        throw new InvalidTargetError("dangling percent escape in query value");
      }
      const normalizedName = normalizeEscapes(name);
      return value === undefined
        ? normalizedName
        : `${normalizedName}=${normalizeEscapes(value)}`;
    })
    .join("&");
}

/**
 * Canonical origin-form request target. Implements the frozen
 * `canonicalize(rawTarget)` rule: RFC 3986 normalization with uppercase
 * escapes, unreserved decoding, dot-segment removal, and verbatim
 * preservation of query order and duplicates.
 */
export function canonicalizeTarget(rawTarget: string): string {
  if (rawTarget.length === 0) throw new InvalidTargetError("empty target");
  if (rawTarget.includes("#")) throw new InvalidTargetError("fragment rejected");
  const queryIndex = rawTarget.indexOf("?");
  const path =
    queryIndex === -1 ? rawTarget : rawTarget.slice(0, queryIndex);
  const query = queryIndex === -1 ? undefined : rawTarget.slice(queryIndex + 1);
  const normalizedPath = normalizePath(path);
  if (query === undefined) return normalizedPath;
  return `${normalizedPath}?${normalizeQuery(query)}`;
}

export function isCanonicalTarget(rawTarget: string): boolean {
  try {
    return rawTarget === canonicalizeTarget(rawTarget);
  } catch {
    return false;
  }
}

export const WsTicketIssuance = z.object({
  ticket_id: z.string().min(1),
  ticket_secret: z.string().min(1),
  ticket_sha256: HEX64,
  nonce: HEX32,
  expires_at: z.string().datetime({ offset: true }),
  scopes: z.array(z.string().min(1)).min(1),
});
export type WsTicketIssuance = z.infer<typeof WsTicketIssuance>;

export const WsRedemptionDoc = z
  .object({
    node_id: NodeId,
    session_id: SessionId,
    device_id: DeviceId,
    ticket_sha256: HEX64,
    nonce: HEX32,
    requested_scopes: z.array(z.string().min(1)),
  })
  .strict();
export type WsRedemptionDoc = z.infer<typeof WsRedemptionDoc>;

export const ApprovalSigDoc = z
  .object({
    node_id: NodeId,
    approval_id: z.string().min(1),
    action_hash: HEX64,
    approval_expiry: z.string().datetime({ offset: true }),
    nonce: HEX32,
  })
  .strict();
export type ApprovalSigDoc = z.infer<typeof ApprovalSigDoc>;

export const OsPrincipal = z.union([
  z.string().regex(/^linux-uid:\d+$/),
  z.string().regex(/^windows-sid:.+$/),
]);
export type OsPrincipal = z.infer<typeof OsPrincipal>;

export const Tier5AssertionDoc = z
  .object({
    node_id: NodeId,
    challenge_id: ChallengeId,
    session_id: z.string().min(1),
    action_hash: HEX64,
    os_principal: OsPrincipal,
    nonce: HEX32,
    issued_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type Tier5AssertionDoc = z.infer<typeof Tier5AssertionDoc>;
