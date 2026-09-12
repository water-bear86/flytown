import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compost } from "../compost.js";
import type { Morsel, Foray, Flight } from "../types.js";

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
    outputWordCount: 0,
    driftRate: 0,
  };
}

function makeMorsel(overrides: Partial<Morsel> = {}): Morsel {
  return {
    id: "",
    caste: "forager",
    personality: "nerdy",
    model: "test-model",
    prompt: "p",
    output: "o",
    timestamp: 0,
    drift: emptyDrift(),
    ...overrides,
  };
}

let dir: string;
let compost: Compost;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flytown-test-"));
  compost = new Compost(join(dir, "compost"));
  await compost.init();
});

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("Compost", () => {
  it("assigns a content-addressed id on stash", async () => {
    const id = await compost.stash(makeMorsel());
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it("stash is deterministic for identical (model, prompt, output)", async () => {
    const a = await compost.stash(makeMorsel({ output: "same" }));
    const b = await compost.stash(makeMorsel({ output: "same" }));
    assert.equal(a, b);
  });

  it("stash differs when any of (model, prompt, output) changes", async () => {
    const a = await compost.stash(makeMorsel({ output: "alpha" }));
    const b = await compost.stash(makeMorsel({ output: "beta" }));
    const c = await compost.stash(makeMorsel({ prompt: "different" }));
    const d = await compost.stash(makeMorsel({ model: "another-model" }));
    assert.equal(new Set([a, b, c, d]).size, 4);
  });

  it("getMorsel round-trips a stashed Morsel", async () => {
    const id = await compost.stash(makeMorsel({ output: "hello" }));
    const got = await compost.getMorsel(id);
    assert.ok(got);
    assert.equal(got!.output, "hello");
  });

  it("getMorsel returns null for missing ids", async () => {
    const got = await compost.getMorsel("deadbeef00000000");
    assert.equal(got, null);
  });

  it("allMorsels lists every stashed Morsel", async () => {
    await compost.stash(makeMorsel({ output: "a" }));
    await compost.stash(makeMorsel({ output: "b" }));
    await compost.stash(makeMorsel({ output: "c" }));
    const all = await compost.allMorsels();
    assert.equal(all.length, 3);
  });

  it("stashes and reads forays", async () => {
    const q: Foray = {
      id: "q1",
      task: "t",
      swarmSize: 1,
      personality: "nerdy",
      morselIds: [],
      guardVerdicts: {},
      startedAt: 0,
    };
    await compost.stashForay(q);
    const all = await compost.allForays();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "q1");
  });

  it("stashes and reads flights", async () => {
    const r: Flight = {
      id: "r1",
      task: "t",
      scanGlobs: [],
      swarmSize: 1,
      personality: "nerdy",
      foragerMorselIds: [],
      stingMorselIds: {},
      guardVerdicts: {},
      outcome: "all_failed",
      startedAt: 0,
    };
    await compost.stashFlight(r);
    const got = await compost.getFlight("r1");
    assert.ok(got);
    assert.equal(got!.id, "r1");
  });
});

