import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ablate, groupIndex, loadConnectome, makeGraph, resolveNodes, shuffleLabels, type PlasticitySpec } from "../flytown/connectome/artifact.js";
import { applySparse, buildSignedGraph, curatedNodeSigns, designatePlasticEdges, propagate } from "../flytown/connectome/engine.js";
import { applyPlasticity, dopaminergicDrive, emptyPlasticState, plasticPreNodes } from "../flytown/connectome/plasticity.js";
import { applyReward, defaultAdaptersFor, encode, groupActivity, readout } from "../flytown/connectome/adapters.js";
import { ORCH_ACTIONS, type OrchAction } from "../flytown/actions.js";
import { FlyPlannerBackend } from "../flytown/fly-planner.js";
import { FEATURE_NAMES } from "../flytown/signals.js";
import { diffPlans } from "../flytown/cli.js";

/**
 * Synthetic mini larva: olfactory & gustatory sensory neurons → PNs → KCs →
 * MBONs → descending neurons; appetitive and aversive DANs innervate
 * different MBON compartments and feed KCs axo-axonically. Real larval
 * group vocabulary, toy wiring.
 */
export function miniLarva() {
  const nodes: { id: string; groups: string[]; name?: string }[] = [];
  const add = (id: string, groups: string[]) => { nodes.push({ id, groups: [...groups, `node:${id}`], name: id }); return nodes.length - 1; };
  const orn = [0, 1, 2, 3].map((i) => add(`ORN${i}`, ["class:sensories", "sens:olfactory", "hemisphere:L"]));
  const grnS = add("GRN-sugar", ["class:sensories", "sens:gustatory", "hemisphere:L"]);
  const grnB = add("GRN-bitter", ["class:sensories", "sens:gustatory", "hemisphere:L"]);
  const noci = add("NOCI", ["class:sensories", "sens:nociceptive"]);
  const vis = add("PR", ["class:sensories", "sens:visual"]);
  const pn = [0, 1].map((i) => add(`PN${i}`, ["class:PNs", "hemisphere:L"]));
  const kc = Array.from({ length: 8 }, (_, i) => add(`KC${i}`, ["class:KCs", "flag:KC", "hemisphere:L"]));
  const mbonA = add("MBON-a1", ["class:MBONs", "flag:MBON"]);
  const mbonB = add("MBON-b1", ["class:MBONs", "flag:MBON"]);
  const mbonC = add("MBON-c1", ["class:MBONs", "flag:MBON"]);
  const danApp = add("DAN-i1", ["class:MBINs", "flag:MBIN"]);
  const danAv = add("DAN-f1", ["class:MBINs", "flag:MBIN"]);
  const lhn = add("LHN0", ["class:LHNs"]);
  const dnv = [0, 1].map((i) => add(`dVNC${i}`, ["class:dVNCs", "flag:DN", "out:DN-VNC"]));
  const dns = add("dSEZ0", ["class:dSEZs", "flag:DN", "out:DN-SEZ"]);
  const rgn = add("RGN0", ["class:RGNs", "out:RGN"]);
  const cn = add("CN0", ["class:CNs"]);
  const fbn = add("FBN0", ["class:FBNs"]);
  const predn = add("pre-dVNC0", ["class:pre-dVNCs"]);
  const edges: [number, number, number][] = [];
  const ch: Record<string, number[]> = { ad: [], aa: [], dd: [], da: [] };
  const link = (a: number, b: number, w: number, type: "ad" | "aa" | "dd" | "da" = "ad") => {
    edges.push([a, b, w]);
    for (const k of Object.keys(ch)) ch[k].push(k === type ? w : 0);
  };
  orn.forEach((o, i) => link(o, pn[i % 2], 20));
  pn.forEach((p, i) => kc.forEach((k, j) => { if ((j + i) % 3 !== 0) link(p, k, 8); }));
  kc.forEach((k, j) => { link(k, mbonA, 6); if (j % 2) link(k, mbonB, 6); if (j % 4 === 0) link(k, mbonC, 4); });
  link(grnS, danApp, 15); link(grnB, danAv, 15); link(noci, danAv, 10);
  link(danApp, mbonA, 5, "aa"); link(danApp, mbonC, 3, "aa"); link(danAv, mbonB, 5, "aa");
  kc.forEach((k) => { link(danApp, k, 2, "aa"); link(danAv, k, 2, "aa"); });
  link(mbonA, dnv[0], 10); link(mbonB, dnv[1], 10); link(mbonC, dns, 8); link(mbonB, rgn, 4);
  link(pn[0], lhn, 12); link(lhn, dnv[0], 6); link(lhn, cn, 5); link(vis, cn, 6); link(cn, dns, 4); link(mbonA, cn, 3);
  // Eschbach-style recurrence: MBON → feedback neuron → DAN; convergence → pre-descending → descending
  link(mbonB, fbn, 5); link(fbn, danApp, 4); link(fbn, danAv, 3); link(cn, predn, 5); link(predn, dnv[1], 6);
  const plasticity: PlasticitySpec = {
    version: 1,
    plasticEdges: { channel: "ad", preGroup: "flag:KC", postGroup: "flag:MBON", rule: "DAN-paired depression (test)", tag: "INFERRED_FROM_LITERATURE" },
    dopaminergic: { appetitive: ["DAN-i1"], aversive: ["DAN-f1"], tag: "INFERRED_FROM_LITERATURE" },
    signs: { byGroup: { "flag:KC": { sign: 1, nt: "acetylcholine" }, "flag:MBIN": { sign: 0, nt: "dopamine" } }, byNode: { "MBON-b1": { sign: -1, nt: "GABA" } }, default: { sign: 1 }, tag: "INFERRED_FROM_LITERATURE" },
  };
  return makeGraph({ id: "mini-larva-1", level: "neuron", nodes, edges, channels: ch, plasticity });
}

