import { describe, expect, it } from "vitest";
import {
  MACHINE_STATES,
  MACHINE_TRANSITIONS,
  assertLegalTransition,
  canTransition,
} from "../src/state-machines.js";

describe("state machines", () => {
  it("accepts every listed legal edge", () => {
    for (const [machine, transitions] of Object.entries(MACHINE_TRANSITIONS)) {
      for (const [from, to] of transitions) {
        expect(canTransition(machine, from, to)).toBe(true);
      }
    }
  });

  it("rejects every unlisted edge", () => {
    for (const [machine, states] of Object.entries(MACHINE_STATES)) {
      const legal = new Set(
        (MACHINE_TRANSITIONS[machine] ?? []).map(([from, to]) => `${from}->${to}`),
      );
      for (const from of states) {
        for (const to of states) {
          if (from === to) continue;
          const expected = legal.has(`${from}->${to}`);
          expect(canTransition(machine, from, to)).toBe(expected);
        }
      }
    }
  });

  it("throws on unknown machines and illegal transitions", () => {
    expect(() => canTransition("nope", "A", "B")).toThrow(/unknown machine/);
    expect(() => assertLegalTransition("approval", "PENDING", "CONSUMED")).toThrow(
      /illegal transition/,
    );
    expect(() =>
      assertLegalTransition("approval", "PENDING", "APPROVED"),
    ).not.toThrow();
  });

  it("covers all eleven required machines", () => {
    expect(Object.keys(MACHINE_TRANSITIONS).sort()).toEqual(
      [
        "agent",
        "approval",
        "browserSession",
        "modelInstallation",
        "node",
        "run",
        "secretStore",
        "stepAttempt",
        "task",
        "trigger",
        "update",
      ].sort(),
    );
  });
});
