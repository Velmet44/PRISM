// Sandboxed artifact rendering descriptors (spec §22.7 + §16.1).
//
// Rich artifacts (HTML, SVG, PDF, any other active format) render ONLY
// inside an <iframe sandbox> WITHOUT allow-same-origin and WITHOUT
// top-navigation, served with `Content-Security-Policy: sandbox` plus a
// default-deny-network policy and `X-Content-Type-Options: nosniff`.
// Agent content never executes in an origin holding a session/device key.

export const SNAPSHOT_HEADER = "X-PRISM-SNAPSHOT";

/** Tokens that MUST never appear in the web iframe sandbox attribute. */
const FORBIDDEN_SANDBOX_TOKENS = new Set([
  "allow-same-origin",
  "allow-top-navigation",
  "allow-top-navigation-by-user-activation",
]);

/**
 * Build the iframe `sandbox` attribute value. Requested tokens that would
 * break origin isolation are silently dropped (fail closed).
 */
export function sandboxAttribute(requested: readonly string[] = []): string {
  const kept = requested.filter((token) => !FORBIDDEN_SANDBOX_TOKENS.has(token));
  // An empty value = maximum sandboxing; callers set it as <iframe sandbox="...">.
  return kept.join(" ").trim();
}

export type ArtifactDisposition = "inline" | "sandboxed" | "download";

/**
 * MIME types safe for direct inline display. HTML, SVG and PDF are NOT
 * here: per §16.1 they render only inside the sandboxed context.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

const SANDBOXED_TYPES = new Set([
  "text/html",
  "image/svg+xml",
  "application/pdf",
]);

export function decideDisposition(contentType: string): ArtifactDisposition {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (INLINE_SAFE_TYPES.has(base)) return "inline";
  if (SANDBOXED_TYPES.has(base)) return "sandboxed";
  return "download";
}

/** CSP for sandboxed artifact responses: sandbox + deny network by default. */
export function cspForSandboxedArtifact(): string {
  return [
    "sandbox",
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "img-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface ArtifactResponseHeaders {
  readonly contentSecurityPolicy: string;
  readonly xContentTypeOptions: "nosniff";
  readonly contentDisposition: string;
}

/**
 * Describe the response headers the Node must serve for an artifact.
 * Inline-safe types may display inline; sandboxed types get the locked-down
 * CSP; everything else is forced to download (attachment, per §16.1).
 */
export function artifactResponseHeaders(
  contentType: string,
  filename: string,
): ArtifactResponseHeaders {
  const disposition = decideDisposition(contentType);
  const safeName = filename.replace(/["\r\n]/g, "_");
  if (disposition === "inline") {
    return {
      contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
      xContentTypeOptions: "nosniff",
      contentDisposition: `inline; filename="${safeName}"`,
    };
  }
  if (disposition === "sandboxed") {
    return {
      contentSecurityPolicy: cspForSandboxedArtifact(),
      xContentTypeOptions: "nosniff",
      contentDisposition: `inline; filename="${safeName}"`,
    };
  }
  return {
    contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'",
    xContentTypeOptions: "nosniff",
    contentDisposition: `attachment; filename="${safeName}"`,
  };
}

/**
 * Escape terminal control sequences for terminal/log views (§22.7):
 * strips ANSI CSI/OSC sequences and C0 controls except \n and \t.
 */
export function stripTerminalSequences(input: string): string {
  return (
    input
      // ANSI CSI sequences: ESC [ ... final byte
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      // ANSI OSC sequences: ESC ] ... (BEL | ESC \)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
      // Remaining C0 controls (except \t \n) and DEL.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}
