/**
 * Synaptic plasticity at designated edges — the larval mushroom-body rule.
 *
 * MEASURED: which edges are KC→MBON, which neurons are dopaminergic and which
 *           MBON compartments each DAN innervates (all from the connectome).
 * INFERRED_FROM_LITERATURE: which DANs signal appetitive vs aversive
 *           reinforcement (optogenetic substitution experiments, Saumweber
 *           2018 / Eschbach 2020), and the rule itself — co-activation of a KC
 *           and dopaminergic input to an MBON compartment *depresses* that
 *           KC→MBON synapse (Δw = −a · e_KC · R_DAN, Jürgensen 2024).
 * ENGINEERING_CHOICE: reward is delivered as a unit drive to the appetitive
 *           (reward > baseline) or aversive (reward < baseline) DAN set; DAN
 *           → MBON compartment drive is one hop over the real DAN→MBON edges;
 *           eligibility is the KC activity recorded at decision time; a slow
 *           recovery toward 1 models forgetting; multipliers are clamped.
 *
 * The connectome is never modified — only the multiplier table, which is
 * versioned, inspectable and resettable.
 */
import type { ConnectomeGraph } from "./artifact.js";
import { groupIndex, normalizeGroupKey } from "./artifact.js";
import type { SignedGraph } from "./engine.js";

export interface PlasticState {
  version: string;
  updates: number;
  /** "pre>post" → multiplier */
  multipliers: Record<string, number>;
  lastReward?: number;
  baseline?: number;
}

export function emptyPlasticState(): PlasticState {
  return { version: "plastic-0", updates: 0, multipliers: {} };
}

export interface PlasticityParams {
  /** learning rate a */
  lr: number;
  /** lowest multiplier a synapse can be depressed to */
  floor: number;
  /** per-update recovery toward 1 (forgetting) */
  recovery: number;
}

export const DEFAULT_PLASTICITY_PARAMS: PlasticityParams = { lr: 0.6, floor: 0.05, recovery: 0.02 };

export interface DanDrive {
  /** MBON node index → dopaminergic drive in [0,1] */
  drive: Map<number, number>;
  dansUsed: number[];
  valence: "appetitive" | "aversive" | "none";
}

/** One-hop DAN → MBON compartment drive over the real edges (any channel). */
export function dopaminergicDrive(graph: ConnectomeGraph, signed: SignedGraph, valence: "appetitive" | "aversive"): DanDrive {
  const spec = graph.plasticity?.dopaminergic;
  const ids = spec ? (valence === "appetitive" ? spec.appetitive : spec.aversive) : [];
  const dans = ids.map((id) => graph.index.get(id)).filter((i): i is number => i !== undefined);
  const drive = new Map<number, number>();
  if (!signed.plastic || dans.length === 0) return { drive, dansUsed: dans, valence: "none" };
  const danSet = new Set(dans);
  const targets = new Set(Array.from(signed.plastic.post));
  const raw = new Map<number, number>();
  for (let e = 0; e < graph.src.length; e++) {
    if (!danSet.has(graph.src[e]) || !targets.has(graph.dst[e])) continue;
    raw.set(graph.dst[e], (raw.get(graph.dst[e]) ?? 0) + graph.weight[e]);
  }
  let max = 0;
  for (const v of raw.values()) if (v > max) max = v;
  for (const [k, v] of raw) drive.set(k, max > 0 ? v / max : 0);
  return { drive, dansUsed: dans, valence };
}

export interface PlasticityUpdate {
  changed: number;
  meanMultiplier: number;
  minMultiplier: number;
  valence: DanDrive["valence"];
  dansUsed: number;
  compartments: number;
}

/**
 * Apply the depression rule. `eligibility` is the KC (pre) activity vector at
 * decision time (full node vector, max-normalised by the caller or not).
 * Mutates `signed.plastic.multiplier` and returns the persisted state.
 */
export function applyPlasticity(graph: ConnectomeGraph, signed: SignedGraph, state: PlasticState, opts: { eligibility: Float64Array; reward: number; params?: PlasticityParams }): { state: PlasticState; update: PlasticityUpdate } {
  const p = opts.params ?? DEFAULT_PLASTICITY_PARAMS;
  const plastic = signed.plastic;
  const baseline = state.baseline ?? 0.5;
  const next: PlasticState = { ...state, multipliers: { ...state.multipliers }, updates: state.updates + 1, lastReward: opts.reward, baseline: baseline + 0.1 * (opts.reward - baseline) };
  next.version = `plastic-${next.updates}`;
  if (!plastic || plastic.edge.length === 0) {
    return { state: next, update: { changed: 0, meanMultiplier: 1, minMultiplier: 1, valence: "none", dansUsed: 0, compartments: 0 } };
  }
  // Reinforcement is delivered by valence, not by advantage: reward in [0,1]
  // above 0.5 activates the appetitive DAN set with strength 2·(r−0.5), below
  // 0.5 the aversive set with strength 2·(0.5−r). Biologically the DANs report
  // the reinforcer itself, not a prediction error — ENGINEERING_CHOICE.
  const valence: "appetitive" | "aversive" = opts.reward >= 0.5 ? "appetitive" : "aversive";
  const dan = dopaminergicDrive(graph, signed, valence);
  const strength = Math.min(1, Math.abs(opts.reward - 0.5) * 2);
  let changed = 0, sum = 0, min = 1;
  for (let i = 0; i < plastic.edge.length; i++) {
    let m = plastic.multiplier[i];
    // forgetting: slow recovery toward the anatomical weight
    m = m + p.recovery * (1 - m);
    const e = opts.eligibility[plastic.pre[i]] ?? 0;
    const d = dan.drive.get(plastic.post[i]) ?? 0;
    if (e > 0 && d > 0 && strength > 0) {
      m = Math.max(p.floor, m - p.lr * strength * e * d);
      changed++;
    }
    m = Math.min(1, m);
    if (m !== plastic.multiplier[i]) {
      plastic.multiplier[i] = m;
      next.multipliers[`${graph.nodes[plastic.pre[i]].id}>${graph.nodes[plastic.post[i]].id}`] = m;
    }
    sum += m;
    if (m < min) min = m;
  }
  return { state: next, update: { changed, meanMultiplier: sum / plastic.edge.length, minMultiplier: min, valence: dan.valence, dansUsed: dan.dansUsed.length, compartments: dan.drive.size } };
}

/** Indices of the plastic pre-group (e.g. KCs) — used to record eligibility in traces. */
export function plasticPreNodes(graph: ConnectomeGraph): number[] {
  const spec = graph.plasticity?.plasticEdges;
  if (!spec) return [];
  return groupIndex(graph).get(normalizeGroupKey(spec.preGroup)) ?? [];
}
