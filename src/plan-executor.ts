/**
 * Topological executor for a Plan. Each node becomes a flight (skipScribe
 * defaults to false so each flight produces its own artifact, which is then
 * fed forward to dependent nodes). On a node failure we may invoke the planner
 * again with the failure context (recursive replan, max depth 2 by default).
 *
 * The executor is planner-agnostic: it consumes a Plan and, on replan, asks
 * an injected PlannerBackend for a new one. The default backend wraps the
 * conventional LLM planner (planTask). Flight execution is likewise injected
 * (flightRunner) so the routing loop can be exercised deterministically without
 * model calls.
 */
import { topologicalOrder, validatePlan } from "./planner.js";
import { performFlight, type FlightOptions, type FlightResult, type FlightStep } from "./flight.js";
import { llmPlannerBackend, type PlannerBackend } from "./flytown/planner-backend.js";
import type {
  Artifact,
  OutputFormat,
  Plan,
  PlanNode,
  Flight,
  TerrariumManifest,
} from "./types.js";
import type { Compost } from "./compost.js";

export type FlightRunner = (opts: FlightOptions) => Promise<FlightResult>;

export interface PlanExecOptions {
  plan: Plan;
  cwd: string;
  compost: Compost;
  rewardFn?: FlightOptions["rewardFn"];
  budgetTokens?: number;
  maxOutputTokensPerCall?: number;
  outputFormat?: OutputFormat;
  parentArtifacts?: Artifact[];
  /** Max times to recursively replan on node failure. Default 2. */
  maxReplanDepth?: number;
  /** Planner backend used for replanning. Default: the conventional LLM planner. */
  planner?: PlannerBackend;
  /** Flight runner. Default: performFlight. Injectable for deterministic evaluation. */
  flightRunner?: FlightRunner;
  /** Forwarded to each flight; lets the UI/console see progress. */
  onStep?: (nodeId: string, step: FlightStep) => void;
  /** Lifecycle hooks for the plan itself. */
  onPlanEvent?: (ev: PlanExecutionEvent) => void;
}

export type PlanExecutionEvent =
  | { kind: "plan:start"; plan: Plan }
  | { kind: "plan:halt"; halt: NonNullable<Plan["halt"]> }
  | { kind: "plan:node:start"; nodeId: string }
  | { kind: "plan:node:done"; nodeId: string; flightId: string; artifactId?: string; outcome: Flight["outcome"] }
  | { kind: "plan:node:failed"; nodeId: string; reason: string }
  | { kind: "plan:replan"; depth: number; reason: string }
  | { kind: "plan:done"; outcome: PlanOutcome; finalFlightId?: string; finalArtifactId?: string; finalMorselId?: string };

export type PlanOutcome = "success" | "failed" | "halted";

export interface PlanExecResult {
  plan: Plan;
  finalArtifact?: Artifact;
  finalFlightId?: string;
  /** Morsel id of the last node's winning morsel — survives even when scribe failed. */
  finalMorselId?: string;
  outcome: PlanOutcome;
  /** Number of replans that actually happened. */
  replans: number;
  /** Set when outcome is "halted". */
  halt?: NonNullable<Plan["halt"]>;
}

