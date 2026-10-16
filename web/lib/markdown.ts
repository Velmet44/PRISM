// Sanitized-markdown renderer for agent-produced content (spec §22.7).
//
// Agent output is untrusted data. Markdown renders through this sanitizer
// with NO raw HTML: the input is HTML-escaped first, then only a small
// markdown subset (code spans, bold, italic, links, images) is re-emitted
// as known-safe tags. Remote images are blocked unless routed through the
// egress-controlled image proxy. Links carry rel="noopener noreferrer" and
// show their destination.

export interface SanitizeOptions {
  /** When true, remote http(s) images are rewritten to the image proxy. */
  readonly routeRemoteImagesViaProxy?: boolean;
  /** Proxy path prefix, e.g. "/image-proxy?url=". */
  readonly imageProxyPrefix?: string;
}

export interface SanitizedMarkdown {
  readonly html: string;
  /** Remote image URLs that were blocked (not proxied). */
  readonly blockedImages: readonly string[];
}

const DEFAULT_PROXY_PREFIX = "/image-proxy?url=";

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isRemoteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isAllowedLinkTarget(url: string): boolean {
  const trimmed = url.trim();
  // Only http(s) and site-relative links. Everything else (javascript:,
  // data:, file:, custom schemes) renders as inert text.
  return (
    /^https?:\/\/[^/\s]+/i.test(trimmed) ||
    (trimmed.startsWith("/") && !trimmed.startsWith("//"))
  );
}

/** Escape inline code spans first so markdown inside code is inert. */
function extractCodeSpans(
  input: string,
): { text: string; spans: readonly string[] } {
  const spans: string[] = [];
  const text = input.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  return { text, spans };
}

function restoreCodeSpans(
  input: string,
  spans: readonly string[],
): string {
  return input.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => {
    const slot = spans[Number(index)];
    return slot ?? "";
  });
}

export function sanitizeMarkdown(
  input: string,
  options: SanitizeOptions = {},
): SanitizedMarkdown {
  const blockedImages: string[] = [];
  const proxyPrefix = options.imageProxyPrefix ?? DEFAULT_PROXY_PREFIX;
  const viaProxy = options.routeRemoteImagesViaProxy ?? false;

  // 1. Pull out code spans so markdown syntax inside code stays literal.
  const { text: withoutCode, spans } = extractCodeSpans(input);

  // 2. Escape everything: this kills all raw HTML/scripts/event handlers.
  let out = escapeHtml(withoutCode);

  // 3. Images: ![alt](url). Remote images are proxied or blocked.
  out = out.replace(
    /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    (_match, alt: string, rawUrl: string) => {
      const url = rawUrl.trim();
      if (isRemoteHttpUrl(url)) {
        if (viaProxy) {
          const proxied = `${proxyPrefix}${encodeURIComponent(url)}`;
          return `<img src="${escapeHtml(proxied)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
        }
        blockedImages.push(url);
        const label = alt.trim().length > 0 ? alt : "image";
        return `${label} [remote image blocked: ${escapeHtml(url)}]`;
      }
      if (url.startsWith("/") && !url.startsWith("//")) {
        return `<img src="${escapeHtml(url)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
      }
      blockedImages.push(url);
      return escapeHtml(`[blocked image: ${url}]`);
    },
  );

  // 4. Links: [text](url) with noopener/noreferrer and visible destination.
  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, text: string, rawUrl: string) => {
      const url = rawUrl.trim();
      if (!isAllowedLinkTarget(url)) {
        return `${text} [link blocked]`;
      }
      const shown = url.length > 120 ? `${url.slice(0, 117)}...` : url;
      return `<a href="${escapeHtml(url)}" rel="noopener noreferrer" target="_blank" title="${escapeHtml(url)}">${text} <span class="link-destination">(${escapeHtml(shown)})</span></a>`;
    },
  );

  // 5. Bold then italic (escaped input cannot contain real tags to confuse).
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  // 6. Restore code spans, then paragraph-split on blank lines.
  out = restoreCodeSpans(out, spans);
  const paragraphs = out
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`);
  return { html: paragraphs.join("\n"), blockedImages };
}
