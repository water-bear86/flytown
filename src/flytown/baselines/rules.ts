/**
 * Baseline #2 — conventional rules-based router.
 * Hand-written scoring over TaskSignals. No graph, no learning, no model call.
 */
import { randomUUID } from "node:crypto";
import { compilePlan, decide, normalizeScores, zeroScores, type ActionScores } from "../actions.js";
import { signalsFor, type PlannerBackend, type PlanRequest, type PlanResponse } from "../planner-backend.js";
import type { TaskSignals } from "../signals.js";
import { makeTrace } from "../trace.js";
import { hashSeed } from "../rng.js";

export function rulesScores(s: TaskSignals): ActionScores {
  const r = zeroScores();
  r.spawn_subrite = 1;

  if (s.cues.mentionsBlocked || s.approvalsPending > 0) r.terminate_blocked += 3;
  if (s.history.attempts >= 2 && s.history.lastOutcome === "failure") r.terminate_blocked += 3;
  if (s.cues.asksForApproval || (s.securitySensitive && s.deliverable === "code_change")) r.request_human_approval += 2.5;
  if (s.cues.asksToStop && s.priorArtifacts > 0) r.terminate_success += 2.5;

  if (s.deliverable === "investigation" || s.failures.runtimeErrors > 0 || s.failures.testFailures > 0) r.request_artifact_investigation += 1.5;
  if (s.cues.misleadingHint || s.conflictingHypotheses >= 2) { r.surface_uncertainty += 1.5; r.request_artifact_investigation += 0.5; }
  if (s.uncertainty > 0.4) r.surface_uncertainty += 1;
  if (s.priorArtifacts > 0) r.search_memory += 1;

  if (s.deliverable === "code_change" && s.repo.hasTests) r.run_tests += 1.2;
  if (s.deliverable === "verification") { r.run_tool += 1.2; r.run_tests += 0.8; }
  if (s.securitySensitive || s.deliverable === "code_change") r.invoke_reviewer += 1;
  if (s.complexity > 0.5) { r.increase_pack_size += 0.8; r.merge_results += 0.8; }
  if (s.deliverable === "research") { r.increase_pack_size += 0.6; r.merge_results += 0.6; }
  if (s.history.lastOutcome === "failure" && s.history.attempts < 2) r.retry_new_approach += 2;
  if (s.pressure > 0.6) { r.increase_pack_size = 0; r.invoke_reviewer *= 0.5; }

  return normalizeScores(r);
}

export function rulesPlannerBackend(): PlannerBackend {
  return {
    id: "rules",
    async plan(req: PlanRequest): Promise<PlanResponse> {
      const signals = await signalsFor(req);
      const scores = rulesScores(signals);
      const decision = decide(scores, signals);
      const runId = req.runId ?? `rules-${randomUUID().slice(0, 8)}`;
      const seed = hashSeed(runId, req.replanDepth ?? 0);
      const plan = compilePlan(decision, signals, { maxNodes: req.maxNodes, plannerId: "rules", planIdSeed: seed.toString(16) });
      const trace = makeTrace({ req, plannerId: "rules", runId, seed: 0, signals, scores, decision, plan, provenance: { rules: "ENGINEERING_CHOICE" } });
      return { plan, trace };
    },
  };
}
