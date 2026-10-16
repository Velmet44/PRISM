/**
 * Node Ed25519 identity (§22.9).
 *
 * - Long-lived Ed25519 keypair generated at install, stored per §21.1
 *   (private material is DEK-wrapped by SecretStore; this module holds only
 *   in-memory key objects and non-secret metadata).
 * - Fingerprint is `hex(SHA256(raw 32-byte pubkey))`; SPKI form is shown in
 *   Node Manager and pinned by the client during pairing.
 * - Handshake: `GET /v1/node/identity → {node_id,pubkey}` then
 *   `POST /v1/node/verify {client_nonce: 32-byte hex} → {node_id,nonce,sig_ed25519}`.
 * - Rotation emits `IDENTITY_ROTATED` and forces re-pairing of every device.
 *
 * Crypto: `node:crypto` only (Ed25519 via `generateKeyPairSync("ed25519")`).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

/** Event type emitted on identity rotation; forces re-pair of all devices. */
export const IDENTITY_ROTATED = "IDENTITY_ROTATED" as const;
export type IdentityRotatedType = typeof IDENTITY_ROTATED;

export interface IdentityRotationEvent {
  type: IdentityRotatedType;
  node_id: string;
  prev_fingerprint: string;
  next_fingerprint: string;
  rotated_at: string;
}

export interface NodeIdentityKeypair {
  /** Raw 32-byte Ed25519 public key. */
  publicKeyRaw: Buffer;
  /** SPKI PEM for display/pinning in Node Manager. */
  publicKeySpkiPem: string;
  /** PKCS#8 PEM; must be DEK-wrapped at rest via SecretStore (§21.1). */
  privateKeyPem: string;
  /** hex(SHA256(raw pubkey)). */
  fingerprint: string;
}

export interface IdentityPublicResponse {
  node_id: string;
  /** Hex of the raw 32-byte public key. */
  pubkey: string;
  /** hex(SHA256(raw pubkey)). */
  fingerprint: string;
  /** SPKI PEM for out-of-band / QR comparison. */
  spki_pem: string;
}

export interface IdentityVerifyResponse {
  node_id: string;
  /** Echo of the client nonce (32-byte hex). */
  nonce: string;
  /** Hex Ed25519 signature over the raw nonce bytes. */
  sig_ed25519: string;
}

const CLIENT_NONCE_HEX_LEN = 64;

function assertRawPubkey(pubkey32: Uint8Array): void {
  if (pubkey32.length !== 32) {
    throw new Error(
      `invalid Ed25519 pubkey length: expected 32 bytes, got ${pubkey32.length}`,
    );
  }
}

function assertNonceHex(nonceHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(nonceHex)) {
    throw new Error("client_nonce must be 32-byte hex (64 hex chars)");
  }
  return Buffer.from(nonceHex, "hex");
}

function base64UrlToBuffer(input: string): Buffer {
  // Node supports base64url directly; normalize padding manually.
  return Buffer.from(input, "base64url");
}

function bufferToBase64Url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Fingerprint per §22.9: `hex(SHA256(raw 32-byte pubkey))`.
 */
export function fingerprintHex(pubkey32: Uint8Array): string {
  assertRawPubkey(pubkey32);
  return createHash("sha256").update(pubkey32).digest("hex");
}

/** SPKI PEM for a raw 32-byte Ed25519 public key. */
export function spkiPemFromRaw(pubkey32: Uint8Array): string {
  assertRawPubkey(pubkey32);
  const key = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: bufferToBase64Url(pubkey32),
    },
    format: "jwk",
  });
  return key.export({ format: "pem", type: "spki" }).toString();
}

/** Rebuild a KeyObject verifier from a raw 32-byte public key. */
export function publicKeyObjectFromRaw(pubkey32: Uint8Array): KeyObject {
  assertRawPubkey(pubkey32);
  return createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: bufferToBase64Url(pubkey32),
    },
    format: "jwk",
  });
}

