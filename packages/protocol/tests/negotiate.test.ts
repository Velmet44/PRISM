import { describe, expect, it } from "vitest";
import {
  CapabilityAdvertisement,
  negotiateProtocol,
} from "../src/capability.js";

const advertisement: CapabilityAdvertisement = {
  protocol_version: "1.2.0",
  node_version: "0.1.0",
  features: ["durable-events", "mystery-future"],
  models: ["qwen3-30b"],
  remote_access: { mode: "quick_tunnel", limits: ["temp"] },
};

describe("negotiateProtocol", () => {
  it("accepts matching majors and reports unknown features as degraded", () => {
    const result = negotiateProtocol("1.0.0", advertisement, ["durable-events"]);
    expect(result).toEqual({ ok: true, degraded: ["mystery-future"] });
  });

  it("rejects major mismatches as UNSUPPORTED", () => {
    const result = negotiateProtocol("2.0.0", advertisement, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED");
  });
});
