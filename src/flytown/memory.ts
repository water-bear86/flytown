/**
 * FlyMemory — the mushroom body doing its actual job: associative memory.
 *
 * Three live/mock experiments put the connectome in the per-task *decision*
 * seat and found the same null every time: the fly collapses to a constant
 * policy, so the real wiring is indistinguishable from a shuffled copy. The
 * diagnosis was not "the graph is wrong" but "the job is wrong" — action
 * selection needs task-dependent output, and a fixed-point readout of a
 * recurrent graph is nearly task-invariant.
 *
 * Associative memory is the job the mushroom body demonstrably has, and it is
 * the one role where the established computational claim about this circuit is
 * precise enough to falsify:
 *
 *   Kenyon-cell sparse codes are a locality-sensitive hash. Similar odours
 *   (here: similar tasks) get overlapping KC codes, so an association learned
 *   at KC→MBON synapses for one odour generalises to similar odours.
 *   (Dasgupta, Stevens & Navlakha, Science 2017 — "A neural algorithm for a
 *   fundamental computing problem"; the fly's sparse random projection plus
 *   winner-take-all beats conventional LSH at similarity search.)
 *
 * So FlyMemory:
 *   fingerprint(task)  MEASURED pathway — ORN/sensory drive → real PN→KC
 *                      wiring → k-WTA. The code is the hash.
 *   store(code, reward) INFERRED_FROM_LITERATURE rule — DAN-gated depression
 *                      of KC→MBON at exactly the synapses the connectome says
 *                      exist, via the appetitive or aversive dopaminergic set.
 *   recall(code)       MEASURED readout — drive onto approach-driving vs
 *                      avoidance-driving MBONs, compared against the same
 *                      graph with plasticity reset. The *shift* is the
 *                      retrieved memory: "tasks that smell like this went
 *                      well / badly".
 *
 * ENGINEERING_CHOICE: what an orchestrator does with that valence (see
 * baselines/memory-rules.ts). METAPHOR: calling a task an odour at all.
 *
 * Nothing here writes to the connectome. Memory lives in the multiplier
 * table (PlasticState), which is versioned, inspectable and resettable.
 */
import { groupIndex, normalizeGroupKey, type ConnectomeGraph } from "./connectome/artifact.js";
import { buildSignedGraph, propagate, DEFAULT_ENGINE_PARAMS, type EngineParams, type SignedGraph, designatePlasticEdges } from "./connectome/engine.js";
import { applyPlasticity, emptyPlasticState, DEFAULT_PLASTICITY_PARAMS, type PlasticityParams, type PlasticState } from "./connectome/plasticity.js";
import { defaultAdaptersFor, encode, resolveGroupKey, type AdapterWeights } from "./connectome/adapters.js";
import { featurize, type TaskSignals } from "./signals.js";

/** A Kenyon-cell sparse code: the node indices that won k-WTA, sorted. */
export type KcCode = Uint32Array;

export interface FlyMemoryOptions {
  graph: ConnectomeGraph;
  adapters?: AdapterWeights;
  engine?: Partial<EngineParams>;
  plasticParams?: Partial<PlasticityParams>;
  /** fraction of the KC population kept active (default 0.1) */
  sparseness?: number;
  /** group holding the plastic pre-population; defaults to the artifact's spec */
  kcGroup?: string;
  state?: PlasticState;
  /**
   * How the code is computed.
   *
   * "feedforward" (default) walks the measured pathway the fly-hashing
   *   literature actually describes: sensory neurons → projection neurons →
   *   Kenyon cells → k-winners-take-all, one hop at a time, no recurrence.
   * "recurrent" reads the Kenyon cells at the fixed point of the whole-brain
   *   simulation. Kept because it is what the planner's readout uses, and
   *   because the difference between the two is itself a finding.
   */
  pathway?: "feedforward" | "recurrent";
  /** ordered layer group specs for the feedforward pathway */
  layers?: string[];
  /**
   * Fraction of the receptor population each task keyword activates. The
   * default adapters use 0.15, which was tuned for the planner's readout; with
   * only 42 larval ORNs and up to six keywords that saturates the input layer
   * and leaves the odour nearly task-independent, so memory overrides it.
   * ENGINEERING_CHOICE — swept in the hash experiment.
   */
  odorFraction?: number;
  /**
   * Drive the receptor layer ONLY with the keyword odour code (default true).
   *
   * The planner's encoder also sends a uniform "stimulus intensity" term to
   * every olfactory receptor, which — measured — saturated all 42 larval ORNs
   * for every task (receptor overlap 1.000), leaving the odour carrying no
   * task identity. A sparse, task-specific odour is the premise of the
   * locality-sensitive-hash claim, so the memory path removes any encoder
   * entry that targets the receptor population wholesale.
   */
  sparseOdorOnly?: boolean;
}

