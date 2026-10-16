import { describe, expect, it } from "vitest";
import {
  Promotion,
  isReadOnlyRequest,
  quarantineCheck,
} from "../src/policy.js";

const scope = {
  origin: "https://api.example.com",
  methods: ["GET"] as Array<"GET" | "HEAD">,
  path: "/v1/status",
  query: [{ key: "verbose", kind: "const" as const, values: ["true"] }],
  headers: { accept: "application/json" },
  body_len: 0 as const,
  credential: "none" as const,
};

const provenance = { origin: "policy_constant" } as const;

describe("isReadOnlyRequest", () => {
  it("allows exact policy-constant reads", () => {
    expect(
      isReadOnlyRequest(scope, {
        origin: "https://api.example.com",
        method: "GET",
        path: "/v1/status",
        query: { verbose: "true" },
        headers: { accept: "application/json" },
        bodyLen: 0,
        credential: "none",
        provenances: { ...provenance },
      }),
    ).toBe(true);
  });

  it("rejects deviations", () => {
    const base = {
      origin: "https://api.example.com",
      method: "GET",
      path: "/v1/status",
      query: { verbose: "true" },
      headers: { accept: "application/json" },
      bodyLen: 0,
      credential: "none",
      provenances: { ...provenance },
    };
    expect(isReadOnlyRequest(scope, { ...base, method: "POST" })).toBe(false);
    expect(
      isReadOnlyRequest(scope, { ...base, query: { verbose: "false" } }),
    ).toBe(false);
    expect(
      isReadOnlyRequest(scope, { ...base, query: { verbose: "true", x: "1" } }),
    ).toBe(false);
    expect(
      isReadOnlyRequest(scope, {
        ...base,
        provenances: { origin: "dynamic_untrusted" },
      }),
    ).toBe(false);
    expect(isReadOnlyRequest(scope, { ...base, bodyLen: 3 })).toBe(false);
    expect(
      isReadOnlyRequest(scope, { ...base, credential: "cred-1" }),
    ).toBe(false);
  });
});

describe("quarantineCheck", () => {
  it("rejects arbitrary ingestion combined with authority", () => {
    expect(
      quarantineCheck({
        ingestsArbitrary: true,
        hasCredential: true,
        hasPrivateData: false,
        hasExternalSend: false,
      }),
    ).toBe("reject");
    expect(
      quarantineCheck({
        ingestsArbitrary: true,
        hasCredential: false,
        hasPrivateData: false,
        hasExternalSend: false,
      }),
    ).toBe("allow");
    expect(
      quarantineCheck({
        ingestsArbitrary: false,
        hasCredential: true,
        hasPrivateData: true,
        hasExternalSend: true,
      }),
    ).toBe("allow");
  });
});

describe("Promotion", () => {
  it("requires exact hashes and a device signature", () => {
    const hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(
      Promotion.safeParse({
        agent_id: "agent-1",
        sha256_normalized_instructions: hex,
        sha256_skill_blobs: [hex],
        sha256_canonical_tool_config: hex,
        policy_version: 7,
        approver_device_sig: "sig",
      }).success,
    ).toBe(true);
  });
});
