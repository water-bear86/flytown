/**
 * Control baseline — seeded random action scores. Uses the same signals and
 * compiler as every other backend, so it isolates "does the decision carry
 * information at all" from "is the plan shape sane".
 */
import { randomUUID } from "node:crypto";
import { compilePlan, decide, normalizeScores, ORCH_ACTIONS, zeroScores } from "../actions.js";
import { signalsFor, type PlannerBackend, type PlanRequest, type PlanResponse } from "../planner-backend.js";
import { hashSeed, makeRng } from "../rng.js";
import { makeTrace } from "../trace.js";

export function randomPlannerBackend(opts: { seed?: number } = {}): PlannerBackend {
  return {
    id: "random",
    async plan(req: PlanRequest): Promise<PlanResponse> {
      const signals = await signalsFor(req);
      const runId = req.runId ?? `random-${randomUUID().slice(0, 8)}`;
      const seed = hashSeed(opts.seed ?? 0, runId, req.replanDepth ?? 0);
      const rng = makeRng(seed);
      const raw = zeroScores();
      for (const a of ORCH_ACTIONS) raw[a] = rng.next();
      const scores = normalizeScores(raw);
      const decision = decide(scores, signals);
      const plan = compilePlan(decision, signals, { maxNodes: req.maxNodes, plannerId: "random", planIdSeed: seed.toString(16) });
      const trace = makeTrace({ req, plannerId: "random", runId, seed, signals, scores, decision, plan, provenance: { random: "ENGINEERING_CHOICE" }, notes: ["control: uniformly random action scores"] });
      return { plan, trace };
    },
  };
}
