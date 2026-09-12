import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compost } from "../compost.js";
import { exportFlightMarkdown } from "../export.js";
import { compareFlights } from "../compare.js";
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

function morsel(
  flightId: string,
  caste: Caste,
  output: string,
  parents?: string[],
): Morsel {
  return {
    id: "",
    flightId,
    caste,
    personality: "nerdy",
    model: "test-model",
    prompt: "p",
    output,
    parentMorselIds: parents,
    timestamp: Date.now(),
    drift: emptyDrift(),
    usage: {
      promptTokens: 50,
      completionTokens: 50,
      totalTokens: 100,
      model: "test-model",
    },
  };
}

let dir: string;
let compost: Compost;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flytown-export-"));
  compost = new Compost(join(dir, "compost"));
  await compost.init();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function buildFlight(id: string, task: string): Promise<Flight> {
  const foragerId = await compost.stash(morsel(id, "forager", `forager-output-${id}`));
  const winnerMorsel = (await compost.getMorsel(foragerId))!;
  winnerMorsel.reward = 0.7;
  await compost.stash(winnerMorsel);
  const flight: Flight = {
    id,
    task,
    scanGlobs: [],
    swarmSize: 1,
    personality: "nerdy",
    foragerMorselIds: [foragerId],
    stingMorselIds: {},
    guardVerdicts: {
      [foragerId]: {
        morselId: foragerId,
        passed: true,
        score: 0.7,
        critique: "good",
      },
    },
    winnerMorselId: foragerId,
    outcome: "winner",
    startedAt: Date.now(),
    finishedAt: Date.now(),
  };
  await compost.stashFlight(flight);
  return flight;
}

describe("exportFlightMarkdown", () => {
  it("returns null for unknown flight", async () => {
    assert.equal(await exportFlightMarkdown(compost, "nope"), null);
  });

  it("emits a markdown bundle covering task, forager, winner", async () => {
    const r = await buildFlight("rx", "do a thing");
    const md = await exportFlightMarkdown(compost, "rx");
    assert.ok(md);
    assert.match(md!, /# Flight `rx`/);
    assert.match(md!, /## Task/);
    assert.match(md!, /do a thing/);
    assert.match(md!, /## Forager swarm/);
    assert.match(md!, /## Winner/);
    assert.ok(md!.includes(r.winnerMorselId!));
  });
});

describe("compareFlights", () => {
  it("returns null when either flight is missing", async () => {
    await buildFlight("a", "t");
    assert.equal(await compareFlights(compost, "a", "missing"), null);
    assert.equal(await compareFlights(compost, "missing", "a"), null);
  });

  it("flags identical tasks as matching, distinct as not", async () => {
    await buildFlight("a", "the same task");
    await buildFlight("b", "the same task");
    await buildFlight("c", "a different task");
    const ab = await compareFlights(compost, "a", "b");
    const ac = await compareFlights(compost, "a", "c");
    assert.ok(ab);
    assert.ok(ac);
    assert.equal(ab!.taskMatches, true);
    assert.equal(ac!.taskMatches, false);
  });

  it("aggregates total tokens and pass rate per flight", async () => {
    await buildFlight("solo", "t");
    const cmp = await compareFlights(compost, "solo", "solo");
    assert.ok(cmp);
    assert.equal(cmp!.a.totalTokens, 100);
    assert.equal(cmp!.a.totalMorsels, 1);
    assert.equal(cmp!.a.passRate, 1);
  });
});
