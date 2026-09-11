/**
 * Sensory encoder and action readout — the two trainable adapters that sit on
 * either side of the fixed connectome.
 *
 * Encoder: TaskSignals feature vector → activity injected into designated
 *          node groups. A "sensory prosthesis": ENGINEERING_CHOICE, with
 *          group choices labelled METAPHOR where they lean on the biological
 *          role of a region or cell class (antennal lobe / olfactory sensory
 *          neurons ≈ task identity, visual system ≈ repo structure, gustatory
 *          ≈ reward history, ...).
 * Readout: final activity → orchestration action scores. Same tags.
 *
 * Both are plain weight tables keyed by feature/action and *node group*
 * ("region:AL" for the projectome, "sens:olfactory" / "flag:MBON" / "out:DN-VNC"
 * for a neuron-level brain). A group key may list alternatives separated by
 * "|"; the first one present in the graph is used, so one default table can
 * serve artifacts whose annotation vocabularies differ slightly. The *same*
 * adapters apply to the real graph and to every null model — which is what
 * makes the comparison fair.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ORCH_ACTIONS, normalizeScores, zeroScores, type ActionScores, type OrchAction } from "../actions.js";
import { FEATURE_NAMES, type FeatureName } from "../signals.js";
import type { ProvenanceTag } from "../trace.js";
import { groupIndex, normalizeGroupKey, type ConnectomeGraph } from "./artifact.js";
import { hashSeed } from "../rng.js";

export interface AdapterEntry { group: string; weight: number; tag: ProvenanceTag; note?: string }

export interface AdapterWeights {
  version: string;
  /** which default table this derives from */
  family?: "projectome" | "larva" | "custom";
  /** feature -> injected drive per group */
  encoder: Partial<Record<FeatureName, AdapterEntry[]>>;
  /** action -> weight per group */
  readout: Record<OrchAction, AdapterEntry[]>;
  /** action -> bias */
  readoutBias: Record<OrchAction, number>;
  /** weight on (1 − mean activity) for terminate_success ("quiescence"); 0 = off */
  quiescenceWeight: number;
  /** gain applied to the encoder output before injection */
  inputGain: number;
  /**
   * Odour code for task identity: each task keyword deterministically
   * activates a `fraction` of the target group (hash of keyword × node id),
   * the way a distinct odorant activates a distinct subset of receptor
   * neurons. Without it, tasks with the same deliverable/complexity are the
   * same stimulus. ENGINEERING_CHOICE (a sensory prosthesis), METAPHOR in
   * its choice of the olfactory population.
   */
  keywordOdor?: { group: string; weight: number; fraction: number; maxKeywords: number; tag: ProvenanceTag };
  /**
   * Per-node readout weights (action → node id → weight), added to the
   * group-mean terms. Empty at init, so an untrained readout is the plain
   * group mean; learning writes sparse per-node weights for nodes inside the
   * readout populations. This is what lets a learned readout exploit *which*
   * MBONs / descending neurons are active rather than how many.
   * ENGINEERING_CHOICE (the reservoir-style "trainable readout on a fixed
   * graph" from the proposal).
   */
  nodeReadout?: Partial<Record<OrchAction, Record<string, number>>>;
  learning?: { updates: number; lastReward?: number; baseline?: number };
}

const M: ProvenanceTag = "METAPHOR";
const L: ProvenanceTag = "INFERRED_FROM_LITERATURE";

function bias(spawn = 0.15, other = 0.02): Record<OrchAction, number> {
  return Object.fromEntries(ORCH_ACTIONS.map((a) => [a, a === "spawn_subrite" ? spawn : other])) as Record<OrchAction, number>;
}

/**
 * Projectome defaults (adult FAFB neuropils). Every group reference is a
 * hypothesis about where a signal "belongs", borrowed from the behavioural
 * neuroscience literature on the named region, not derived from the
 * connectome data itself.
 */
