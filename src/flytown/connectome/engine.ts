/**
 * Propagation engine — discrete-time, rate-based activation over a fixed
 * sparse signed graph.
 *
 *   a_{t+1} = (1 − λ)·a_t + λ·σ( gain · W·a_t + input_t )
 *
 * W: MEASURED topology, ENGINEERING_CHOICE magnitude (synapse count as a
 *    proxy for strength), INFERRED_FROM_LITERATURE sign (neurotransmitter
 *    prediction → excitatory / inhibitory / modulatory).
 * λ, gain, σ, step count: ENGINEERING_CHOICE. None of these are measured
 * physiological quantities. They are exposed, versioned and replayable.
 *
 * Sparse throughout — never builds an n×n matrix. Deterministic. Bounded.
 * Throws EngineInvalidStateError on NaN/Inf so callers can fail safe.
 */
import type { ConnectomeGraph } from "./artifact.js";

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

export interface SignedGraph {
  n: number;
  src: Uint32Array;
  dst: Uint32Array;
  /** normalised signed weights */
  w: Float64Array;
  policy: SignPolicy;
  normalization: "in_l1" | "none";
}

/**
 * Convert synapse counts + NT breakdown into signed, per-target-normalised
 * weights. With in_l1 normalisation the total |input| any node can receive
 * from the graph is ≤ gain, which keeps dynamics bounded regardless of graph
 * size — an ENGINEERING_CHOICE that discards absolute synapse scale between
 * regions and keeps relative composition.
 */
export function buildSignedGraph(graph: ConnectomeGraph, opts: { policy?: SignPolicy; normalization?: SignedGraph["normalization"]; excludeSelfEdges?: boolean } = {}): SignedGraph {
  const policy = opts.policy ?? DEFAULT_SIGN_POLICY;
  const normalization = opts.normalization ?? "in_l1";
  const E = graph.src.length;
  const w = new Float64Array(E);
  const ntClasses = Object.keys(graph.nt);
  for (let e = 0; e < E; e++) {
    // Intra-region recurrence (self edges: 57% of all synapses at projectome
    // level) can be folded into the leak term instead of the graph —
    // ENGINEERING_CHOICE exposed as a variant so its effect is measurable.
    if (opts.excludeSelfEdges && graph.src[e] === graph.dst[e]) { w[e] = 0; continue; }
    if (ntClasses.length === 0) { w[e] = graph.weight[e]; continue; }
    let signed = 0, counted = 0;
    for (const cls of ntClasses) {
      const c = graph.nt[cls][e];
      counted += c;
      signed += (policy[cls] ?? 0) * c;
    }
    // Synapses of unknown class contribute excitatory weight scaled to the remainder.
    const unknown = Math.max(0, graph.weight[e] - counted);
    w[e] = signed + unknown;
  }
  if (normalization === "in_l1") {
    const inAbs = new Float64Array(graph.n);
    for (let e = 0; e < E; e++) inAbs[graph.dst[e]] += Math.abs(w[e]);
    for (let e = 0; e < E; e++) if (inAbs[graph.dst[e]] > 0) w[e] /= inAbs[graph.dst[e]];
  }
  return { n: graph.n, src: graph.src, dst: graph.dst, w, policy, normalization };
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

export function propagate(graph: SignedGraph, input: Float64Array, params: EngineParams = DEFAULT_ENGINE_PARAMS): PropagationResult {
  if (input.length !== graph.n) throw new EngineInvalidStateError(`input length ${input.length} != n ${graph.n}`);
  const p = params.recurrence ? { ...params, inputSteps: Math.min(params.inputSteps, params.steps) } : { ...params, steps: 2, inputSteps: 1, leak: 1 };
  let a = new Float64Array(graph.n);
  const history: Float64Array[] = [];
  const drive = new Float64Array(graph.n);
  for (let t = 0; t < p.steps; t++) {
    drive.fill(0);
    if (p.recurrence || t > 0) {
      for (let e = 0; e < graph.src.length; e++) drive[graph.dst[e]] += graph.w[e] * a[graph.src[e]];
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
    a = next;
    history.push(Float64Array.from(a));
  }
  let max = 0, sum = 0, active = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] > max) max = a[i]; sum += a[i]; if (a[i] > 1e-3) active++; }
  return { final: a, history, params: p, stats: { maxActivity: max, meanFinalActivity: a.length ? sum / a.length : 0, activeRegions: active, steps: p.steps } };
}
