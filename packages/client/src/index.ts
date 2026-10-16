import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { p256 } from "@noble/curves/p256";
import {
  CapabilityAdvertisement,
  ENDPOINTS,
  HEADER_POP,
  HEADER_POP_DOC,
  HEADER_SNAPSHOT,
  negotiateProtocol,
  packRedemption,
} from "@prism/protocol";
import {
  PROOF_SIGNING_PREFIX,
  ProofDoc,
  WS_PROOF_PREFIX,
  WsTicketIssuance,
  canonicalizeTarget,
  toCanonicalJson,
  type SubscriptionFilter,
} from "@prism/schemas";
import type { ProtocolError } from "@prism/schemas";

export const KNOWN_FEATURES = [
  "durable-events",
  "ephemeral-streams",
  "device-proofs",
  "snapshot-resync",
  "pairing",
  "ws-mplex",
] as const;

export interface ClientOptions {
  readonly baseUrl: string;
  readonly protocolVersion: string;
  readonly fetchImpl?: typeof fetch;
}

export function fingerprintHex(publicKeyRaw32: Uint8Array): string {
  return Array.from(sha256(publicKeyRaw32))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function verifyNodeSignature(
  publicKeyRaw32: Uint8Array,
  message: Uint8Array,
  signature64: Uint8Array,
): boolean {
  return ed25519.verify(signature64, message, publicKeyRaw32);
}

export function nodeIdBindingMessage(
  nodeId: string,
  clientNonceHex: string,
): Uint8Array {
  return new TextEncoder().encode(`${nodeId}:${clientNonceHex}`);
}

// ---------------------------------------------------------------------------
// Small portable codecs (no Buffer: this SDK also runs in browsers)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("invalid hex encoding");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64Char(sixtet: number): string {
  const ch = B64URL[sixtet & 63];
  if (ch === undefined) throw new Error("base64url range error");
  return ch;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const byte = (i: number): number => {
    const v = bytes[i];
    if (v === undefined) throw new Error("base64url range error");
    return v;
  };
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (byte(i) << 16) | (byte(i + 1) << 8) | byte(i + 2);
    out += b64Char(n >> 18) + b64Char(n >> 12) + b64Char(n >> 6) + b64Char(n);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const a = byte(i);
    out += b64Char(a >> 2) + b64Char(a << 4);
  } else if (rest === 2) {
    const n = (byte(i) << 8) | byte(i + 1);
    out += b64Char(n >> 10) + b64Char(n >> 4) + b64Char(n << 2);
  }
  return out;
}

function base64UrlToBytes(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("invalid base64url");
  const sextets = Array.from(input, (ch) => B64URL.indexOf(ch));
  if (sextets.includes(-1)) throw new Error("invalid base64url");
  const at = (i: number): number => {
    const v = sextets[i];
    if (v === undefined) throw new Error("invalid base64url length");
    return v;
  };
  const out: number[] = [];
  let i = 0;
  for (; i + 3 < sextets.length; i += 4) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3);
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  const rest = sextets.length - i;
  if (rest === 2) {
    const n = (at(i) << 6) | at(i + 1);
    out.push((n >> 4) & 255);
  } else if (rest === 3) {
    const n = (at(i) << 12) | (at(i + 1) << 6) | at(i + 2);
    out.push((n >> 10) & 255, (n >> 2) & 255);
  } else if (rest !== 0) {
    throw new Error("invalid base64url length");
  }
  return new Uint8Array(out);
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

function sha256HexBytes(data: Uint8Array): string {
  return bytesToHex(sha256(data));
}

// ---------------------------------------------------------------------------
// Device P-256 keys (ES256 PoP + WS redemption, §58.12)
// ---------------------------------------------------------------------------

/**
 * Signs a PoP/redemption signing input; returns the 64-byte P-1363
 * `r || s` signature. Inject a WebCrypto-backed signer in browsers so the
 * private key stays non-extractable; the noble default below is for
 * non-browser hosts and tests.
 */