export function defaultProjectomeAdapters(): AdapterWeights {
  return {
    version: "projectome-default-2",
    family: "projectome",
    inputGain: 1.0,
    quiescenceWeight: 0,
    encoder: {
      complexity: [{ group: "AL", weight: 0.9, tag: M, note: "task as odour stimulus" }],
      deliv_code_change: [{ group: "AL", weight: 0.5, tag: M }, { group: "LH", weight: 0.2, tag: M }],
      deliv_investigation: [{ group: "AL", weight: 0.6, tag: M }, { group: "MB_CA", weight: 0.3, tag: M, note: "investigation leans on memory" }],
      deliv_research: [{ group: "AL", weight: 0.5, tag: M }, { group: "MB_CA", weight: 0.4, tag: M }],
      deliv_verification: [{ group: "AL", weight: 0.4, tag: M }, { group: "GNG", weight: 0.4, tag: M, note: "tasting the result" }],
      deliv_answer: [{ group: "AL", weight: 0.4, tag: M }, { group: "LH", weight: 0.3, tag: M, note: "innate / fast response" }],
      deliv_unknown: [{ group: "AL", weight: 0.3, tag: M }],
      repo_size: [{ group: "ME", weight: 0.8, tag: M, note: "medulla: scene richness" }, { group: "LA", weight: 0.4, tag: M }],
      repo_has_tests: [{ group: "LO", weight: 0.7, tag: M, note: "lobula: structured features present" }],
      repo_has_manifest: [{ group: "LOP", weight: 0.4, tag: M }],
      test_failures: [{ group: "AMMC", weight: 0.9, tag: M, note: "mechanosensory alarm" }, { group: "SAD", weight: 0.4, tag: M }],
      runtime_errors: [{ group: "AMMC", weight: 0.8, tag: M }, { group: "WED", weight: 0.4, tag: M }],
      compile_errors: [{ group: "AMMC", weight: 0.7, tag: M }],
      prior_success: [{ group: "GNG", weight: 0.8, tag: M, note: "sugar" }],
      prior_failure: [{ group: "PRW", weight: 0.9, tag: M, note: "bitter" }, { group: "FLA", weight: 0.4, tag: M }],
      attempts: [{ group: "PRW", weight: 0.6, tag: M }, { group: "MB_ML", weight: 0.3, tag: M, note: "avoidance memory" }],
      pressure: [{ group: "SAD", weight: 0.9, tag: M, note: "urgency" }, { group: "AMMC", weight: 0.3, tag: M }],
      approvals_pending: [{ group: "SMP", weight: 0.8, tag: M, note: "higher-order gate" }],
      cue_approval: [{ group: "SMP", weight: 0.9, tag: M }],
      cue_blocked: [{ group: "PRW", weight: 0.7, tag: M }, { group: "SAD", weight: 0.5, tag: M }],
      cue_stop: [{ group: "GNG", weight: 0.5, tag: M }, { group: "GA", weight: 0.4, tag: M }],
      cue_misleading: [{ group: "EB", weight: 0.6, tag: M, note: "heading uncertainty" }, { group: "LH", weight: 0.3, tag: M }],
      uncertainty: [{ group: "EB", weight: 0.9, tag: M }, { group: "PB", weight: 0.3, tag: M }],
      conflicting: [{ group: "EB", weight: 0.6, tag: M }, { group: "FB", weight: 0.5, tag: M, note: "competing drives" }],
      security_sensitive: [{ group: "LH", weight: 0.8, tag: M, note: "innate aversion" }, { group: "SMP", weight: 0.3, tag: M }],
      prior_artifacts: [{ group: "MB_CA", weight: 0.9, tag: M, note: "calyx: memory input" }],
      constraints: [{ group: "FB", weight: 0.4, tag: M }],
    },
    readout: {
      spawn_subrite: [{ group: "LAL", weight: 1.0, tag: M, note: "premotor" }, { group: "SPS", weight: 0.4, tag: M }, { group: "IPS", weight: 0.3, tag: M }],
      increase_pack_size: [{ group: "FB", weight: 0.9, tag: M, note: "arousal / exploration" }, { group: "CRE", weight: 0.4, tag: M }],
      request_artifact_investigation: [{ group: "LH", weight: 0.8, tag: M }, { group: "PLP", weight: 0.4, tag: M }, { group: "MB_CA", weight: 0.3, tag: M }],
      invoke_reviewer: [{ group: "SLP", weight: 0.8, tag: M }, { group: "SIP", weight: 0.5, tag: M }],
      merge_results: [{ group: "PB", weight: 0.8, tag: M, note: "integration" }, { group: "EB", weight: 0.3, tag: M }],
      run_tool: [{ group: "GNG", weight: 0.7, tag: M }, { group: "SAD", weight: 0.4, tag: M }],
      run_tests: [{ group: "WED", weight: 0.6, tag: M }, { group: "AVLP", weight: 0.5, tag: M }, { group: "PVLP", weight: 0.4, tag: M }],
      retry_new_approach: [{ group: "MB_ML", weight: 0.8, tag: M, note: "learned avoidance" }, { group: "MB_VL", weight: 0.7, tag: M }],
      search_memory: [{ group: "MB_CA", weight: 0.8, tag: M }, { group: "MB_PED", weight: 0.6, tag: M }],
      surface_uncertainty: [{ group: "EB", weight: 0.9, tag: M }, { group: "NO", weight: 0.4, tag: M }],
      request_human_approval: [{ group: "SMP", weight: 0.9, tag: M }, { group: "ATL", weight: 0.3, tag: M }],
      terminate_success: [{ group: "GA", weight: 0.5, tag: M }, { group: "BU", weight: 0.3, tag: M }],
      terminate_blocked: [{ group: "PRW", weight: 0.8, tag: M, note: "bitter" }, { group: "FLA", weight: 0.5, tag: M }],
    },
    readoutBias: bias(),
  };
}

