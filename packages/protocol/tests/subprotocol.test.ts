import { describe, expect, it } from "vitest";
import {
  WS_SUBPROTOCOL,
  packRedemption,
  parseRedemption,
} from "../src/subprotocol.js";

describe("subprotocol", () => {
  it("packs and parses redemption pairs", () => {
    const value = packRedemption("dGlja2V0", "c2ln");
    expect(value.startsWith(`${WS_SUBPROTOCOL}, `)).toBe(true);
    expect(parseRedemption(value)).toEqual({
      ticketSecretB64: "dGlja2V0",
      signatureB64: "c2ln",
    });
  });

  it("rejects oversize values and incomplete pairs", () => {
    expect(() => packRedemption("a".repeat(5000), "b")).toThrow(/4KB/);
    expect(() => parseRedemption(WS_SUBPROTOCOL)).toThrow();
    expect(() => parseRedemption(`${WS_SUBPROTOCOL}, .sig`)).toThrow();
  });
});
