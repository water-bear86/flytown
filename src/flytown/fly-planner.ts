/**
 * The fly planner — a PlannerBackend whose decision substrate is a fixed
 * connectome-derived graph.
 *
 *   signals → encoder → [connectome propagation] → readout → decide → compile
 *
 * Only the middle bracket is biology (MEASURED topology + INFERRED sign +
 * ENGINEERING dynamics). Everything else is shared with the baselines.
 * Variants (shuffled labels, degree-preserving random rewiring, region
 * ablation, no recurrence, no NT sign, no learning) are first-class so the
 * evaluation harness can ask whether the real wiring matters.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { compilePlan, decide, type OrchAction } from "./actions.js";
import { signalsFor, type PlannerBackend, type PlanRequest, type PlanResponse } from "./planner-backend.js";
import { FEATURE_NAMES, featurize } from "./signals.js";
import { hashSeed, makeRng } from "./rng.js";
import { makeTrace, type BrainActivityTrace, type DecisionTrace, type ProvenanceTag } from "./trace.js";
import {
  ablate, baseRegion, loadConnectome, randomDegreePreserving, shuffleLabels, signless,
  type ConnectomeGraph, type ConnectomeVariant,
} from "./connectome/artifact.js";
import { buildSignedGraph, DEFAULT_ENGINE_PARAMS, DEFAULT_SIGN_POLICY, propagate, type EngineParams, type SignedGraph, type SignPolicy } from "./connectome/engine.js";
import { applyReward, baseIndex, defaultAdapters, encode, loadAdapters, readout, saveAdapters, type AdapterWeights } from "./connectome/adapters.js";

export interface FlyPlannerOptions {
  connectomeId: string;
  /** Pre-loaded graph (tests / harness). When absent, loaded from the artifact root. */
  graph?: ConnectomeGraph;
  connectomeRoot?: string;
  variant?: ConnectomeVariant;
  /** Region ids or base names to lesion (variant becomes "ablated"). */
  ablateRegions?: string[];
  /** Seed for label shuffling / rewiring. */
  variantSeed?: number;
  engine?: Partial<EngineParams>;
  signPolicy?: SignPolicy;
  /** Drop intra-region (self) edges from the propagation matrix. */
  excludeSelfEdges?: boolean;
  adapters?: AdapterWeights;
  /** Directory for learned adapter weights (<root>/.flytown/weights). */
  weightsDir?: string;
  learning?: boolean;
  learningRate?: number;
  /** Sample the primary action ∝ readout scores (training only; evaluation is greedy). */
  explore?: boolean;
  /** Planner id override (used to label variants in traces). */
  id?: string;
}

interface Prepared { graph: ConnectomeGraph; signed: SignedGraph; bases: Map<string, number[]> }

export class FlyPlannerBackend implements PlannerBackend {
  readonly id: string;
  private prepared?: Promise<Prepared>;
  private adapters?: AdapterWeights;
  private readonly engine: EngineParams;
  private readonly weightsFile?: string;

