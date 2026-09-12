/**
 * Connectome runtime artifacts — loading, checksum verification and the
 * null-model transforms used by the evaluation harness.
 *
 * Artifacts are produced offline by connectome-etl/ (Python) and consumed
 * here without any Python dependency. Format (per connectome/<id>/):
 *   manifest.json    — source dataset, version, checksums, every preprocessing assumption
 *   nodes.json       — [{ id, index, provenance, groups?: string[], ...stats }]
 *   graph.json       — { format: "coo", n, src[], dst[], weight[], nt?: {ACH: [], ...}, channels?: {ad: [], ...} }
 *   plasticity.json  — optional curated learning-site / sign table (neuron-level artifacts)
 *
 * Nodes carry `groups` (e.g. "region:AL", "flag:KC", "sens:olfactory"); the
 * adapters key on groups so the same runtime serves a 79-region projectome
 * and a 3,000-neuron larval brain. Projectome nodes without explicit groups
 * get "region:<base>" derived from their id.
 *
 * Nothing in this module changes biological structure except the explicitly
 * named transforms (shuffleLabels, randomDegreePreserving, ablate), each of
 * which exists to test whether the real topology matters.
 */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRng } from "../rng.js";
import type { ProvenanceTag } from "../trace.js";

export interface ConnectomeNode {
  id: string;
  index: number;
  provenance: ProvenanceTag;
  /** group keys the adapters can address, e.g. "region:AL", "flag:KC", "sens:olfactory" */
  groups?: string[];
  name?: string;
  neuronCount?: number;
  inSynapses?: number;
  outSynapses?: number;
  outNt?: Record<string, number>;
  [k: string]: unknown;
}

export interface ConnectomeManifest {
  artifactVersion: number;
  id: string;
  level: "projectome" | "curated" | "neuron";
  createdAt: string;
  source: Record<string, unknown> & { materialization?: number; license?: string; citations?: string[] };
  preprocessing: { assumptions?: { id: string; category: ProvenanceTag; text: string }[]; [k: string]: unknown };
  graph: { nodeCount: number; edgeCount: number; totalSynapses?: number; weightSemantics?: string; ntClasses?: string[]; channels?: string[] };
  checksums: Record<string, string>;
}

/** Curated learning-site and sign information (neuron-level artifacts). */
export interface PlasticitySpec {
  version: number;
  plasticEdges?: { channel?: string; preGroup: string; postGroup: string; rule: string; tag: ProvenanceTag };
  dopaminergic?: { appetitive: string[]; aversive: string[]; unknown?: string[]; source?: string; tag: ProvenanceTag; note?: string };
  signs?: {
    byGroup?: Record<string, { sign: number; nt?: string; source?: string }>;
    byNode?: Record<string, { sign: number; nt?: string; source?: string }>;
    default?: { sign: number; note?: string };
    tag: ProvenanceTag;
  };
}

export type ConnectomeVariant = "real" | "shuffled" | "random_degree" | "ablated" | "signless";

export interface ConnectomeGraph {
  id: string;
  manifest: ConnectomeManifest;
  variant: ConnectomeVariant;
  variantSeed: number;
  ablatedRegions: string[];
  n: number;
  nodes: ConnectomeNode[];
  index: Map<string, number>;
  src: Uint32Array;
  dst: Uint32Array;
  weight: Float64Array;
  /** neurotransmitter class -> per-edge synapse counts (parallel to src/dst) */
  nt: Record<string, Float64Array>;
  /** generic per-edge channels, e.g. synapse type ad/aa/dd/da (larva) */
  channels: Record<string, Float64Array>;
  plasticity?: PlasticitySpec;
}

export class ConnectomeArtifactError extends Error {}

export function defaultConnectomeRoot(): string {
  if (process.env.FLYTOWN_CONNECTOME_DIR) return resolve(process.env.FLYTOWN_CONNECTOME_DIR);
  // dist/flytown/connectome/artifact.js  or  src/flytown/connectome/artifact.ts → package root
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "connectome");
}

export async function listConnectomes(root = defaultConnectomeRoot()): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Only artifacts the runtime can actually load (manifest + JSON graph);
      // binary-only neuron-level bundles are listed by `fly connectome` later.
      try { await Promise.all([readFile(join(root, e.name, "manifest.json")), readFile(join(root, e.name, "graph.json"))]); out.push(e.name); } catch { /* not loadable */ }
    }
    return out.sort();
  } catch {
    return [];
  }
}

