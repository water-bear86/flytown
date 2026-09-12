/**
 * PlannerBackend — the FLYTOWN integration seam.
 *
 * The plan executor consumes a Plan (DAG of flights). Anything that can
 * produce a valid Plan can drive the existing worker pipeline unchanged. The
 * conventional LLM planner is one backend; rules/random/learned baselines and
 * the connectome-derived fly planner are others.
 *
 * Every backend may attach a DecisionTrace so the decision is auditable
 * regardless of how it was made.
 */
import { planTask } from "../planner.js";
import type { Artifact, Plan } from "../types.js";
import type { DecisionTrace } from "./trace.js";

export interface PlanRequest {
  task: string;
  /** Terrarium root / repository the task is about. Used for repo signals. */
  cwd: string;
  parentArtifacts?: Artifact[];
  failureContext?: { failedNodeId: string; reason: string; partialPlan: Plan };
  maxNodes?: number;
  maxOutputTokens?: number;
  budgetTokens?: number;
  /** 0 for the initial plan, 1.. for replans. */
  replanDepth?: number;
  /** Extra structured signals the caller already knows (test failures, errors, approvals...). */
  extraSignals?: Partial<import("./signals.js").ExternalSignals>;
  /** Pre-computed repository signals (replay, harness caching). */
  repo?: import("./signals.js").RepoSignals;
  /** Stable id used to key traces; generated when absent. */
  runId?: string;
}

/** Shared: derive signals for a request (honours a pre-computed repo scan). */
export async function signalsFor(req: PlanRequest) {
  const { deriveSignals } = await import("./signals.js");
  return deriveSignals({
    task: req.task, cwd: req.cwd, parentArtifacts: req.parentArtifacts, failureContext: req.failureContext,
    replanDepth: req.replanDepth, budgetTokens: req.budgetTokens, extra: req.extraSignals, repo: req.repo,
  });
}

export interface PlanResponse {
  plan: Plan;
  usage?: { totalTokens: number };
  trace?: DecisionTrace;
}

export interface PlannerBackend {
  readonly id: string;
  plan(req: PlanRequest): Promise<PlanResponse>;
}

/** Wraps the conventional LLM planner (planTask) as a PlannerBackend. */
export function llmPlannerBackend(): PlannerBackend {
  return {
    id: "llm",
    async plan(req) {
      const { plan, usage } = await planTask({
        task: req.task,
        parentArtifacts: req.parentArtifacts,
        failureContext: req.failureContext,
        maxNodes: req.maxNodes,
        maxOutputTokens: req.maxOutputTokens,
      });
      plan.plannerId = "llm";
      return { plan, usage };
    },
  };
}

/**
 * Runs `primary`; if it throws, records the failure and delegates to
 * `fallback`. This is the kill switch: the conventional planner always
 * remains reachable.
 */
export function withFallback(primary: PlannerBackend, fallback: PlannerBackend, onFallback?: (err: unknown) => void): PlannerBackend {
  return {
    id: primary.id,
    async plan(req) {
      try {
        return await primary.plan(req);
      } catch (err) {
        onFallback?.(err);
        const res = await fallback.plan(req);
        res.plan.plannerId = `${fallback.id}(fallback-from:${primary.id})`;
        return res;
      }
    },
  };
}
