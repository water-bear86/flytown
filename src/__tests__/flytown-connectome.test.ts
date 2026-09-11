import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ablate, degreeStats, loadConnectome, makeGraph, randomDegreePreserving, shuffleLabels, signless, ConnectomeArtifactError } from "../flytown/connectome/artifact.js";
import { buildSignedGraph, DEFAULT_ENGINE_PARAMS, EngineInvalidStateError, propagate } from "../flytown/connectome/engine.js";
import { defaultAdapters, encode, readout, applyReward } from "../flytown/connectome/adapters.js";
import { FEATURE_NAMES } from "../flytown/signals.js";
import { ORCH_ACTIONS, type OrchAction } from "../flytown/actions.js";

function chain() {
  // A → B → C, plus an inhibitory D → C and a self loop on B
  return makeGraph({
    id: "chain", nodes: ["A", "B", "C", "D"],
    edges: [[0, 1, 10], [1, 2, 10], [3, 2, 10], [1, 1, 2]],
    nt: { ACH: [10, 10, 0, 2], GABA: [0, 0, 10, 0] },
  });
}

describe("engine", () => {
  it("propagates activity along the chain deterministically and stays bounded", () => {
    const g = buildSignedGraph(chain());
    const input = Float64Array.from([1, 0, 0, 0]);
    const a = propagate(g, input);
    const b = propagate(g, input);
    assert.deepEqual(Array.from(a.final), Array.from(b.final));
    assert.ok(a.final[1] > 0 && a.final[2] > 0, "activity reaches B and C");
    for (const v of a.final) assert.ok(v >= 0 && v <= DEFAULT_ENGINE_PARAMS.aMax);
    assert.equal(a.history.length, DEFAULT_ENGINE_PARAMS.steps);
  });
  it("inhibitory input suppresses the target", () => {
    const g = buildSignedGraph(chain());
    const excite = propagate(g, Float64Array.from([1, 0, 0, 0])).final[2];
    const inhibit = propagate(g, Float64Array.from([1, 0, 0, 1])).final[2];
    assert.ok(inhibit < excite, `C should be lower with GABA drive (${inhibit} vs ${excite})`);
    const nosign = propagate(buildSignedGraph(signless(chain())), Float64Array.from([1, 0, 0, 1])).final[2];
    assert.ok(nosign > inhibit, "signless variant treats D→C as excitatory");
  });
  it("recurrence=false is a single feed-forward hop", () => {
    const g = buildSignedGraph(chain());
    const r = propagate(g, Float64Array.from([1, 0, 0, 0]), { ...DEFAULT_ENGINE_PARAMS, recurrence: false });
    assert.equal(r.history.length, 2);
    assert.ok(r.final[1] > 0);
    assert.equal(r.final[2], 0, "C is two hops away and must not be reached without recurrence");
  });
  it("rejects malformed input and non-finite state", () => {
    const g = buildSignedGraph(chain());
    assert.throws(() => propagate(g, Float64Array.from([1, 0])), EngineInvalidStateError);
    assert.throws(() => propagate(g, Float64Array.from([NaN, 0, 0, 0])), EngineInvalidStateError);
  });
  it("in_l1 normalisation bounds total absolute input per node", () => {
    const g = buildSignedGraph(chain());
    const inAbs = new Float64Array(g.n);
    for (let e = 0; e < g.src.length; e++) inAbs[g.dst[e]] += Math.abs(g.w[e]);
    for (const v of inAbs) assert.ok(v <= 1 + 1e-9);
  });
});

describe("null-model transforms", () => {
  it("shuffleLabels keeps every edge and degree statistic, changes the label map", () => {
    const g = chain();
    const s = shuffleLabels(g, 42);
    assert.deepEqual(degreeStats(s), degreeStats(g));
    assert.equal(s.variant, "shuffled");
    assert.deepEqual([...s.index.keys()].sort(), ["A", "B", "C", "D"]);
    const moved = g.nodes.filter((n) => s.index.get(n.id) !== n.index).length;
    assert.ok(moved > 0, "at least one label moved");
  });
  it("randomDegreePreserving preserves in/out edge counts and total weight", () => {
    const g = makeGraph({ id: "ring", nodes: ["a", "b", "c", "d", "e", "f"], edges: [[0, 1, 1], [1, 2, 2], [2, 3, 3], [3, 4, 4], [4, 5, 5], [5, 0, 6], [0, 3, 7], [1, 4, 8]] });
    const r = randomDegreePreserving(g, 7, 50);
    const d0 = degreeStats(g), d1 = degreeStats(r);
    assert.deepEqual(d1.outDegree, d0.outDegree);
    assert.deepEqual(d1.inDegree, d0.inDegree);
    assert.deepEqual(d1.outStrength, d0.outStrength);
    assert.equal(r.src.length, g.src.length);
    const same = Array.from(g.dst).every((v, i) => v === r.dst[i]);
    assert.equal(same, false, "rewiring changed at least one edge");
  });
  it("ablate removes all edges touching a region (by id or base name)", () => {
    const g = makeGraph({ id: "lr", nodes: ["AL_L", "AL_R", "LH_L"], edges: [[0, 2, 5], [1, 2, 5], [2, 0, 1]] });
    const a = ablate(g, ["AL"]);
    assert.equal(a.src.length, 0);
    assert.deepEqual(a.ablatedRegions, ["AL"]);
    const b = ablate(g, ["AL_L"]);
    assert.equal(b.src.length, 1);
    assert.deepEqual(b.ablatedRegions, ["AL_L"]);
    assert.throws(() => ablate(g, ["NOPE"]), ConnectomeArtifactError);
  });
});

