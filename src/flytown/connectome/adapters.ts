/**
 * Sensory encoder and action readout — the two trainable adapters that sit on
 * either side of the fixed connectome.
 *
 * Encoder: TaskSignals feature vector → activity injected into designated
 *          input regions. A "sensory prosthesis": ENGINEERING_CHOICE, with
 *          region choices labelled METAPHOR where they lean on the biological
 *          role of a region (antennal lobe ≈ task identity, optic lobe ≈ repo
 *          structure, gustatory ≈ reward history, ...).
 * Readout: final regional activity → orchestration action scores. Same tags.
 *
 * Both are plain weight tables keyed by feature/action and hemisphere-
 * stripped region base name, so the *same* adapters apply to the real graph
 * and to every null model — which is what makes the comparison fair.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ORCH_ACTIONS, normalizeScores, zeroScores, type ActionScores, type OrchAction } from "../actions.js";
import { FEATURE_NAMES, type FeatureName } from "../signals.js";
import type { ProvenanceTag } from "../trace.js";
import { baseRegion, type ConnectomeGraph } from "./artifact.js";

export interface AdapterEntry { region: string; weight: number; tag: ProvenanceTag; note?: string }

export interface AdapterWeights {
  version: string;
  /** feature -> injected drive per region base */
  encoder: Partial<Record<FeatureName, AdapterEntry[]>>;
  /** action -> weight per region base */
  readout: Record<OrchAction, AdapterEntry[]>;
  /** action -> bias */
  readoutBias: Record<OrchAction, number>;
  /** weight on (1 − mean activity) for terminate_success ("quiescence") */
  quiescenceWeight: number;
  /** gain applied to the encoder output before injection */
  inputGain: number;
  learning?: { updates: number; lastReward?: number; baseline?: number };
}

const M: ProvenanceTag = "METAPHOR";
const E: ProvenanceTag = "ENGINEERING_CHOICE";

/**
 * Default adapters. Every region reference is a hypothesis about where a
 * signal "belongs", borrowed from the behavioural-neuroscience literature on
 * the named region, not something derived from the connectome data itself.
 */