/** Extract the raw 32-byte public key from a SPKI PEM or JWK-backed KeyObject. */
export function rawFromSpkiPem(spkiPem: string): Buffer {
  const key = createPublicKey(spkiPem);
  const jwk = key.export({ format: "jwk" });
  if (jwk.x === undefined) throw new Error("Ed25519 JWK missing x");
  const raw = base64UrlToBuffer(jwk.x);
  assertRawPubkey(raw);
  return raw;
}

/**
 * Generate a fresh long-lived Ed25519 identity keypair.
 * Private material must be DEK-wrapped before persistence (§21.1).
 */
export function generateIdentity(): NodeIdentityKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.x === undefined) throw new Error("Ed25519 export missing x");
  const publicKeyRaw = base64UrlToBuffer(jwk.x);
  assertRawPubkey(publicKeyRaw);
  const fingerprint = fingerprintHex(publicKeyRaw);
  const publicKeySpkiPem = publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  const privateKeyPem = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  // Zero-width check: PEMs must parse back.
  rawFromSpkiPem(publicKeySpkiPem);
  createPrivateKey(privateKeyPem);
  return { publicKeyRaw, publicKeySpkiPem, privateKeyPem, fingerprint };
}

/**
 * Sign a 32-byte client nonce (hex) with the identity private key.
 * Returns the raw signature bytes (64 bytes Ed25519).
 */
export function signNonce(
  privateKeyPem: string,
  clientNonceHex: string,
): Buffer {
  const nonce = assertNonceHex(clientNonceHex);
  const priv = createPrivateKey(privateKeyPem);
  return sign(null, nonce, priv);
}

/**
 * Verify an Ed25519 signature over a 32-byte nonce.
 * Accepts the public key as raw 32 bytes or SPKI PEM. Constant-time
 * signature check is performed by `node:crypto`; the boolean result
 * leaks nothing about key material.
 */
export function verifyNonce(
  publicKeyRawOrPem: Uint8Array | string,
  clientNonceHex: string,
  signature: Uint8Array,
): boolean {
  const nonce = assertNonceHex(clientNonceHex);
  const pub: KeyObject =
    typeof publicKeyRawOrPem === "string"
      ? createPublicKey(publicKeyRawOrPem)
      : publicKeyObjectFromRaw(publicKeyRawOrPem);
  try {
    return verify(null, nonce, pub, signature);
  } catch {
    return false;
  }
}

/**
 * Combined sign-then-verify helper for the §22.9 handshake in tests and
 * route handlers: signs `clientNonceHex` and immediately verifies the
 * signature against the paired public key. Returns the verify response
 * shape plus a boolean that must be true.
 */
export function signVerify(
  keypair: NodeIdentityKeypair,
  clientNonceHex: string,
): { response: IdentityVerifyResponse; verified: boolean } {
  const sig = signNonce(keypair.privateKeyPem, clientNonceHex);
  const verified = verifyNonce(
    keypair.publicKeyRaw,
    clientNonceHex,
    sig,
  );
  const response: IdentityVerifyResponse = {
    node_id: "",
    nonce: clientNonceHex.toLowerCase(),
    sig_ed25519: Buffer.from(sig).toString("hex"),
  };
  return { response, verified };
}

/** Constant-time fingerprint comparison for pairing flows. */
export function fingerprintsEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex.toLowerCase(), "hex");
  const b = Buffer.from(bHex.toLowerCase(), "hex");
  if (a.length !== b.length || a.length !== 32) return false;
  return timingSafeEqual(a, b);
}

/**
 * In-memory Node identity holder. Persistence (DEK-wrapped private key +
 * non-secret metadata) is the caller's responsibility via SecretStore.
 */
export class NodeIdentity {
  private readonly nodeId: string;
  private keypair: NodeIdentityKeypair;
  private rePairRequired = false;
  private lastRotation: IdentityRotationEvent | null = null;

  constructor(nodeId: string, initial?: NodeIdentityKeypair) {
    if (nodeId.length === 0) throw new Error("nodeId must be non-empty");
    this.nodeId = nodeId;
    this.keypair = initial ?? generateIdentity();
  }

  get node_id(): string {
    return this.nodeId;
  }