describe("adapters", () => {
  it("encoder injects into the regions named for a feature and reports missing ones", () => {
    const g = makeGraph({ id: "mini", nodes: ["AL_L", "AL_R", "ME_L"], edges: [] });
    const x = new Float64Array(FEATURE_NAMES.length);
    x[FEATURE_NAMES.indexOf("complexity")] = 1;
    x[FEATURE_NAMES.indexOf("repo_size")] = 0.5;
    const enc = encode(x, defaultAdapters(), g);
    assert.ok(enc.input[0] > 0 && enc.input[1] > 0, "AL_L and AL_R both driven");
    assert.equal(enc.input[0], enc.input[1]);
    assert.ok(enc.input[2] > 0, "ME_L driven by repo_size");
    assert.ok(enc.missingGroups.includes("LA"));
  });
  it("readout maps regional activity to action scores with contributions", () => {
    const g = makeGraph({ id: "mini", nodes: ["LAL_L", "EB", "PRW"], edges: [] });
    const ro = readout(Float64Array.from([0, 1, 0]), defaultAdapters(), g);
    const top = Object.entries(ro.scores).sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(top, "surface_uncertainty");
    assert.deepEqual(ro.contributions.surface_uncertainty[0][0], "region:EB");
  });
  it("applyReward only touches adapter weights and never the graph", () => {
    const w0 = defaultAdapters();
    const before = w0.readout.spawn_subrite.find((e) => e.group === "LAL")!.weight;
    const scores = Object.fromEntries(ORCH_ACTIONS.map((a) => [a, 1 / ORCH_ACTIONS.length])) as Record<OrchAction, number>;
    const w1 = applyReward({ ...w0, learning: { updates: 0, baseline: 0 } }, { action: "spawn_subrite", scores, activityByGroup: { "region:LAL": 1 }, reward: 1 });
    assert.ok(w1.readout.spawn_subrite.find((e) => e.group === "LAL")!.weight > before);
    assert.equal(w0.readout.spawn_subrite.find((e) => e.group === "LAL")!.weight, before, "input untouched");
    assert.equal(w1.learning?.updates, 1);
  });
});

describe("loadConnectome", () => {
  it("loads a checksummed artifact and rejects a tampered one", async () => {
    const root = await mkdtemp(join(tmpdir(), "flytown-art-"));
    const dir = join(root, "toy-1");
    await mkdir(dir);
    const nodes = JSON.stringify([{ id: "A", index: 0, provenance: "MEASURED" }, { id: "B", index: 1, provenance: "MEASURED" }]);
    const graph = JSON.stringify({ format: "coo", n: 2, src: [0], dst: [1], weight: [3], nt: { ACH: [3] } });
    const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
    const manifest = { artifactVersion: 1, id: "toy-1", level: "projectome", createdAt: "x", source: {}, preprocessing: {}, graph: { nodeCount: 2, edgeCount: 1 }, checksums: { "nodes.json": sha(nodes), "graph.json": sha(graph) } };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(dir, "nodes.json"), nodes);
    await writeFile(join(dir, "graph.json"), graph);
    const g = await loadConnectome("toy-1", { root });
    assert.equal(g.n, 2);
    assert.equal(g.src.length, 1);
    assert.equal(g.nt.ACH[0], 3);
    await writeFile(join(dir, "graph.json"), JSON.stringify({ format: "coo", n: 2, src: [0], dst: [1], weight: [999], nt: { ACH: [999] } }));
    await assert.rejects(loadConnectome("toy-1", { root: root + "/" }), ConnectomeArtifactError);
  });
});
