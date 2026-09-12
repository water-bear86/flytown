/**
 * The fly planner — a PlannerBackend whose decision substrate is a fixed
 * connectome-derived graph.
 *
 *   signals → encoder → [connectome propagation] → readout → decide → compile
 *
 * Only the middle bracket is biology (MEASURED topology + INFERRED sign +
 * ENGINEERING dynamics). Everything else is shared with the baselines.
 * Variants (shuffled labels, degree-preserving random rewiring, ablation, no
 * recurrence, no sign, adapter learning on/off, synaptic plasticity on/off)
 * are first-class so the evaluation harness can ask whether the real wiring
 * matters.
 *
 * Two independent learning channels:
 *   learning  — adapter (encoder/readout) weights, REINFORCE-style. Ours.
 *   plastic   — designated synapses inside the graph (e.g. larval KC→MBON),
 *               depressed by dopaminergic drive over the real DAN wiring.
 *               Rule and DAN valence from the literature; wiring measured.
 * The connectome topology itself is never modified.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compilePlan, decide, type OrchAction } from "./actions.js";
import { signalsFor, type PlannerBackend, type PlanRequest, type PlanResponse } from "./planner-backend.js";
import { FEATURE_NAMES, featurize } from "./signals.js";
import { hashSeed, makeRng } from "./rng.js";
import { makeTrace, type BrainActivityTrace, type DecisionTrace, type ProvenanceTag } from "./trace.js";
import {
  ablate, DEFAULT_CONNECTOME_ID, groupIndex, loadConnectome, randomDegreePreserving, shuffleLabels, signless,
  type ConnectomeGraph, type ConnectomeVariant,
} from "./connectome/artifact.js";
import { buildSignedGraph, DEFAULT_ENGINE_PARAMS, DEFAULT_SIGN_POLICY, propagate, type EngineParams, type SignedGraph, type SignPolicy } from "./connectome/engine.js";
import { applyReward, defaultAdaptersFor, encode, groupActivity, loadAdapters, readout, readoutPopulation, saveAdapters, type AdapterWeights } from "./connectome/adapters.js";
import { applyPlasticity, emptyPlasticState, plasticPreNodes, DEFAULT_PLASTICITY_PARAMS, type PlasticState, type PlasticityParams } from "./connectome/plasticity.js";

export interface FlyPlannerOptions {
  connectomeId: string;
  /** Pre-loaded graph (tests / harness). When absent, loaded from the artifact root. */
  graph?: ConnectomeGraph;
  connectomeRoot?: string;
  variant?: ConnectomeVariant;
  /** Region ids, base names or group keys to lesion (variant becomes "ablated"). */
  ablateRegions?: string[];
  /** Seed for label shuffling / rewiring. */
  variantSeed?: number;
  engine?: Partial<EngineParams>;
  signPolicy?: SignPolicy;
  /** Drop intra-node (self) edges from the propagation matrix. */
  excludeSelfEdges?: boolean;
  /** Per-channel weighting for synapse-type channels (larva). */
  channelWeights?: Record<string, number>;
  /**
   * k-WTA sparse coding for named populations. Default: Kenyon cells at 10%
   * when the artifact has a `flag:KC` group (see engine.ts); pass [] to
   * disable (variant "nosparse").
   */
  sparseGroups?: { group: string; fraction: number }[];
  adapters?: AdapterWeights;
  /** Directory for learned state (<root>/.flytown/weights). */
  weightsDir?: string;
  /** Adapter learning (encoder/readout weights). */
  learning?: boolean;
  learningRate?: number;
  /** Synaptic plasticity at the artifact's designated plastic edges. */
  plastic?: boolean;
  plasticParams?: Partial<PlasticityParams>;
  /** Pre-loaded plastic multipliers (frozen evaluation after training). */
  plasticState?: PlasticState;
  /** Sample the primary action ∝ readout scores (training only; evaluation is greedy). */
  explore?: boolean;
  /** Planner id override (used to label variants in traces). */
  id?: string;
}

interface Prepared { graph: ConnectomeGraph; signed: SignedGraph; groups: Map<string, number[]>; plasticPre: number[] }