describe("groups and curated signs", () => {
  it("resolves group keys, bare region names and node ids", () => {
    const g = miniLarva();
    const groups = groupIndex(g);
    assert.equal(groups.get("flag:KC")!.length, 8);
    assert.deepEqual(resolveNodes(g, "MBON-b1"), [g.index.get("MBON-b1")]);
    assert.equal(resolveNodes(g, "sens:olfactory").length, 4);
    assert.equal(resolveNodes(g, "nope").length, 0);
    const a = ablate(g, ["flag:MBIN"]);
    assert.ok(a.src.length < g.src.length);
    assert.deepEqual(a.ablatedRegions, ["flag:MBIN"]);
  });
  it("uses the curated sign table when no neurotransmitter channels exist", () => {
    const g = miniLarva();
    const s = curatedNodeSigns(g)!;
    assert.equal(s[g.index.get("KC0")!], 1);
    assert.equal(s[g.index.get("DAN-i1")!], 0, "modulatory DANs carry no fast sign");
    assert.equal(s[g.index.get("MBON-b1")!], -1, "byNode overrides default");
    const signed = buildSignedGraph(g);
    assert.equal(signed.signSource, "curated");
    const e = Array.from(g.src).findIndex((s, i) => s === g.index.get("MBON-b1") && g.dst[i] === g.index.get("dVNC1"));
    assert.ok(signed.w[e] < 0, "GABAergic MBON-b1 output is inhibitory");
  });
  it("larval default adapters bind to the larval group vocabulary", () => {
    const g = miniLarva();
    const ad = defaultAdaptersFor(g);
    assert.equal(ad.family, "larva");
    const x = new Float64Array(FEATURE_NAMES.length);
    x[FEATURE_NAMES.indexOf("complexity")] = 1;
    x[FEATURE_NAMES.indexOf("prior_success")] = 1;
    const enc = encode(x, ad, g);
    assert.ok(enc.input[g.index.get("ORN0")!] > 0, "task drives olfactory neurons");
    assert.ok(enc.input[g.index.get("GRN-sugar")!] > 0, "prior success tastes of sugar");
    assert.equal(enc.input[g.index.get("KC0")!], 0, "encoder never drives interneurons");
    const ro = readout(propagate(buildSignedGraph(g), enc.input).final, ad, g);
    for (const entries of Object.values(ad.readout)) for (const e of entries) assert.ok(!e.group.startsWith("sens:"), `readout must not read sensory groups: ${e.group}`);
    assert.ok(Object.values(ro.contributions).some((c) => c.length > 0));
  });
  it("binds every default group to the real larval artifact when it is available", async () => {
    let g;
    try { g = await loadConnectome("l1-larva-winding2023-1"); } catch { return; }
    const ad = defaultAdaptersFor(g);
    const x = new Float64Array(FEATURE_NAMES.length).fill(1);
    const enc = encode(x, ad, g);
    assert.deepEqual(enc.missingGroups, [], `encoder groups missing from artifact: ${enc.missingGroups.join(",")}`);
    const ro = readout(propagate(buildSignedGraph(g, { plastic: true }), enc.input).final, ad, g);
    assert.deepEqual(ro.missingGroups, [], `readout groups missing from artifact: ${ro.missingGroups.join(",")}`);
    assert.ok(designatePlasticEdges(g)!.edge.length > 1000, "thousands of KC→MBON synapses designated plastic");
  });
});