/**
 * Larval (neuron-level) defaults. Encoder targets are *sensory neuron
 * classes* — here the "odour" metaphor is literal: task identity drives
 * olfactory receptor neurons, reward history drives gustatory neurons,
 * errors drive nociceptive/thermosensory neurons. Readout groups are the
 * brain's output classes (descending neurons to VNC / SEZ, ring-gland
 * neuroendocrine neurons) and the mushroom-body output neurons whose
 * KC→MBON inputs are the designated plastic synapses. Which output class
 * maps to which orchestration action remains ENGINEERING_CHOICE/METAPHOR;
 * what is biology is that reward reaches these synapses through the real
 * gustatory → dopaminergic → MBON-compartment wiring.
 */
export function defaultLarvaAdapters(): AdapterWeights {
  // Sensory groups (encoder only). Group keys follow the l1-larva artifact's
  // vocabulary; alternatives keep the table usable on other annotations.
  const olf = "sens:olfactory|class2:ORN|class2:olfactory";
  const gustExt = "sens:gustatory-external|sens:gustatory|class2:gustatory";
  const gustPhar = "sens:gustatory-pharyngeal|sens:gustatory|class2:gustatory";
  const noci = "sens:noci|sens:nociceptive|class2:nociceptive";
  const thermo = "sens:thermo-warm|sens:thermosensory|class2:thermo";
  const mech = "sens:mechano-ch|sens:mechanosensory|sens:somatosensory|class:ascending";
  const proprio = "sens:proprio|sens:proprioceptive|sens:mechano-ii-iii";
  const vis = "sens:visual|class2:visual|class2:photoRh5";
  const enteric = "sens:gut|sens:enteric|class2:enteric";
  const resp = "sens:respiratory|sens:gut";
  // Interneuron / output groups (readout only — never sensory, so every
  // action score has to come through the brain).
  const kc = "flag:KC|class:KC|class:KCs";
  const mbonApp = "class2:app|flag:MBON";
  const mbonAv = "class2:av|flag:MBON";
  const mbonNeither = "class2:neith|flag:MBON";
  const dan = "class2:DAN|flag:MBIN|class:MBIN";
  const dnvnc = "out:DN-VNC|class:dVNC|class:dVNCs|flag:DN";
  const dnsez = "out:DN-SEZ|class:dSEZ|class:dSEZs";
  const rgn = "out:RGN|class:RGN|class:RGNs";
  const lhn = "class:LHN|class:LHNs";
  const pn = "class:uPN|class:PN|class:PNs";
  const fbn = "class:FBN|class:FBNs|class:MB-FBNs";
  const fb2n = "class:FB2N|class:FFN";
  const cn = "class:CN|class:CNs";
  const preVnc = "class:pre-DN-VNC|class:pre-dVNC|class:pre-dVNCs";
  const preSez = "class:pre-DN-SEZ|class:pre-dSEZ|class:pre-dSEZs";
  const cx = "class:CX";
  return {
    version: "larva-default-2",
    family: "larva",
    inputGain: 1.0,
    quiescenceWeight: 0,
    // Odour identity: task keywords AND the deliverable kind each activate a
    // distinct receptor subset; only a weak uniform "intensity" term reaches
    // all receptors, so the pattern — not the level — carries the task.
    keywordOdor: { group: olf, weight: 1.2, fraction: 0.15, maxKeywords: 6, tag: M },
    encoder: {
      complexity: [{ group: olf, weight: 0.15, tag: M, note: "stimulus intensity" }],
      deliv_code_change: [{ group: mech, weight: 0.2, tag: M }],
      deliv_investigation: [{ group: mech, weight: 0.3, tag: M }],
      deliv_research: [{ group: vis, weight: 0.3, tag: M }],
      deliv_verification: [{ group: gustPhar, weight: 0.4, tag: M, note: "tasting the result" }],
      deliv_answer: [{ group: vis, weight: 0.2, tag: M }],
      deliv_unknown: [],
      repo_size: [{ group: vis, weight: 0.8, tag: M, note: "visual scene richness" }],
      repo_has_tests: [{ group: vis, weight: 0.5, tag: M }, { group: proprio, weight: 0.4, tag: M, note: "body sense of structure" }],
      repo_has_manifest: [{ group: proprio, weight: 0.4, tag: M }],
      test_failures: [{ group: noci, weight: 0.9, tag: M, note: "nociceptive alarm" }, { group: thermo, weight: 0.3, tag: M }],
      runtime_errors: [{ group: noci, weight: 0.8, tag: M }, { group: mech, weight: 0.3, tag: M }],
      compile_errors: [{ group: noci, weight: 0.7, tag: M }],
      prior_success: [{ group: gustExt, weight: 0.9, tag: M, note: "sugar" }],
      prior_failure: [{ group: noci, weight: 0.6, tag: M, note: "punishment" }, { group: gustExt, weight: 0.3, tag: M, note: "bitter" }],
      attempts: [{ group: mech, weight: 0.5, tag: M }],
      pressure: [{ group: mech, weight: 0.9, tag: M, note: "urgency" }, { group: resp, weight: 0.3, tag: M, note: "internal state" }],
      approvals_pending: [{ group: enteric, weight: 0.8, tag: M, note: "internal-state gate" }],
      cue_approval: [{ group: enteric, weight: 0.9, tag: M }],
      cue_blocked: [{ group: noci, weight: 0.7, tag: M }, { group: thermo, weight: 0.4, tag: M }],
      cue_stop: [{ group: gustPhar, weight: 0.6, tag: M, note: "satiety" }, { group: enteric, weight: 0.4, tag: M }],
      cue_misleading: [{ group: olf, weight: 0.3, tag: M }, { group: vis, weight: 0.3, tag: M }],
      uncertainty: [{ group: vis, weight: 0.5, tag: M }, { group: mech, weight: 0.4, tag: M }],
      conflicting: [{ group: olf, weight: 0.4, tag: M }, { group: thermo, weight: 0.3, tag: M }],
      security_sensitive: [{ group: noci, weight: 0.8, tag: M, note: "innate aversion" }],
      prior_artifacts: [{ group: olf, weight: 0.4, tag: M, note: "familiar odour" }, { group: gustExt, weight: 0.3, tag: M }],
      constraints: [{ group: proprio, weight: 0.4, tag: M }],
    },
    // MBON valence (Eschbach et al. 2020 annotations shipped with the
    // artifact): avoidance-driving MBONs ↔ "change course", approach-driving
    // MBONs ↔ "carry on". The measured DAN→compartment wiring matches the
    // textbook logic — appetitive DANs innervate avoidance-MBON compartments
    // (drive-weighted 1.89 av vs 0.01 app) and aversive DANs innervate
    // approach-MBON compartments (5.28 app vs 0.05 av) — so reward depresses
    // avoidance and punishment depresses approach for the task's KC code.
    // The valence→action mapping itself remains METAPHOR.
    readout: {
      spawn_subrite: [{ group: dnvnc, weight: 1.0, tag: M, note: "locomotor command" }, { group: preVnc, weight: 0.4, tag: M }, { group: mbonApp, weight: 0.5, tag: L, note: "approach-driving MBONs" }],
      increase_pack_size: [{ group: preVnc, weight: 0.5, tag: M }, { group: fbn, weight: 0.6, tag: M, note: "MB feedback / arousal" }, { group: mbonApp, weight: 0.3, tag: L }],
      request_artifact_investigation: [{ group: lhn, weight: 0.8, tag: M, note: "innate odour evaluation" }, { group: pn, weight: 0.3, tag: M }],
      invoke_reviewer: [{ group: cn, weight: 0.8, tag: M, note: "convergence neurons" }, { group: lhn, weight: 0.3, tag: M }],
      merge_results: [{ group: cn, weight: 0.6, tag: M }, { group: preSez, weight: 0.5, tag: M }],
      run_tool: [{ group: dnsez, weight: 0.8, tag: M, note: "feeding / SEZ motor" }],
      run_tests: [{ group: dnsez, weight: 0.6, tag: M }, { group: preSez, weight: 0.4, tag: M }],
      retry_new_approach: [{ group: mbonAv, weight: 0.9, tag: L, note: "avoidance-driving MBONs: change course" }, { group: mbonNeither, weight: 0.2, tag: M }, { group: dan, weight: 0.2, tag: M }],
      search_memory: [{ group: kc, weight: 0.5, tag: M, note: "sparse memory code" }, { group: mbonNeither, weight: 0.4, tag: M }],
      surface_uncertainty: [{ group: fbn, weight: 0.7, tag: M }, { group: fb2n, weight: 0.4, tag: M }, { group: mbonAv, weight: 0.3, tag: L }],
      request_human_approval: [{ group: rgn, weight: 0.9, tag: M, note: "neuroendocrine" }],
      terminate_success: [{ group: rgn, weight: 0.5, tag: M }, { group: cx, weight: 0.4, tag: M, note: "central complex: settled state" }],
      terminate_blocked: [{ group: fb2n, weight: 0.6, tag: M, note: "second-order MB feedback" }, { group: rgn, weight: 0.5, tag: M }, { group: mbonAv, weight: 0.4, tag: L }],
    },
    readoutBias: bias(),
  };
}