export type DeviceSigner = (signingInput: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Noble-backed signer over a raw 32-byte P-256 private key. */
export function createP256Signer(privateKey32: Uint8Array): DeviceSigner {
  if (privateKey32.length !== 32) throw new Error("P-256 private key must be 32 bytes");
  const priv = new Uint8Array(privateKey32);
  return (signingInput: Uint8Array): Uint8Array => {
    const digest = sha256(signingInput);
    return p256.sign(digest, priv).toCompactRawBytes();
  };
}

/** Fresh device keypair; the private key is held in memory only, never sent. */
export function generateDeviceKeypair(): {
  readonly privateKey: Uint8Array;
  readonly publicKeyUncompressed: Uint8Array;
} {
  const priv = p256.utils.randomPrivateKey();
  return { privateKey: priv, publicKeyUncompressed: p256.getPublicKey(priv, false) };
}

/** ES256 verify of a PoP/redemption signature (P-1363, base digest = SHA-256). */
export function verifyP256Signature(
  publicKey: Uint8Array,
  signingInput: Uint8Array,
  signature64: Uint8Array,
): boolean {
  try {
    if (signature64.length !== 64) return false;
    return p256.verify(signature64, sha256(signingInput), publicKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Identity pinning (§22.9)
// ---------------------------------------------------------------------------

/** Mirrors the Node's `IDENTITY_ROTATED` event type (node/src/identity). */
export const IDENTITY_ROTATED = "IDENTITY_ROTATED" as const;

export interface NodeIdentityView {
  readonly nodeId: string;
  readonly fingerprint: string;
  readonly publicKeyRaw: Uint8Array;
  readonly spkiPem: string | null;
}

export class IdentityPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityPinError";
  }
}

export class IdentityRotatedError extends IdentityPinError {
  constructor(
    readonly prevFingerprint: string,
    readonly nextFingerprint: string,
  ) {
    super(
      `node identity changed (prev ${prevFingerprint}, next ${nextFingerprint}): re-pairing required`,
    );
    this.name = "IdentityRotatedError";
  }
}

// ---------------------------------------------------------------------------
// Pairing + session types
// ---------------------------------------------------------------------------

export interface QrInvite {
  /** Single-use pairing token from the QR (never the owner key). */
  readonly token: string;
  /** Current Node endpoint. */
  readonly endpoint: string;
  /** Expected identity fingerprint for out-of-band comparison. */
  readonly fingerprint: string;
}

export interface PairingOptions {
  readonly deviceName?: string;
  readonly clientClass?: "bundled" | "public_static";
  readonly scopes?: readonly string[];
  readonly exchangePath?: string;
}

export interface PairedSession {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly sessionToken: string;
  readonly scopes: readonly string[];
  readonly clientClass: "bundled" | "public_static";
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: Uint8Array | string | undefined;
  readonly contentType?: string | undefined;
}

// ---------------------------------------------------------------------------
// Minimal WebSocket surface (inject browser or `ws`-package implementations)
// ---------------------------------------------------------------------------

export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WsFactory = (url: string, protocols: string | string[]) => WsLike;

export class PrismClient {
  private readonly fetchImpl: typeof fetch;
  private signer: DeviceSigner | null = null;
  private session: PairedSession | null = null;
  private pinnedFingerprintValue: string | null = null;
  private identityRotated: { prev: string; next: string } | null = null;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl;
  }

  /** Current Node endpoint; follows the QR endpoint after pairing. */
  private baseUrl: string;

  async getCapabilities(): Promise<{
    advertisement: CapabilityAdvertisement;
    degraded: readonly string[];
  }> {
    const response = await this.fetchImpl(
      `${this.baseUrl}${ENDPOINTS.nodeCapabilities}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      throw new Error(`capabilities request failed: ${response.status}`);
    }
    const parsed = CapabilityAdvertisement.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("capabilities response failed validation");
    }
    const negotiated = negotiateProtocol(
      this.options.protocolVersion,
      parsed.data,
      KNOWN_FEATURES,
    );
    if (!negotiated.ok) {
      const error: ProtocolError = {
        code: "UNSUPPORTED",
        message: negotiated.reason,
        retryable: false,
        correlation_id: crypto.randomUUID(),
      };
      throw new Error(
        `unsupported protocol [${error.code}]: ${error.message} (${error.correlation_id})`,
      );
    }
    return { advertisement: parsed.data, degraded: negotiated.degraded };
  }

  // -- pairing ------------------------------------------------------------

  /**
   * Pair with a Node from a QR invite: out-of-band fingerprint match, then
   * exchange the single-use token plus the fresh device public key for a
   * scoped, device-bound session. The token is discarded after exchange.
   */
  async startPairing(qr: QrInvite, opts?: PairingOptions): Promise<PairedSession> {
    const keypair = generateDeviceKeypair();
    return this.startPairingWithKeypair(qr, keypair.privateKey, keypair.publicKeyUncompressed, opts);
  }

  /** Same as {@link startPairing} with a caller-held keypair (e.g. WebCrypto). */
  async startPairingWithKeypair(
    qr: QrInvite,
    devicePrivateKey: Uint8Array,
    devicePublicUncompressed: Uint8Array,
    opts?: PairingOptions,
  ): Promise<PairedSession> {
    if (qr.token.length === 0) throw new Error("pairing token required");
    const endpoint = qr.endpoint.replace(/\/+$/, "");
    const identity = await this.fetchIdentity(endpoint, null);
    if (identity.fingerprint.toLowerCase() !== qr.fingerprint.toLowerCase()) {
      throw new IdentityPinError("QR fingerprint does not match node identity; possible impersonation");
    }
    this.pinnedFingerprintValue = identity.fingerprint.toLowerCase();
    this.identityRotated = null;

    const exchangePath = opts?.exchangePath ?? "/v1/pairing/exchange";
    const body = JSON.stringify({
      token: qr.token,
      device_pubkey: bytesToBase64Url(devicePublicUncompressed),
      client_class: opts?.clientClass ?? "bundled",
      ...(opts?.deviceName !== undefined ? { device_name: opts.deviceName } : {}),
      ...(opts?.scopes !== undefined ? { scopes: [...opts.scopes] } : {}),
    });
    const response = await this.fetchImpl(`${endpoint}${exchangePath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!response.ok) {
      throw new Error(`pairing exchange failed: ${response.status}`);
    }
    const data = (await response.json()) as {
      node_id: string;
      device_id: string;
      session_id: string;
      session_token: string;
      scopes: string[];
    };
    if (
      typeof data.node_id !== "string" ||
      typeof data.device_id !== "string" ||
      typeof data.session_id !== "string" ||
      typeof data.session_token !== "string" ||
      !Array.isArray(data.scopes)
    ) {
      throw new Error("pairing exchange response failed validation");
    }
    this.session = {
      nodeId: data.node_id,
      sessionId: data.session_id,
      deviceId: data.device_id,
      sessionToken: data.session_token,
      scopes: [...data.scopes],
      clientClass: opts?.clientClass ?? "bundled",
    };
    this.signer = createP256Signer(devicePrivateKey);
    // The SDK copy of the base URL follows the QR endpoint: sessions are
    // bound to NodeId+DeviceId, not to the endpoint (§22.2/§38.3).
    this.baseUrl = endpoint;
    return { ...this.session, scopes: [...this.session.scopes] };
  }

  /** Replace the PoP signer (e.g. with a WebCrypto non-extractable signer). */
  setSigner(signer: DeviceSigner): void {
    this.signer = signer;
  }

  getSession(): PairedSession | null {
    return this.session ? { ...this.session, scopes: [...this.session.scopes] } : null;
  }

  // -- identity with pinning -----------------------------------------------

  pinnedFingerprint(): string | null {
    return this.pinnedFingerprintValue;
  }

  /** Explicit user fingerprint match (first pair and post-rotation re-pair). */
  pinIdentity(fingerprint: string): void {
    if (!/^[0-9a-fA-F]{64}$/.test(fingerprint)) throw new Error("fingerprint must be 32-byte hex");
    this.pinnedFingerprintValue = fingerprint.toLowerCase();
    this.identityRotated = null;
  }

  isIdentityRotated(): boolean {
    return this.identityRotated !== null;
  }

  /**
   * Acknowledge a rotation after the user matched the new fingerprint out of
   * band: drops the old session (re-pair required) and pins the new value.
   */
  acknowledgeIdentityRotation(): { prev: string; next: string } {
    const rotation = this.identityRotated;
    if (!rotation) throw new Error("no pending identity rotation");
    this.session = null;
    this.pinnedFingerprintValue = rotation.next;
    this.identityRotated = null;
    return { ...rotation };
  }

  private async fetchIdentity(baseUrl: string, pin: string | null): Promise<NodeIdentityView> {
    const response = await this.fetchImpl(`${baseUrl}${ENDPOINTS.nodeIdentity}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`identity request failed: ${response.status}`);
    }
    const data = (await response.json()) as {
      node_id: string;
      pubkey: string;
      fingerprint: string;
      spki_pem?: string;
    };
    if (typeof data.node_id !== "string" || typeof data.pubkey !== "string" || typeof data.fingerprint !== "string") {
      throw new Error("identity response failed validation");
    }
    const fingerprint = data.fingerprint.toLowerCase();
    if (pin !== null && fingerprint !== pin) {
      throw new IdentityRotatedError(pin, fingerprint);
    }
    return {
      nodeId: data.node_id,
      fingerprint,
      publicKeyRaw: hexToBytes(data.pubkey),
      spkiPem: typeof data.spki_pem === "string" ? data.spki_pem : null,
    };
  }

  /**
   * Fetch the Node identity and enforce the pin. A mismatch marks
   * `IDENTITY_ROTATED`: the session is kept until the caller acknowledges
   * the rotation (which drops it and forces re-pairing, never silent).
   */
  async getIdentity(): Promise<NodeIdentityView> {
    try {
      return await this.fetchIdentity(this.baseUrl, this.pinnedFingerprintValue);
    } catch (err) {
      if (err instanceof IdentityRotatedError) {
        this.identityRotated = { prev: err.prevFingerprint, next: err.nextFingerprint };
      }
      throw err;
    }
  }

  /**
   * Prove-up: POST a fresh client nonce and verify the Ed25519 signature
   * against the pinned identity. Re-pins on first explicit match.
   */
  async verifyNodeIdentity(clientNonceHex?: string): Promise<boolean> {
    const nonce = clientNonceHex ?? randomHex(32);
    if (!/^[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("client nonce must be 32-byte hex");
    const identity = await this.getIdentity();
    const response = await this.fetchImpl(`${this.baseUrl}${ENDPOINTS.nodeVerify}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_nonce: nonce.toLowerCase() }),
    });
    if (!response.ok) {
      throw new Error(`identity verify failed: ${response.status}`);
    }
    const data = (await response.json()) as { node_id: string; nonce: string; sig_ed25519: string };
    if (data.nonce.toLowerCase() !== nonce.toLowerCase()) return false;
    return verifyNodeSignature(identity.publicKeyRaw, hexToBytes(data.nonce), hexToBytes(data.sig_ed25519));
  }

  // -- authenticated requests (ES256 PoP, §58.12) ----------------------------

  private requireSession(): PairedSession {
    if (!this.session || !this.signer) throw new Error("not paired: call startPairing first");
    return this.session;
  }

  /**
   * Authenticated fetch: `Authorization: Bearer <session_token>` plus
   * `X-PRISM-POP` / `X-PRISM-POP-DOC` carrying an ES256 proof over the
   * complete canonical request, including `body_sha256` over the exact body
   * bytes. `iat` is now (60s freshness window) and `jti` is single-use.
   */
  async request(target: string, opts?: RequestOptions): Promise<Response> {
    const session = this.requireSession();
    const signer = this.signer as DeviceSigner;
    const method = opts?.method ?? "GET";
    let rawBody: Uint8Array;
    if (typeof opts?.body === "string") rawBody = new TextEncoder().encode(opts.body);
    else rawBody = opts?.body ?? new Uint8Array(0);
    if (method === "GET" && rawBody.length !== 0) {
      throw new Error("GET with a non-empty body is rejected");
    }
    const canonical = canonicalizeTarget(target);
    const contentType = (opts?.contentType ?? "application/json").trim().toLowerCase();
    const proof = {
      v: 1 as const,
      node_id: session.nodeId,
      session_id: session.sessionId,
      device_id: session.deviceId,
      method,
      target: canonical,
      body_sha256: sha256HexBytes(rawBody),
      content_type: contentType,
      content_encoding: "identity" as const,
      iat: Math.floor(Date.now() / 1000),
      jti: randomHex(16),
      token_sha256: sha256HexBytes(new TextEncoder().encode(session.sessionToken)),
    };
    if (!ProofDoc.safeParse(proof).success) {
      throw new Error("proof document failed validation");
    }
    const signingInput = new TextEncoder().encode(PROOF_SIGNING_PREFIX + toCanonicalJson(proof));
    const signature = await signer(signingInput);
    if (signature.length !== 64) throw new Error("device signer must return 64-byte P-1363");
    return this.fetchImpl(`${this.baseUrl}${canonical}`, {
      method,
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        [HEADER_POP]: bytesToBase64Url(signature),
        [HEADER_POP_DOC]: toCanonicalJson(proof),
        "content-type": contentType,
      },
      body: rawBody.length === 0 ? undefined : rawBody as unknown as BodyInit,
    });
  }

  /** Issue a short-lived WS ticket over an authenticated request (§22.4). */
  async requestWsTicket(scopes: readonly string[]): Promise<WsTicketIssuance> {
    if (scopes.length === 0) throw new Error("ticket requires scopes");
    const response = await this.request(ENDPOINTS.wsTickets, {
      method: "POST",
      body: JSON.stringify({ scopes: [...scopes] }),
    });
    if (response.status === 401) throw new Error("ticket issuance denied: unauthenticated");
    if (response.status === 429) throw new Error("ticket issuance rate-limited");
    if (!response.ok) throw new Error(`ticket issuance failed: ${response.status}`);
    const parsed = WsTicketIssuance.safeParse(await response.json());
    if (!parsed.success) throw new Error("ticket issuance response failed validation");
    return parsed.data;
  }

  /**
   * Redeem a ticket: open one socket per Node with
   * `Sec-WebSocket-Protocol: prism.v1, <ticket>.<redemption_sig>`.
   * The ticket secret never appears in a URL.
   */
  async connectWs(
    ticket: WsTicketIssuance,
    opts: {
      readonly wsImpl: WsFactory;
      readonly requestedScopes?: readonly string[];
      readonly wsUrl?: string;
      readonly signer?: DeviceSigner;
    },
  ): Promise<MultiplexedWs> {
    const session = this.requireSession();
    const signer = opts.signer ?? (this.signer as DeviceSigner);
    const requested = opts.requestedScopes ? [...opts.requestedScopes] : [...ticket.scopes];
    for (const scope of requested) {
      if (!ticket.scopes.includes(scope)) {
        throw new Error(`requested scope exceeds ticket: ${scope}`);
      }
    }
    const doc = {
      node_id: session.nodeId,
      session_id: session.sessionId,
      device_id: session.deviceId,
      ticket_sha256: ticket.ticket_sha256,
      nonce: ticket.nonce,
      requested_scopes: requested,
    };
    const signingInput = new TextEncoder().encode(WS_PROOF_PREFIX + toCanonicalJson(doc));
    const signature = await signer(signingInput);
    if (signature.length !== 64) throw new Error("device signer must return 64-byte P-1363");
    const protocol = packRedemption(ticket.ticket_secret, bytesToBase64Url(signature));
    const base = this.baseUrl.replace(/^http/, "ws");
    const url = opts.wsUrl ?? `${base.replace(/\/+$/, "")}/ws`;
    const socket = opts.wsImpl(url, protocol);
    return new MultiplexedWs(socket, {
      fetchSnapshotPage: async (snapshotToken, filter, cursor, limit) =>
        this.authenticatedSnapshotFetch(snapshotToken, cursor, limit),
    });
  }

  private async authenticatedSnapshotFetch(
    snapshotToken: string,
    cursor: number,
    limit: number,
  ): Promise<{ events: SnapshotEvent[]; asOfSequence: number }> {
    const session = this.requireSession();
    const canonical = canonicalizeTarget(`/v1/events/snapshot?cursor=${cursor}&limit=${limit}`);
    const proof = {
      v: 1 as const,
      node_id: session.nodeId,
      session_id: session.sessionId,
      device_id: session.deviceId,
      method: "GET" as const,
      target: canonical,
      body_sha256: sha256HexBytes(new Uint8Array(0)),
      content_type: "application/json",
      content_encoding: "identity" as const,
      iat: Math.floor(Date.now() / 1000),
      jti: randomHex(16),
      token_sha256: sha256HexBytes(new TextEncoder().encode(session.sessionToken)),
    };
    const signer = this.signer as DeviceSigner;
    const signature = await signer(new TextEncoder().encode(PROOF_SIGNING_PREFIX + toCanonicalJson(proof)));
    const response = await this.fetchImpl(`${this.baseUrl}${canonical}`, {
      headers: {
        authorization: `Bearer ${session.sessionToken}`,
        [HEADER_POP]: bytesToBase64Url(signature),
        [HEADER_POP_DOC]: toCanonicalJson(proof),
        [HEADER_SNAPSHOT]: snapshotToken,
      },
    });
    if (!response.ok) throw new Error(`snapshot fetch failed: ${response.status}`);
    const data = (await response.json()) as { events: SnapshotEvent[]; as_of_sequence: number };
    return { events: data.events, asOfSequence: data.as_of_sequence };
  }
}

