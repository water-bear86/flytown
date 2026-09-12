import { randomUUID } from "node:crypto";
import { renderArtifactContext, scribe } from "./artifact.js";
import { Budget, BudgetExceededError } from "./budget.js";
import { makeForager } from "./castes.js";
import { measureDrift } from "./drift.js";
import { callInsect, callInsectStream } from "./openai-client.js";
import { sugar } from "./reward.js";
import { scout } from "./scout.js";
import { stingPass } from "./sting.js";
import { swarmVariant } from "./swarm-prompt.js";
import { guardReview } from "./guard-review.js";
import { soldierFallback } from "./fallback.js";
import { clusterFailures, pickSeedMorsel, runSpecialistRecovery } from "./specialist.js";
import { runDebateRound } from "./debate.js";
import { makeThinkingRelay } from "./streaming.js";
import type { ToolDefinition } from "./tools.js";
import type {
  Artifact,
  Morsel,
  OutputFormat,
  Personality,
  PlanNodeHints,
  Flight,
  GuardVerdict,
} from "./types.js";
import type { Compost } from "./compost.js";
import type { RewardFn } from "./reward-plugin.js";

export interface FlightOptions {
  task: string;
  swarmSize: number;
  scanGlobs?: string[];
  cwd: string;
  compost: Compost;
  personality?: Personality;
  rewardFn?: RewardFn;
  noFallback?: boolean;
  budgetTokens?: number;
  maxOutputTokensPerCall?: number;
  onStep?: (step: FlightStep) => void;
  /** Prior artifacts to load as context (Phase 1 memory). */
  parentArtifacts?: Artifact[];
  /** Skip writing the post-flight Artifact (used by flights under a planner). */
  skipScribe?: boolean;
  /** Skip the failure-driven specialist recovery layer (Phase 2). Default false. */
  noSpecialist?: boolean;
  /** Max number of specialist clusters to spawn. Default 3. */
  specialistCap?: number;
  /** Phase 4: run an inter-agent debate round after the initial swarm. Default false (opt-in). */
  debate?: boolean;
  /** Phase 5: enable verifier tool-use during guard review. */
  guardTools?: boolean;
  /** Optional verifier tools used when guardTools is true. */
  tools?: ToolDefinition[];
  /** Optional formatting constraint for answer-producing calls. */
  outputFormat?: OutputFormat;
  /** Planner hints attached to the plan node this flight executes (informational). */
  nodeHints?: PlanNodeHints;
}

export type FlightStep =
  | { kind: "scout:start"; globs: string[] }
  | { kind: "scout:done"; morselId: string; fileCount: number }
  | { kind: "artifacts:loaded"; count: number; artifactIds: string[] }
  | { kind: "swarm:start"; size: number }
  | { kind: "swarm:forager"; morselId: string; index: number; personality?: Personality }
  | { kind: "debate:start"; round: number; size: number }
  | { kind: "debate:forager"; morselId: string; index: number; round: number }
  | { kind: "debate:done"; round: number }
  | { kind: "sting:start" }
  | { kind: "sting:done"; foragerId: string; waspId: string }
  | { kind: "review:start" }
  | { kind: "tool:calls"; calls: { name: string; args: Record<string, unknown> }[] }
  | { kind: "tool:results"; results: { name: string; ok: boolean; error?: string; durationMs?: number }[] }
  | { kind: "review:verdict"; verdict: GuardVerdict }
  | { kind: "specialist:cluster:start" }
  | { kind: "specialist:cluster:done"; clusters: { name: string; severity: "high"|"medium"|"low"; description: string }[] }
  | { kind: "specialist:cluster:empty"; reason: string }
  | { kind: "specialist:cluster:error"; message: string }
  | { kind: "specialist:spawn"; index: number; focus: string }
  | { kind: "specialist:done"; morselId: string; index: number }
  | { kind: "specialist:verdict"; verdict: GuardVerdict; index: number }
  | { kind: "fallback:start" }
  | { kind: "fallback:done"; morselId: string }
  | { kind: "scribe:start" }
  | { kind: "scribe:done"; artifactId: string }
  | { kind: "scribe:error"; message: string }
  /** Live partial output streamed from an insect. slot is "soldier", "forager#N", "specialist#N", etc. */
  | { kind: "thinking"; slot: string; text: string }
  | { kind: "budget:exceeded"; used: number; cap: number; phase: string }
  | { kind: "flight:done"; outcome: Flight["outcome"] };

