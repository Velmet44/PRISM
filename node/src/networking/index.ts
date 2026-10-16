/**
 * LAN transport policy (§22.5).
 *
 * If the Node API is exposed beyond loopback on a LAN, TLS MUST be enabled
 * by default. Plaintext bearer credentials over arbitrary LAN HTTP are not
 * an acceptable default. The setup flow may provide a managed local
 * certificate or a user-supplied certificate.
 *
 * Crypto/transport: option types only; no sockets are opened here. Callers
 * pass the result of {@link buildHttpsOptions} to `node:https`.
 */
import type { ServerOptions as HttpsServerOptions } from "node:https";

/** Frozen TLS defaults: LAN requires TLS; loopback may stay plaintext. */
export interface TlsPolicy {
  readonly lanTlsRequired: true;
  readonly allowPlaintextLoopback: true;
}

export function getTlsPolicy(): TlsPolicy {
  return { lanTlsRequired: true, allowPlaintextLoopback: true };
}

// ---------------------------------------------------------------------------
// Binding classification
// ---------------------------------------------------------------------------

/** Strip brackets and any trailing `:port` from a host value. */
function stripPort(host: string): string {
  let h = host.trim();
  if (h.startsWith("[") && h.includes("]")) {
    return h.slice(1, h.indexOf("]"));
  }
  // Single colon → host:port. Multiple colons → bare IPv6, keep as-is.
  const first = h.indexOf(":");
  const last = h.lastIndexOf(":");
  if (first !== -1 && first === last) {
    h = h.slice(0, first);
  }
  return h;
}

/** True for loopback names/addresses that never leave the host. */
export function isLoopbackHost(host: string): boolean {
  const h = stripPort(host).toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (h.startsWith("127.")) {
    const parts = h.split(".");
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) return true;
  }
  return false;
}

/**
 * True when a bind address/host may be reachable beyond loopback, in which
 * case {@link getTlsPolicy} requires TLS. Wildcard binds (`0.0.0.0`, `::`),
 * RFC 1918 / link-local / unique-local addresses, public IPs, and DNS names
 * all count as LAN-or-wider; only loopback does not.
 */
export function isLanBinding(host: string): boolean {
  const h = stripPort(host).toLowerCase();
  if (h === "" || isLoopbackHost(h)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Certificates: managed local cert or user-supplied cert (§22.5)
// ---------------------------------------------------------------------------

export interface PemCertKey {
  readonly certPem: string;
  readonly keyPem: string;
}

export type CertSource =
  | { readonly kind: "managed"; readonly cert: PemCertKey }
  | { readonly kind: "user"; readonly cert: PemCertKey }
  | { readonly kind: "none" };

function assertPem(label: string, pem: string, marker: string): void {
  if (!pem.includes(marker)) {
    throw new Error(`invalid ${label}: missing ${marker}`);
  }
}

function assertCertKey(label: string, cert: PemCertKey): void {
  assertPem(`${label}.certPem`, cert.certPem, "-----BEGIN CERTIFICATE-----");
  assertPem(`${label}.keyPem`, cert.keyPem, "-----BEGIN PRIVATE KEY-----");
}

/**
 * Build `node:https` server options. A user-supplied certificate wins over
 * the managed local certificate; with neither, returns null and the caller
 * MUST refuse any non-loopback binding (see {@link resolveTlsForBinding}).
 */
export function buildHttpsOptions(source: CertSource): HttpsServerOptions | null {
  if (source.kind === "none") return null;
  assertCertKey(source.kind, source.cert);
  return { cert: source.cert.certPem, key: source.cert.keyPem };
}

export type TlsResolution =
  | { readonly mode: "https"; readonly options: HttpsServerOptions }
  | { readonly mode: "http-loopback" }
  | { readonly mode: "refused"; readonly reason: string };

/**
 * Enforce the LAN-TLS default at listen time: loopback may serve plaintext,
 * any LAN-or-wider binding requires a managed or user certificate and is
 * refused without one.
 */
export function resolveTlsForBinding(host: string, source: CertSource): TlsResolution {
  if (!isLanBinding(host)) return { mode: "http-loopback" };
  const options = buildHttpsOptions(source);
  if (!options) {
    return {
      mode: "refused",
      reason: `TLS required for non-loopback binding ${JSON.stringify(host)}: provide a managed or user certificate`,
    };
  }
  return { mode: "https", options };
}
