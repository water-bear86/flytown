import { CASTES, type Artifact, type Caste, type Morsel, type Flight } from "./types.js";
import type { Compost } from "./compost.js";

export interface AuditReport {
  flight: Flight;
  totalMorsels: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  byCaste: Record<Caste, CasteStats>;
  highestDrift: { morselId: string; rate: number; caste: Caste } | null;
  longestChain: { length: number; morselIds: string[] };
  warnings: string[];
  /** Phase 1+ artifact lineage attached to this flight. */
  artifact?: Artifact | null;
  /** Other artifacts that cite this one (children). */
  artifactChildren?: Artifact[];
}

export interface CasteStats {
  count: number;
  totalTokens: number;
  avgDriftRate: number;
  avgRewardOrZero: number;
}

export async function auditFlight(
  compost: Compost,
  flightId: string,
): Promise<AuditReport | null> {
  const flight = await compost.getFlight(flightId);
  if (!flight) return null;

  const ids = collectFlightMorselIds(flight);
  const morsels: Morsel[] = [];
  for (const id of ids) {
    const l = await compost.getMorsel(id);
    if (l) morsels.push(l);
  }

  const byCaste = emptyCasteStats();
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let highestDrift: AuditReport["highestDrift"] = null;
  for (const l of morsels) {
    const stats = byCaste[l.caste];
    stats.count += 1;
    if (l.usage) {
      stats.totalTokens += l.usage.totalTokens;
      totalTokens += l.usage.totalTokens;
      promptTokens += l.usage.promptTokens;
      completionTokens += l.usage.completionTokens;
    }
    stats.avgDriftRate += l.drift.driftRate;
    stats.avgRewardOrZero += l.reward ?? 0;
    if (!highestDrift || l.drift.driftRate > highestDrift.rate) {
      highestDrift = {
        morselId: l.id,
        rate: l.drift.driftRate,
        caste: l.caste,
      };
    }
  }
  for (const k of CASTES) {
    const stats = byCaste[k];
    if (stats.count > 0) {
      stats.avgDriftRate /= stats.count;
      stats.avgRewardOrZero /= stats.count;
    }
  }

  const morselById = new Map(morsels.map((l) => [l.id, l]));
  const longestChain = findLongestChain(morselById);

  const warnings: string[] = [];
  if (flight.outcome === "soldier_fallback" && !flight.soldierMorselId) {
    warnings.push("flight declared soldier_fallback but no soldier morsel was stashed");
  }
  if (flight.winnerMorselId && !morselById.has(flight.winnerMorselId)) {
    warnings.push(`winner morsel ${flight.winnerMorselId} is not in the Compost`);
  }
  for (const l of morsels) {
    for (const pid of l.parentMorselIds ?? []) {
      if (!morselById.has(pid)) {
        const orphan = await compost.getMorsel(pid);
        if (!orphan) {
          warnings.push(`morsel ${l.id} references missing parent ${pid}`);
        }
      }
    }
  }

  // Phase 6: artifact lineage.
  const artifact = await compost.getArtifactByFlightId(flightId);
  let artifactChildren: Artifact[] = [];
  if (artifact) {
    const all = await compost.allArtifacts();
    artifactChildren = all.filter((a) => a.parentArtifactIds.includes(artifact.id));
  }

  return {
    flight,
    totalMorsels: morsels.length,
    totalTokens,
    promptTokens,
    completionTokens,
    byCaste,
    highestDrift,
    longestChain,
    warnings,
    artifact,
    artifactChildren,
  };
}

export function collectFlightMorselIds(flight: Flight): string[] {
  const ids = new Set<string>();
  if (flight.contextMorselId) ids.add(flight.contextMorselId);
  for (const id of flight.foragerMorselIds) ids.add(id);
  for (const id of Object.values(flight.stingMorselIds)) ids.add(id);
  if (flight.soldierMorselId) ids.add(flight.soldierMorselId);
  for (const id of flight.specialistMorselIds ?? []) ids.add(id);
  return [...ids];
}

function emptyCasteStats(): Record<Caste, CasteStats> {
  const out = {} as Record<Caste, CasteStats>;
  for (const k of CASTES) {
    out[k] = {
      count: 0,
      totalTokens: 0,
      avgDriftRate: 0,
      avgRewardOrZero: 0,
    };
  }
  return out;
}

function findLongestChain(
  morselById: Map<string, Morsel>,
): { length: number; morselIds: string[] } {
  const depth = new Map<string, number>();
  const choice = new Map<string, string | null>();
  const visiting = new Set<string>();

  function compute(id: string): number {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) {
      // cycle: treat as leaf
      return 1;
    }
    visiting.add(id);
    const l = morselById.get(id);
    let best = 0;
    let bestParent: string | null = null;
    for (const pid of l?.parentMorselIds ?? []) {
      if (!morselById.has(pid)) continue;
      const d = compute(pid);
      if (d > best) {
        best = d;
        bestParent = pid;
      }
    }
    visiting.delete(id);
    depth.set(id, best + 1);
    choice.set(id, bestParent);
    return best + 1;
  }

  let bestId: string | null = null;
  let bestDepth = 0;
  for (const id of morselById.keys()) {
    const d = compute(id);
    if (d > bestDepth) {
      bestDepth = d;
      bestId = id;
    }
  }
  if (!bestId) return { length: 0, morselIds: [] };

  const chain: string[] = [];
  let cur: string | null = bestId;
  while (cur) {
    chain.push(cur);
    cur = choice.get(cur) ?? null;
  }
  chain.reverse();
  return { length: bestDepth, morselIds: chain };
}