// ---------------------------------------------------------------------------
// Multiplexed socket: one socket per Node (§23.0 client side)
// ---------------------------------------------------------------------------

export interface SnapshotEvent {
  readonly event_id: string;
  readonly sequence: number;
  readonly event_type: string;
  readonly [key: string]: unknown;
}

export type MuxServerMessage =
  | { readonly kind: "durable"; readonly subscription_id: string; readonly events: SnapshotEvent[] }
  | {
      readonly kind: "ephemeral";
      readonly subscription_id: string;
      readonly stream: string;
      readonly counter: number;
      readonly payload: unknown;
    }
  | {
      readonly kind: "resync_required";
      readonly subscription_id: string;
      readonly snapshot_token: string;
      readonly as_of_sequence: number;
      readonly expires_at: string;
    }
  | { readonly kind: "subscribed"; readonly request_id: string; readonly subscription_id: string; readonly replay: SnapshotEvent[] }
  | { readonly kind: "error"; readonly request_id?: string; readonly code: string; readonly message: string };

export interface MultiplexedWsOptions {
  readonly fetchSnapshotPage: (
    snapshotToken: string,
    filter: SubscriptionFilter,
    cursor: number,
    limit: number,
  ) => Promise<{ events: SnapshotEvent[]; asOfSequence: number }>;
  readonly snapshotPageLimit?: number;
}