/** sensory → projection neurons → Kenyon cells (larval group vocabulary, with fallbacks) */
export const DEFAULT_PATHWAY_LAYERS = ["class:uPN|class:PN|class:PNs", "flag:KC|class:KC"];

export interface RecallResult {
  /** mean drive onto approach-driving MBONs, learned graph */
  approach: number;
  /** mean drive onto avoidance-driving MBONs, learned graph */
  avoid: number;
  /** (approach − avoid) learned minus (approach − avoid) with plasticity reset */
  valenceShift: number;
  /** how much of the code's KC→MBON mass has been depressed at all, 0..1 */
  familiarity: number;
  codeSize: number;
}

export class FlyMemory {
  readonly graph: ConnectomeGraph;
  readonly adapters: AdapterWeights;
  readonly engine: EngineParams;
  readonly kcIdx: Uint32Array;
  private readonly groups: Map<string, number[]>;
  private readonly signed: SignedGraph;
  /** same topology with multipliers pinned at 1 — the "naive" comparison */
  private readonly naive: SignedGraph;
  private readonly approachIdx: number[];
  private readonly avoidIdx: number[];
  private readonly plasticParams: PlasticityParams;
  private readonly pathway: "feedforward" | "recurrent";
  private readonly layerIdx: Uint32Array[];
  state: PlasticState;
  episodes = 0;

  constructor(opts: FlyMemoryOptions) {
    this.graph = opts.graph;
    const baseAdapters = opts.adapters ?? defaultAdaptersFor(opts.graph);
    let adapters = baseAdapters;
    if (opts.odorFraction !== undefined && adapters.keywordOdor) {
      adapters = { ...adapters, keywordOdor: { ...adapters.keywordOdor, fraction: opts.odorFraction } };
    }
    if (opts.sparseOdorOnly !== false && adapters.keywordOdor) {
      const odorGroup = adapters.keywordOdor.group;
      const encoder: typeof adapters.encoder = {};
      for (const [feature, entries] of Object.entries(adapters.encoder)) {
        const kept = (entries ?? []).filter((e) => e.group !== odorGroup);
        if (kept.length) encoder[feature as keyof typeof adapters.encoder] = kept;
      }
      adapters = { ...adapters, encoder };
    }
    this.adapters = adapters;
    this.odorFraction = opts.odorFraction;
    this.engine = { ...DEFAULT_ENGINE_PARAMS, ...(opts.engine ?? {}) };
    this.plasticParams = { ...DEFAULT_PLASTICITY_PARAMS, ...(opts.plasticParams ?? {}) };
    this.groups = groupIndex(opts.graph);
    this.state = opts.state ?? emptyPlasticState();
    const kcGroup = normalizeGroupKey(opts.kcGroup ?? opts.graph.plasticity?.plasticEdges?.preGroup ?? "flag:KC");
    const kc = this.groups.get(kcGroup);
    if (!kc || kc.length === 0) throw new Error(`FlyMemory: connectome "${opts.graph.id}" has no ${kcGroup} population (needed for the sparse code)`);
    this.kcIdx = Uint32Array.from(kc);
    const sparse = [{ group: kcGroup, fraction: opts.sparseness ?? 0.1 }];
    this.signed = buildSignedGraph(opts.graph, { plastic: true, plasticMultipliers: this.state.multipliers, sparseGroups: sparse });
    this.naive = buildSignedGraph(opts.graph, { plastic: true, sparseGroups: sparse });
    this.approachIdx = resolveGroupKey(this.groups, "class2:app|flag:MBON")?.idx ?? [];
    this.avoidIdx = resolveGroupKey(this.groups, "class2:av|flag:MBON")?.idx ?? [];
    this.pathway = opts.pathway ?? "feedforward";
    this.layerIdx = (opts.layers ?? DEFAULT_PATHWAY_LAYERS).map((spec) => {
      const hit = resolveGroupKey(this.groups, spec);
      if (!hit) throw new Error(`FlyMemory: pathway layer "${spec}" not present in ${opts.graph.id}`);
      return Uint32Array.from(hit.idx);
    });
    this.sparseK = Math.max(1, Math.round(this.kcIdx.length * (opts.sparseness ?? 0.1)));
  }

