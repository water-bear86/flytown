import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildClusterPrompt,
  buildSpecialistPrompt,
  parseClustersJson,
  pickSeedMorsel,
} from "../specialist.js";
import type { Morsel, GuardVerdict } from "../types.js";

const makeMorsel = (id: string, output: string, reward = 0): Morsel => ({
  id,
  flightId: "flight-1",
  caste: "forager",
  personality: "nerdy",
  model: "gpt-5-mini",
  prompt: "p",
  output,
  reward,
  timestamp: 0,
  drift: {
    casteMentions: { forager: 0, wasp: 0, scout: 0, guard: 0, soldier: 0, messenger: 0 },
    totalCasteWords: 0,
    outputWordCount: output.split(/\s+/).length,
    driftRate: 0,
  },
});

const makeVerdict = (morselId: string, score: number, passed = false): GuardVerdict => ({
  morselId, passed, score, critique: "fails because " + morselId,
});

describe("buildClusterPrompt", () => {
  it("includes task, all foragers, verdicts, and wasp attacks", () => {
    const foragerMorsels = [
      makeMorsel("g0", "first attempt"),
      makeMorsel("g1", "second attempt"),
    ];
    const verdicts = {
      g0: makeVerdict("g0", 0.3),
      g1: makeVerdict("g1", 0.4),
    };
    const waspByForagerId = {
      g0: makeMorsel("gr0", "g0 fails on null input"),
      g1: makeMorsel("gr1", "g1 fails on empty array"),
    };
    const out = buildClusterPrompt({
      task: "TASK_X", foragerMorsels, verdicts, waspMorselByForagerId: waspByForagerId, maxClusters: 3,
    });
    assert.ok(out.includes("TASK_X"));
    assert.ok(out.includes("first attempt"));
    assert.ok(out.includes("g0 fails on null input"));
    assert.ok(out.includes("Forager #0"));
    assert.ok(out.includes("Forager #1"));
    assert.ok(out.includes("clusters"));
    assert.ok(out.includes("severity"));
  });
});

describe("parseClustersJson", () => {
  it("parses a clean cluster array", () => {
    const json = JSON.stringify({
      clusters: [
        { name: "null-handling", description: "ignores null", affectedForagerIndexes: [0, 1], specialistFocus: "handle null", severity: "high" },
        { name: "off-by-one", description: "loop bounds wrong", affectedForagerIndexes: [2], specialistFocus: "fix bounds", severity: "medium" },
      ],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, "null-handling");
    assert.equal(out[0].severity, "high");
    assert.deepEqual(out[0].affectedForagerIndexes, [0, 1]);
  });

  it("strips code fences and leading prose", () => {
    const json = "Here are the clusters:\n```json\n" + JSON.stringify({
      clusters: [{ name: "n", description: "d", affectedForagerIndexes: [], specialistFocus: "f", severity: "low" }],
    }) + "\n```";
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "n");
  });

  it("sorts by severity descending and respects the cap", () => {
    const json = JSON.stringify({
      clusters: [
        { name: "low-thing", description: "x", specialistFocus: "fix x", severity: "low" },
        { name: "high-thing", description: "y", specialistFocus: "fix y", severity: "high" },
        { name: "med-thing", description: "z", specialistFocus: "fix z", severity: "medium" },
        { name: "low-other", description: "w", specialistFocus: "fix w", severity: "low" },
      ],
    });
    const out = parseClustersJson(json, 3, 2);
    assert.equal(out.length, 2);
    assert.equal(out[0].name, "high-thing");
    assert.equal(out[1].name, "med-thing");
  });

  it("filters out invalid forager indexes", () => {
    const json = JSON.stringify({
      clusters: [{ name: "n", description: "d", specialistFocus: "f", affectedForagerIndexes: [0, 5, -1, 2], severity: "high" }],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.deepEqual(out[0].affectedForagerIndexes, [0, 2]);
  });

  it("coerces unknown severity to 'medium'", () => {
    const json = JSON.stringify({
      clusters: [{ name: "n", description: "d", specialistFocus: "f", severity: "catastrophic" }],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out[0].severity, "medium");
  });

  it("drops clusters missing required fields", () => {
    const json = JSON.stringify({
      clusters: [
        { name: "", description: "missing name", specialistFocus: "f", severity: "high" },
        { name: "valid", description: "ok", specialistFocus: "f", severity: "high" },
        { name: "missing-focus", description: "ok", severity: "high" },
      ],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "valid");
  });

  it("returns [] for malformed JSON without throwing", () => {
    const out = parseClustersJson("totally not json", 3, 5);
    assert.deepEqual(out, []);
  });

  it("returns [] when 'clusters' is missing", () => {
    const out = parseClustersJson(JSON.stringify({ stuff: 1 }), 3, 5);
    assert.deepEqual(out, []);
  });

  it("falls back description to specialistFocus when description is empty", () => {
    const json = JSON.stringify({
      clusters: [{ name: "n", description: "", specialistFocus: "do the thing", severity: "high" }],
    });
    const out = parseClustersJson(json, 3, 5);
    assert.equal(out[0].description, "do the thing");
  });
});

describe("buildSpecialistPrompt", () => {
  it("includes task, focus, severity, seed, and wasp critique", () => {
    const out = buildSpecialistPrompt({
      task: "TASK_Y",
      cluster: { name: "n", description: "DESCR", specialistFocus: "FOCUS", affectedForagerIndexes: [0], severity: "high" },
      seedMorsel: makeMorsel("seed-1", "SEED_OUTPUT"),
      seedWaspCritique: "WASP_SAID",
    });
    assert.ok(out.includes("TASK_Y"));
    assert.ok(out.includes("FOCUS"));
    assert.ok(out.includes("DESCR"));
    assert.ok(out.includes("SEED_OUTPUT"));
    assert.ok(out.includes("WASP_SAID"));
    assert.ok(out.includes("high"));
  });

  it("works without a wasp critique", () => {
    const out = buildSpecialistPrompt({
      task: "T",
      cluster: { name: "n", description: "d", specialistFocus: "f", affectedForagerIndexes: [], severity: "low" },
      seedMorsel: makeMorsel("s", "S"),
    });
    assert.ok(out.includes("T"));
    assert.ok(!out.includes("Wasp's specific complaint"));
  });
});

describe("pickSeedMorsel", () => {
  it("returns the highest-reward forager", () => {
    const morsels = [
      makeMorsel("a", "x", 0.2),
      makeMorsel("b", "y", 0.5),
      makeMorsel("c", "z", 0.1),
    ];
    const seed = pickSeedMorsel(morsels, {});
    assert.equal(seed?.id, "b");
  });

  it("falls back to highest verdict score when reward is missing", () => {
    const morsels = [
      makeMorsel("a", "x"),
      makeMorsel("b", "y"),
    ];
    delete morsels[0].reward;
    delete morsels[1].reward;
    const verdicts = {
      a: makeVerdict("a", 0.3),
      b: makeVerdict("b", 0.7),
    };
    const seed = pickSeedMorsel(morsels, verdicts);
    assert.equal(seed?.id, "b");
  });

  it("returns undefined for empty list", () => {
    assert.equal(pickSeedMorsel([], {}), undefined);
  });
});
