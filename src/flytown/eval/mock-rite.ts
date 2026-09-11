/**
 * Deterministic mock worker world.
 *
 * Replaces performRite so the routing loop (plan → execute → fail → replan)
 * can be exercised thousands of times with no model calls. The mock is
 * deliberately simple and *documented*: outcomes depend on the fixture's
 * traps, the node's action hint, pack size and a seeded RNG. It is a toy —
 * it validates that a planner's decisions are consequential and comparable,
 * not that they are good in the real world. Live evaluation (`--live`) uses
 * the real pipeline.
 */
import { randomUUID } from "node:crypto";
import type { RiteRunner } from "../../plan-executor.js";
import type { RiteOptions, RiteResult } from "../../rite.js";
import type { Artifact, Loot, Rite } from "../../types.js";
import { makeRng, hashSeed } from "../rng.js";
import type { Fixture } from "./fixtures.js";

export interface MockRiteStats {
  rites: number;
  tokens: number;
  goblinCalls: number;
  failures: number;
  /** actions seen, in order */
  actions: string[];
}

export interface MockRiteOptions {
  fixture: Fixture;
  seed: number;
  stats?: MockRiteStats;
}

const TOKENS_PER_GOBLIN = 1800;
const TOKENS_FIXED = 1400; // raccoon + troll + scribe

export function makeMockRiteRunner(opts: MockRiteOptions): RiteRunner {
  const stats = opts.stats ?? { rites: 0, tokens: 0, goblinCalls: 0, failures: 0, actions: [] };
  const seen = { investigated: false, mainAttempts: 0, verified: false, reviewed: false };
  return async (ro: RiteOptions): Promise<RiteResult> => {
    const action = actionOf(ro);
    const rng = makeRng(hashSeed(opts.seed, opts.fixture.id, stats.rites, action));
    stats.rites++;
    stats.actions.push(action);
    const pack = Math.max(1, ro.packSize);
    stats.goblinCalls += pack;
    stats.tokens += TOKENS_FIXED + pack * TOKENS_PER_GOBLIN + (ro.debate ? pack * 600 : 0) + (ro.trollTools ? 400 : 0);

    const t = opts.fixture.traps;
    let pFail = t.baseFailure ?? 0.1;
    if (action === "request_artifact_investigation" || action === "search_memory") { seen.investigated = true; pFail *= 0.5; }
    if (action === "run_tests" || action === "run_tool") { seen.verified = true; pFail *= 0.5; }
    if (action === "invoke_reviewer") { seen.reviewed = true; pFail *= 0.5; }
    if (action === "spawn_subrite") {
      seen.mainAttempts++;
      if (t.needsInvestigation && !seen.investigated) pFail = Math.max(pFail, 0.75);
      if (t.firstMainAttemptFails && seen.mainAttempts === 1) pFail = 1;
      if (ro.debate) pFail *= 0.8;
    }
    if (action === "merge_results") {
      if (t.needsVerification && !seen.verified) pFail = Math.max(pFail, 0.5);
      if (t.needsReview && !seen.reviewed) pFail = Math.max(pFail, 0.5);
    }
    // Bigger packs help a little, with diminishing returns; very small packs hurt.
    pFail *= pack >= 4 ? 0.8 : pack === 1 ? 1.3 : 1;
    pFail = Math.min(1, pFail);

    const failed = rng.next() < pFail;
    if (failed) stats.failures++;
    const riteId = `mock-${randomUUID().slice(0, 8)}`;
    const winner: Loot = {
      id: `loot-${riteId}`, riteId, creatureKind: "goblin", personality: ro.personality ?? "nerdy", model: "mock", prompt: ro.task,
      output: failed ? "" : `mock output for ${action}`, reward: failed ? 0 : 0.6 + 0.4 * rng.next(), timestamp: Date.now(),
      drift: { creatureMentions: { goblin: 0, gremlin: 0, raccoon: 0, troll: 0, ogre: 0, pigeon: 0 }, totalCreatureWords: 0, outputWordCount: 3, driftRate: 0 },
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, model: "mock" },
    };
    const rite: Rite = {
      id: riteId, task: ro.task, scanGlobs: [], packSize: pack, personality: ro.personality ?? "nerdy",
      goblinLootIds: failed ? [] : [winner.id], chaosLootIds: {}, trollVerdicts: {},
      winnerLootId: failed ? undefined : winner.id,
      outcome: failed ? "all_failed" : rng.next() < 0.15 ? "specialist_recovery" : "winner",
      startedAt: Date.now(), finishedAt: Date.now(),
    };
    if (!failed && !ro.skipScribe) {
      const art: Artifact = {
        id: `${riteId}-art`, riteId, task: ro.task, outcome: rite.outcome, winnerLootId: winner.id,
        claims: [{ text: `mock claim from ${action}`, confidence: "likely" }], evidence: [], openQuestions: [], nextSteps: [],
        parentArtifactIds: (ro.parentArtifacts ?? []).map((a) => a.id), keywords: [action], timestamp: Date.now(),
      };
      await ro.hoard.stashArtifact(art);
    }
    ro.onStep?.({ kind: "rite:done", outcome: rite.outcome });
    return { rite, winnerLoot: winner, allLoot: failed ? [] : [winner] };
  };
}

function actionOf(ro: RiteOptions): string {
  return ro.nodeHints?.action ?? "spawn_subrite";
}