/** Pick a default table for a graph: larva-style if it has sensory-class groups, else projectome. */
export function defaultAdaptersFor(graph: ConnectomeGraph): AdapterWeights {
  const hasSens = graph.nodes.some((n) => (n.groups ?? []).some((g) => g.startsWith("sens:") || g.startsWith("flag:")));
  return hasSens ? defaultLarvaAdapters() : defaultProjectomeAdapters();
}

/** Backwards-compatible alias (projectome). */
export function defaultAdapters(): AdapterWeights {
  return defaultProjectomeAdapters();
}

function normalizeEntry(e: AdapterEntry & { region?: string }): AdapterEntry {
  if (!e.group && e.region) return { group: e.region, weight: e.weight, tag: e.tag, note: e.note };
  return e;
}

export async function loadAdapters(file: string, fallback: AdapterWeights = defaultProjectomeAdapters()): Promise<AdapterWeights> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as AdapterWeights;
    if (!raw.readout || !raw.encoder) return fallback;
    for (const k of Object.keys(raw.encoder) as FeatureName[]) raw.encoder[k] = raw.encoder[k]!.map(normalizeEntry);
    for (const a of ORCH_ACTIONS) raw.readout[a] = (raw.readout[a] ?? []).map(normalizeEntry);
    return raw;
  } catch {
    return fallback;
  }
}

