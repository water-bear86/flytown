import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { FlyMemory, codeSimilarity, keywordSimilarity, hashQuality, spearman } from "../flytown/memory.js";
import { applyMemoryModulation } from "../flytown/baselines/memory-rules.js";
import { rulesScores } from "../flytown/baselines/rules.js";
import { normalizeScores, ORCH_ACTIONS } from "../flytown/actions.js";
import { deriveSignals, type RepoSignals } from "../flytown/signals.js";
import { TASK_CORPUS, corpusByVariant } from "../flytown/eval/corpus.js";
import { makeGraph, type ConnectomeGraph } from "../flytown/connectome/artifact.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryRulesPlannerBackend } from "../flytown/baselines/memory-rules.js";
import { resolvePlannerBackend } from "../flytown/registry.js";
import { canLearn } from "../flytown/planner-backend.js";
import { runHarness } from "../flytown/eval/harness.js";
import { FIXTURES } from "../flytown/eval/fixtures.js";

const EMPTY_REPO: RepoSignals = { present: false, fileCount: 0, languages: {}, hasTests: false, hasPackageManifest: false, frameworks: [], truncated: false };
const sig = (task: string) => deriveSignals({ task, cwd: "/nonexistent", repo: EMPTY_REPO });

/**
 * The minimum structure FlyMemory needs: receptors → projection neurons →
 * Kenyon cells → valence-labelled MBONs, with dopaminergic neurons wired to
 * the MBON compartments and a plasticity spec naming the site.
 */
function memoryLarva(): ConnectomeGraph {
  const nodes: { id: string; groups: string[]; name?: string }[] = [];
  const add = (id: string, groups: string[]) => { nodes.push({ id, groups: [...groups, `node:${id}`], name: id }); return nodes.length - 1; };
  const orn = Array.from({ length: 8 }, (_, i) => add(`ORN${i}`, ["class:sens", "sens:olfactory", "class2:ORN"]));
  const pn = Array.from({ length: 4 }, (_, i) => add(`uPN${i}`, ["class:uPN"]));
  const kc = Array.from({ length: 8 }, (_, i) => add(`KC${i}`, ["flag:KC", "class:KC"]));
  const app = [0, 1].map((i) => add(`MBON-app${i}`, ["flag:MBON", "class:MBON", "class2:app"]));
  const av = [0, 1].map((i) => add(`MBON-av${i}`, ["flag:MBON", "class:MBON", "class2:av"]));
  const danApp = add("DAN-i1", ["class2:DAN", "flag:MBIN"]);
  const danAv = add("DAN-f1", ["class2:DAN", "flag:MBIN"]);
  const edges: [number, number, number][] = [];
  const ch: Record<string, number[]> = { ad: [], aa: [] };
  const link = (a: number, b: number, w: number, type: "ad" | "aa" = "ad") => {
    edges.push([a, b, w]);
    for (const k of Object.keys(ch)) ch[k].push(k === type ? w : 0);
  };
  // Each receptor reaches two projection neurons; each PN reaches a distinct,
  // overlapping subset of Kenyon cells (a sparse random-ish projection).
  orn.forEach((o, i) => { link(o, pn[i % 4], 20); link(o, pn[(i + 1) % 4], 12); });
  pn.forEach((p, i) => kc.forEach((k, j) => { if ((j * 3 + i) % 4 !== 0) link(p, k, 8); }));
  // Every KC drives both valence classes; appetitive DANs innervate the
  // avoidance compartments and vice versa (the measured valence inversion).
  kc.forEach((k) => { for (const m of [...app, ...av]) link(k, m, 6); });
  for (const m of av) link(danApp, m, 30, "aa");
  for (const m of app) link(danAv, m, 30, "aa");
  return makeGraph({
    id: "memory-larva", level: "neuron", nodes, edges, channels: ch,
    plasticity: {
      version: 1,
      plasticEdges: { channel: "ad", preGroup: "flag:KC", postGroup: "flag:MBON", rule: "test", tag: "INFERRED_FROM_LITERATURE" },
      dopaminergic: { appetitive: ["DAN-i1"], aversive: ["DAN-f1"], tag: "INFERRED_FROM_LITERATURE" },
    },
  });
}