describe("plasticity", () => {
  it("designates only channel-ad KC→MBON edges as plastic", () => {
    const g = miniLarva();
    const p = designatePlasticEdges(g)!;
    assert.ok(p.edge.length > 0);
    for (let i = 0; i < p.edge.length; i++) {
      assert.ok(g.nodes[p.pre[i]].groups!.includes("flag:KC"));
      assert.ok(g.nodes[p.post[i]].groups!.includes("flag:MBON"));
      assert.ok(g.channels.ad[p.edge[i]] > 0);
    }
    assert.equal(plasticPreNodes(g).length, 8);
  });
  it("dopaminergic drive reaches only the compartments the chosen DANs innervate", () => {
    const g = miniLarva();
    const signed = buildSignedGraph(g, { plastic: true });
    const app = dopaminergicDrive(g, signed, "appetitive");
    const av = dopaminergicDrive(g, signed, "aversive");
    assert.ok(app.drive.has(g.index.get("MBON-a1")!) && app.drive.has(g.index.get("MBON-c1")!));
    assert.ok(!app.drive.has(g.index.get("MBON-b1")!));
    assert.ok(av.drive.has(g.index.get("MBON-b1")!) && !av.drive.has(g.index.get("MBON-a1")!));
  });
  it("reward depresses KC→MBON synapses of active KCs in the rewarded compartment only, bounded and resettable", () => {
    const g = miniLarva();
    const signed = buildSignedGraph(g, { plastic: true });
    const elig = new Float64Array(g.n);
    elig[g.index.get("KC0")!] = 1; elig[g.index.get("KC1")!] = 0.5;
    let state = emptyPlasticState();
    ({ state } = applyPlasticity(g, signed, { ...state, baseline: 0 }, { eligibility: elig, reward: 1 }));
    const p = signed.plastic!;
    const mult = (pre: string, post: string) => { const i = Array.from(p.pre).findIndex((a, k) => a === g.index.get(pre) && p.post[k] === g.index.get(post)); return i >= 0 ? p.multiplier[i] : NaN; };
    assert.ok(mult("KC0", "MBON-a1") < 1, "eligible KC → appetitive-DAN compartment depressed");
    assert.ok(mult("KC1", "MBON-a1") < 1 && mult("KC1", "MBON-a1") > mult("KC0", "MBON-a1"), "weaker eligibility → weaker depression");
    assert.equal(mult("KC1", "MBON-b1"), 1, "aversive compartment untouched by appetitive reward");
    assert.equal(mult("KC2", "MBON-a1"), 1, "inactive KC untouched");
    for (const m of p.multiplier) assert.ok(m >= 0.05 && m <= 1);
    assert.ok(Object.keys(state.multipliers).length > 0 && state.updates === 1);
    // aversive reward hits the other compartment
    elig.fill(0); elig[g.index.get("KC1")!] = 1;
    ({ state } = applyPlasticity(g, signed, { ...state, baseline: 0.5 }, { eligibility: elig, reward: 0 }));
    assert.ok(mult("KC1", "MBON-b1") < 1, "punishment depresses the aversive-DAN compartment");
    // depressed synapses change propagation
    const input = new Float64Array(g.n); input[g.index.get("ORN0")!] = 1; input[g.index.get("ORN1")!] = 1;
    const fresh = propagate(buildSignedGraph(g, { plastic: true }), input).final;
    const learned = propagate(signed, input).final;
    assert.notDeepEqual(Array.from(fresh), Array.from(learned));
    assert.ok(learned[g.index.get("MBON-a1")!] <= fresh[g.index.get("MBON-a1")!]);
  });
  it("shuffled labels move the plastic site and DAN identities (the null model still learns, elsewhere)", () => {
    const g = miniLarva();
    const s = shuffleLabels(g, 3);
    const p = designatePlasticEdges(s);
    assert.ok(p, "plastic edges still designated by (now scrambled) labels");
    const real = designatePlasticEdges(g)!;
    assert.notDeepEqual(Array.from(p!.edge), Array.from(real.edge));
  });
});