export async function saveAdapters(file: string, w: AdapterWeights): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(w, null, 2) + "\n", "utf8");
}

/** Resolve a group spec ("a|b|c" alternatives; bare names mean region:<name>) to node indices and the key that matched. */
export function resolveGroupKey(groups: Map<string, number[]>, spec: string): { key: string; idx: number[] } | undefined {
  for (const alt of spec.split("|")) {
    const key = normalizeGroupKey(alt.trim());
    const idx = groups.get(key);
    if (idx && idx.length) return { key, idx };
  }
  return undefined;
}

export function resolveGroup(groups: Map<string, number[]>, spec: string): number[] | undefined {
  return resolveGroupKey(groups, spec)?.idx;
}

export interface EncodeResult { input: Float64Array; missingGroups: string[]; usedGroups: string[] }

/**
 * Each node of a targeted group receives the same drive (weight × feature),
 * regardless of how many nodes the group has — a stimulus drives every
 * receptor neuron of its modality; it is not shared out among them.
 * ENGINEERING_CHOICE. (Projectome regions are single nodes per side, so this
 * is identical to the earlier per-region formulation there.)
 */
export function encode(features: Float64Array, adapters: AdapterWeights, graph: ConnectomeGraph, groups = groupIndex(graph), keywords: string[] = []): EncodeResult {
  const input = new Float64Array(graph.n);
  const missing = new Set<string>();
  const used = new Set<string>();
  for (let f = 0; f < FEATURE_NAMES.length; f++) {
    const x = features[f];
    if (!x) continue;
    for (const entry of adapters.encoder[FEATURE_NAMES[f]] ?? []) {
      const hit = resolveGroupKey(groups, entry.group);
      if (!hit) { missing.add(entry.group); continue; }
      used.add(hit.key);
      const drive = entry.weight * x * adapters.inputGain / (graph.manifest.level === "projectome" ? hit.idx.length : 1);
      for (const i of hit.idx) input[i] += drive;
    }
  }
  const odor = adapters.keywordOdor;
  if (odor) {
    // The deliverable kind is part of the odour too (a distinct receptor subset per kind).
    const deliverables = FEATURE_NAMES.filter((n, i) => n.startsWith("deliv_") && features[i] > 0).map((n) => `deliverable:${n.slice(6)}`);
    const kws = [...deliverables, ...keywords].slice(0, odor.maxKeywords + deliverables.length);
    const hit = kws.length ? resolveGroupKey(groups, odor.group) : undefined;
    if (kws.length && !hit) missing.add(odor.group);
    else if (hit) {
      used.add(hit.key);
      const perKeyword = odor.weight * adapters.inputGain / kws.length;
      for (const kw of kws) {
        // deterministic receptor subset per keyword
        for (const i of hit.idx) {
          if ((hashSeed(kw, graph.nodes[i].id) % 10_000) / 10_000 < odor.fraction) input[i] += perKeyword;
        }
      }
    }
  }
  return { input, missingGroups: [...missing].sort(), usedGroups: [...used].sort() };
}