describe("code and rank statistics", () => {
  it("codeSimilarity is Jaccard over sparse codes", () => {
    assert.equal(codeSimilarity(Uint32Array.from([1, 2, 3]), Uint32Array.from([1, 2, 3])), 1);
    assert.equal(codeSimilarity(Uint32Array.from([1, 2]), Uint32Array.from([3, 4])), 0);
    assert.equal(codeSimilarity(Uint32Array.from([1, 2, 3]), Uint32Array.from([2, 3, 4])), 0.5);
    assert.equal(codeSimilarity(Uint32Array.from([]), Uint32Array.from([])), 1);
  });
  it("keywordSimilarity is Jaccard over keyword lists", () => {
    assert.equal(keywordSimilarity(["a", "b"], ["a", "b"]), 1);
    assert.equal(keywordSimilarity(["a"], ["b"]), 0);
    assert.equal(keywordSimilarity(["a", "b", "c"], ["b", "c", "d"]), 0.5);
  });
  it("spearman is 1 for monotone agreement, -1 for reversal, 0 for a constant", () => {
    assert.ok(Math.abs(spearman([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-9);
    assert.ok(Math.abs(spearman([1, 2, 3, 4], [40, 30, 20, 10]) + 1) < 1e-9);
    assert.equal(spearman([1, 2, 3], [5, 5, 5]), 0);
  });
  it("hashQuality reports AUC 0.5 when codes carry no category information", () => {
    const same = Uint32Array.from([1, 2, 3]);
    const q = hashQuality([
      { code: same, category: "x", keywords: ["a"] },
      { code: same, category: "x", keywords: ["a"] },
      { code: same, category: "y", keywords: ["a"] },
      { code: same, category: "y", keywords: ["a"] },
    ]);
    assert.equal(q.auc, 0.5);
    assert.equal(q.distinctCodes, 0.25);
  });
  it("hashQuality reports AUC 1 when same-category codes are strictly more similar", () => {
    const q = hashQuality([
      { code: Uint32Array.from([1, 2, 3]), category: "x", keywords: ["a"] },
      { code: Uint32Array.from([1, 2, 4]), category: "x", keywords: ["a"] },
      { code: Uint32Array.from([7, 8, 9]), category: "y", keywords: ["z"] },
      { code: Uint32Array.from([7, 8, 10]), category: "y", keywords: ["z"] },
    ]);
    assert.equal(q.auc, 1);
    assert.ok(q.meanSameSimilarity > q.meanCrossSimilarity);
  });
});

describe("corpus", () => {
  it("covers ten categories with a balanced train/held-out split", () => {
    const cats = new Set(TASK_CORPUS.map((t) => t.category));
    assert.equal(cats.size, 10);
    assert.equal(TASK_CORPUS.length, 80);
    assert.equal(corpusByVariant("a").length, 40);
    assert.equal(corpusByVariant("b").length, 40);
    for (const c of cats) {
      const inCat = TASK_CORPUS.filter((t) => t.category === c);
      assert.equal(inCat.filter((t) => t.variant === "a").length, 4, `${c} training half`);
      assert.equal(inCat.filter((t) => t.variant === "b").length, 4, `${c} held-out half`);
    }
    assert.equal(new Set(TASK_CORPUS.map((t) => t.task)).size, 80, "no duplicate task text");
  });
});

describe("FlyMemory", () => {
  it("fingerprints are sparse, deterministic and task-dependent", async () => {
    const mem = new FlyMemory({ graph: memoryLarva(), sparseness: 0.5 });
    const a = mem.fingerprint(await sig("Fix the crash when a player disconnects mid-tick"));
    const b = mem.fingerprint(await sig("Fix the crash when a player disconnects mid-tick"));
    const c = mem.fingerprint(await sig("Research and compare three ORM options for this codebase"));
    assert.deepEqual(Array.from(a), Array.from(b), "deterministic");
    assert.ok(a.length > 0 && a.length <= 4, `sparse: at most k of the 8 KCs (got ${a.length})`);
    assert.notDeepEqual(Array.from(a), Array.from(c), "different tasks → different codes");
  });
  it("drives receptors only through the keyword odour, never a uniform flood", async () => {
    const mem = new FlyMemory({ graph: memoryLarva(), sparseness: 0.5 });
    const stats = mem.odorStats([await sig("fix the inventory duplication race"), await sig("research three orm options")]);
    assert.ok(stats.receptors > 0);
    assert.ok(stats.meanPairwiseOverlap < 1, `receptor patterns must differ between tasks (got ${stats.meanPairwiseOverlap})`);
  });
  it("storing an outcome depresses only KC→MBON synapses of that task's code", async () => {
    const mem = new FlyMemory({ graph: memoryLarva(), sparseness: 0.5 });
    const s = await sig("Fix the crash when a player disconnects mid-tick");
    const before = mem.recall(s);
    assert.equal(before.valenceShift, 0, "nothing learned yet");
    assert.equal(before.familiarity, 0);
    const res = mem.store(s, 0.1);
    assert.ok(res.changed > 0, "depression touched some synapses");
    const after = mem.recall(s);
    assert.notEqual(after.valenceShift, before.valenceShift, "recall changes after storing");
    assert.ok(after.familiarity > 0, "the code's synapses are now marked");
    assert.equal(mem.episodes, 1);
  });
  it("reset restores the naive graph", async () => {
    const mem = new FlyMemory({ graph: memoryLarva(), sparseness: 0.5 });
    const s = await sig("Fix the off-by-one in the list handler");
    mem.store(s, 0.1);
    assert.ok(mem.recall(s).familiarity > 0);
    mem.reset();
    assert.equal(mem.recall(s).familiarity, 0);
    assert.equal(mem.recall(s).valenceShift, 0);
    assert.equal(mem.episodes, 0);
  });
  it("refuses a connectome with no Kenyon-cell population", async () => {
    const { makeGraph } = await import("../flytown/connectome/artifact.js");
    const g = makeGraph({ id: "no-kc", nodes: ["A", "B"], edges: [[0, 1, 1]] });
    assert.throws(() => new FlyMemory({ graph: g }), /flag:KC/);
  });
});

describe("memory modulation", () => {
  const CAUTION_ACTIONS = ["request_artifact_investigation", "search_memory", "invoke_reviewer", "increase_swarm_size", "surface_uncertainty", "run_tests", "retry_new_approach"] as const;
  const cautionMass = (s: Record<string, number>) => CAUTION_ACTIONS.reduce((t, a) => t + s[a], 0);
  const ambiguous = "CI fails intermittently with a timeout. Not sure if it is the runner or a race. Figure out what is going on.";

  it("a negative retrieved valence shifts mass onto caution and away from going direct", async () => {
    const base = rulesScores(await sig(ambiguous));
    const out = applyMemoryModulation(base, { approach: 0, avoid: 0, valenceShift: -0.2, familiarity: 1, codeSize: 14 });
    assert.equal(out.direction, "caution");
    assert.ok(cautionMass(out.scores) > cautionMass(base), "aggregate caution rises");
    assert.ok(out.scores.spawn_flight < base.spawn_flight, "going direct is damped");
    // The point of interpolating rather than scaling: an action the router
    // scored at exactly zero can still be introduced by experience.
    assert.equal(base.invoke_reviewer, 0);
    assert.ok(out.scores.invoke_reviewer > 0, "a zero-scored action can be introduced");
    const total = ORCH_ACTIONS.reduce((t, a) => t + out.scores[a], 0);
    assert.ok(Math.abs(total - 1) < 1e-9, "still a distribution");
  });
  it("a positive retrieved valence shifts mass onto going direct", async () => {
    const base = rulesScores(await sig(ambiguous));
    const out = applyMemoryModulation(base, { approach: 0, avoid: 0, valenceShift: 0.2, familiarity: 1, codeSize: 14 });
    assert.equal(out.direction, "directness");
    assert.ok(out.scores.spawn_flight > base.spawn_flight);
    assert.ok(cautionMass(out.scores) < cautionMass(base));
    assert.equal(out.scores.terminate_success, base.terminate_success, "memory never pushes toward declaring the task already done");
  });
  it("never blends past the cap, however large the retrieved valence", async () => {
    const base = rulesScores(await sig(ambiguous));
    const out = applyMemoryModulation(base, { approach: 0, avoid: 0, valenceShift: 99, familiarity: 1, codeSize: 14 });
    assert.equal(out.magnitude, 0.5);
    assert.ok(out.scores.request_artifact_investigation > 0, "the router still has a say");
  });
  it("leaves the scores untouched inside the dead zone", async () => {
    const s = await sig("Fix the failing test");
    const base = rulesScores(s);
    const out = applyMemoryModulation(base, { approach: 0, avoid: 0, valenceShift: 0.0001, familiarity: 0, codeSize: 0 });
    assert.equal(out.direction, "none");
    assert.deepEqual(out.scores, base);
    assert.deepEqual(applyMemoryModulation(normalizeScores({ spawn_flight: 1 }), { approach: 0, avoid: 0, valenceShift: NaN, familiarity: 0, codeSize: 0 }).direction, "none");
  });
});

describe("rules+memory planner", () => {
  const task = "Fix the flaky retry test in the payments client";
  const req = (runId: string) => ({ task, cwd: "/nonexistent", repo: EMPTY_REPO, runId });

  it("stores outcomes, persists them, and restores them only onto the same graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "flytown-memrules-"));
    const graph = memoryLarva();
    const first = memoryRulesPlannerBackend({ id: "rules+memory", root, graph });
    const a = await first.plan(req("m1"));
    assert.match(a.trace!.notes.join(" "), /0 episodes stored/);
    await first.learn(a.trace!, 0);
    await first.learn(a.trace!, 0);

    const saved = JSON.parse(await readFile(join(root, ".flytown", "weights", "memory-memory-larva.json"), "utf8"));
    assert.equal(saved.episodes, 2);
    assert.ok(Object.keys(saved.state.multipliers).length > 0, "punishment depressed KC→MBON synapses");

    const again = memoryRulesPlannerBackend({ id: "rules+memory", root, graph: memoryLarva() });
    const b = await again.plan(req("m2"));
    assert.match(b.trace!.notes.join(" "), /2 episodes stored \(2 restored/);
    const original = (await first.getMemory()).recall(a.trace!.signals);
    const restored = (await again.getMemory()).recall(b.trace!.signals);
    assert.ok(original.familiarity > 0, "the stored episodes touched this task's code");
    assert.deepEqual(restored, original, "the restored memory recalls exactly what the original does");

    const shuffled = memoryRulesPlannerBackend({ id: "rules+memory:shuffled", root, graph: memoryLarva(), variant: "shuffled" });
    const c = await shuffled.plan(req("m3"));
    assert.match(c.trace!.notes.join(" "), /0 episodes stored/, "a null-model memory never restores the real one");
  });

  it("is registered, with a shuffled null, and accepts feedback", async () => {
    const root = await mkdtemp(join(tmpdir(), "flytown-memreg-"));
    const real = resolvePlannerBackend("rules+memory", { root, graph: memoryLarva() });
    const nul = resolvePlannerBackend("rules+memory:shuffled", { root, graph: memoryLarva(), seed: 3 });
    assert.equal(real.id, "rules+memory");
    assert.equal(nul.id, "rules+memory:shuffled");
    assert.ok(canLearn(real) && canLearn(nul));
    const t = (await nul.plan(req("r1"))).trace!;
    assert.match(t.notes[0], /\(shuffled\)/);
    assert.notEqual(t.seed, 0, "the trace records the seed the plan id was derived from");
  });

  it("gets outcomes from the evaluation harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "flytown-memharness-"));
    const fixtures = FIXTURES.filter((f) => ["q-engine-layout", "blocked-credentials"].includes(f.id));
    await runHarness({ planners: ["rules+memory"], fixtures, seeds: [1, 2], root, resolve: { graph: memoryLarva() } });
    const saved = JSON.parse(await readFile(join(root, ".flytown", "weights", "memory-memory-larva.json"), "utf8"));
    assert.equal(saved.episodes, fixtures.length * 2, "one stored episode per evaluated run");
  });
});
