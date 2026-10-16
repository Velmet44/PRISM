import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERROR_CODES, ProtocolError, isRetryable } from "../src/errors.js";
import { EventEnvelope } from "../src/events.js";
import { CursorPagination } from "../src/pagination.js";
import { SupportManifest } from "../src/support-manifest.js";

describe("errors", () => {
  it("contains the frozen code list including resync and locked codes", () => {
    expect(ERROR_CODES).toContain("RESYNC_REQUIRED");
    expect(ERROR_CODES).toContain("SECRETS_LOCKED");
    expect(ERROR_CODES).toContain("SIDE_EFFECT_UNCERTAIN");
  });

  it("marks only the retryable subset", () => {
    expect(isRetryable("TIMEOUT")).toBe(true);
    expect(isRetryable("POLICY_DENIED")).toBe(false);
    expect(
      ProtocolError.safeParse({
        code: "UNAUTHENTICATED",
        message: "bad proof",
        retryable: false,
        correlation_id: "corr-1",
      }).success,
    ).toBe(true);
  });
});

describe("pagination", () => {
  it("bounds page size", () => {
    expect(
      CursorPagination.safeParse({ order: "asc", limit: 50 }).success,
    ).toBe(true);
    expect(CursorPagination.safeParse({ order: "asc", limit: 0 }).success).toBe(
      false,
    );
    expect(
      CursorPagination.safeParse({ order: "asc", limit: 201 }).success,
    ).toBe(false);
  });
});

describe("event envelope", () => {
  it("accepts a node-level event with nullable aggregates", () => {
    expect(
      EventEnvelope.safeParse({
        event_id: "evt-1",
        sequence: 0,
        event_type: "device.paired",
        event_version: 1,
        node_id: "node-1",
        owner_id: "owner-1",
        agent_id: null,
        task_id: null,
        run_id: null,
        step_id: null,
        step_attempt_id: null,
        causation_id: null,
        correlation_id: "corr-1",
        occurred_at: "2026-10-16T00:00:00.000Z",
        payload_ref: "payload-1",
        security_class: "security_audit",
      }).success,
    ).toBe(true);
  });
});

describe("support manifest example", () => {
  it("validates the committed example", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(
      join(here, "..", "examples", "support-manifest.example.json"),
      "utf8",
    );
    const parsed = SupportManifest.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.combinations.length).toBeGreaterThanOrEqual(3);
    }
  });
});
