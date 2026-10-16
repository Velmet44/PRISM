/**
 * Public Node API listener (spec §6.1, §22.5, §24/§50.1).
 *
 * This module owns the remotely reachable route space (`/v1/*`, `/ws`,
 * `/hooks/*`, bundled Web assets) together with its own route registry,
 * middleware chain, and audit stream: `PUBLIC_ROUTES`, `PUBLIC_MIDDLEWARE`,
 * and `PUBLIC_AUDIT`. These are distinct objects from the Node Manager's
 * `NM_ROUTES` / `NM_MIDDLEWARE` / `NM_AUDIT` in `src/node-manager/` and are
 * never shared with it.
 *
 * Tier-5 (human-only) actions MUST NOT be exposed here at all (§20.2): any
 * Tier-5 path attempted via the public listener is rejected with
 * `{code: UNAUTHORIZED, remediation: "nm_required"}`.
 *
 * Only `node:http` primitives are used. No express.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ENDPOINTS, PROTOCOL_VERSION, STAGE0_NODE_VERSION } from "@prism/protocol";
import type { ErrorCode } from "@prism/schemas";

/**
 * Loopback reachability is transport isolation, NOT authentication (§6.1).
 * A request arriving from 127.0.0.1 carries no administrative authority on
 * its own; Tier-5 still requires a fresh OS-backed helper assertion, and
 * public routes still require their normal credentials.
 */
export const loopbackIsNotAuth = true as const;

/** Tier-5 is never satisfiable through the public listener. */
export function isPublicTier5Blocked(): boolean {
  return true;
}

export interface PublicRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly auth: "none" | "owner-or-device";
  readonly description: string;
}

/**
 * Public API route registry. Owned by this module; never the same object as
 * the Node Manager's `NM_ROUTES`. Node Manager routes (`/nm/*`) are NOT
 * registered here at all.
 */
export const PUBLIC_ROUTES: Record<string, PublicRoute> = {
  "GET /v1/node/capabilities": {
    method: "GET",
    path: ENDPOINTS.nodeCapabilities,
    auth: "none",
    description: "Advertise protocol/node versions, features, and models (§24).",
  },
  "GET /v1/node/identity": {
    method: "GET",
    path: ENDPOINTS.nodeIdentity,
    auth: "none",
    description: "Return the Node identity fingerprint and public key (§22.9).",
  },
  "POST /v1/node/verify": {
    method: "POST",
    path: ENDPOINTS.nodeVerify,
    auth: "none",
    description: "Prove Node identity over a client nonce (§22.9).",
  },
  "POST /v1/ws/tickets": {
    method: "POST",
    path: ENDPOINTS.wsTickets,
    auth: "owner-or-device",
    description: "Issue a short-lived WebSocket ticket (auth required; stub).",
  },
};

export type PublicMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void;

function publicTlsMiddleware(
  _req: IncomingMessage,
  _res: ServerResponse,
  next: () => void,
): void {
  // LAN bindings require TLS by default (§22.5); enforced at listen time.
  next();
}

function publicAuthMiddleware(
  _req: IncomingMessage,
  _res: ServerResponse,
  next: () => void,
): void {
  next();
}

function publicAuditMiddleware(
  _req: IncomingMessage,
  _res: ServerResponse,
  next: () => void,
): void {
  next();
}

/**
 * Public API middleware chain. Owned by this module; never the same array
 * as the Node Manager's `NM_MIDDLEWARE`.
 */
export const PUBLIC_MIDDLEWARE: PublicMiddleware[] = [
  publicTlsMiddleware,
  publicAuthMiddleware,
  publicAuditMiddleware,
];

export interface PublicAuditEvent {
  readonly at: string;
  readonly route: string;
  readonly outcome: "ok" | "denied";
  readonly reason?: string;
}

/**
 * Public API audit stream. Owned by this module; never the same array as
 * the Node Manager's `NM_AUDIT`.
 */
export const PUBLIC_AUDIT: PublicAuditEvent[] = [];

export function publicAudit(event: Omit<PublicAuditEvent, "at">): PublicAuditEvent {
  const entry: PublicAuditEvent = { ...event, at: new Date().toISOString() };
  PUBLIC_AUDIT.push(entry);
  return entry;
}

export interface ProtocolErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly correlation_id: string;
  readonly remediation?: unknown;
}

