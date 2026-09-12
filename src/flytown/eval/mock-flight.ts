/**
 * Deterministic mock worker world.
 *
 * Replaces performFlight so the routing loop (plan → execute → fail → replan)
 * can be exercised thousands of times with no model calls. The mock is
 * deliberately simple and *documented*: outcomes depend on the fixture's
 * traps, the node's action hint, swarm size and a seeded RNG. It is a toy —
 * it validates that a planner's decisions are consequential and comparable,
 * not that they are good in the real world. Live evaluation (`--live`) uses
 * the real pipeline.
 */
import { randomUUID } from "node:crypto";
import type { FlightRunner } from "../../plan-executor.js";
import type { FlightOptions, FlightResult } from "../../flight.js";
import type { Artifact, Morsel, Flight } from "../../types.js";
import { makeRng, hashSeed } from "../rng.js";
import type { Fixture } from "./fixtures.js";

export interface MockFlightStats {
  flights: number;
  tokens: number;
  foragerCalls: number;
  failures: number;
  /** actions seen, in order */
  actions: string[];
}

export interface MockFlightOptions {
  fixture: Fixture;
  seed: number;
  stats?: MockFlightStats;
}

const TOKENS_PER_FORAGER = 1800;
const TOKENS_FIXED = 1400; // scout + guard + scribe

export function makeMockFlightRunner(opts: MockFlightOptions): FlightRunner {
  const stats = opts.stats ?? { flights: 0, tokens: 0, foragerCalls: 0, failures: 0, actions: [] };
  const seen = { investigated: false, mainAttempts: 0, verified: false, reviewed: false };
  return async (ro: FlightOptions): Promise<FlightResult> => {
    const action = actionOf(ro);
    const rng = makeRng(hashSeed(opts.seed, opts.fixture.id, stats.flights, action));
    stats.flights++;
    stats.actions.push(action);
    const swarm = Math.max(1, ro.swarmSize);
    stats.foragerCalls += swarm;
    stats.tokens += TOKENS_FIXED + swarm * TOKENS_PER_FORAGER + (ro.debate ? swarm * 600 : 0) + (ro.guardTools ? 400 : 0);

    const t = opts.fixture.traps;
    let pFail = t.baseFailure ?? 0.1;
    if (action === "request_artifact_investigation" || action === "search_memory") { seen.investigated = true; pFail *= 0.5; }
    if (action === "run_tests" || action === "run_tool") { seen.verified = true; pFail *= 0.5; }
    if (action === "invoke_reviewer") { seen.reviewed = true; pFail *= 0.5; }
    if (action === "spawn_flight") {
      seen.mainAttempts++;
      if (t.needsInvestigation && !seen.investigated) pFail = Math.max(pFail, 0.75);
      if (t.firstMainAttemptFails && seen.mainAttempts === 1) pFail = 1;
      if (ro.debate) pFail *= 0.8;
    }
    if (action === "merge_results") {
      if (t.needsVerification && !seen.verified) pFail = Math.max(pFail, 0.5);
      if (t.needsReview && !seen.reviewed) pFail = Math.max(pFail, 0.5);
    }
    // Bigger swarms help a little, with diminishing returns; very small swarms hurt.
    pFail *= swarm >= 4 ? 0.8 : swarm === 1 ? 1.3 : 1;
    pFail = Math.min(1, pFail);

    const failed = rng.next() < pFail;
    if (failed) stats.failures++;
    const flightId = `mock-${randomUUID().slice(0, 8)}`;
    const winner: Morsel = {
      id: `morsel-${flightId}`, flightId, caste: "forager", personality: ro.personality ?? "nerdy", model: "mock", prompt: ro.task,
      output: failed ? "" : `mock output for ${action}`, reward: failed ? 0 : 0.6 + 0.4 * rng.next(), timestamp: Date.now(),
      drift: { casteMentions: { forager: 0, wasp: 0, scout: 0, guard: 0, soldier: 0, messenger: 0 }, totalCasteWords: 0, outputWordCount: 3, driftRate: 0 },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, model: "mock" },
    };
    const flight: Flight = {
      id: flightId, task: ro.task, scanGlobs: [], swarmSize: swarm, personality: ro.personality ?? "nerdy",
      foragerMorselIds: failed ? [] : [winner.id], stingMorselIds: {}, guardVerdicts: {},
      winnerMorselId: failed ? undefined : winner.id,
      outcome: failed ? "all_failed" : rng.next() < 0.15 ? "specialist_recovery" : "winner",
      startedAt: Date.now(), finishedAt: Date.now(),
    };
    if (!failed && !ro.skipScribe) {
      const art: Artifact = {
        id: `${flightId}-art`, flightId, task: ro.task, outcome: flight.outcome, winnerMorselId: winner.id,
        claims: [{ text: `mock claim from ${action}`, confidence: "likely" }], evidence: [], openQuestions: [], nextSteps: [],
        parentArtifactIds: (ro.parentArtifacts ?? []).map((a) => a.id), keywords: [action], timestamp: Date.now(),
      };
      await ro.compost.stashArtifact(art);
    }
    ro.onStep?.({ kind: "flight:done", outcome: flight.outcome });
    return { flight, winnerMorsel: winner, allMorsels: failed ? [] : [winner] };
  };
}

function actionOf(ro: FlightOptions): string {
  return ro.nodeHints?.action ?? "spawn_flight";
}
