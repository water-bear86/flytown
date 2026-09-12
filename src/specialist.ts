import { makeSpecialistForager, makeGuard } from "./castes.js";
import { measureDrift } from "./drift.js";
import { extractFirstJsonObject } from "./json-extract.js";
import { callInsect, callInsectStream } from "./openai-client.js";
import { makeThinkingRelay } from "./streaming.js";
import { guardReview } from "./guard-review.js";
import type { FailureCluster, Morsel, OutputFormat, GuardVerdict } from "./types.js";
import type { Compost } from "./compost.js";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * Build the user prompt for the failure-clustering call. Pure; safe to test.
 */
export function buildClusterPrompt(opts: {
  task: string;
  foragerMorsels: Morsel[];
  verdicts: Record<string, GuardVerdict>;
  waspMorselByForagerId: Record<string, Morsel | undefined>;
  maxClusters: number;
}): string {
  const lines: string[] = [];
  lines.push(`Original task:`);
  lines.push(opts.task);
  lines.push("");
  lines.push(`The swarm of ${opts.foragerMorsels.length} foragers all failed guard review. Their attempts and critiques follow.`);
  lines.push("");
  opts.foragerMorsels.forEach((g, i) => {
    const v = opts.verdicts[g.id];
    const wasp = opts.waspMorselByForagerId[g.id];
    lines.push(`--- Forager #${i} [${g.personality}] (morsel ${g.id}) ---`);
    lines.push(`Output:`);
    lines.push(truncate(g.output, 800));
    if (v) {
      lines.push(`Guard verdict: passed=${v.passed} score=${v.score.toFixed(2)}`);
      lines.push(`Guard critique: ${v.critique}`);
    } else {
      lines.push(`(no guard verdict)`);
    }
    if (wasp) {
      lines.push(`Wasp attack:`);
      lines.push(truncate(wasp.output, 600));
    }
    lines.push("");
  });
  lines.push(
    `Identify the 1-${opts.maxClusters} dominant failure modes across these attempts. ` +
      `A failure mode is a category of mistake (e.g. "null-handling", "off-by-one", "wrong-abstraction", "missing-edge-case"). ` +
      `Output ONLY a single JSON object, nothing else, matching this schema:`,
  );
  lines.push(`{`);
  lines.push(`  "clusters": [`);
  lines.push(`    {`);
  lines.push(`      "name": "kebab-case identifier",`);
  lines.push(`      "description": "1-2 sentences of what is wrong",`);
  lines.push(`      "affectedForagerIndexes": [0, 1],`);
  lines.push(`      "specialistFocus": "concise instruction telling a specialist what to fix",`);
  lines.push(`      "severity": "high" | "medium" | "low"`);
  lines.push(`    }`);
  lines.push(`  ]`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`Sort clusters by severity descending. No code fences. JSON only.`);
  return lines.join("\n");
}

/**
 * Parse a clustering JSON blob. Forgiving (handles fences, bad enums, etc.).
 */
export function parseClustersJson(raw: string, swarmSize: number, maxClusters: number): FailureCluster[] {
  const json = extractFirstJsonObject(raw);
  let parsed: Record<string, unknown> = {};
  if (json) {
    try {
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }
  const arr = Array.isArray(parsed.clusters) ? parsed.clusters : [];
  const clusters: FailureCluster[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const obj = c as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name.trim() : "";
    const description = typeof obj.description === "string" ? obj.description.trim() : "";
    const focus = typeof obj.specialistFocus === "string" ? obj.specialistFocus.trim() : "";
    if (!name || !focus) continue;
    const severityRaw = obj.severity;
    const severity: FailureCluster["severity"] =
      severityRaw === "high" || severityRaw === "medium" || severityRaw === "low"
        ? severityRaw
        : "medium";
    const idxs = Array.isArray(obj.affectedForagerIndexes)
      ? (obj.affectedForagerIndexes as unknown[])
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0 && n < swarmSize)
      : [];
    clusters.push({
      name,
      description: description || focus,
      affectedForagerIndexes: idxs,
      specialistFocus: focus,
      severity,
    });
  }
  return clusters
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, maxClusters);
}

/**
 * Build the user prompt a Specialist Forager receives. Pure.
 */
export function buildSpecialistPrompt(opts: {
  task: string;
  cluster: FailureCluster;
  seedMorsel: Morsel;
  seedWaspCritique?: string;
}): string {
  const parts: string[] = [];
  parts.push(`Original task:`);
  parts.push(opts.task);
  parts.push("");
  parts.push(`Your focus (the issue you must fix): ${opts.cluster.specialistFocus}`);
  parts.push(`Severity: ${opts.cluster.severity}`);
  parts.push(`Cluster description: ${opts.cluster.description}`);
  parts.push("");
  parts.push(`Best previous attempt (seed — fix this, don't restart unless unsalvageable):`);
  parts.push(opts.seedMorsel.output);
  if (opts.seedWaspCritique) {
    parts.push("");
    parts.push(`Wasp's specific complaint about this attempt:`);
    parts.push(truncate(opts.seedWaspCritique, 600));
  }
  parts.push("");
  parts.push(`Output the corrected answer only. No preamble. No commentary on the changes.`);
  return parts.join("\n");
}