interface MuxSubscription {
  filter: SubscriptionFilter;
  stream: string | null;
  cursor: number;
  acked: number;
  seenIds: Set<string>;
  onDurable: ((events: SnapshotEvent[]) => void) | null;
  onEphemeral: ((counter: number, payload: unknown) => void) | null;
  expectedCounter: number;
  onGap: ((expected: number, got: number) => void) | null;
}

/**
 * One socket per Node carrying many subscriptions. Durable subscriptions
 * replay from the cursor then go live; ephemeral deltas are live-only with
 * per-subscription gap counters; the highest applied sequence is acked;
 * `resync_required` pages a snapshot (token in `X-PRISM-SNAPSHOT`) and
 * rejoins at the new head.
 */
export class MultiplexedWs {
  private readonly subs = new Map<string, MuxSubscription>();
  private readonly pending = new Map<string, (subId: string, replay: SnapshotEvent[]) => void>();
  private requestSeq = 0;

  constructor(
    private readonly socket: WsLike,
    private readonly opts: MultiplexedWsOptions,
  ) {
    socket.onmessage = (ev: { data: unknown }): void => {
      if (typeof ev.data !== "string") return;
      let msg: MuxServerMessage;
      try {
        msg = JSON.parse(ev.data) as MuxServerMessage;
      } catch {
        return;
      }
      void this.handleMessage(msg);
    };
  }