const cache = new Map<string, Promise<ConnectomeGraph>>();

export async function loadConnectome(id: string, opts: { root?: string; verifyChecksums?: boolean } = {}): Promise<ConnectomeGraph> {
  const root = opts.root ?? defaultConnectomeRoot();
  const key = `${root}::${id}`;
  if (!cache.has(key)) cache.set(key, loadUncached(root, id, opts.verifyChecksums ?? true).catch((err) => { cache.delete(key); throw err; }));
  return cache.get(key)!;
}

async function loadUncached(root: string, id: string, verify: boolean): Promise<ConnectomeGraph> {
  const dir = join(root, id);
  let manifestRaw: string, nodesRaw: string, graphRaw: string;
  try {
    [manifestRaw, nodesRaw, graphRaw] = await Promise.all([
      readFile(join(dir, "manifest.json"), "utf8"),
      readFile(join(dir, "nodes.json"), "utf8"),
      readFile(join(dir, "graph.json"), "utf8"),
    ]);
  } catch (err) {
    throw new ConnectomeArtifactError(`connectome artifact "${id}" not found under ${root} (${err instanceof Error ? err.message : String(err)}). Run connectome-etl/build.py or set FLYTOWN_CONNECTOME_DIR.`);
  }
  const manifest = JSON.parse(manifestRaw) as ConnectomeManifest;
  if (verify) {
    for (const [file, raw] of [["nodes.json", nodesRaw], ["graph.json", graphRaw]] as const) {
      const expected = manifest.checksums?.[file];
      if (!expected) throw new ConnectomeArtifactError(`manifest for "${id}" has no checksum for ${file}`);
      const actual = "sha256:" + createHash("sha256").update(raw).digest("hex");
      if (expected !== actual) throw new ConnectomeArtifactError(`checksum mismatch for ${id}/${file}: manifest ${expected} vs file ${actual}`);
    }
  }
  const nodes = (JSON.parse(nodesRaw) as ConnectomeNode[]).slice().sort((a, b) => a.index - b.index);
  nodes.forEach((n, i) => { if (n.index !== i) throw new ConnectomeArtifactError(`nodes.json for "${id}" is not a dense 0..n-1 index (node ${n.id} has index ${n.index} at position ${i})`); });
  const g = JSON.parse(graphRaw) as { format: string; n: number; src: number[]; dst: number[]; weight: number[]; nt?: Record<string, number[]>; channels?: Record<string, number[]> };
  if (g.format !== "coo") throw new ConnectomeArtifactError(`unsupported graph format "${g.format}" in ${id}`);
  if (g.n !== nodes.length) throw new ConnectomeArtifactError(`graph.n (${g.n}) != nodes.length (${nodes.length}) in ${id}`);
  const E = g.src.length;
  if (g.dst.length !== E || g.weight.length !== E) throw new ConnectomeArtifactError(`ragged COO arrays in ${id}`);
  const src = Uint32Array.from(g.src), dst = Uint32Array.from(g.dst), weight = Float64Array.from(g.weight);
  for (let e = 0; e < E; e++) {
    if (src[e] >= g.n || dst[e] >= g.n) throw new ConnectomeArtifactError(`edge ${e} out of range in ${id}`);
    if (!Number.isFinite(weight[e]) || weight[e] < 0) throw new ConnectomeArtifactError(`edge ${e} has invalid weight in ${id}`);
  }
  const nt: Record<string, Float64Array> = {};
  for (const [cls, arr] of Object.entries(g.nt ?? {})) {
    if (arr.length !== E) throw new ConnectomeArtifactError(`nt[${cls}] length mismatch in ${id}`);
    nt[cls] = Float64Array.from(arr);
  }
  const channels: Record<string, Float64Array> = {};
  for (const [ch, arr] of Object.entries(g.channels ?? {})) {
    if (arr.length !== E) throw new ConnectomeArtifactError(`channels[${ch}] length mismatch in ${id}`);
    channels[ch] = Float64Array.from(arr);
  }
  let plasticity: PlasticitySpec | undefined;
  try {
    plasticity = JSON.parse(await readFile(join(dir, "plasticity.json"), "utf8")) as PlasticitySpec;
  } catch { /* optional */ }
  ensureGroups(nodes);
  return {
    id, manifest, variant: "real", variantSeed: 0, ablatedRegions: [], n: g.n, nodes,
    index: new Map(nodes.map((n) => [n.id, n.index])), src, dst, weight, nt, channels, plasticity,
  };
}

