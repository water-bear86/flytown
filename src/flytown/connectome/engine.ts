/**
 * Propagation engine — discrete-time, rate-based activation over a fixed
 * sparse signed graph.
 *
 *   a_{t+1} = (1 − λ)·a_t + λ·σ( gain · W·a_t + input_t )
 *
 * W: MEASURED topology, ENGINEERING_CHOICE magnitude (synapse count as a
 *    proxy for strength), INFERRED_FROM_LITERATURE sign (adult: predicted
 *    neurotransmitter class; larva: curated per-class/per-neuron table, no
 *    prediction dataset exists) — or +1 when no sign information exists.
 * λ, gain, σ, step count: ENGINEERING_CHOICE. None of these are measured
 * physiological quantities. They are exposed, versioned and replayable.
 *
 * Designated plastic edges (e.g. larval KC→MBON) carry a per-edge multiplier
 * in [0, 1] that the plasticity rule (plasticity.ts) depresses; everything
 * else is fixed.
 *
 * Sparse throughout — never builds an n×n matrix. Deterministic. Bounded.
 * Throws EngineInvalidStateError on NaN/Inf so callers can fail safe.
 */
import { groupIndex, normalizeGroupKey, type ConnectomeGraph } from "./artifact.js";

export type SignPolicy = Record<string, number>;

/**
 * Default neurotransmitter → sign policy (INFERRED_FROM_LITERATURE):
 *  ACH  +1  acetylcholine: principal excitatory transmitter in the fly CNS
 *  GABA −1  inhibitory
 *  GLUT −1  glutamate acts predominantly inhibitory in the adult Drosophila
 *           brain via GluClα (Liu & Wilson 2013) — an inference, not a per-
 *           synapse measurement; some glutamatergic synapses are excitatory
 *  DA/OCT/SER 0  neuromodulators: no fast sign; treated as no direct drive
 *           (their influence is modelled, if at all, via the learning layer)
 */
export const DEFAULT_SIGN_POLICY: SignPolicy = { ACH: 1, GABA: -1, GLUT: -1, DA: 0, OCT: 0, SER: 0 };

export interface PlasticEdges {
  /** indices into the edge arrays */
  edge: Uint32Array;
  /** multiplier per plastic edge, in [floor, 1] */
  multiplier: Float64Array;
  /** node index of pre (e.g. KC) and post (e.g. MBON) per plastic edge */
  pre: Uint32Array;
  post: Uint32Array;
  rule: string;
}

export interface SparseSet {
  /** node indices subject to k-winners-take-all */
  idx: Uint32Array;
  /** number of winners kept active each step */
  k: number;
  group: string;
}

export interface SignedGraph {
  n: number;
  src: Uint32Array;
  dst: Uint32Array;
  /** normalised signed weights (before plastic multipliers) */
  w: Float64Array;
  policy: SignPolicy;
  normalization: "in_l1" | "none";
  /** how each edge's sign was decided */
  signSource: "nt" | "curated" | "none";
  plastic?: PlasticEdges;
  /**
   * Populations with an enforced sparse code (k-winners-take-all applied
   * after each update step). Kenyon cells fire at ~5–10% sparseness in vivo,
   * enforced by high thresholds and APL feedback inhibition — the sparse
   * code is what makes association-specific plasticity possible.
   * INFERRED_FROM_LITERATURE that the code is sparse; ENGINEERING_CHOICE to
   * implement it as k-WTA rather than a biophysical threshold.
   */
  sparse?: SparseSet[];
}

export interface BuildSignedOptions {
  policy?: SignPolicy;
  normalization?: SignedGraph["normalization"];
  excludeSelfEdges?: boolean;
  /** per-channel weighting for multi-channel (synapse-type) artifacts; default 1 for every channel */
  channelWeights?: Record<string, number>;
  /** designate plastic edges from the artifact's plasticity spec */
  plastic?: boolean;
  /** initial multipliers for plastic edges keyed "pre>post" (learned state) */
  plasticMultipliers?: Record<string, number>;
  /** groups to sparsen with k-WTA: fraction of the population kept active */
  sparseGroups?: { group: string; fraction: number }[];
}

/**
 * Convert synapse counts (+ NT breakdown or curated signs) into signed,
 * per-target-normalised weights. With in_l1 normalisation the total |input|
 * any node can receive from the graph is ≤ gain, which keeps dynamics bounded
 * regardless of graph size — an ENGINEERING_CHOICE that discards absolute
 * synapse scale between nodes and keeps relative composition.
 */
