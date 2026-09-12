import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { crossCasteDrift, measureDrift } from "../drift.js";

describe("measureDrift", () => {
  it("returns a zeroed report for empty input", () => {
    const r = measureDrift("");
    assert.equal(r.totalCasteWords, 0);
    assert.equal(r.outputWordCount, 0);
    assert.equal(r.driftRate, 0);
    for (const k of Object.keys(r.casteMentions)) {
      assert.equal(r.casteMentions[k as keyof typeof r.casteMentions], 0);
    }
  });

  it("counts singular and plural caste mentions with word boundaries", () => {
    const r = measureDrift(
      "the forager met two foragers and a Guard, but ignored the guarding reply.",
    );
    assert.equal(r.casteMentions.forager, 2, "forager + foragers = 2");
    assert.equal(r.casteMentions.guard, 1, "guarding should NOT match guard");
    assert.equal(r.totalCasteWords, 3);
    assert.ok(r.driftRate > 0);
  });

  it("does not double-count plural and singular forms", () => {
    const r = measureDrift("Messengers and messenger. soldier. soldiers.");
    assert.equal(r.casteMentions.messenger, 2);
    assert.equal(r.casteMentions.soldier, 2);
  });

  it("treats unrelated text as zero drift", () => {
    const r = measureDrift("the quick brown fox jumps over the lazy dog");
    assert.equal(r.totalCasteWords, 0);
    assert.equal(r.driftRate, 0);
  });
});

describe("crossCasteDrift", () => {
  it("excludes self-mentions when computing cross-caste drift", () => {
    const text = "forager forager forager scout";
    const cross = crossCasteDrift(text, "forager");
    // 1 cross word (scout) over 4 total words = 0.25
    assert.equal(cross, 0.25);
  });

  it("returns 0 when only self-mentions are present", () => {
    const text = "guard guard guards";
    assert.equal(crossCasteDrift(text, "guard"), 0);
  });

  it("returns 0 for empty input", () => {
    assert.equal(crossCasteDrift("", "forager"), 0);
  });
});