  private send(obj: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(obj));
  }

  private async handleMessage(msg: MuxServerMessage): Promise<void> {
    if (msg.kind === "subscribed") {
      const resolve = this.pending.get(msg.request_id);
      if (resolve) {
        this.pending.delete(msg.request_id);
        resolve(msg.subscription_id, msg.replay);
      }
      return;
    }
    if (msg.kind === "error") return;
    const sub = this.subs.get(msg.subscription_id);
    if (!sub) return;
    if (msg.kind === "durable") {
      const fresh = msg.events.filter((e) => {
        if (sub.seenIds.has(e.event_id)) return false;
        sub.seenIds.add(e.event_id);
        return e.sequence > sub.acked;
      });
      if (fresh.length > 0) {
        fresh.sort((a, b) => a.sequence - b.sequence);
        sub.cursor = (fresh[fresh.length - 1] as SnapshotEvent).sequence;
        sub.onDurable?.(fresh);
        this.ack(msg.subscription_id);
      }
      return;
    }
    if (msg.kind === "ephemeral") {
      if (msg.counter !== sub.expectedCounter + 1 && sub.expectedCounter !== 0) {
        sub.onGap?.(sub.expectedCounter + 1, msg.counter);
      }
      sub.expectedCounter = msg.counter;
      sub.onEphemeral?.(msg.counter, msg.payload);
      return;
    }
    if (msg.kind === "resync_required") {
      await this.resync(msg.subscription_id, sub, msg.snapshot_token);
    }
  }

  /** Highest applied sequence is acked; the server advances its watermark. */
  ack(subscriptionId: string): void {
    const sub = this.subs.get(subscriptionId);
    if (!sub) return;
    sub.acked = sub.cursor;
    this.send({ type: "ack", subscription_id: subscriptionId, sequence: sub.acked });
  }

  /**
   * Subscribe with a filter + cursor: the server replays matching durable
   * events with `sequence > cursor`, then the subscription goes live.
   */
  async subscribe(
    filter: SubscriptionFilter,
    cursor: number,
    onDurable: (events: SnapshotEvent[]) => void,
  ): Promise<string> {
    const requestId = `req-${(this.requestSeq += 1)}`;
    const done = new Promise<{ subId: string; replay: SnapshotEvent[] }>((resolve) => {
      this.pending.set(requestId, (subId, replay) => resolve({ subId, replay }));
    });
    this.send({ type: "subscribe", request_id: requestId, filter, cursor });
    const { subId, replay } = await done;
    this.subs.set(subId, {
      filter: { ...filter },
      stream: null,
      cursor,
      acked: cursor,
      seenIds: new Set(),
      onDurable,
      onEphemeral: null,
      expectedCounter: 0,
      onGap: null,
    });
    const sub = this.subs.get(subId) as MuxSubscription;
    const fresh = replay.filter((e) => {
      if (sub.seenIds.has(e.event_id)) return false;
      sub.seenIds.add(e.event_id);
      return true;
    });
    if (fresh.length > 0) {
      sub.cursor = (fresh[fresh.length - 1] as SnapshotEvent).sequence;
      onDurable(fresh);
      this.ack(subId);
    }
    return subId;
  }

  /** Live-only ephemeral subscription: deltas are never replayed. */
  async subscribeEphemeral(
    stream: string,
    filter: SubscriptionFilter,
    handlers: {
      readonly onDelta: (counter: number, payload: unknown) => void;
      readonly onGap?: (expected: number, got: number) => void;
    },
  ): Promise<string> {
    const requestId = `req-${(this.requestSeq += 1)}`;
    const done = new Promise<string>((resolve) => {
      this.pending.set(requestId, (subId) => resolve(subId));
    });
    this.send({ type: "subscribe_ephemeral", request_id: requestId, stream, filter });
    const subId = await done;
    this.subs.set(subId, {
      filter: { ...filter },
      stream,
      cursor: 0,
      acked: 0,
      seenIds: new Set(),
      onDurable: null,
      onEphemeral: handlers.onDelta,
      expectedCounter: 0,
      onGap: handlers.onGap ?? null,
    });
    return subId;
  }

  /**
   * Partial recovery for ephemeral streams: re-fetch the partial-message
   * snapshot over the API, then rejoin live from the fresh baseline. The
   * caller supplies the refetch; this resets gap tracking.
   */
  rejoinAfterPartial(subscriptionId: string, baselineCounter: number): void {
    const sub = this.subs.get(subscriptionId);
    if (!sub || sub.stream === null) throw new Error("unknown ephemeral subscription");
    sub.expectedCounter = baselineCounter;
    this.send({ type: "rejoin", subscription_id: subscriptionId });
  }

  private async resync(subscriptionId: string, sub: MuxSubscription, snapshotToken: string): Promise<void> {
    const limit = this.opts.snapshotPageLimit ?? 100;
    let cursor = 0;
    const collected: SnapshotEvent[] = [];
    let asOf = 0;
    for (;;) {
      const page = await this.opts.fetchSnapshotPage(snapshotToken, sub.filter, cursor, limit);
      asOf = page.asOfSequence;
      if (page.events.length === 0) break;
      collected.push(...page.events);
      cursor = (page.events[page.events.length - 1] as SnapshotEvent).sequence;
      if (page.events.length < limit) break;
    }
    sub.seenIds.clear();
    sub.cursor = asOf;
    sub.acked = cursor;
    sub.onDurable?.(collected);
    this.send({ type: "subscribe", filter: sub.filter, cursor: asOf });
  }

  unsubscribe(subscriptionId: string): void {
    this.subs.delete(subscriptionId);
    this.send({ type: "unsubscribe", subscription_id: subscriptionId });
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}
