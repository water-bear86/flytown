import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compost } from "../compost.js";
import { renderMorselAncestry, renderFlightGraph } from "../graph.js";
import type { Caste, Morsel, Flight } from "../types.js";

function emptyDrift() {
  return {
    casteMentions: {
      forager: 0,
      wasp: 0,
      scout: 0,
      guard: 0,
      soldier: 0,
      messenger: 0,
    },
    totalCasteWords: 0,
    outputWordCount: 1,
    driftRate: 0,
  };
}

function morsel(caste: Caste, output: string, parents?: string[]): Morsel {
  return {
    id: "",
    flightId: "rg1",
    caste,
    personality: "nerdy",
    model: "test",
    prompt: caste + " " + output,
    output,
    parentMorselIds: parents,
    timestamp: Date.now(),
    drift: emptyDrift(),
  };
}

let dir: string;
let compost: Compost;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flytown-graph-"));
  compost = new Compost(join(dir, "compost"));
  await compost.init();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("renderFlightGraph", () => {
  it("returns null for an unknown flight", async () => {
    const out = await renderFlightGraph(compost, "missing");
    assert.equal(out, null);
  });

  it("renders scout, forager, wasp, guard, and soldier rows", async () => {
    const ra = await compost.stash(morsel("scout", "facts"));
    const g1 = await compost.stash(morsel("forager", "draft 1", [ra]));
    const g2 = await compost.stash(morsel("forager", "draft 2", [ra]));
    const x1 = await compost.stash(morsel("wasp", "attacks 1", [g1]));
    const x2 = await compost.stash(morsel("wasp", "attacks 2", [g2]));
    const t1 = await compost.stash(morsel("guard", "verdict 1", [g1, x1]));
    const t2 = await compost.stash(morsel("guard", "verdict 2", [g2, x2]));
    const og = await compost.stash(morsel("soldier", "fallback", [g1, g2]));

    const flight: Flight = {
      id: "rg1",
      task: "render me",
      scanGlobs: [],
      swarmSize: 2,
      personality: "nerdy",
      contextMorselId: ra,
      foragerMorselIds: [g1, g2],
      stingMorselIds: { [g1]: x1, [g2]: x2 },
      soldierMorselId: og,
      guardVerdicts: {
        [g1]: { morselId: g1, passed: false, score: 0.3, critique: "" },
        [g2]: { morselId: g2, passed: false, score: 0.4, critique: "" },
      },
      winnerMorselId: og,
      outcome: "soldier_fallback",
      startedAt: 0,
    };
    await compost.stashFlight(flight);

    const out = await renderFlightGraph(compost, "rg1");
    assert.ok(out);
    assert.match(out!, /scout\s+/);
    assert.match(out!, /forager\s+/);
    assert.match(out!, /wasp/);
    assert.match(out!, /soldier/);
    assert.match(out!, /★ winner \(fallback\)/);
    // Guards should be picked up because their parent is one of the foragers
    assert.ok(out!.includes(t1) || out!.includes(t2));
  });
});

describe("renderMorselAncestry", () => {
  it("walks parent chain back to roots", async () => {
    const root = await compost.stash(morsel("scout", "root"));
    const mid = await compost.stash(morsel("forager", "mid", [root]));
    const top = await compost.stash(morsel("soldier", "top", [mid]));
    const out = await renderMorselAncestry(compost, top);
    assert.ok(out);
    assert.match(out!, /soldier\s+/);
    assert.match(out!, /forager\s+/);
    assert.match(out!, /scout\s+/);
  });

  it("handles cycles without infinite recursion", async () => {
    const a = await compost.stash(morsel("forager", "a"));
    // Tamper: rewrite a's parents to point to itself
    const aMorsel = await compost.getMorsel(a);
    assert.ok(aMorsel);
    aMorsel!.parentMorselIds = [a];
    await compost.stash(aMorsel!);
    const out = await renderMorselAncestry(compost, a);
    assert.ok(out);
    assert.match(out!, /cycle/);
  });
});