describe("sparse coding (k-WTA)", () => {
  it("keeps only the k most active Kenyon cells and makes eligibility task-specific", () => {
    const g = miniLarva();
    const dense = buildSignedGraph(g);
    const sparse = buildSignedGraph(g, { sparseGroups: [{ group: "flag:KC", fraction: 0.25 }] });
    assert.equal(sparse.sparse![0].k, 2);
    const kc = groupIndex(g).get("flag:KC")!;
    const ad = defaultAdaptersFor(g);
    ad.keywordOdor = { group: "sens:olfactory", weight: 1, fraction: 0.5, maxKeywords: 2, tag: "METAPHOR" };
    const x = new Float64Array(FEATURE_NAMES.length);
    const inA = encode(x, ad, g, undefined, ["timeout"]).input, inB = encode(x, ad, g, undefined, ["mutex"]).input;
    const activeDense = kc.filter((i) => propagate(dense, inA).final[i] > 1e-6).length;
    const finA = propagate(sparse, inA).final, finB = propagate(sparse, inB).final;
    const activeA = kc.filter((i) => finA[i] > 0), activeB = kc.filter((i) => finB[i] > 0);
    assert.ok(activeDense > 2, "dense model activates most KCs");
    assert.ok(activeA.length <= 2 && activeB.length <= 2, "sparse model keeps ≤ k KCs");
    for (const i of kc) assert.ok(finA[i] >= 0);
  });
  it("applySparse zeroes everything when nothing is positive", () => {
    const v = Float64Array.from([0, 0, 0, 0]);
    applySparse(v, [{ idx: Uint32Array.from([0, 1, 2, 3]), k: 2, group: "t" }]);
    assert.deepEqual(Array.from(v), [0, 0, 0, 0]);
    const w = Float64Array.from([0.1, 0.5, 0.3, 0.9]);
    applySparse(w, [{ idx: Uint32Array.from([0, 1, 2, 3]), k: 2, group: "t" }]);
    assert.deepEqual(Array.from(w), [0, 0.5, 0, 0.9]);
  });
});

