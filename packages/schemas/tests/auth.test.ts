import { describe, expect, it } from "vitest";
import { ProofDoc } from "../src/auth.js";
import { EMPTY_BODY_SHA256, sha256Hex } from "../src/node-crypto.js";

const baseProof = {
  v: 1,
  node_id: "node-1",
  session_id: "sess-1",
  device_id: "dev-1",
  method: "GET",
  target: "/v1/agents",
  body_sha256: EMPTY_BODY_SHA256,
  content_type: "application/json",
  content_encoding: "identity",
  iat: 1728000000,
  jti: "0123456789abcdef0123456789abcdef",
  token_sha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
} as const;

describe("ProofDoc", () => {
  it("accepts the frozen schema", () => {
    expect(ProofDoc.safeParse({ ...baseProof }).success).toBe(true);
  });

  it("rejects extra keys, bad digests, and bad encodings", () => {
    expect(
      ProofDoc.safeParse({ ...baseProof, extra: "nope" }).success,
    ).toBe(false);
    expect(
      ProofDoc.safeParse({ ...baseProof, body_sha256: "xyz" }).success,
    ).toBe(false);
    expect(
      ProofDoc.safeParse({ ...baseProof, content_encoding: "deflate" })
        .success,
    ).toBe(false);
    expect(ProofDoc.safeParse({ ...baseProof, v: 2 }).success).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("hashes empty input to the known constant", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(EMPTY_BODY_SHA256);
    expect(sha256Hex("")).toBe(EMPTY_BODY_SHA256);
  });

  it("hashes raw bytes before any decoding", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