/** Projectome nodes without explicit groups get region groups from their id. */
export function ensureGroups(nodes: ConnectomeNode[]): void {
  for (const n of nodes) {
    if (n.groups && n.groups.length) continue;
    n.groups = [`region:${baseRegion(n.id)}`, `node:${n.id}`];
  }
}

/** Build an in-memory graph (tests, synthetic experiments). */
export function makeGraph(opts: {
  id: string;
  nodes: (string | { id: string; groups?: string[]; name?: string })[];
  edges: [number, number, number][];
  nt?: Record<string, number[]>;
  channels?: Record<string, number[]>;
  level?: ConnectomeManifest["level"];
  plasticity?: PlasticitySpec;
}): ConnectomeGraph {
  const nodes: ConnectomeNode[] = opts.nodes.map((spec, index) => typeof spec === "string"
    ? { id: spec, index, provenance: "ENGINEERING_CHOICE" as const }
    : { id: spec.id, index, provenance: "ENGINEERING_CHOICE" as const, groups: spec.groups, name: spec.name });
  ensureGroups(nodes);
  const E = opts.edges.length;
  const nt: Record<string, Float64Array> = {};
  for (const [k, v] of Object.entries(opts.nt ?? {})) nt[k] = Float64Array.from(v);
  const channels: Record<string, Float64Array> = {};
  for (const [k, v] of Object.entries(opts.channels ?? {})) channels[k] = Float64Array.from(v);
  const manifest: ConnectomeManifest = {
    artifactVersion: 1, id: opts.id, level: opts.level ?? "projectome", createdAt: new Date(0).toISOString(),
    source: { dataset: "synthetic" }, preprocessing: { assumptions: [] },
    graph: { nodeCount: nodes.length, edgeCount: E, ntClasses: Object.keys(nt), channels: Object.keys(channels) }, checksums: {},
  };
  return {
    id: opts.id, manifest, variant: "real", variantSeed: 0, ablatedRegions: [], n: nodes.length, nodes,
    index: new Map(nodes.map((n) => [n.id, n.index])),
    src: Uint32Array.from(opts.edges.map((e) => e[0])), dst: Uint32Array.from(opts.edges.map((e) => e[1])), weight: Float64Array.from(opts.edges.map((e) => e[2])), nt, channels,
    plasticity: opts.plasticity,
  };
}

/** Node ids grouped by hemisphere-stripped base name (AL_L, AL_R → "AL"). */
export function baseRegion(id: string): string {
  return id.replace(/_(L|R)$/i, "");
}

export function regionsForBase(graph: ConnectomeGraph, base: string): string[] {
  return graph.nodes.filter((n) => baseRegion(n.id) === base).map((n) => n.id);
}

/** group key → node indices. Legacy bare region names ("AL") resolve to "region:AL". */
export function groupIndex(graph: ConnectomeGraph): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const n of graph.nodes) {
    for (const g of n.groups ?? []) {
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(n.index);
    }
  }
  return m;
}

export function normalizeGroupKey(key: string): string {
  return key.includes(":") ? key : `region:${key}`;
}

/** Resolve a region id, base name, or group key to node indices. */
export function resolveNodes(graph: ConnectomeGraph, key: string, groups = groupIndex(graph)): number[] {
  const direct = graph.index.get(key);
  if (direct !== undefined) return [direct];
  const byGroup = groups.get(normalizeGroupKey(key));
  if (byGroup && byGroup.length) return byGroup;
  const base = regionsForBase(graph, key).map((id) => graph.index.get(id)!);
  return base;
}

/**
 * Null model 1 — permute node labels. Topology (and therefore every degree /
 * weight statistic) is untouched; only the correspondence between biological
 * identity (region name, cell class, sensory modality) and structure is
 * destroyed. If a fly-derived planner behaves identically on this graph, the
 * biology contributed nothing.
 */
export function shuffleLabels(graph: ConnectomeGraph, seed: number): ConnectomeGraph {
  const rng = makeRng(seed);
  const perm = rng.shuffle(graph.nodes.map((_, i) => i));
  const nodes = perm.map((from, i) => ({ ...graph.nodes[from], index: i }));
  return { ...graph, variant: "shuffled", variantSeed: seed, nodes, index: new Map(nodes.map((n) => [n.id, n.index])) };
}

