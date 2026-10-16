import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { describe, expect, it, vi } from "vitest";
import {
  PrismClient,
  fingerprintHex,
  nodeIdBindingMessage,
  verifyNodeSignature,
} from "../src/index.js";

describe("identity helpers", () => {
  it("round-trips ed25519 sign and verify, rejecting tampering", () => {
    const secret = sha256(new TextEncoder().encode("prism-stage0-test"));
    const publicKey = ed25519.getPublicKey(secret);
    const message = nodeIdBindingMessage("node-1", "ab".repeat(32));
    const signature = ed25519.sign(message, secret);
    expect(verifyNodeSignature(publicKey, message, signature)).toBe(true);
    const tampered = new Uint8Array(signature);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(verifyNodeSignature(publicKey, message, tampered)).toBe(false);
  });

  it("fingerprints raw 32-byte keys as hex sha256", () => {
    const key = new Uint8Array(32).fill(7);
    expect(fingerprintHex(key)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("PrismClient.getCapabilities", () => {
  it("negotiates matching majors and surfaces degraded features", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        protocol_version: "1.0.0",
        node_version: "0.1.0",
        features: ["durable-events", "next-thing"],
        models: [],
        remote_access: { mode: "quick_tunnel", limits: [] },
      }),
    );
    const client = new PrismClient({
      baseUrl: "https://node.example",
      protocolVersion: "1.0.0",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await client.getCapabilities();
    expect(result.degraded).toEqual(["next-thing"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("throws UNSUPPORTED on major mismatch", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        protocol_version: "2.0.0",
        node_version: "0.1.0",
        features: [],
        models: [],
        remote_access: { mode: "quick_tunnel", limits: [] },
      }),
    );
    const client = new PrismClient({
      baseUrl: "https://node.example",
      protocolVersion: "1.0.0",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.getCapabilities()).rejects.toThrow(/UNSUPPORTED/);
  });
});