export function buildSignedGraph(graph: ConnectomeGraph, opts: BuildSignedOptions = {}): SignedGraph {
  const policy = opts.policy ?? DEFAULT_SIGN_POLICY;
  const normalization = opts.normalization ?? "in_l1";
  const E = graph.src.length;
  const w = new Float64Array(E);
  const ntClasses = Object.keys(graph.nt);
  const channelNames = Object.keys(graph.channels);
  const nodeSign = curatedNodeSigns(graph);
  const signSource: SignedGraph["signSource"] = ntClasses.length ? "nt" : nodeSign ? "curated" : "none";
  for (let e = 0; e < E; e++) {
    // Intra-node recurrence (self edges: 57% of all synapses at projectome
    // level) can be folded into the leak term instead of the graph —
    // ENGINEERING_CHOICE exposed as a variant so its effect is measurable.
    if (opts.excludeSelfEdges && graph.src[e] === graph.dst[e]) { w[e] = 0; continue; }
    let magnitude = graph.weight[e];
    if (channelNames.length && opts.channelWeights) {
      magnitude = 0;
      for (const ch of channelNames) magnitude += (opts.channelWeights[ch] ?? 1) * graph.channels[ch][e];
    }
    if (ntClasses.length) {
      let signed = 0, counted = 0;
      for (const cls of ntClasses) {
        const c = graph.nt[cls][e];
        counted += c;
        signed += (policy[cls] ?? 0) * c;
      }
      // Synapses of unknown class contribute excitatory weight scaled to the remainder.
      const unknown = Math.max(0, graph.weight[e] - counted);
      w[e] = (signed + unknown) * (graph.weight[e] > 0 ? magnitude / graph.weight[e] : 1);
    } else if (nodeSign) {
      w[e] = nodeSign[graph.src[e]] * magnitude;
    } else {
      w[e] = magnitude;
    }
  }
  if (normalization === "in_l1") {
    const inAbs = new Float64Array(graph.n);
    for (let e = 0; e < E; e++) inAbs[graph.dst[e]] += Math.abs(w[e]);
    for (let e = 0; e < E; e++) if (inAbs[graph.dst[e]] > 0) w[e] /= inAbs[graph.dst[e]];
  }
  const plastic = opts.plastic ? designatePlasticEdges(graph, opts.plasticMultipliers) : undefined;
  let sparse: SparseSet[] | undefined;
  if (opts.sparseGroups?.length) {
    const groups = groupIndex(graph);
    sparse = [];
    for (const s of opts.sparseGroups) {
      const idx = groups.get(normalizeGroupKey(s.group));
      if (!idx || idx.length === 0) continue;
      const k = Math.max(1, Math.round(idx.length * s.fraction));
      sparse.push({ idx: Uint32Array.from(idx), k, group: normalizeGroupKey(s.group) });
      // Gain compensation: with per-target L1 normalisation, a population that
      // is only k/n active would deliver only k/n of its targets' input
      // budget. Scale its outgoing weights by n/k so the *active* winners
      // carry the population's full drive — the standard treatment in k-WTA
      // / fly-hashing models. ENGINEERING_CHOICE.
      if (normalization === "in_l1") {
        const inSet = new Set(idx);
        const gain = idx.length / k;
        for (let e = 0; e < E; e++) if (inSet.has(graph.src[e])) w[e] *= gain;
      }
    }
  }
  return { n: graph.n, src: graph.src, dst: graph.dst, w, policy, normalization, signSource, plastic, sparse };
}

/** k-winners-take-all on a population: keep the k largest, zero the rest. */
export function applySparse(next: Float64Array, sets: SparseSet[]): void {
  for (const s of sets) {
    if (s.idx.length <= s.k) continue;
    const vals = Array.from(s.idx, (i) => next[i]);
    const sorted = vals.slice().sort((a, b) => b - a);
    const threshold = sorted[s.k - 1];
    if (threshold <= 0) { for (const i of s.idx) next[i] = 0; continue; }
    let kept = 0;
    for (const i of s.idx) {
      if (next[i] >= threshold && kept < s.k) kept++;
      else next[i] = 0;
    }
  }
}

/** Per-node sign from the artifact's curated table (byNode → byGroup → default), or null when absent. */
export function curatedNodeSigns(graph: ConnectomeGraph): Float64Array | null {
  const signs = graph.plasticity?.signs;
  if (!signs) return null;
  const out = new Float64Array(graph.n).fill(signs.default?.sign ?? 1);
  const byGroup = signs.byGroup ?? {};
  for (const n of graph.nodes) {
    for (const g of n.groups ?? []) {
      const s = byGroup[g] ?? byGroup[normalizeGroupKey(g)];
      if (s) { out[n.index] = s.sign; break; }
    }
    const byNode = signs.byNode?.[n.id];
    if (byNode) out[n.index] = byNode.sign;
  }
  return out;
}

/** Edges whose pre is in preGroup and post in postGroup (and channel, if given, is non-zero). */
export function designatePlasticEdges(graph: ConnectomeGraph, initial?: Record<string, number>): PlasticEdges | undefined {
  const spec = graph.plasticity?.plasticEdges;
  if (!spec) return undefined;
  const groups = groupIndex(graph);
  const pre = new Set(groups.get(normalizeGroupKey(spec.preGroup)) ?? []);
  const post = new Set(groups.get(normalizeGroupKey(spec.postGroup)) ?? []);
  const channel = spec.channel && graph.channels[spec.channel] ? graph.channels[spec.channel] : undefined;
  const edge: number[] = [], mult: number[] = [], preIdx: number[] = [], postIdx: number[] = [];
  for (let e = 0; e < graph.src.length; e++) {
    if (!pre.has(graph.src[e]) || !post.has(graph.dst[e])) continue;
    if (channel && channel[e] <= 0) continue;
    edge.push(e);
    preIdx.push(graph.src[e]); postIdx.push(graph.dst[e]);
    const key = `${graph.nodes[graph.src[e]].id}>${graph.nodes[graph.dst[e]].id}`;
    mult.push(initial?.[key] ?? 1);
  }
  return { edge: Uint32Array.from(edge), multiplier: Float64Array.from(mult), pre: Uint32Array.from(preIdx), post: Uint32Array.from(postIdx), rule: spec.rule };
}