export function defaultAdapters(): AdapterWeights {
  return {
    version: "default-2",
    inputGain: 1.0,
    // Quiescence bonus for terminate_success is off by default: with max-
    // normalised readout it only ever measured absolute magnitude, which made
    // any non-propagating null model halt every task (a degenerate comparison).
    quiescenceWeight: 0,
    encoder: {
      // task identity & complexity → antennal lobe ("odour")
      complexity: [{ region: "AL", weight: 0.9, tag: M, note: "task as odour stimulus" }],
      deliv_code_change: [{ region: "AL", weight: 0.5, tag: M }, { region: "LH", weight: 0.2, tag: M }],
      deliv_investigation: [{ region: "AL", weight: 0.6, tag: M }, { region: "MB_CA", weight: 0.3, tag: M, note: "investigation leans on memory" }],
      deliv_research: [{ region: "AL", weight: 0.5, tag: M }, { region: "MB_CA", weight: 0.4, tag: M }],
      deliv_verification: [{ region: "AL", weight: 0.4, tag: M }, { region: "GNG", weight: 0.4, tag: M, note: "tasting the result" }],
      deliv_answer: [{ region: "AL", weight: 0.4, tag: M }, { region: "LH", weight: 0.3, tag: M, note: "innate / fast response" }],
      deliv_unknown: [{ region: "AL", weight: 0.3, tag: M }],
      // repository structure → visual system
      repo_size: [{ region: "ME", weight: 0.8, tag: M, note: "medulla: scene richness" }, { region: "LA", weight: 0.4, tag: M }],
      repo_has_tests: [{ region: "LO", weight: 0.7, tag: M, note: "lobula: structured features present" }],
      repo_has_manifest: [{ region: "LOP", weight: 0.4, tag: M }],
      // failures & errors → mechanosensory / nociceptive-like entry
      test_failures: [{ region: "AMMC", weight: 0.9, tag: M, note: "mechanosensory alarm" }, { region: "SAD", weight: 0.4, tag: M }],
      runtime_errors: [{ region: "AMMC", weight: 0.8, tag: M }, { region: "WED", weight: 0.4, tag: M }],
      compile_errors: [{ region: "AMMC", weight: 0.7, tag: M }],
      // reward history → gustatory ("sugar" / "bitter")
      prior_success: [{ region: "GNG", weight: 0.8, tag: M, note: "sugar" }],
      prior_failure: [{ region: "PRW", weight: 0.9, tag: M, note: "bitter" }, { region: "FLA", weight: 0.4, tag: M }],
      attempts: [{ region: "PRW", weight: 0.6, tag: M }, { region: "MB_ML", weight: 0.3, tag: M, note: "avoidance memory" }],
      // pressure & approvals
      pressure: [{ region: "SAD", weight: 0.9, tag: M, note: "urgency" }, { region: "AMMC", weight: 0.3, tag: M }],
      approvals_pending: [{ region: "SMP", weight: 0.8, tag: M, note: "higher-order gate" }],
      cue_approval: [{ region: "SMP", weight: 0.9, tag: M }],
      cue_blocked: [{ region: "PRW", weight: 0.7, tag: M }, { region: "SAD", weight: 0.5, tag: M }],
      cue_stop: [{ region: "GNG", weight: 0.5, tag: M }, { region: "GA", weight: 0.4, tag: M }],
      cue_misleading: [{ region: "EB", weight: 0.6, tag: M, note: "heading uncertainty" }, { region: "LH", weight: 0.3, tag: M }],
      // uncertainty / conflict → central complex heading representation
      uncertainty: [{ region: "EB", weight: 0.9, tag: M }, { region: "PB", weight: 0.3, tag: M }],
      conflicting: [{ region: "EB", weight: 0.6, tag: M }, { region: "FB", weight: 0.5, tag: M, note: "competing drives" }],
      security_sensitive: [{ region: "LH", weight: 0.8, tag: M, note: "innate aversion" }, { region: "SMP", weight: 0.3, tag: M }],
      prior_artifacts: [{ region: "MB_CA", weight: 0.9, tag: M, note: "calyx: memory input" }],
      constraints: [{ region: "FB", weight: 0.4, tag: M }],
    },
    readout: {
      spawn_subrite: [{ region: "LAL", weight: 1.0, tag: M, note: "premotor" }, { region: "SPS", weight: 0.4, tag: M }, { region: "IPS", weight: 0.3, tag: M }],
      increase_pack_size: [{ region: "FB", weight: 0.9, tag: M, note: "arousal / exploration" }, { region: "CRE", weight: 0.4, tag: M }],
      request_artifact_investigation: [{ region: "LH", weight: 0.8, tag: M }, { region: "PLP", weight: 0.4, tag: M }, { region: "MB_CA", weight: 0.3, tag: M }],
      invoke_reviewer: [{ region: "SLP", weight: 0.8, tag: M }, { region: "SIP", weight: 0.5, tag: M }],
      merge_results: [{ region: "PB", weight: 0.8, tag: M, note: "integration" }, { region: "EB", weight: 0.3, tag: M }],
      run_tool: [{ region: "GNG", weight: 0.7, tag: M }, { region: "SAD", weight: 0.4, tag: M }],
      run_tests: [{ region: "WED", weight: 0.6, tag: M }, { region: "AVLP", weight: 0.5, tag: M }, { region: "PVLP", weight: 0.4, tag: M }],
      retry_new_approach: [{ region: "MB_ML", weight: 0.8, tag: M, note: "learned avoidance" }, { region: "MB_VL", weight: 0.7, tag: M }],
      search_memory: [{ region: "MB_CA", weight: 0.8, tag: M }, { region: "MB_PED", weight: 0.6, tag: M }],
      surface_uncertainty: [{ region: "EB", weight: 0.9, tag: M }, { region: "NO", weight: 0.4, tag: M }],
      request_human_approval: [{ region: "SMP", weight: 0.9, tag: M }, { region: "ATL", weight: 0.3, tag: M }],
      terminate_success: [{ region: "GA", weight: 0.5, tag: M }, { region: "BU", weight: 0.3, tag: M }],
      terminate_blocked: [{ region: "PRW", weight: 0.8, tag: M, note: "bitter" }, { region: "FLA", weight: 0.5, tag: M }],
    },
    readoutBias: Object.fromEntries(ORCH_ACTIONS.map((a) => [a, a === "spawn_subrite" ? 0.15 : 0.02])) as Record<OrchAction, number>,
  };
}

export async function loadAdapters(file: string): Promise<AdapterWeights> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as AdapterWeights;
    if (!raw.readout || !raw.encoder) return defaultAdapters();
    return raw;
  } catch {
    return defaultAdapters();
  }
}

export async function saveAdapters(file: string, w: AdapterWeights): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(w, null, 2) + "\n", "utf8");
}

/** Region-base → node indices map, computed once per graph. */
export function baseIndex(graph: ConnectomeGraph): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of graph.nodes) {
    const b = baseRegion(n.id);
    if (!m.has(b)) m.set(b, []);
    m.get(b)!.push(n.index);
  }
  return m;
}

export interface EncodeResult { input: Float64Array; missingRegions: string[] }