/**
 * Planner spec for these options, in the registry's grammar
 * (`fly:connectome=<id>+shuffled+ablate=A,B+plastic`), so a trace's plannerId
 * names the brain it ran on and `resolveFlyOptions(flyPlannerSpec(o))`
 * rebuilds the same planner. Covers every option the spec grammar can
 * express; the rest (preloaded graph/adapters/plastic state, sign policy,
 * variant seed, exploration) are recorded elsewhere in the trace.
 */
export function flyPlannerSpec(opts: FlyPlannerOptions): string {
  const flags: string[] = [];
  if (opts.connectomeId && opts.connectomeId !== DEFAULT_CONNECTOME_ID) flags.push(`connectome=${opts.connectomeId}`);
  if (opts.variant && opts.variant !== "real" && opts.variant !== "ablated") flags.push(opts.variant);
  if (opts.ablateRegions?.length) flags.push(`ablate=${opts.ablateRegions.join(",")}`);
  if (opts.engine?.recurrence === false) flags.push("norecurrence");
  if (opts.excludeSelfEdges) flags.push("noself");
  if (opts.engine?.divisive) flags.push(`div=${opts.engine.divisive}`);
  if (opts.engine?.gain !== undefined) flags.push(`gain=${opts.engine.gain}`);
  if (opts.engine?.steps !== undefined) flags.push(`steps=${opts.engine.steps}`);
  if (opts.engine?.leak !== undefined) flags.push(`leak=${opts.engine.leak}`);
  if (opts.engine?.inputSteps !== undefined) flags.push(`insteps=${opts.engine.inputSteps}`);
  if (opts.sparseGroups && opts.sparseGroups.length === 0) flags.push("nosparse");
  else if (opts.sparseGroups?.length) flags.push(`sparse=${opts.sparseGroups.map((s) => `${s.group}@${s.fraction}`).join(",")}`);
  if (opts.channelWeights && Object.keys(opts.channelWeights).length) flags.push(`channels=${Object.entries(opts.channelWeights).map(([k, v]) => `${k}:${v}`).join(",")}`);
  if (opts.learning) flags.push("learning");
  if (opts.learningRate !== undefined) flags.push(`lr=${opts.learningRate}`);
  if (opts.plastic) flags.push("plastic");
  if (opts.plasticParams?.lr !== undefined) flags.push(`plr=${opts.plasticParams.lr}`);
  return flags.length ? `fly:${flags.join("+")}` : "fly";
}

/**
 * Seed key in the planner-id format used before 2026-09-12. Exploration draws
 * and plan ids derive from it, so recorded experiments (including the
 * pre-registered larva run) reproduce exactly. Do not change it.
 */
function legacySeedKey(opts: FlyPlannerOptions): string {
  const parts = ["fly"];
  if (opts.variant && opts.variant !== "real") parts.push(opts.variant);
  if (opts.ablateRegions?.length) parts.push(`ablate=${opts.ablateRegions.join("+")}`);
  if (opts.engine?.recurrence === false) parts.push("norecurrence");
  if (opts.excludeSelfEdges) parts.push("noself");
  if (opts.engine?.divisive) parts.push(`div=${opts.engine.divisive}`);
  if (opts.engine?.gain !== undefined) parts.push(`gain=${opts.engine.gain}`);
  if (opts.engine?.steps !== undefined) parts.push(`steps=${opts.engine.steps}`);
  if (opts.engine?.leak !== undefined) parts.push(`leak=${opts.engine.leak}`);
  if (opts.engine?.inputSteps !== undefined) parts.push(`insteps=${opts.engine.inputSteps}`);
  if (opts.sparseGroups && opts.sparseGroups.length === 0) parts.push("nosparse");
  else if (opts.sparseGroups?.length) parts.push(`sparse=${opts.sparseGroups.map((s) => `${s.group}@${s.fraction}`).join("+")}`);
  if (opts.learning) parts.push("learning");
  if (opts.plastic) parts.push("plastic");
  return parts.join(":");
}

const FULL_ACTIVITY_MAX_NODES = 200;

export class FlyPlannerBackend implements PlannerBackend {
  readonly id: string;
  private readonly seedKey: string;
  private prepared?: Promise<Prepared>;
  private adapters?: AdapterWeights;
  private plasticState: PlasticState;
  private readonly engine: EngineParams;
  private readonly weightsFile?: string;
  private readonly plasticFile?: string;