describe("odour code and per-node readout", () => {
  it("keywords select deterministic, distinct receptor subsets", () => {
    const g = miniLarva();
    const ad = defaultAdaptersFor(g);
    ad.keywordOdor = { group: "sens:olfactory", weight: 1, fraction: 0.3, maxKeywords: 4, tag: "METAPHOR" };
    const x = new Float64Array(FEATURE_NAMES.length);
    const olf = [0, 1, 2, 3].map((i) => g.index.get(`ORN${i}`)!);
    const words = ["timeout", "contracts", "physics", "deterministic", "cache", "balances", "inventory", "mutex", "rate", "limit", "keychain", "token"];
    const patterns = words.map((w) => encode(x, ad, g, undefined, [w]).input);
    assert.deepEqual(Array.from(encode(x, ad, g, undefined, ["timeout"]).input), Array.from(patterns[0]), "deterministic");
    const distinct = new Set(patterns.map((p) => olf.map((i) => (p[i] > 0 ? 1 : 0)).join("")));
    assert.ok(distinct.size > 1, "different keywords → different receptor subsets");
    // over many keywords, each activates a fraction of the population, not all of it
    const activeCounts = patterns.map((p) => olf.filter((i) => p[i] > 0).length);
    assert.ok(activeCounts.some((n) => n > 0) && activeCounts.every((n) => n < olf.length), `sparse subsets, got ${activeCounts.join(",")}`);
    for (const p of patterns) assert.ok(Array.from(p).every((v, i) => olf.includes(i) || v === 0), "only olfactory neurons driven");
  });
  it("per-node readout weights are learned inside the readout populations and change the score", () => {
    const g = miniLarva();
    const ad = defaultAdaptersFor(g);
    const scores = Object.fromEntries(ORCH_ACTIONS.map((a) => [a, 1 / ORCH_ACTIONS.length])) as Record<OrchAction, number>;
    const activity = new Float64Array(g.n);
    activity[g.index.get("MBON-a1")!] = 1;
    const before = readout(activity, ad, g).scores.retry_new_approach;
    const learned = applyReward({ ...ad, learning: { updates: 0, baseline: 0 } }, { action: "retry_new_approach", scores, activityByGroup: { "flag:MBON": 0.33 }, reward: 1, readoutNodeActivity: { "MBON-a1": 1 } });
    assert.ok(learned.nodeReadout?.retry_new_approach?.["MBON-a1"]! > 0, "rewarded action gains weight on the active MBON");
    assert.ok((learned.nodeReadout?.spawn_flight?.["MBON-a1"] ?? 0) < 0, "competitors lose weight on it");
    const after = readout(activity, ad, g).scores.retry_new_approach;
    assert.equal(after, before, "original table untouched");
    const afterLearned = readout(activity, learned, g).scores.retry_new_approach;
    assert.ok(afterLearned > before);
  });
});

describe("fly planner on a neuron-level substrate", () => {
  const repo = { present: true, fileCount: 300, languages: { ts: 100 }, hasTests: true, hasPackageManifest: true, frameworks: ["typescript"], truncated: false };
  it("plans with plasticity, records eligibility and plastic stats, learns, and replays identically when frozen", async () => {
    const fly = new FlyPlannerBackend({ connectomeId: "mini-larva-1", graph: miniLarva(), plastic: true, learning: true });
    const req = { task: "Fix the crash when a player disconnects mid-tick and add a regression test", cwd: "/nope", repo, runId: "lv-1", extraSignals: { runtimeErrors: 1 } };
    const res = await fly.plan(req);
    const b = res.trace!.brain!;
    assert.equal(b.level, "neuron");
    assert.ok(b.plastic && b.plastic.edges > 0 && b.plastic.depressedEdges === 0);
    assert.ok(b.eligibility && Object.keys(b.eligibility).length > 0, "KC eligibility recorded");
    assert.equal(res.trace!.provenance["plasticity.site"], "MEASURED");
    assert.equal(res.trace!.provenance["plasticity.rule"], "INFERRED_FROM_LITERATURE");
    const out = await fly.learn(res.trace!, 1);
    assert.ok(out?.plastic && out.plastic.updates === 1);
    assert.ok(out?.adapters?.learning?.updates === 1);
    const after = await fly.plan({ ...req, runId: "lv-2" });
    assert.ok(after.trace!.brain!.plastic!.depressedEdges > 0, "second decision sees depressed synapses");
    // frozen copy reproduces the trained planner's decision deterministically
    const frozen = new FlyPlannerBackend({ ...fly.options, adapters: await fly.snapshotAdapters(), plasticState: fly.snapshotPlastic(), learning: false, plastic: true, id: "fly:plastic" });
    const a = await frozen.plan({ ...req, runId: "lv-3" });
    const c = await frozen.plan({ ...req, runId: "lv-3" });
    assert.deepEqual(diffPlans(a.trace!, c.plan, c.trace), []);
    assert.deepEqual(a.trace!.brain!.plastic, after.trace!.brain!.plastic);
  });
  it("large-graph traces store group activity instead of per-node vectors", () => {
    const g = miniLarva();
    const ga = groupActivity(Float64Array.from(g.nodes.map((_, i) => i / g.n)), g);
    assert.ok("flag:KC" in ga && !("node:KC0" in ga));
    assert.ok(Object.values(ga).every((v) => v >= 0 && v <= 1));
  });
});