export function protocolError(
  code: ErrorCode,
  message: string,
  remediation?: unknown,
): ProtocolErrorBody {
  return {
    code,
    message,
    retryable: false,
    correlation_id: randomBytes(8).toString("hex"),
    ...(remediation === undefined ? {} : { remediation }),
  };
}

/** Rejection used for ANY Tier-5 attempt via the public listener. */
export function publicTier5Rejection(): ProtocolErrorBody {
  return protocolError(
    "UNAUTHORIZED",
    "Tier-5 actions are satisfiable only through Node Manager",
    NM_REQUIRED,
  );
}

const NM_REQUIRED = "nm_required" as const;

export interface PublicHandlerOptions {
  nodeId?: string;
  nodePublicKey?: string;
  nodeVersion?: string;
  features?: string[];
  models?: string[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 1_048_576): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Build the public API request handler (`node:http` only). Tier-5 paths
 * (`/nm/*`) are guarded FIRST so they can never be served here, even if a
 * route were registered by mistake.
 */
export function buildPublicHandler(options: PublicHandlerOptions = {}) {
  const nodeId = options.nodeId ?? "node-uninitialized";
  const nodePublicKey = options.nodePublicKey ?? "uninitialized";
  const nodeVersion = options.nodeVersion ?? STAGE0_NODE_VERSION;
  const features = options.features ?? [];
  const models = options.models ?? [];

  return (req: IncomingMessage, res: ServerResponse): void => {
    void handlePublicRequest(req, res, {
      nodeId,
      nodePublicKey,
      nodeVersion,
      features,
      models,
    }).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, protocolError("WORKER_FAILURE", "handler failed"));
      }
    });
  };
}

interface ResolvedOptions {
  nodeId: string;
  nodePublicKey: string;
  nodeVersion: string;
  features: string[];
  models: string[];
}

async function handlePublicRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResolvedOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = (req.method ?? "GET").toUpperCase();

  // Tier-5 guard: Node Manager routes are not registered on this listener
  // at all, and any Tier-5 attempt is rejected outright (§6.1, §20.2).
  if (pathname === ENDPOINTS.nmChallenges || pathname.startsWith("/nm/")) {
    publicAudit({ route: `${method} ${pathname}`, outcome: "denied", reason: "tier5-via-public" });
    sendJson(res, 403, publicTier5Rejection());
    return;
  }

  if (method === "GET" && pathname === ENDPOINTS.nodeCapabilities) {
    sendJson(res, 200, {
      protocol_version: PROTOCOL_VERSION,
      node_version: options.nodeVersion,
      features: options.features,
      models: options.models,
      remote_access: { mode: "none", limits: [] },
    });
    return;
  }

  if (method === "GET" && pathname === ENDPOINTS.nodeIdentity) {
    sendJson(res, 200, { node_id: options.nodeId, pubkey: options.nodePublicKey });
    return;
  }

  if (method === "POST" && pathname === ENDPOINTS.nodeVerify) {
    let raw = "";
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 400, protocolError("INVALID_ARGUMENT", "unreadable body"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = raw === "" ? {} : JSON.parse(raw);
    } catch {
      sendJson(res, 400, protocolError("INVALID_ARGUMENT", "body must be JSON"));
      return;
    }
    const nonce =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["client_nonce"]
        : undefined;
    if (typeof nonce !== "string" || !/^[0-9a-f]{64}$/.test(nonce)) {
      sendJson(
        res,
        400,
        protocolError("INVALID_ARGUMENT", "client_nonce must be 32-byte hex"),
      );
      return;
    }
    // Full Ed25519 prove-up lives with the identity module (Stage 1, other
    // owner); until wired, fail explicitly instead of fabricating a proof.
    sendJson(
      res,
      503,
      protocolError(
        "RESOURCE_UNAVAILABLE",
        "node identity not initialized",
        "complete pairing via Node Manager",
      ),
    );
    return;
  }

  if (method === "POST" && pathname === ENDPOINTS.wsTickets) {
    const auth = req.headers["authorization"];
    if (typeof auth !== "string" || auth.trim() === "") {
      sendJson(
        res,
        401,
        protocolError("UNAUTHENTICATED", "owner or device credential required"),
      );
      return;
    }
    // Ticket minting is owned by the auth module (Stage 1, other owner).
    sendJson(
      res,
      503,
      protocolError(
        "RESOURCE_UNAVAILABLE",
        "ticket issuance not initialized",
        "retry after pairing",
      ),
    );
    return;
  }

  sendJson(
    res,
    404,
    protocolError("NOT_FOUND", `unknown public route ${pathname}`),
  );
}