export function encode(features: Float64Array, adapters: AdapterWeights, graph: ConnectomeGraph, bases = baseIndex(graph)): EncodeResult {
  const input = new Float64Array(graph.n);
  const missing = new Set<string>();
  for (let f = 0; f < FEATURE_NAMES.length; f++) {
    const x = features[f];
    if (!x) continue;
    for (const entry of adapters.encoder[FEATURE_NAMES[f]] ?? []) {
      const idx = bases.get(entry.region);
      if (!idx) { missing.add(entry.region); continue; }
      const share = entry.weight * x * adapters.inputGain / idx.length;
      for (const i of idx) input[i] += share;
    }
  }
  return { input, missingRegions: [...missing].sort() };
}

export interface ReadoutResult { scores: ActionScores; contributions: Record<OrchAction, [string, number][]>; missingRegions: string[] }

export function readout(rawActivity: Float64Array, adapters: AdapterWeights, graph: ConnectomeGraph, bases = baseIndex(graph)): ReadoutResult {
  const raw = zeroScores();
  const contributions = {} as Record<OrchAction, [string, number][]>;
  const missing = new Set<string>();
  // The readout sees the relative activity *pattern* (max-normalised), not its
  // absolute magnitude — otherwise a globally quieter graph collapses onto the
  // biases and a louder one onto whichever region saturates first.
  // ENGINEERING_CHOICE.
  let max = 0, mean = 0;
  for (let i = 0; i < rawActivity.length; i++) { if (rawActivity[i] > max) max = rawActivity[i]; mean += rawActivity[i]; }
  mean = rawActivity.length ? mean / rawActivity.length : 0;
  const activity = max > 0 ? rawActivity.map((v) => v / max) : rawActivity;
  for (const a of ORCH_ACTIONS) {
    let s = adapters.readoutBias[a] ?? 0;
    const contrib: [string, number][] = [];
    for (const entry of adapters.readout[a] ?? []) {
      const idx = bases.get(entry.region);
      if (!idx) { missing.add(entry.region); continue; }
      let act = 0;
      for (const i of idx) act += activity[i];
      act /= idx.length;
      const c = entry.weight * act;
      s += c;
      if (c > 0) contrib.push([entry.region, c]);
    }
    if (a === "terminate_success") s += adapters.quiescenceWeight * (1 - Math.min(1, mean * 4));
    raw[a] = Math.max(0, s);
    contributions[a] = contrib.sort((x, y) => y[1] - x[1]);
  }
  return { scores: normalizeScores(raw), contributions, missingRegions: [...missing].sort() };
}

/**
 * Reward-modulated update of the readout weights — a REINFORCE-style
 * three-factor rule over the softmax action distribution:
 *
 *   Δw[a][region] = lr · (reward − baseline) · (1[a = taken] − p_a) · activity[region]
 *
 * so a rewarded action is strengthened *and* its competitors weakened (and
 * vice-versa), which a "taken-action-only" rule cannot do. Activity here is
 * the max-normalised pattern the readout actually saw. Topology is never
 * touched. ENGINEERING_CHOICE with a dopaminergic flavour (METAPHOR).
 */
export function applyReward(adapters: AdapterWeights, opts: { action: OrchAction; scores: ActionScores; activityByBase: Record<string, number>; reward: number; lr?: number }): AdapterWeights {
  const lr = opts.lr ?? 0.1;
  const learning = adapters.learning ?? { updates: 0 };
  const baseline = learning.baseline ?? opts.reward;
  const advantage = Math.max(-1, Math.min(1, opts.reward - baseline));
  const next: AdapterWeights = JSON.parse(JSON.stringify(adapters));
  const bases = Object.entries(opts.activityByBase).filter(([, v]) => v > 0.05).sort((a, b) => b[1] - a[1]);
  for (const a of ORCH_ACTIONS) {
    const g = advantage * ((a === opts.action ? 1 : 0) - (opts.scores[a] ?? 0));
    if (g === 0) continue;
    const entries = next.readout[a];
    for (const entry of entries) {
      const act = opts.activityByBase[entry.region] ?? 0;
      entry.weight = Math.max(0, Math.min(2, entry.weight + lr * g * act));
    }
    // Sparse growth: when the gradient wants to strengthen an action, let the
    // most active regions it is not yet connected to acquire a connection.
    if (g > 0) {
      for (const [region, act] of bases.slice(0, 3)) {
        if (entries.length >= 8 || entries.some((e) => e.region === region)) continue;
        entries.push({ region, weight: lr * g * act, tag: "ENGINEERING_CHOICE", note: "grown by reward" });
      }
    }
    next.readoutBias[a] = Math.max(0, Math.min(1, (next.readoutBias[a] ?? 0) + 0.25 * lr * g));
  }
  next.learning = {
    updates: learning.updates + 1,
    lastReward: opts.reward,
    baseline: baseline + 0.1 * (opts.reward - baseline),
  };
  next.version = `learned-${next.learning.updates}`;
  return next;
}
