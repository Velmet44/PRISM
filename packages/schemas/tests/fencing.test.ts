import { describe, expect, it } from "vitest";
import {
  compareFencingToken,
  isStaleFencingToken,
  parseFencingToken,
} from "../src/checkpoints.js";

describe("fencing tokens", () => {
  it("parses epoch:counter", () => {
    expect(parseFencingToken("3:42")).toEqual({ epoch: 3, counter: 42 });
    expect(() => parseFencingToken("3")).toThrow();
    expect(() => parseFencingToken("a:b")).toThrow();
  });

  it("orders by epoch first, then counter", () => {
    expect(compareFencingToken("1:9", "2:0")).toBeLessThan(0);
    expect(compareFencingToken("2:0", "1:99")).toBeGreaterThan(0);
    expect(compareFencingToken("2:3", "2:4")).toBeLessThan(0);
    expect(compareFencingToken("2:4", "2:4")).toBe(0);
  });

  it("detects stale workers across restarts", () => {
    expect(isStaleFencingToken("1:99", "2:0")).toBe(true);
    expect(isStaleFencingToken("2:0", "2:0")).toBe(false);
    expect(isStaleFencingToken("2:1", "2:0")).toBe(false);
  });
});
