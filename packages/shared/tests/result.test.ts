import { describe, expect, it } from "vitest";
import { assertNever, err, must, ok } from "../src/result.js";

describe("result", () => {
  it("wraps values and errors", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("boom")).toEqual({ ok: false, error: "boom" });
    expect(must(ok(2))).toBe(2);
    expect(() => must(err(new Error("x")))).toThrow(/x/);
    expect(() => assertNever("nope" as never)).toThrow();
  });
});