  constructor(private readonly opts: FlyPlannerOptions) {
    this.id = opts.id ?? flyPlannerSpec(opts);
    this.seedKey = opts.id ?? legacySeedKey(opts);
    this.engine = { ...DEFAULT_ENGINE_PARAMS, ...(opts.engine ?? {}) };
    this.weightsFile = opts.weightsDir ? join(opts.weightsDir, `${opts.connectomeId}.adapters.json`) : undefined;
    this.plasticFile = opts.weightsDir ? join(opts.weightsDir, `${opts.connectomeId}.plastic.json`) : undefined;
    this.plasticState = opts.plasticState ?? emptyPlasticState();
  }

  private async prepare(): Promise<Prepared> {
    if (!this.prepared) {
      this.prepared = (async () => {
        let graph = this.opts.graph ?? (await loadConnectome(this.opts.connectomeId, { root: this.opts.connectomeRoot }));
        const seed = this.opts.variantSeed ?? 1;
        switch (this.opts.variant ?? "real") {
          case "shuffled": graph = shuffleLabels(graph, seed); break;
          case "random_degree": graph = randomDegreePreserving(graph, seed); break;
          case "signless": graph = signless(graph); break;
          default: break;
        }
        if (this.opts.ablateRegions?.length) graph = ablate(graph, this.opts.ablateRegions);
        if (this.opts.plastic && !this.opts.plasticState && this.plasticFile) {
          try { this.plasticState = JSON.parse(await readFile(this.plasticFile, "utf8")) as PlasticState; } catch { /* fresh */ }
        }
        const hasKC = graph.nodes.some((n) => (n.groups ?? []).includes("flag:KC"));
        const sparseGroups = this.opts.sparseGroups ?? (hasKC ? [{ group: "flag:KC", fraction: 0.1 }] : []);
        const signed = buildSignedGraph(graph, {
          policy: this.opts.signPolicy ?? DEFAULT_SIGN_POLICY, excludeSelfEdges: this.opts.excludeSelfEdges,
          channelWeights: this.opts.channelWeights, plastic: !!this.opts.plastic, plasticMultipliers: this.plasticState.multipliers,
          sparseGroups,
        });
        return { graph, signed, groups: groupIndex(graph), plasticPre: plasticPreNodes(graph) };
      })();
    }
    return this.prepared;
  }

  private async getAdapters(graph: ConnectomeGraph): Promise<AdapterWeights> {
    if (!this.adapters) {
      const fallback = defaultAdaptersFor(graph);
      this.adapters = this.opts.adapters ?? (this.opts.learning && this.weightsFile ? await loadAdapters(this.weightsFile, fallback) : fallback);
    }
    return this.adapters;
  }