export interface EngineParams {
  /** number of update steps (T). */
  steps: number;
  /** leak λ in (0,1]. */
  leak: number;
  /** gain on recurrent drive. */
  gain: number;
  /** how many initial steps the external input is applied. */
  inputSteps: number;
  /** upper bound on activity. */
  aMax: number;
  /** false → feed-forward only: input, one hop, stop. */
  recurrence: boolean;
  /**
   * Divisive normalisation strength β: a_i ← a_i / (1 + β·mean(a)).
   * 0 disables. A canonical-normalisation style global inhibition
   * (ENGINEERING_CHOICE, after Carandini & Heeger) that keeps activity graded
   * instead of saturating every reachable node.
   */
  divisive: number;
}

/**
 * Defaults: sustained input (inputSteps = steps) and gain < 1 on an in-L1-
 * normalised matrix make the update a contraction, so activity settles to a
 * unique, graded, input-dependent fixed point instead of either saturating
 * every reachable node (gain ≫ 1) or decaying to nothing once a transient
 * input is removed. ENGINEERING_CHOICE, chosen after the first matched run
 * showed both failure modes producing task-invariant decisions.
 */
export const DEFAULT_ENGINE_PARAMS: EngineParams = { steps: 15, leak: 0.5, gain: 0.9, inputSteps: 15, aMax: 1, recurrence: true, divisive: 0 };

export class EngineInvalidStateError extends Error {}

export interface PropagationResult {
  final: Float64Array;
  history: Float64Array[];
  params: EngineParams;
  stats: { maxActivity: number; meanFinalActivity: number; activeRegions: number; steps: number };
}

/** σ: rectified tanh — rates are non-negative and saturate at aMax. */
function sigma(x: number, aMax: number): number {
  return x <= 0 ? 0 : aMax * Math.tanh(x);
}

/** Effective weights with plastic multipliers applied (allocation-free view when there are none). */
export function effectiveWeights(graph: SignedGraph): Float64Array {
  if (!graph.plastic || graph.plastic.edge.length === 0) return graph.w;
  const w = Float64Array.from(graph.w);
  for (let i = 0; i < graph.plastic.edge.length; i++) w[graph.plastic.edge[i]] *= graph.plastic.multiplier[i];
  return w;
}

export function propagate(graph: SignedGraph, input: Float64Array, params: EngineParams = DEFAULT_ENGINE_PARAMS): PropagationResult {
  if (input.length !== graph.n) throw new EngineInvalidStateError(`input length ${input.length} != n ${graph.n}`);
  const p = params.recurrence ? { ...params, inputSteps: Math.min(params.inputSteps, params.steps) } : { ...params, steps: 2, inputSteps: 1, leak: 1 };
  const w = effectiveWeights(graph);
  let a = new Float64Array(graph.n);
  const history: Float64Array[] = [];
  const drive = new Float64Array(graph.n);
  for (let t = 0; t < p.steps; t++) {
    drive.fill(0);
    if (p.recurrence || t > 0) {
      for (let e = 0; e < graph.src.length; e++) drive[graph.dst[e]] += w[e] * a[graph.src[e]];
    }
    const next = new Float64Array(graph.n);
    const useInput = t < p.inputSteps;
    let sum = 0;
    for (let i = 0; i < graph.n; i++) {
      const x = p.gain * drive[i] + (useInput ? input[i] : 0);
      const v = (1 - p.leak) * a[i] + p.leak * sigma(x, p.aMax);
      if (!Number.isFinite(v)) throw new EngineInvalidStateError(`non-finite activity at step ${t}, node ${i}`);
      next[i] = v > p.aMax ? p.aMax : v < 0 ? 0 : v;
      sum += next[i];
    }
    if (p.divisive > 0 && graph.n > 0) {
      const denom = 1 + p.divisive * (sum / graph.n);
      for (let i = 0; i < graph.n; i++) next[i] /= denom;
    }
    if (graph.sparse?.length) applySparse(next, graph.sparse);
    a = next;
    history.push(Float64Array.from(a));
  }
  let max = 0, sum = 0, active = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] > max) max = a[i]; sum += a[i]; if (a[i] > 1e-3) active++; }
  return { final: a, history, params: p, stats: { maxActivity: max, meanFinalActivity: a.length ? sum / a.length : 0, activeRegions: active, steps: p.steps } };
}