/** Run the failure-clustering LLM call. */
export async function clusterFailures(opts: {
  task: string;
  foragerMorsels: Morsel[];
  verdicts: Record<string, GuardVerdict>;
  waspMorselByForagerId: Record<string, Morsel | undefined>;
  maxClusters: number;
  maxOutputTokens?: number;
}): Promise<{ clusters: FailureCluster[]; usage: Morsel["usage"] }> {
  // Use the guard model for clustering — it's the same adversarial sensibility,
  // and it's typically a cheap mini-tier model.
  const judge = makeGuard();
  const prompt = buildClusterPrompt({
    task: opts.task,
    foragerMorsels: opts.foragerMorsels,
    verdicts: opts.verdicts,
    waspMorselByForagerId: opts.waspMorselByForagerId,
    maxClusters: opts.maxClusters,
  });
  const { text, usage } = await callInsect(
    {
      ...judge,
      systemPrompt:
        `You are a failure analyst in the FLYTOWN swarm. ` +
        `Cluster the failures of a swarm of forager agents into 1-${opts.maxClusters} dominant failure modes. ` +
        `Output strict JSON only, no prose, no fences.`,
    },
    prompt,
    { maxOutputTokens: opts.maxOutputTokens ?? 800 },
  );
  const clusters = parseClustersJson(text, opts.foragerMorsels.length, opts.maxClusters);
  return { clusters, usage };
}

/**
 * Pick the seed morsel from a failed swarm: highest-reward forager, falling back
 * to the highest guard score, then the first.
 */
export function pickSeedMorsel(
  foragerMorsels: Morsel[],
  verdicts: Record<string, GuardVerdict>,
): Morsel | undefined {
  if (foragerMorsels.length === 0) return undefined;
  return foragerMorsels.reduce((best, cur) => {
    const bScore = best.reward ?? verdicts[best.id]?.score ?? 0;
    const cScore = cur.reward ?? verdicts[cur.id]?.score ?? 0;
    return cScore > bScore ? cur : best;
  });
}

/**
 * Run the specialist recovery layer. Returns the winner if any specialist
 * passes review OR meaningfully improves over the seed; null otherwise.
 */
export async function runSpecialistRecovery(opts: {
  flightId: string;
  task: string;
  clusters: FailureCluster[];
  seedMorsel: Morsel;
  seedScore: number;
  seedWaspByForagerId: Record<string, Morsel | undefined>;
  compost: Compost;
  maxOutputTokensPerCall?: number;
  outputFormat?: OutputFormat;
  /** Min absolute score-over-seed to count as a recovery win when no specialist passes outright. Default 0.05. */
  improvementMargin?: number;
  onSpawn?: (index: number, cluster: FailureCluster) => void;
  onDone?: (index: number, morsel: Morsel) => void;
  onVerdict?: (index: number, morsel: Morsel, verdict: GuardVerdict) => void;
  /** Live partial output from each specialist as it streams. */
  onThink?: (index: number, cumulativeText: string) => void;
}): Promise<{
  morsels: Morsel[];
  verdicts: Record<string, GuardVerdict>;
  winner: Morsel | null;
  /** Why this specialist won: "passed" if it cleared the guard, "improved" if it just beat the seed score. */
  winReason: "passed" | "improved" | null;
}> {
  const seedWasp = opts.seedWaspByForagerId[opts.seedMorsel.id]?.output;

  const jobs = opts.clusters.map((cluster, i) => async () => {
    opts.onSpawn?.(i, cluster);
    const specialist = makeSpecialistForager(cluster.specialistFocus);
    const userPrompt = buildSpecialistPrompt({
      task: opts.task,
      cluster,
      seedMorsel: opts.seedMorsel,
      seedWaspCritique: seedWasp,
    });
    const onThink = opts.onThink;
    let output: string;
    let usage;
    if (onThink) {
      const relay = makeThinkingRelay((text) => onThink(i, text));
      const r = await callInsectStream(specialist, userPrompt, relay.onChunk, {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      });
      relay.done();
      output = r.text;
      usage = r.usage;
    } else {
      const r = await callInsect(specialist, userPrompt, {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      });
      output = r.text;
      usage = r.usage;
    }
    const drift = measureDrift(output);
    const morsel: Morsel = {
      id: "",
      flightId: opts.flightId,
      caste: "forager",
      personality: specialist.personality,
      model: specialist.model,
      prompt: userPrompt,
      output,
      parentMorselIds: [opts.seedMorsel.id],
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.compost.stash(morsel);
    opts.onDone?.(i, morsel);
    return { morsel, index: i };
  });

  const results = await Promise.all(jobs.map((fn) => fn()));

  // Re-judge each specialist output sequentially (cheap, ordered logs).
  const verdicts: Record<string, GuardVerdict> = {};
  for (const { morsel, index } of results) {
    const { verdict, guardMorsel } = await guardReview({
      foragerMorsel: morsel,
      originalTask: opts.task,
      stingMorsel: undefined,
      compost: opts.compost,
      flightId: opts.flightId,
    });
    verdicts[morsel.id] = verdict;
    // stash guard's verdict morsel
    void guardMorsel;
    opts.onVerdict?.(index, morsel, verdict);
  }

  const allMorsels = results.map((r) => r.morsel);
  const passing = allMorsels.filter((l) => verdicts[l.id]?.passed);

  let winner: Morsel | null = null;
  let winReason: "passed" | "improved" | null = null;

  if (passing.length > 0) {
    winner = passing.reduce((best, cur) => {
      const bs = verdicts[best.id]?.score ?? 0;
      const cs = verdicts[cur.id]?.score ?? 0;
      return cs > bs ? cur : best;
    });
    winReason = "passed";
  } else {
    const margin = opts.improvementMargin ?? 0.05;
    const best = allMorsels.reduce((b, c) => {
      const bs = verdicts[b.id]?.score ?? 0;
      const cs = verdicts[c.id]?.score ?? 0;
      return cs > bs ? c : b;
    }, allMorsels[0]);
    if (best && (verdicts[best.id]?.score ?? 0) >= opts.seedScore + margin) {
      winner = best;
      winReason = "improved";
    }
  }

  return { morsels: allMorsels, verdicts, winner, winReason };
}

/* --------- internal helpers --------- */

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