export interface ReadoutResult { scores: ActionScores; contributions: Record<OrchAction, [string, number][]>; missingGroups: string[] }

export function readout(rawActivity: Float64Array, adapters: AdapterWeights, graph: ConnectomeGraph, groups = groupIndex(graph)): ReadoutResult {
  const raw = zeroScores();
  const contributions = {} as Record<OrchAction, [string, number][]>;
  const missing = new Set<string>();
  // The readout sees the relative activity *pattern*, not its absolute
  // magnitude — otherwise a globally quieter graph collapses onto the biases
  // and a louder one onto whichever node saturates first. Normalisation is by
  // the maximum over the *readout populations themselves* (not the sensory
  // neurons, which otherwise carry the maximum and compress every internal
  // population into a narrow band). ENGINEERING_CHOICE.
  const pop = readoutPopulation(adapters, groups);
  let max = 0, mean = 0;
  for (const i of pop.length ? pop : rawActivity.keys()) if (rawActivity[i] > max) max = rawActivity[i];
  for (let i = 0; i < rawActivity.length; i++) mean += rawActivity[i];
  mean = rawActivity.length ? mean / rawActivity.length : 0;
  const activity = max > 0 ? rawActivity.map((v) => Math.min(1, v / max)) : rawActivity;
  for (const a of ORCH_ACTIONS) {
    let s = adapters.readoutBias[a] ?? 0;
    const contrib: [string, number][] = [];
    for (const entry of adapters.readout[a] ?? []) {
      const hit = resolveGroupKey(groups, entry.group);
      if (!hit) { missing.add(entry.group); continue; }
      let act = 0;
      for (const i of hit.idx) act += activity[i];
      act /= hit.idx.length;
      const c = entry.weight * act;
      s += c;
      if (c > 0) contrib.push([hit.key, c]);
    }
    const perNode = adapters.nodeReadout?.[a];
    if (perNode) {
      let c = 0;
      for (const [id, w] of Object.entries(perNode)) {
        const i = graph.index.get(id);
        if (i !== undefined) c += w * activity[i];
      }
      s += c;
      if (c > 0) contrib.push(["node-readout", c]);
    }
    if (a === "terminate_success" && adapters.quiescenceWeight) s += adapters.quiescenceWeight * (1 - Math.min(1, mean * 4));
    raw[a] = Math.max(0, s);
    contributions[a] = contrib.sort((x, y) => y[1] - x[1]);
  }
  return { scores: normalizeScores(raw), contributions, missingGroups: [...missing].sort() };
}