const SWARM_PERSONALITIES: Personality[] = ["nerdy", "cynical", "chipper", "stoic", "feral"];

function pickSwarmPersonalities(swarmSize: number, base?: Personality): Personality[] {
  const pool = [...SWARM_PERSONALITIES];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: Personality[] = [];
  if (base) {
    out.push(base);
    const idx = pool.indexOf(base);
    if (idx >= 0) pool.splice(idx, 1);
  }
  for (let i = out.length; i < swarmSize; i++) {
    out.push(pool[(i - out.length) % pool.length]);
  }
  return out;
}

export interface FlightResult {
  flight: Flight;
  winnerMorsel: Morsel;
  allMorsels: Morsel[];
}

/**
 * Run one flight: scout (optional) → forager swarm → [debate] → wasp sting
 * pass → guard review → specialist recovery on failure → soldier escalation →
 * scribe. Every model call is stashed as a Morsel in the Compost.
 */
export async function performFlight(opts: FlightOptions): Promise<FlightResult> {
  const personality: Personality = opts.personality ?? "nerdy";
  const flightId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const onStep = opts.onStep ?? (() => {});

  const flight: Flight = {
    id: flightId,
    task: opts.task,
    scanGlobs: opts.scanGlobs ?? [],
    swarmSize: opts.swarmSize,
    personality,
    foragerMorselIds: [],
    stingMorselIds: {},
    guardVerdicts: {},
    outcome: "all_failed",
    startedAt,
  };
  const allMorsels: Morsel[] = [];
  const budget = new Budget(opts.budgetTokens);

  const checkBudget = (phase: string): boolean => {
    try {
      budget.enforceOrThrow();
      return true;
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        onStep({
          kind: "budget:exceeded",
          used: err.used,
          cap: err.cap,
          phase,
        });
        return false;
      }
      throw err;
    }
  };

  // Memory: prepend prior artifact context if any were passed in.
  let artifactBlock = "";
  if (opts.parentArtifacts && opts.parentArtifacts.length > 0) {
    artifactBlock = opts.parentArtifacts
      .map((a) => renderArtifactContext(a))
      .join("\n\n");
    onStep({
      kind: "artifacts:loaded",
      count: opts.parentArtifacts.length,
      artifactIds: opts.parentArtifacts.map((a) => a.id),
    });
  }

  let factsBlock = "";
  if (opts.scanGlobs && opts.scanGlobs.length > 0 && checkBudget("scout")) {
    onStep({ kind: "scout:start", globs: opts.scanGlobs });
    const result = await scout({
      task: opts.task,
      scanGlobs: opts.scanGlobs,
      cwd: opts.cwd,
      compost: opts.compost,
      personality,
      flightId,
    });
    budget.charge(result.morsel.usage);
    flight.contextMorselId = result.morsel.id;
    factsBlock = result.facts;
    allMorsels.push(result.morsel);
    onStep({
      kind: "scout:done",
      morselId: result.morsel.id,
      fileCount: result.files.length,
    });
  }

  onStep({ kind: "swarm:start", size: opts.swarmSize });
  if (!checkBudget("swarm")) {
    flight.finishedAt = Date.now();
    await opts.compost.stashFlight(flight);
    onStep({ kind: "flight:done", outcome: flight.outcome });
    throw new BudgetExceededError(budget.used, opts.budgetTokens ?? 0);
  }
  const foragerPersonalities = pickSwarmPersonalities(opts.swarmSize, opts.personality);
  const sections = [opts.task];
  if (artifactBlock) sections.push(`Prior context (artifacts you may build on):\n${artifactBlock}`);
  if (factsBlock) sections.push(`Facts gathered by the Scout:\n${factsBlock}`);
  const taskWithFacts = sections.join("\n\n");

  const foragerJobs = foragerPersonalities.map((p, i) => async () => {
    const forager = makeForager(p);
    const variantPrompt = swarmVariant(taskWithFacts, i, opts.swarmSize);
    const slot = `forager#${i}`;
    const relay = makeThinkingRelay((text) => onStep({ kind: "thinking", slot, text }));
    const { text: output, usage } = await callInsectStream(
      forager,
      variantPrompt,
      relay.onChunk,
      {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      },
    );
    relay.done();
    const drift = measureDrift(output);
    const morsel: Morsel = {
      id: "",
      flightId,
      caste: "forager",
      personality: forager.personality,
      model: forager.model,
      prompt: variantPrompt,
      output,
      parentMorselIds: flight.contextMorselId ? [flight.contextMorselId] : undefined,
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.compost.stash(morsel);
    onStep({ kind: "swarm:forager", morselId: morsel.id, index: i, personality: p });
    return morsel;
  }).map((fn) => fn());

  let foragerMorsels = await Promise.all(foragerJobs);
  for (const g of foragerMorsels) budget.charge(g.usage);
  allMorsels.push(...foragerMorsels);

  // Phase 4: inter-agent debate round (opt-in). Each forager sees peers and revises.
  if (opts.debate && foragerMorsels.length >= 2 && checkBudget("debate")) {
    onStep({ kind: "debate:start", round: 1, size: foragerMorsels.length });
    try {
      const { revisedMorsels } = await runDebateRound({
        flightId,
        task: opts.task,
        swarmMorsels: foragerMorsels,
        compost: opts.compost,
        maxOutputTokensPerCall: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
        onSpawn: (i) => { /* the slot is already a forager#i */ },
        onDone: (i, l) =>
          onStep({ kind: "debate:forager", morselId: l.id, index: i, round: 1 }),
        onThink: (i, text) =>
          onStep({ kind: "thinking", slot: `forager#${i}`, text }),
      });
      for (const l of revisedMorsels) {
        budget.charge(l.usage);
        allMorsels.push(l);
      }
      // Replace the swarm with the revised morsels so downstream stages judge the
      // post-debate version (more honest evaluation of the debate's effect).
      foragerMorsels = revisedMorsels;
      onStep({ kind: "debate:done", round: 1 });
    } catch {
      onStep({ kind: "debate:done", round: 1 });
      // fall through; debate failures are non-fatal
    }
  }

  flight.foragerMorselIds = foragerMorsels.map((g) => g.id);

  onStep({ kind: "sting:start" });
  if (!checkBudget("sting")) {
    flight.finishedAt = Date.now();
    await opts.compost.stashFlight(flight);
    onStep({ kind: "flight:done", outcome: flight.outcome });
    throw new BudgetExceededError(budget.used, opts.budgetTokens ?? 0);
  }
  const stingJobs = foragerMorsels.map(async (g) => {
    const c = await stingPass({
      foragerMorsel: g,
      originalTask: opts.task,
      compost: opts.compost,
      flightId,
    });
    onStep({ kind: "sting:done", foragerId: g.id, waspId: c.id });
    return [g.id, c] as const;
  });
  const stingResults = await Promise.all(stingJobs);
  const stingByForagerId = new Map<string, Morsel>();
  for (const [gid, cl] of stingResults) {
    flight.stingMorselIds[gid] = cl.id;
    stingByForagerId.set(gid, cl);
    allMorsels.push(cl);
    budget.charge(cl.usage);
  }

  // sequential so console output stays in swarm order
  onStep({ kind: "review:start" });
  const rewardFn = opts.rewardFn ?? sugar;
  for (const g of foragerMorsels) {
    if (!checkBudget("review")) break;
    const { verdict, guardMorsel } = await guardReview({
      foragerMorsel: g,
      originalTask: opts.task,
      stingMorsel: stingByForagerId.get(g.id),
      compost: opts.compost,
      flightId,
      withTools: opts.guardTools,
      tools: opts.tools,
      onToolCalls: (calls) =>
        onStep({ kind: "tool:calls", calls: calls.map((c) => ({ name: c.name, args: c.args })) }),
      onToolResults: (results) =>
        onStep({
          kind: "tool:results",
          results: results.map((r) => ({
            name: r.name, ok: r.ok, error: r.error, durationMs: r.durationMs,
          })),
        }),
    });
    budget.charge(guardMorsel.usage);
    flight.guardVerdicts[g.id] = verdict;
    g.reward = rewardFn(g, verdict);
    await opts.compost.stash(g);
    allMorsels.push(guardMorsel);
    onStep({ kind: "review:verdict", verdict });
  }

  const passed = foragerMorsels.filter((g) => flight.guardVerdicts[g.id]?.passed);
  let winnerMorsel: Morsel;

  if (passed.length > 0) {
    winnerMorsel = passed.reduce((best, cur) =>
      (cur.reward ?? 0) > (best.reward ?? 0) ? cur : best,
    );
    flight.winnerMorselId = winnerMorsel.id;
    flight.outcome = "winner";
  } else if (opts.noFallback) {
    winnerMorsel = foragerMorsels.reduce((best, cur) =>
      (cur.reward ?? 0) > (best.reward ?? 0) ? cur : best,
    );
    flight.winnerMorselId = winnerMorsel.id;
    flight.outcome = "all_failed";
  } else {
    // Phase 2 recovery: try specialist recovery before paying for the soldier.
    let specialistWinner: Morsel | null = null;
    const specialistsAllowed =
      !opts.noSpecialist && foragerMorsels.length > 0 && checkBudget("specialist");
    if (specialistsAllowed) {
      onStep({ kind: "specialist:cluster:start" });
      try {
        const seed = pickSeedMorsel(foragerMorsels, flight.guardVerdicts);
        const waspByForagerId: Record<string, Morsel | undefined> = {};
        for (const [gid, gl] of stingByForagerId) waspByForagerId[gid] = gl;
        const cap = Math.max(1, Math.min(opts.specialistCap ?? 3, 3));
        const { clusters, usage: clusterUsage } = await clusterFailures({
          task: opts.task,
          foragerMorsels,
          verdicts: flight.guardVerdicts,
          waspMorselByForagerId: waspByForagerId,
          maxClusters: cap,
        });
        if (clusterUsage) budget.charge(clusterUsage);
        onStep({
          kind: "specialist:cluster:done",
          clusters: clusters.map((c) => ({
            name: c.name,
            severity: c.severity,
            description: c.description,
          })),
        });

        if (!seed) {
          onStep({ kind: "specialist:cluster:empty", reason: "no failed seed output available" });
        } else if (clusters.length === 0) {
          onStep({ kind: "specialist:cluster:empty", reason: "failure clustering returned no repair focus" });
        } else if (checkBudget("specialist")) {
          const seedScore = flight.guardVerdicts[seed.id]?.score ?? 0;
          const result = await runSpecialistRecovery({
            flightId,
            task: opts.task,
            clusters,
            seedMorsel: seed,
            seedScore,
            seedWaspByForagerId: waspByForagerId,
            compost: opts.compost,
            maxOutputTokensPerCall: opts.maxOutputTokensPerCall,
            outputFormat: opts.outputFormat,
            onSpawn: (i, c) =>
              onStep({ kind: "specialist:spawn", index: i, focus: c.specialistFocus }),
            onDone: (i, l) =>
              onStep({ kind: "specialist:done", morselId: l.id, index: i }),
            onVerdict: (i, l, v) => {
              onStep({ kind: "specialist:verdict", verdict: v, index: i });
            },
            onThink: (i, text) =>
              onStep({ kind: "thinking", slot: `specialist#${i}`, text }),
          });
          for (const l of result.morsels) {
            if (l.usage) budget.charge(l.usage);
            allMorsels.push(l);
          }
          flight.specialistMorselIds = result.morsels.map((l) => l.id);
          flight.specialistVerdicts = result.verdicts;
          if (result.winner) {
            const r = result.verdicts[result.winner.id];
            result.winner.reward = r ? rewardFn(result.winner, r) : 0;
            await opts.compost.stash(result.winner);
            specialistWinner = result.winner;
          }
        }
      } catch (err) {
        onStep({
          kind: "specialist:cluster:error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (specialistWinner) {
      flight.winnerMorselId = specialistWinner.id;
      flight.outcome = "specialist_recovery";
      winnerMorsel = specialistWinner;
    } else if (!checkBudget("fallback")) {
      winnerMorsel = foragerMorsels.reduce((best, cur) =>
        (cur.reward ?? 0) > (best.reward ?? 0) ? cur : best,
      );
      flight.winnerMorselId = winnerMorsel.id;
      flight.outcome = "all_failed";
    } else {
      onStep({ kind: "fallback:start" });
      const soldierMorsel = await soldierFallback({
        task: opts.task,
        foragerMorsels,
        guardVerdicts: flight.guardVerdicts,
        stingByForagerId: Object.fromEntries(stingByForagerId),
        compost: opts.compost,
        flightId,
        outputFormat: opts.outputFormat,
        onThink: (text) => onStep({ kind: "thinking", slot: "soldier", text }),
      });
      budget.charge(soldierMorsel.usage);
      flight.soldierMorselId = soldierMorsel.id;
      flight.winnerMorselId = soldierMorsel.id;
      flight.outcome = "soldier_fallback";
      allMorsels.push(soldierMorsel);
      winnerMorsel = soldierMorsel;
      onStep({ kind: "fallback:done", morselId: soldierMorsel.id });
    }
  }

  flight.finishedAt = Date.now();
  await opts.compost.stashFlight(flight);

  // Phase 1 memory: Messenger-as-Scribe distills this flight into a typed Artifact.
  // Failure here is non-fatal: the flight itself succeeded, the artifact is a bonus.
  if (!opts.skipScribe && checkBudget("scribe")) {
    onStep({ kind: "scribe:start" });
    try {
      const verdicts = Object.values(flight.guardVerdicts);
      const soldierMorselForScribe =
        flight.soldierMorselId && flight.soldierMorselId !== flight.winnerMorselId
          ? allMorsels.find((l) => l.id === flight.soldierMorselId) ?? null
          : (flight.outcome === "soldier_fallback" ? winnerMorsel : null);
      const waspMorsels = allMorsels.filter((l) => l.caste === "wasp");
      const { artifact, usage } = await scribe({
        flight,
        winnerMorsel,
        foragerMorsels,
        waspMorsels,
        soldierMorsel: soldierMorselForScribe,
        verdicts,
        parentArtifacts: opts.parentArtifacts ?? [],
      });
      if (usage && typeof usage === "object" && "totalTokens" in usage) {
        try { budget.charge(usage as Morsel["usage"]); } catch { /* budget cap is informational here */ }
      }
      await opts.compost.stashArtifact(artifact);
      onStep({ kind: "scribe:done", artifactId: artifact.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onStep({ kind: "scribe:error", message });
      // non-fatal — artifact is a bonus, not a requirement
    }
  }

  onStep({ kind: "flight:done", outcome: flight.outcome });

  return { flight, winnerMorsel, allMorsels };
}
