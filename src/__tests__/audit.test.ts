import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compost } from "../compost.js";
import { auditFlight, collectFlightMorselIds } from "../audit.js";
import type { Caste, Morsel, Flight, TokenUsage } from "../types.js";

function emptyDrift(rate = 0) {
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
    outputWordCount: 100,
    driftRate: rate,
  };
}

function tokens(t: number, model = "test"): TokenUsage {
  return {
    promptTokens: Math.floor(t * 0.6),
    completionTokens: t - Math.floor(t * 0.6),
    totalTokens: t,
    model,
  };
}

function morsel(
  caste: Caste,
  output: string,
  parents?: string[],
  rate = 0,
  tok = 100,
): Morsel {
  return {
    id: "",
    flightId: "test-flight",
    caste,
    personality: "nerdy",
    model: "test",
    prompt: caste + " prompt " + output,
    output,
    parentMorselIds: parents,
    timestamp: Date.now(),
    drift: emptyDrift(rate),
    usage: tokens(tok),
  };
}

let dir: string;
let compost: Compost;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flytown-audit-"));
  compost = new Compost(join(dir, "compost"));
  await compost.init();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe("auditFlight", () => {
  it("returns null for an unknown flight", async () => {
    const out = await auditFlight(compost, "nope");
    assert.equal(out, null);
  });

  it("aggregates tokens, drift, and longest chain", async () => {
    const scout = morsel("scout", "facts", undefined, 0.0, 80);
    const ra = await compost.stash(scout);
    const forager = morsel("forager", "draft answer", [ra], 0.05, 200);
    const ga = await compost.stash(forager);
    const wasp = morsel("wasp", "attacks", [ga], 0.1, 150);
    const gra = await compost.stash(wasp);
    const guard = morsel("guard", '{"passed":true,"score":0.8,"critique":"ok"}', [
      ga,
      gra,
    ], 0.0, 50);
    const ta = await compost.stash(guard);

    const flight: Flight = {
      id: "r1",
      task: "do thing",
      scanGlobs: ["src/**/*.ts"],
      swarmSize: 1,
      personality: "nerdy",
      contextMorselId: ra,
      foragerMorselIds: [ga],
      stingMorselIds: { [ga]: gra },
      guardVerdicts: {
        [ga]: { morselId: ga, passed: true, score: 0.8, critique: "ok" },
      },
      winnerMorselId: ga,
      outcome: "winner",
      startedAt: 0,
    };
    await compost.stashFlight(flight);
    // Guard morsel lives outside the flight manifest, so audit totals don't
    // include it — the manifest is the source of truth for what's "in" a flight.
    void ta;

    const report = await auditFlight(compost, "r1");
    assert.ok(report);
    assert.equal(report!.totalMorsels, 3, "scout + forager + wasp");
    assert.equal(report!.totalTokens, 80 + 200 + 150);
    assert.equal(report!.byCaste.forager.count, 1);
    assert.equal(report!.byCaste.wasp.count, 1);
    assert.equal(report!.byCaste.scout.count, 1);

    // Highest drift rate is the wasp at 0.1
    assert.ok(report!.highestDrift);
    assert.equal(report!.highestDrift!.caste, "wasp");

    // Longest chain: scout → forager → wasp = depth 3
    assert.equal(report!.longestChain.length, 3);
    assert.deepEqual(report!.longestChain.morselIds, [ra, ga, gra]);
    assert.equal(report!.warnings.length, 0);
  });

  it("warns when soldier_fallback was declared but no soldier morsel is present", async () => {
    const foragerId = await compost.stash(morsel("forager", "fail attempt"));
    const flight: Flight = {
      id: "r2",
      task: "t",
      scanGlobs: [],
      swarmSize: 1,
      personality: "nerdy",
      foragerMorselIds: [foragerId],
      stingMorselIds: {},
      guardVerdicts: {},
      outcome: "soldier_fallback",
      startedAt: 0,
    };
    await compost.stashFlight(flight);
    const report = await auditFlight(compost, "r2");
    assert.ok(report);
    assert.ok(
      report!.warnings.some((w) => w.includes("soldier")),
      "should warn about missing soldier morsel",
    );
  });
});

describe("collectFlightMorselIds", () => {
  it("dedupes across all morsel id sources", () => {
    const r: Flight = {
      id: "r",
      task: "t",
      scanGlobs: [],
      swarmSize: 2,
      personality: "nerdy",
      contextMorselId: "ctx",
      foragerMorselIds: ["g1", "g2", "g1"],
      stingMorselIds: { g1: "x1", g2: "x2" },
      soldierMorselId: "o1",
      guardVerdicts: {},
      outcome: "soldier_fallback",
      startedAt: 0,
    };
    const ids = collectFlightMorselIds(r);
    assert.deepEqual(new Set(ids), new Set(["ctx", "g1", "g2", "x1", "x2", "o1"]));
  });
});