  constructor(private readonly opts: FlyPlannerOptions) {
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
    if (opts.learning) parts.push("learning");
    this.id = opts.id ?? parts.join(":");
    this.engine = { ...DEFAULT_ENGINE_PARAMS, ...(opts.engine ?? {}) };
    this.weightsFile = opts.weightsDir ? join(opts.weightsDir, `${opts.connectomeId}.adapters.json`) : undefined;
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
        const signed = buildSignedGraph(graph, { policy: this.opts.signPolicy ?? DEFAULT_SIGN_POLICY, excludeSelfEdges: this.opts.excludeSelfEdges });
        return { graph, signed, bases: baseIndex(graph) };
      })();
    }
    return this.prepared;
  }

  private async getAdapters(): Promise<AdapterWeights> {
    if (!this.adapters) {
      this.adapters = this.opts.adapters ?? (this.opts.learning && this.weightsFile ? await loadAdapters(this.weightsFile) : defaultAdapters());
    }
    return this.adapters;
  }

  async plan(req: PlanRequest): Promise<PlanResponse> {
    const { graph, signed, bases } = await this.prepare();
    const adapters = await this.getAdapters();
    const signals = await signalsFor(req);
    const x = featurize(signals);
    const enc = encode(x, adapters, graph, bases);
    const prop = propagate(signed, enc.input, this.engine);
    const ro = readout(prop.final, adapters, graph, bases);
    const runId = req.runId ?? `fly-${randomUUID().slice(0, 8)}`;
    const seed = hashSeed(this.id, runId, req.replanDepth ?? 0);
    const decision = decide(ro.scores, signals, this.opts.explore ? { explore: { rng: makeRng(hashSeed(seed, "explore")) } } : {});
    const plan = compilePlan(decision, signals, { maxNodes: req.maxNodes, plannerId: this.id, planIdSeed: seed.toString(16) });

    const regionId = (i: number) => graph.nodes[i].id;
    const toRecord = (v: Float64Array) => Object.fromEntries(Array.from(v, (val, i) => [regionId(i), round(val)]));
    const brain: BrainActivityTrace = {
      connectomeId: graph.id,
      variant: graph.variant,
      ablatedRegions: graph.ablatedRegions,
      recurrence: this.engine.recurrence,
      weightsVersion: adapters.version,
      engine: { steps: prop.params.steps, leak: prop.params.leak, gain: prop.params.gain, inputSteps: prop.params.inputSteps, aMax: prop.params.aMax, divisive: prop.params.divisive, excludeSelfEdges: !!this.opts.excludeSelfEdges, normalization: signed.normalization, signPolicy: JSON.stringify(signed.policy), variantSeed: graph.variantSeed },
      input: toRecord(enc.input),
      steps: prop.history.map((h, t) => ({ t, activity: toRecord(h) })),
      readoutContributions: Object.fromEntries(Object.entries(ro.contributions).map(([a, c]) => [a, c.map(([r, v]) => [r, round(v)] as [string, number])])),
      stats: { ...prop.stats, maxActivity: round(prop.stats.maxActivity), meanFinalActivity: round(prop.stats.meanFinalActivity) },
    };
    const provenance: Record<string, ProvenanceTag> = {
      "connectome.topology": graph.variant === "real" || graph.variant === "ablated" || graph.variant === "signless" ? "MEASURED" : "ENGINEERING_CHOICE",
      "connectome.weight_magnitude": "ENGINEERING_CHOICE",
      "connectome.sign": graph.variant === "signless" ? "ENGINEERING_CHOICE" : "INFERRED_FROM_LITERATURE",
      "engine.dynamics": "ENGINEERING_CHOICE",
      "adapters.encoder": "METAPHOR",
      "adapters.readout": "METAPHOR",
      "compiler": "ENGINEERING_CHOICE",
    };
    const notes: string[] = [];
    if (enc.missingRegions.length) notes.push(`encoder regions absent from graph: ${enc.missingRegions.join(",")}`);
    if (ro.missingRegions.length) notes.push(`readout regions absent from graph: ${ro.missingRegions.join(",")}`);
    const trace = makeTrace({
      req, plannerId: this.id, runId, seed, signals, scores: ro.scores, decision, plan, brain, provenance, notes,
      features: Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, x[i]])),
      learning: { enabled: !!this.opts.learning, applied: [] },
    });
    return { plan, trace };
  }

  /**
   * Reward feedback (off unless opts.learning). Updates only adapter weights;
   * the connectome is never modified. Persists versioned weights when a
   * weightsDir was given.
   */
  async learn(trace: DecisionTrace, reward: number): Promise<AdapterWeights | null> {
    if (!this.opts.learning || !trace.brain) return null;
    const adapters = await this.getAdapters();
    const last = trace.brain.steps[trace.brain.steps.length - 1]?.activity ?? {};
    const byBase: Record<string, number> = {};
    const counts: Record<string, number> = {};
    let max = 0;
    for (const [id, v] of Object.entries(last)) {
      const b = baseRegion(id);
      byBase[b] = (byBase[b] ?? 0) + v;
      counts[b] = (counts[b] ?? 0) + 1;
    }
    for (const b of Object.keys(byBase)) { byBase[b] /= counts[b]; if (byBase[b] > max) max = byBase[b]; }
    if (max > 0) for (const b of Object.keys(byBase)) byBase[b] /= max;
    this.adapters = applyReward(adapters, { action: trace.decision.primary as OrchAction, scores: trace.actionScores, activityByBase: byBase, reward, lr: this.opts.learningRate });
    if (this.weightsFile) await saveAdapters(this.weightsFile, this.adapters);
    trace.learning = { enabled: true, applied: [`readout.${trace.decision.primary}`] };
    return this.adapters;
  }

  /** Reset learned adapters to defaults (in memory; caller deletes the file if desired). */
  resetLearning(): void {
    this.adapters = defaultAdapters();
  }

  /** Current adapter weights (deep copy) — e.g. to freeze after training. */
  async snapshotAdapters(): Promise<AdapterWeights> {
    return JSON.parse(JSON.stringify(await this.getAdapters())) as AdapterWeights;
  }

  get options(): FlyPlannerOptions {
    return this.opts;
  }
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