/** Node indices belonging to any readout population of the table (the per-node readout's support). */
export function readoutPopulation(adapters: AdapterWeights, groups: Map<string, number[]>): number[] {
  const idx = new Set<number>();
  for (const entries of Object.values(adapters.readout)) for (const e of entries) for (const i of resolveGroup(groups, e.group) ?? []) idx.add(i);
  return [...idx].sort((a, b) => a - b);
}

/** Mean activity per group key (max-normalised), for traces and learning. */
export function groupActivity(activity: Float64Array, graph: ConnectomeGraph, groups = groupIndex(graph), normalize = true): Record<string, number> {
  let max = 0;
  if (normalize) for (let i = 0; i < activity.length; i++) if (activity[i] > max) max = activity[i];
  const out: Record<string, number> = {};
  for (const [g, idx] of groups) {
    if (g.startsWith("node:")) continue;
    let s = 0;
    for (const i of idx) s += activity[i];
    out[g] = idx.length ? (max > 0 ? s / idx.length / max : s / idx.length) : 0;
  }
  return out;
}

/**
 * Reward-modulated update of the readout weights — a REINFORCE-style
 * three-factor rule over the softmax action distribution:
 *
 *   Δw[a][group] = lr · (reward − baseline) · (1[a = taken] − p_a) · activity[group]
 *
 * so a rewarded action is strengthened *and* its competitors weakened (and
 * vice-versa). `activityByGroup` is keyed by the group keys actually present
 * in the graph (see groupActivity). Topology is never touched.
 * ENGINEERING_CHOICE with a dopaminergic flavour (METAPHOR).
 */
export function applyReward(adapters: AdapterWeights, opts: { action: OrchAction; scores: ActionScores; activityByGroup: Record<string, number>; reward: number; lr?: number; /** node id → activity for nodes inside the readout populations (enables per-node readout learning) */ readoutNodeActivity?: Record<string, number> }): AdapterWeights {
  const lr = opts.lr ?? 0.1;
  const learning = adapters.learning ?? { updates: 0 };
  // Running-mean baseline, initialised at the neutral midpoint so the very
  // first reward already carries a signal.
  const baseline = learning.baseline ?? 0.5;
  const advantage = Math.max(-1, Math.min(1, opts.reward - baseline));
  const next: AdapterWeights = JSON.parse(JSON.stringify(adapters));
  if (opts.readoutNodeActivity && advantage !== 0) {
    next.nodeReadout ??= {};
    for (const a of ORCH_ACTIONS) {
      const g = advantage * ((a === opts.action ? 1 : 0) - (opts.scores[a] ?? 0));
      if (g === 0) continue;
      const table = (next.nodeReadout[a] ??= {});
      for (const [id, act] of Object.entries(opts.readoutNodeActivity)) {
        if (act <= 0) continue;
        const v = (table[id] ?? 0) + lr * g * act;
        if (Math.abs(v) < 1e-4) delete table[id]; else table[id] = Math.max(-1, Math.min(1, v));
      }
    }
  }
  const lookup = (spec: string): number => {
    for (const alt of spec.split("|")) {
      const k = normalizeGroupKey(alt.trim());
      if (k in opts.activityByGroup) return opts.activityByGroup[k];
    }
    return 0;
  };
  const hot = Object.entries(opts.activityByGroup).filter(([g, v]) => v > 0.2 && !g.startsWith("node:") && !g.startsWith("hemisphere:")).sort((a, b) => b[1] - a[1]);
  for (const a of ORCH_ACTIONS) {
    const g = advantage * ((a === opts.action ? 1 : 0) - (opts.scores[a] ?? 0));
    if (g === 0) continue;
    const entries = next.readout[a];
    for (const entry of entries) {
      const act = lookup(entry.group);
      entry.weight = Math.max(0, Math.min(2, entry.weight + lr * g * act));
    }
    // Sparse growth: when the gradient wants to strengthen an action, let the
    // most active groups it is not yet connected to acquire a connection.
    if (g > 0) {
      for (const [group, act] of hot.slice(0, 3)) {
        if (entries.length >= 8 || entries.some((e) => e.group.split("|").some((alt) => normalizeGroupKey(alt) === group))) continue;
        entries.push({ group, weight: lr * g * act, tag: "ENGINEERING_CHOICE", note: "grown by reward" });
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