  getFingerprint(): string {
    return this.keypair.fingerprint;
  }

  /** Non-secret public material for `GET /v1/node/identity`. */
  getIdentityPublic(): IdentityPublicResponse {
    return {
      node_id: this.nodeId,
      pubkey: this.keypair.publicKeyRaw.toString("hex"),
      fingerprint: this.keypair.fingerprint,
      spki_pem: this.keypair.publicKeySpkiPem,
    };
  }

  /** For parity with the required `getIdentityPublic()` hook name. */
  getPublicKeyRaw(): Buffer {
    return Buffer.from(this.keypair.publicKeyRaw);
  }

  /**
   * Handle `POST /v1/node/verify {client_nonce}`.
   * While the SecretStore is LOCKED, callers must return SECRETS_LOCKED
   * instead of signing (§21.1); this method asserts unlock by requiring
   * the caller to have checked — it never reads the store itself.
   */
  signVerifyNonce(clientNonceHex: string): IdentityVerifyResponse {
    const sig = signNonce(this.keypair.privateKeyPem, clientNonceHex);
    return {
      node_id: this.nodeId,
      nonce: clientNonceHex.toLowerCase(),
      sig_ed25519: sig.toString("hex"),
    };
  }

  verifyClientNonce(
    clientNonceHex: string,
    sigHex: string,
  ): boolean {
    let sig: Buffer;
    try {
      if (!/^[0-9a-fA-F]{128}$/.test(sigHex)) return false;
      sig = Buffer.from(sigHex, "hex");
    } catch {
      return false;
    }
    return verifyNonce(this.keypair.publicKeyRaw, clientNonceHex, sig);
  }

  /**
   * Rotate the identity keypair. Emits an explicit `IDENTITY_ROTATED`
   * event and sets the re-pair flag: every device must re-pair, never
   * silently continue with the old pin (§22.9). Restore paths must not
   * call this implicitly (§40.4).
   */
  rotateIdentity(nowIso?: string): IdentityRotationEvent {
    const prevFingerprint = this.keypair.fingerprint;
    const next = generateIdentity();
    this.keypair = next;
    this.rePairRequired = true;
    const event: IdentityRotationEvent = {
      type: IDENTITY_ROTATED,
      node_id: this.nodeId,
      prev_fingerprint: prevFingerprint,
      next_fingerprint: next.fingerprint,
      rotated_at: nowIso ?? new Date().toISOString(),
    };
    this.lastRotation = event;
    return event;
  }

  /** True after rotation until every device has re-paired. */
  isRePairRequired(): boolean {
    return this.rePairRequired;
  }

  /** Cleared by the pairing flow once all devices have re-paired. */
  acknowledgeRePairComplete(): void {
    this.rePairRequired = false;
  }

  getLastRotation(): IdentityRotationEvent | null {
    return this.lastRotation;
  }

  /** Export for DEK-wrapping. Never persist `privateKeyPem` in plaintext. */
  exportForStorage(): {
    node_id: string;
    public_key_hex: string;
    spki_pem: string;
    fingerprint: string;
    private_key_pem: string;
  } {
    return {
      node_id: this.nodeId,
      public_key_hex: this.keypair.publicKeyRaw.toString("hex"),
      spki_pem: this.keypair.publicKeySpkiPem,
      fingerprint: this.keypair.fingerprint,
      private_key_pem: this.keypair.privateKeyPem,
    };
  }

  static importFromStorage(stored: {
    node_id: string;
    public_key_hex: string;
    spki_pem: string;
    fingerprint: string;
    private_key_pem: string;
  }): NodeIdentity {
    const raw = Buffer.from(stored.public_key_hex, "hex");
    const fingerprint = fingerprintHex(raw);
    if (fingerprint !== stored.fingerprint.toLowerCase()) {
      throw new Error("identity fingerprint mismatch on import");
    }
    return new NodeIdentity(stored.node_id, {
      publicKeyRaw: raw,
      publicKeySpkiPem: stored.spki_pem,
      privateKeyPem: stored.private_key_pem,
      fingerprint,
    });
  }
}