export async function executePlan(opts: PlanExecOptions): Promise<PlanExecResult> {
  const maxDepth = opts.maxReplanDepth ?? 2;
  const planner = opts.planner ?? llmPlannerBackend();
  const runFlight = opts.flightRunner ?? performFlight;
  let plan = opts.plan;
  opts.onPlanEvent?.({ kind: "plan:start", plan });

  // Map nodeId -> Artifact produced.
  const produced = new Map<string, Artifact>();
  // Map nodeId -> winnerMorselId (independent of whether scribe succeeded).
  const morselByNode = new Map<string, string>();
  const parentArtifacts = opts.parentArtifacts ?? [];
  let replans = 0;

  for (let attempt = 0; attempt <= maxDepth; attempt++) {
    if (plan.halt) {
      opts.onPlanEvent?.({ kind: "plan:halt", halt: plan.halt });
      opts.onPlanEvent?.({ kind: "plan:done", outcome: "halted" });
      return { plan, outcome: "halted", replans, halt: plan.halt };
    }

    const v = validatePlan(plan);
    if (!v.ok) {
      opts.onPlanEvent?.({ kind: "plan:done", outcome: "failed" });
      throw new Error(`invalid plan: ${v.errors.join("; ")}`);
    }

    const order = topologicalOrder(plan);
    let failedNode: PlanNode | null = null;
    let failureReason = "";

    for (const node of order) {
      // Skip already-completed nodes if replan preserved them.
      if (node.status === "done" && node.artifactId) continue;

      // Gather parent artifacts: external priors + outputs of node.inputs.
      const inputArtifacts: Artifact[] = [...parentArtifacts];
      for (const inp of node.inputs) {
        const a = produced.get(inp);
        if (a) inputArtifacts.push(a);
      }

      node.status = "running";
      opts.onPlanEvent?.({ kind: "plan:node:start", nodeId: node.id });

      try {
        const result = await runFlight({
          task: node.task,
          swarmSize: node.swarmSize ?? 3,
          scanGlobs: [],
          cwd: opts.cwd,
          compost: opts.compost,
          personality: node.personality,
          rewardFn: opts.rewardFn,
          budgetTokens: opts.budgetTokens,
          maxOutputTokensPerCall: opts.maxOutputTokensPerCall,
          outputFormat: opts.outputFormat,
          parentArtifacts: inputArtifacts,
          guardTools: node.hints?.guardTools,
          debate: node.hints?.debate,
          nodeHints: node.hints,
          // flights still produce their own artifacts (cheap scribe call)
          skipScribe: false,
          onStep: (step) => opts.onStep?.(node.id, step),
        });
        node.flightId = result.flight.id;
        node.status = "done";
        if (result.flight.winnerMorselId) morselByNode.set(node.id, result.flight.winnerMorselId);

        // Pull the just-written artifact back from the compost if scribe succeeded.
        const artifact = await opts.compost.getArtifactByFlightId(result.flight.id);
        if (artifact) {
          node.artifactId = artifact.id;
          produced.set(node.id, artifact);
        }

        opts.onPlanEvent?.({
          kind: "plan:node:done",
          nodeId: node.id,
          flightId: result.flight.id,
          artifactId: artifact?.id,
          outcome: result.flight.outcome,
        });

        // A node "fails" for the planner's purposes only if it ended in
        // all_failed. winner / specialist_recovery / soldier_fallback are all
        // acceptable resolutions.
        if (result.flight.outcome === "all_failed") {
          failedNode = node;
          failureReason = `node ${node.id} ended all_failed (no usable output)`;
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        node.status = "failed";
        node.failureReason = message;
        opts.onPlanEvent?.({ kind: "plan:node:failed", nodeId: node.id, reason: message });
        failedNode = node;
        failureReason = message;
        break;
      }
    }

    if (!failedNode) {
      // success
      const lastNode = order[order.length - 1];
      const finalArtifact = lastNode ? produced.get(lastNode.id) : undefined;
      const finalMorselId = lastNode ? morselByNode.get(lastNode.id) : undefined;
      opts.onPlanEvent?.({
        kind: "plan:done",
        outcome: "success",
        finalFlightId: lastNode?.flightId,
        finalArtifactId: finalArtifact?.id,
        finalMorselId,
      });
      return {
        plan,
        finalArtifact,
        finalFlightId: lastNode?.flightId,
        finalMorselId,
        outcome: "success",
        replans,
      };
    }

    // Failure path: try replan if budget allows.
    if (attempt >= maxDepth) {
      opts.onPlanEvent?.({ kind: "plan:done", outcome: "failed" });
      return { plan, outcome: "failed", replans };
    }

    opts.onPlanEvent?.({ kind: "plan:replan", depth: attempt + 1, reason: failureReason });
    replans++;

    const replanned = await planner.plan({
      task: plan.rootTask,
      cwd: opts.cwd,
      parentArtifacts: [...parentArtifacts, ...produced.values()],
      failureContext: { failedNodeId: failedNode.id, reason: failureReason, partialPlan: plan },
      maxOutputTokens: opts.maxOutputTokensPerCall,
      budgetTokens: opts.budgetTokens,
      replanDepth: attempt + 1,
    });
    plan = { ...replanned.plan, replanDepth: attempt + 1 };
    // Carry forward artifacts produced so far so subsequent nodes can reuse them
    // when the new plan re-uses input ids by coincidence (best-effort).
  }

  opts.onPlanEvent?.({ kind: "plan:done", outcome: "failed" });
  return { plan, outcome: "failed", replans };
}

// Re-export for convenient imports.
export type { TerrariumManifest };
