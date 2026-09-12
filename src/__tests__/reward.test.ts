import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { sugar } from "../reward.js";
import type { Morsel, GuardVerdict } from "../types.js";

function morsel(output: string, caste: Morsel["caste"] = "forager"): Morsel {
  return {
    id: "x",
    caste,
    personality: "nerdy",
    model: "test",
    prompt: "p",
    output,
    timestamp: 0,
    drift: {
      casteMentions: {
        forager: 0,
        wasp: 0,
        scout: 0,
        guard: 0,
        soldier: 0,
        messenger: 0,
      },
      totalCasteWords: 0,
      outputWordCount: 0,
      driftRate: 0,
    },
  };
}

function verdict(score: number, passed: boolean): GuardVerdict {
  return { morselId: "x", passed, score, critique: "" };
}

describe("sugar", () => {
  it("output passing review hits the pass bonus", () => {
    const r = sugar(morsel("a clean answer"), verdict(0.8, true));
    // 0.8 + 0.1 = 0.9
    assert.equal(r.toFixed(3), "0.900");
  });

  it("output failing review gets no pass bonus", () => {
    const r = sugar(morsel("a clean answer"), verdict(0.4, false));
    assert.equal(r.toFixed(3), "0.400");
  });

  it("does not penalise caste-name mentions (they are ordinary English words)", () => {
    const mentions = sugar(
      morsel("add a guard clause, then scout the codebase for other callers", "forager"),
      verdict(0.9, true),
    );
    const none = sugar(
      morsel("add an early return, then search the codebase for other callers", "forager"),
      verdict(0.9, true),
    );
    assert.equal(mentions, none);
    assert.equal(mentions.toFixed(3), "1.000");
  });

  it("a wall of caste names still scores guardScore + passBonus", () => {
    const wall = "scout wasp soldier ".repeat(100);
    assert.equal(sugar(morsel(wall, "forager"), verdict(0.5, true)).toFixed(3), "0.600");
  });

  it("clamps to [0, 1]", () => {
    const r1 = sugar(morsel("clean"), verdict(2, true));
    const r2 = sugar(morsel("clean"), verdict(-1, false));
    assert.equal(r1, 1);
    assert.equal(r2, 0);
  });
});