  async plan(req: PlanRequest): Promise<PlanResponse> {
    const { graph, signed, groups, plasticPre } = await this.prepare();
    const adapters = await this.getAdapters(graph);
    const signals = await signalsFor(req);
    const x = featurize(signals);
    const enc = encode(x, adapters, graph, groups, signals.keywords);
    const prop = propagate(signed, enc.input, this.engine);
    const ro = readout(prop.final, adapters, graph, groups);
    const runId = req.runId ?? `fly-${randomUUID().slice(0, 8)}`;
    const seed = hashSeed(this.seedKey, runId, req.replanDepth ?? 0);
    const decision = decide(ro.scores, signals, this.opts.explore ? { explore: { rng: makeRng(hashSeed(seed, "explore")) } } : {});
    const plan = compilePlan(decision, signals, { maxNodes: req.maxNodes, plannerId: this.id, planIdSeed: seed.toString(16) });

    const full = graph.n <= FULL_ACTIVITY_MAX_NODES;
    const nodeId = (i: number) => graph.nodes[i].id;
    const toRecord = (v: Float64Array) => Object.fromEntries(Array.from(v, (val, i) => [nodeId(i), round(val)]));
    const groupRecord = (v: Float64Array) => Object.fromEntries(Object.entries(groupActivity(v, graph, groups, false)).map(([g, val]) => [g, round(val)]));
    const inputRecord = full ? toRecord(enc.input) : Object.fromEntries(Object.entries(groupRecord(enc.input)).filter(([, v]) => v > 0));
    const steps = prop.history.map((h, t) => ({ t, activity: full ? toRecord(h) : (t === prop.history.length - 1 || t === 0 ? groupRecord(h) : {}) }));
    const eligibility = plasticPre.length ? Object.fromEntries(plasticPre.filter((i) => prop.final[i] > 1e-3).map((i) => [nodeId(i), round(prop.final[i])])) : undefined;
    // Activity of the readout populations at decision time (max-normalised), so
    // adapter learning can address individual output neurons.
    let maxAct = 0;
    for (let i = 0; i < prop.final.length; i++) if (prop.final[i] > maxAct) maxAct = prop.final[i];
    const readoutActivity = Object.fromEntries(readoutPopulation(adapters, groups).filter((i) => prop.final[i] > 1e-3).map((i) => [nodeId(i), round(maxAct > 0 ? prop.final[i] / maxAct : 0)]));
    const brain: BrainActivityTrace = {
      connectomeId: graph.id,
      level: graph.manifest.level,
      variant: graph.variant,
      ablatedRegions: graph.ablatedRegions,
      recurrence: this.engine.recurrence,
      weightsVersion: adapters.version,
      plasticVersion: this.opts.plastic ? this.plasticState.version : undefined,
      engine: { steps: prop.params.steps, leak: prop.params.leak, gain: prop.params.gain, inputSteps: prop.params.inputSteps, aMax: prop.params.aMax, divisive: prop.params.divisive, excludeSelfEdges: !!this.opts.excludeSelfEdges, normalization: signed.normalization, signSource: signed.signSource, signPolicy: JSON.stringify(signed.policy), variantSeed: graph.variantSeed, nodes: graph.n, edges: graph.src.length, plasticEdges: signed.plastic?.edge.length ?? 0, sparse: (signed.sparse ?? []).map((s) => `${s.group}:${s.k}/${s.idx.length}`).join(",") || "none" },
      input: inputRecord,
      steps,
      readoutContributions: Object.fromEntries(Object.entries(ro.contributions).map(([a, c]) => [a, c.map(([r, v]) => [r, round(v)] as [string, number])])),
      stats: { ...prop.stats, maxActivity: round(prop.stats.maxActivity), meanFinalActivity: round(prop.stats.meanFinalActivity) },
      eligibility,
      readoutActivity,
      plastic: signed.plastic ? plasticSummary(signed) : undefined,
    };
    const provenance: Record<string, ProvenanceTag> = {
      "connectome.topology": graph.variant === "real" || graph.variant === "ablated" || graph.variant === "signless" ? "MEASURED" : "ENGINEERING_CHOICE",
      "connectome.weight_magnitude": "ENGINEERING_CHOICE",
      "connectome.sign": signed.signSource === "none" ? "ENGINEERING_CHOICE" : "INFERRED_FROM_LITERATURE",
      "engine.dynamics": "ENGINEERING_CHOICE",
      "adapters.encoder": "METAPHOR",
      "adapters.readout": "METAPHOR",
      "compiler": "ENGINEERING_CHOICE",
    };
    if (signed.plastic) {
      provenance["plasticity.site"] = "MEASURED";
      provenance["plasticity.rule"] = "INFERRED_FROM_LITERATURE";
      provenance["plasticity.dan_valence"] = "INFERRED_FROM_LITERATURE";
      provenance["plasticity.reward_delivery"] = "ENGINEERING_CHOICE";
    }
    const notes: string[] = [];
    if (enc.missingGroups.length) notes.push(`encoder groups absent from graph: ${enc.missingGroups.join(",")}`);
    if (ro.missingGroups.length) notes.push(`readout groups absent from graph: ${ro.missingGroups.join(",")}`);
    if (this.opts.plastic && !signed.plastic) notes.push("plasticity requested but the artifact declares no plastic edges");
    const trace = makeTrace({
      req, plannerId: this.id, runId, seed, signals, scores: ro.scores, decision, plan, brain, provenance, notes,
      features: Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, x[i]])),
      learning: { enabled: !!this.opts.learning || !!this.opts.plastic, applied: [] },
    });
    return { plan, trace };
  }

  /**
   * Reward feedback. Adapter learning (opts.learning) updates readout weights;
   * synaptic plasticity (opts.plastic) depresses designated KC→MBON edges via
   * dopaminergic drive. Both persist versioned state when a weightsDir was
   * given. Returns what was applied, or null when neither channel is on.
   */
  async learn(trace: DecisionTrace, reward: number): Promise<{ adapters?: AdapterWeights; plastic?: PlasticState } | null> {
    if ((!this.opts.learning && !this.opts.plastic) || !trace.brain) return null;
    const { graph, signed, groups } = await this.prepare();
    const applied: string[] = [];
    const out: { adapters?: AdapterWeights; plastic?: PlasticState } = {};
    const last = trace.brain.steps[trace.brain.steps.length - 1]?.activity ?? {};
    if (this.opts.learning) {
      const adapters = await this.getAdapters(graph);
      const byGroup = graph.n <= FULL_ACTIVITY_MAX_NODES ? groupActivity(vectorFromRecord(last, graph), graph, groups) : normalizeRecord(last);
      this.adapters = applyReward(adapters, { action: trace.decision.primary as OrchAction, scores: trace.actionScores, activityByGroup: byGroup, reward, lr: this.opts.learningRate, readoutNodeActivity: trace.brain.readoutActivity });
      if (this.weightsFile) await saveAdapters(this.weightsFile, this.adapters);
      applied.push(`readout.${trace.decision.primary}`);
      out.adapters = this.adapters;
    }
    if (this.opts.plastic && signed.plastic) {
      const eligibility = new Float64Array(graph.n);
      for (const [id, v] of Object.entries(trace.brain.eligibility ?? {})) { const i = graph.index.get(id); if (i !== undefined) eligibility[i] = v; }
      let max = 0;
      for (let i = 0; i < eligibility.length; i++) if (eligibility[i] > max) max = eligibility[i];
      if (max > 0) for (let i = 0; i < eligibility.length; i++) eligibility[i] /= max;
      const res = applyPlasticity(graph, signed, this.plasticState, { eligibility, reward, params: { ...DEFAULT_PLASTICITY_PARAMS, ...(this.opts.plasticParams ?? {}) } });
      this.plasticState = res.state;
      if (this.plasticFile) { await mkdir(dirname(this.plasticFile), { recursive: true }); await writeFile(this.plasticFile, JSON.stringify(this.plasticState, null, 2) + "\n", "utf8"); }
      applied.push(`plastic:${res.update.valence}:${res.update.changed}`);
      out.plastic = this.plasticState;
    }
    trace.learning = { enabled: true, applied };
    return out;
  }

  /** Reset learned adapters and plastic multipliers to defaults (in memory). */
  async resetLearning(): Promise<void> {
    this.adapters = undefined;
    this.plasticState = emptyPlasticState();
    const { signed } = await this.prepare();
    signed.plastic?.multiplier.fill(1);
  }

  /** Current adapter weights (deep copy) — e.g. to freeze after training. */
  async snapshotAdapters(): Promise<AdapterWeights> {
    const { graph } = await this.prepare();
    return JSON.parse(JSON.stringify(await this.getAdapters(graph))) as AdapterWeights;
  }

  /** Current plastic multipliers (deep copy). */
  snapshotPlastic(): PlasticState {
    return JSON.parse(JSON.stringify(this.plasticState)) as PlasticState;
  }

  get options(): FlyPlannerOptions {
    return this.opts;
  }
}

function plasticSummary(signed: SignedGraph): NonNullable<BrainActivityTrace["plastic"]> {
  const m = signed.plastic!.multiplier;
  let sum = 0, min = 1, depressed = 0;
  for (let i = 0; i < m.length; i++) { sum += m[i]; if (m[i] < min) min = m[i]; if (m[i] < 0.999) depressed++; }
  return { edges: m.length, meanMultiplier: round(m.length ? sum / m.length : 1), minMultiplier: round(min), depressedEdges: depressed, rule: signed.plastic!.rule };
}

function vectorFromRecord(rec: Record<string, number>, graph: ConnectomeGraph): Float64Array {
  const v = new Float64Array(graph.n);
  for (const [id, val] of Object.entries(rec)) { const i = graph.index.get(id); if (i !== undefined) v[i] = val; }
  return v;
}

function normalizeRecord(rec: Record<string, number>): Record<string, number> {
  let max = 0;
  for (const v of Object.values(rec)) if (v > max) max = v;
  if (max <= 0) return { ...rec };
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v / max]));
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