  private readonly sparseK: number;
  readonly odorFraction?: number;

  /** Receptor-layer statistics for the current encoder — how sparse is the odour really? */
  odorStats(signalsList: TaskSignals[]): { meanActiveReceptors: number; receptors: number; meanPairwiseOverlap: number } {
    const sens = resolveGroupKey(this.groups, "sens:olfactory|class2:ORN")?.idx ?? [];
    const patterns = signalsList.map((s) => {
      const v = this.input(s);
      return new Set(sens.filter((i) => v[i] > 0));
    });
    let sum = 0, pairs = 0;
    for (let i = 0; i < patterns.length; i++) {
      for (let j = i + 1; j < patterns.length; j++) {
        const a = patterns[i], b = patterns[j];
        let inter = 0;
        for (const x of b) if (a.has(x)) inter++;
        const union = a.size + b.size - inter;
        sum += union > 0 ? inter / union : 0;
        pairs++;
      }
    }
    return {
      meanActiveReceptors: patterns.length ? patterns.reduce((s, p) => s + p.size, 0) / patterns.length : 0,
      receptors: sens.length,
      meanPairwiseOverlap: pairs ? sum / pairs : 0,
    };
  }

  /**
   * One feedforward hop: sum signed input from `from` into every node of `to`.
   * Only measured edges are used; nothing recurrent, nothing skipped.
   */
  private hop(activity: Float64Array, from: Uint32Array, to: Uint32Array): Float64Array {
    const fromSet = new Set(Array.from(from));
    const toSet = new Set(Array.from(to));
    const next = new Float64Array(this.graph.n);
    const g = this.naive;
    for (let e = 0; e < g.src.length; e++) {
      if (!fromSet.has(g.src[e]) || !toSet.has(g.dst[e])) continue;
      next[g.dst[e]] += g.w[e] * activity[g.src[e]];
    }
    return next;
  }

  /** k-winners-take-all over one population, returning the winning indices. */
  private winners(activity: Float64Array, pop: Uint32Array, k: number): number[] {
    const scored = Array.from(pop, (i) => [i, activity[i]] as const).filter(([, v]) => v > 0);
    scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return scored.slice(0, k).map(([i]) => i).sort((a, b) => a - b);
  }

  /** Sensory drive for a task: the encoder, including the keyword odour code. */
  private input(signals: TaskSignals): Float64Array {
    return encode(featurize(signals), this.adapters, this.graph, this.groups, signals.keywords).input;
  }

  /**
   * The hash. Propagates the task's sensory drive through the real wiring and
   * returns the Kenyon cells that survived k-WTA.
   */
  fingerprint(signals: TaskSignals): KcCode {
    if (this.pathway === "recurrent") {
      const final = propagate(this.naive, this.input(signals), this.engine).final;
      const winners: number[] = [];
      for (const i of this.kcIdx) if (final[i] > 0) winners.push(i);
      return Uint32Array.from(winners.sort((a, b) => a - b));
    }
    // Feedforward: sensory drive, then one measured hop per layer, k-WTA at the end.
    let activity = this.input(signals);
    let from: Uint32Array = Uint32Array.from(Array.from({ length: this.graph.n }, (_, i) => i).filter((i) => activity[i] > 0));
    for (const layer of this.layerIdx) {
      activity = this.hop(activity, from, layer);
      from = layer;
    }
    return Uint32Array.from(this.winners(activity, this.layerIdx[this.layerIdx.length - 1] ?? this.kcIdx, this.sparseK));
  }

  /** Retrieve the learned valence for a task. */
  recall(signals: TaskSignals): RecallResult {
    const input = this.input(signals);
    const learned = propagate(this.signed, input, this.engine).final;
    const fresh = propagate(this.naive, input, this.engine).final;
    const mean = (v: Float64Array, idx: number[]) => (idx.length ? idx.reduce((s, i) => s + v[i], 0) / idx.length : 0);
    const approach = mean(learned, this.approachIdx), avoid = mean(learned, this.avoidIdx);
    const shift = (approach - avoid) - (mean(fresh, this.approachIdx) - mean(fresh, this.avoidIdx));
    const code = new Set(Array.from(this.fingerprint(signals)));
    const plastic = this.signed.plastic;
    let touched = 0, total = 0;
    if (plastic) {
      for (let e = 0; e < plastic.edge.length; e++) {
        if (!code.has(plastic.pre[e])) continue;
        total++;
        if (plastic.multiplier[e] < 0.999) touched++;
      }
    }
    return { approach, avoid, valenceShift: shift, familiarity: total ? touched / total : 0, codeSize: code.size };
  }