/**
 * Null model 2 — degree-preserving rewiring (directed edge swaps). Keeps each
 * node's out-edge count and in-edge count exactly; weights and channels
 * travel with their source, so out-strength is exact and in-strength
 * approximate. Labels stay put, so this tests whether the *specific wiring*
 * matters given the same coarse degree structure.
 */
export function randomDegreePreserving(graph: ConnectomeGraph, seed: number, swapsPerEdge = 10): ConnectomeGraph {
  const rng = makeRng(seed);
  const E = graph.src.length;
  const src = Uint32Array.from(graph.src), dst = Uint32Array.from(graph.dst);
  const present = new Set<number>();
  const key = (a: number, b: number) => a * graph.n + b;
  for (let e = 0; e < E; e++) present.add(key(src[e], dst[e]));
  const swaps = E * swapsPerEdge;
  for (let s = 0; s < swaps; s++) {
    const i = rng.int(E), j = rng.int(E);
    if (i === j) continue;
    const a = src[i], b = dst[i], c = src[j], d = dst[j];
    if (b === d || a === c) continue;
    const k1 = key(a, d), k2 = key(c, b);
    if (present.has(k1) || present.has(k2)) continue;
    present.delete(key(a, b)); present.delete(key(c, d));
    present.add(k1); present.add(k2);
    dst[i] = d; dst[j] = b;
  }
  return { ...graph, variant: "random_degree", variantSeed: seed, src, dst, weight: Float64Array.from(graph.weight), nt: copyChannels(graph.nt), channels: copyChannels(graph.channels) };
}

function copyChannels(c: Record<string, Float64Array>): Record<string, Float64Array> {
  const out: Record<string, Float64Array> = {};
  for (const [k, v] of Object.entries(c)) out[k] = Float64Array.from(v);
  return out;
}

/** Remove every edge touching the named regions / groups (lesion). */
export function ablate(graph: ConnectomeGraph, keys: string[]): ConnectomeGraph {
  const groups = groupIndex(graph);
  const idx = new Set<number>();
  for (const k of keys) {
    const found = resolveNodes(graph, k, groups);
    if (found.length === 0) throw new ConnectomeArtifactError(`cannot ablate unknown region/group "${k}"`);
    for (const i of found) idx.add(i);
  }
  const keep: number[] = [];
  for (let e = 0; e < graph.src.length; e++) if (!idx.has(graph.src[e]) && !idx.has(graph.dst[e])) keep.push(e);
  const pick = (c: Record<string, Float64Array>) => {
    const out: Record<string, Float64Array> = {};
    for (const [k, v] of Object.entries(c)) out[k] = Float64Array.from(keep.map((e) => v[e]));
    return out;
  };
  const label = keys.map((k) => normalizeGroupKey(k).replace(/^region:/, ""));
  return {
    ...graph, variant: "ablated", ablatedRegions: [...graph.ablatedRegions, ...label].sort(),
    src: Uint32Array.from(keep.map((e) => graph.src[e])), dst: Uint32Array.from(keep.map((e) => graph.dst[e])), weight: Float64Array.from(keep.map((e) => graph.weight[e])),
    nt: pick(graph.nt), channels: pick(graph.channels),
  };
}

/** Drop neurotransmitter / curated sign information: every edge becomes excitatory. */
export function signless(graph: ConnectomeGraph): ConnectomeGraph {
  return { ...graph, variant: "signless", nt: {}, plasticity: graph.plasticity ? { ...graph.plasticity, signs: undefined } : undefined };
}

export interface DegreeStats { outDegree: number[]; inDegree: number[]; outStrength: number[]; inStrength: number[] }

export function degreeStats(graph: ConnectomeGraph): DegreeStats {
  const outDegree = new Array(graph.n).fill(0), inDegree = new Array(graph.n).fill(0);
  const outStrength = new Array(graph.n).fill(0), inStrength = new Array(graph.n).fill(0);
  for (let e = 0; e < graph.src.length; e++) {
    outDegree[graph.src[e]]++; inDegree[graph.dst[e]]++;
    outStrength[graph.src[e]] += graph.weight[e]; inStrength[graph.dst[e]] += graph.weight[e];
  }
  return { outDegree, inDegree, outStrength, inStrength };
}
