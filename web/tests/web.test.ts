import { describe, expect, it } from "vitest";
import { sanitizeMarkdown } from "../lib/markdown.js";
import {
  artifactResponseHeaders,
  decideDisposition,
  sandboxAttribute,
  cspForSandboxedArtifact,
  stripTerminalSequences,
} from "../lib/artifacts.js";
import { canSubmitApprovalFromWeb } from "../features/tasks/index.js";
import { decideRunApprovalFromWeb } from "../features/runs/index.js";
import { DisplayCacheStore } from "../state/index.js";

describe("markdown sanitizer (spec §22.7)", () => {
  it("strips script tags and raw HTML", () => {
    const { html } = sanitizeMarkdown(
      'hello <script>alert("x")</script> <div onload="evil()">world</div>',
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<div");
    expect(html).toContain("&lt;script&gt;");
  });

  it("blocks remote images without the proxy, routes via proxy when enabled", () => {
    const blocked = sanitizeMarkdown("![alt](https://evil.example/p.png)");
    expect(blocked.html).not.toContain("<img");
    expect(blocked.blockedImages).toEqual(["https://evil.example/p.png"]);

    const proxied = sanitizeMarkdown("![alt](https://evil.example/p.png)", {
      routeRemoteImagesViaProxy: true,
    });
    expect(proxied.html).toContain("<img");
    expect(proxied.html).not.toContain("https://evil.example/p.png");
    expect(proxied.html).toContain("/image-proxy?url=");
    expect(proxied.blockedImages).toEqual([]);
  });

  it("renders links with noopener/noreferrer and a visible destination", () => {
    const { html } = sanitizeMarkdown("[docs](https://example.com/x)");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("https://example.com/x");
  });

  it("refuses javascript: link targets", () => {
    const { html } = sanitizeMarkdown("[click](javascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).toContain("[link blocked]");
  });
});

describe("artifact sandbox (spec §22.7)", () => {
  it("never allows allow-same-origin or top navigation", () => {
    expect(
      sandboxAttribute(["allow-scripts", "allow-same-origin"]),
    ).not.toContain("allow-same-origin");
    expect(
      sandboxAttribute([
        "allow-top-navigation",
        "allow-top-navigation-by-user-activation",
      ]),
    ).toBe("");
  });

  it("sends HTML/SVG/PDF to the sandbox and everything else to download", () => {
    expect(decideDisposition("text/html")).toBe("sandboxed");
    expect(decideDisposition("image/svg+xml")).toBe("sandboxed");
    expect(decideDisposition("application/pdf")).toBe("sandboxed");
    expect(decideDisposition("image/png")).toBe("inline");
    expect(decideDisposition("application/zip")).toBe("download");
  });

  it("serves sandboxed artifacts with sandbox CSP + nosniff", () => {
    const headers = artifactResponseHeaders("text/html", "report.html");
    expect(headers.contentSecurityPolicy).toContain("sandbox");
    expect(headers.contentSecurityPolicy).toContain("default-src 'none'");
    expect(headers.xContentTypeOptions).toBe("nosniff");
    expect(cspForSandboxedArtifact()).toContain("connect-src 'none'");
  });

  it("forces unknown types to attachment with nosniff", () => {
    const headers = artifactResponseHeaders("application/zip", "a.zip");
    expect(headers.contentDisposition.startsWith("attachment")).toBe(true);
    expect(headers.xContentTypeOptions).toBe("nosniff");
  });

  it("escapes terminal control sequences", () => {
    const out = stripTerminalSequences("ok\x1b[31mRED\x1b[0m\nline2\x07");
    expect(out).not.toContain("\x1b");
    expect(out).toContain("RED");
    expect(out).toContain("\n");
  });
});

describe("approval tiers from web (spec §20.2)", () => {
  it("allows Tier<=3 with device-bound confirmation", () => {
    for (const tier of [0, 1, 2, 3] as const) {
      const res = canSubmitApprovalFromWeb(
        { approvalId: "a", actionHash: "h", tier },
        "public_static",
      );
      expect(res.ok).toBe(true);
    }
  });

  it("requires bundled-or-trusted-origin for Tier-4", () => {
    const approval = { approvalId: "a", actionHash: "h", tier: 4 as const };
    expect(canSubmitApprovalFromWeb(approval, "bundled").ok).toBe(true);
    expect(canSubmitApprovalFromWeb(approval, "trusted-origin").ok).toBe(true);
    const refused = canSubmitApprovalFromWeb(approval, "public_static");
    expect(refused.ok).toBe(false);
  });

  it("never allows Tier-5 from web", () => {
    const approval = { approvalId: "a", actionHash: "h", tier: 5 as const };
    for (const origin of ["bundled", "trusted-origin", "public_static"] as const) {
      const res = decideRunApprovalFromWeb(approval, "approve", origin);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("TIER5_NM_ONLY");
        expect(res.remediation).toContain("nm_required");
      }
    }
  });
});

describe("display cache (spec §4.2)", () => {
  it("never mutates the canonical objects handed to it", () => {
    const store = new DisplayCacheStore();
    const node = {
      nodeId: "n1",
      endpoint: "https://node.local",
      fingerprint: "abc",
      status: "paired",
    };
    store.upsertNodes([node]);
    node.status = "MUTATED";
    const dump = store.dump();
    expect(dump.nodes[0]?.status).toBe("paired");
  });

  it("hands out copies so readers cannot corrupt the cache", () => {
    const store = new DisplayCacheStore();
    store.upsertTasks([
      { taskId: "t1", title: "work", status: "RUNNING" },
    ]);
    const first = store.dump();
    (first.tasks[0] as { status: string }).status = "MUTATED";
    expect(store.dump().tasks[0]?.status).toBe("RUNNING");
  });

  it("applies events after the cursor, dedupes, and resyncs wholesale", () => {
    const store = new DisplayCacheStore();
    expect(
      store.applyEvents([
        { eventId: "e1", sequence: 3, type: "run.started", aggregateId: "r1" },
        { eventId: "e1", sequence: 3, type: "run.started", aggregateId: "r1" },
        { eventId: "e0", sequence: 1, type: "stale", aggregateId: "r1" },
      ]),
    ).toBe(1);
    expect(store.getCursor()).toBe(3);

    store.handleResyncRequired({
      snapshotToken: "tok",
      asOfSequence: 10,
      expiresAt: "2030-01-01T00:05:00Z",
    });
    expect(store.needsResync()).toBe(true);
    expect(store.getSnapshotFetchHeaders()).toEqual({
      "X-PRISM-SNAPSHOT": "tok",
    });
    store.replaceProjectionFromSnapshot(
      { nodes: [], agents: [], tasks: [], runs: [] },
      10,
    );
    expect(store.needsResync()).toBe(false);
    expect(store.getCursor()).toBe(10);
  });
});