  /**
   * Associate a task with an outcome. reward ≥ 0.5 recruits the appetitive
   * dopaminergic set, below 0.5 the aversive set; either way the depression
   * lands only on KC→MBON synapses whose KC is in this task's code, in the
   * compartments those DANs actually innervate.
   */
  store(signals: TaskSignals, reward: number): { changed: number; valence: string } {
    const code = this.fingerprint(signals);
    const eligibility = new Float64Array(this.graph.n);
    for (const i of code) eligibility[i] = 1;
    const res = applyPlasticity(this.graph, this.signed, this.state, { eligibility, reward, params: this.plasticParams });
    this.state = res.state;
    this.episodes++;
    return { changed: res.update.changed, valence: res.update.valence };
  }

  reset(): void {
    this.state = emptyPlasticState();
    if (this.signed.plastic) this.signed.plastic.multiplier.fill(1);
    this.episodes = 0;
  }

  /** Replace the stored associations with a saved state (same graph only; see memory-rules.ts). */
  restore(state: PlasticState, episodes: number): void {
    const saved = designatePlasticEdges(this.graph, state.multipliers);
    if (this.signed.plastic && saved && saved.multiplier.length === this.signed.plastic.multiplier.length) this.signed.plastic.multiplier.set(saved.multiplier);
    this.state = state;
    this.episodes = episodes;
  }
}

/** Overlap of two sparse codes as |A∩B| / |A∪B|. */
export function codeSimilarity(a: KcCode, b: KcCode): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(Array.from(a));
  let inter = 0;
  for (const x of b) if (setA.has(x)) inter++;
  const union = a.length + b.length - inter;
  return union > 0 ? inter / union : 0;
}

/** Jaccard similarity of two keyword lists — the input-space similarity the hash should preserve. */
export function keywordSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  let inter = 0;
  for (const w of new Set(b)) if (setA.has(w)) inter++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? inter / union : 0;
}

export interface HashQuality {
  /** pairs whose tasks share a category */
  samePairs: number;
  crossPairs: number;
  meanSameSimilarity: number;
  meanCrossSimilarity: number;
  /** P(similarity(same-category pair) > similarity(cross-category pair)); 0.5 = uninformative */
  auc: number;
  /** Spearman rank correlation between code similarity and keyword (input-space) similarity */
  spearman: number;
  /** distinct codes / number of tasks — 1.0 means no collisions */
  distinctCodes: number;
  meanCodeSize: number;
}

/**
 * Does this graph's KC code behave like a locality-sensitive hash of tasks?
 * AUC compares same-category against cross-category pairs; Spearman compares
 * code similarity against input-space (keyword) similarity. Both are computed
 * identically for the real graph and its null models, so the comparison is
 * fair even though the corpus is authored.
 */
export function hashQuality(items: { code: KcCode; category: string; keywords: string[] }[]): HashQuality {
  const same: number[] = [], cross: number[] = [];
  const codeSims: number[] = [], kwSims: number[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const s = codeSimilarity(items[i].code, items[j].code);
      (items[i].category === items[j].category ? same : cross).push(s);
      codeSims.push(s);
      kwSims.push(keywordSimilarity(items[i].keywords, items[j].keywords));
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  let wins = 0, ties = 0;
  for (const s of same) for (const c of cross) { if (s > c) wins++; else if (s === c) ties++; }
  const comparisons = same.length * cross.length;
  const codes = new Set(items.map((it) => Array.from(it.code).join(",")));
  return {
    samePairs: same.length, crossPairs: cross.length,
    meanSameSimilarity: mean(same), meanCrossSimilarity: mean(cross),
    auc: comparisons ? (wins + ties / 2) / comparisons : 0.5,
    spearman: spearman(codeSims, kwSims),
    distinctCodes: items.length ? codes.size / items.length : 0,
    meanCodeSize: mean(items.map((it) => it.code.length)),
  };
}

export function spearman(x: number[], y: number[]): number {
  if (x.length < 2) return 0;
  const rank = (v: number[]) => {
    const order = v.map((val, i) => [val, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[order[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y);
  const n = x.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
