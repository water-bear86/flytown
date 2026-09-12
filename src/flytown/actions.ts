/**
 * Orchestration action vocabulary and the shared action → Plan compiler.
 *
 * Every planner backend (rules, random, learned, fly) emits scores over the
 * same small action set; this module turns those scores into a FLYTOWN
 * Plan with one deterministic, unit-tested rule set. Backends therefore differ
 * only in *what they decide*, never in how a decision becomes work — which is
 * what makes them comparable.
 */
import { randomUUID } from "node:crypto";
import type { Personality, Plan, PlanEdge, PlanNode } from "../types.js";
import type { TaskSignals } from "./signals.js";

export const ORCH_ACTIONS = [
  "spawn_flight",
  "increase_swarm_size",
  "request_artifact_investigation",
  "invoke_reviewer",
  "merge_results",
  "run_tool",
  "run_tests",
  "retry_new_approach",
  "search_memory",
  "surface_uncertainty",
  "request_human_approval",
  "terminate_success",
  "terminate_blocked",
] as const;
export type OrchAction = (typeof ORCH_ACTIONS)[number];
export type ActionScores = Record<OrchAction, number>;

export function zeroScores(): ActionScores {
  return Object.fromEntries(ORCH_ACTIONS.map((a) => [a, 0])) as ActionScores;
}

/** Normalise non-negative scores to sum to 1 (uniform if all zero / invalid). */
export function normalizeScores(raw: Partial<ActionScores>): ActionScores {
  const out = zeroScores();
  let sum = 0;
  for (const a of ORCH_ACTIONS) {
    const v = raw[a];
    const x = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    out[a] = x;
    sum += x;
  }
  if (sum <= 0) {
    for (const a of ORCH_ACTIONS) out[a] = 1 / ORCH_ACTIONS.length;
    return out;
  }
  for (const a of ORCH_ACTIONS) out[a] /= sum;
  return out;
}

export interface OrchDecision {
  primary: OrchAction;
  /** Actions with score >= includeRatio * max, excluding primary. */
  included: OrchAction[];
  scores: ActionScores;
  swarmSize: number;
  personality: Personality;
}

export interface DecideOptions {
  /** Actions whose score is at least this fraction of the max are included. Default 0.5. */
  includeRatio?: number;
  /**
   * Exploration: sample the primary action ∝ scores (seeded) instead of taking
   * the argmax. Used only during training epochs; evaluation is always greedy.
   */
  explore?: { rng: { next(): number } };
}

const PERSONALITY_ROTATION: Personality[] = ["stoic", "nerdy", "cynical", "chipper", "feral"];

export function decide(scores: ActionScores, signals: TaskSignals, opts: DecideOptions = {}): OrchDecision {
  const includeRatio = opts.includeRatio ?? 0.5;
  const entries = ORCH_ACTIONS.map((a) => [a, scores[a]] as const).sort((x, y) => y[1] - x[1] || ORCH_ACTIONS.indexOf(x[0]) - ORCH_ACTIONS.indexOf(y[0]));
  let primary: OrchAction = entries[0][0];
  if (opts.explore) {
    let u = opts.explore.rng.next();
    for (const [a, v] of entries) { u -= v; if (u <= 0) { primary = a; break; } }
  }
  const max = scores[primary] > 0 ? scores[primary] : entries[0][1];
  const included = entries.filter(([a, v]) => a !== primary && v >= includeRatio * max && v > 0).map(([a]) => a);
  const hasAction = (a: OrchAction) => primary === a || included.includes(a);

  let swarmSize = 3;
  if (hasAction("increase_swarm_size")) swarmSize = 5;
  else if (hasAction("surface_uncertainty")) swarmSize = 4;
  if (signals.pressure > 0.7) swarmSize = Math.max(1, swarmSize - 2);
  else if (signals.pressure > 0.4) swarmSize = Math.max(1, swarmSize - 1);

  let personality: Personality;
  switch (signals.deliverable) {
    case "investigation": personality = "cynical"; break;
    case "research": personality = "nerdy"; break;
    case "verification": personality = "stoic"; break;
    case "code_change": personality = "stoic"; break;
    case "answer": personality = "chipper"; break;
    default: personality = "nerdy";
  }
  if (hasAction("surface_uncertainty")) personality = "cynical";
  if (hasAction("retry_new_approach") && signals.history.replanDepth > 0) {
    // Rotate away from whatever led the failed attempt.
    personality = PERSONALITY_ROTATION[(signals.history.replanDepth + PERSONALITY_ROTATION.indexOf(personality) + 1) % PERSONALITY_ROTATION.length];
  }

  return { primary, included, scores, swarmSize, personality };
}

export interface CompileOptions {
  maxNodes?: number;
  plannerId: string;
  /** Deterministic plan id suffix (tests / replay). */
  planIdSeed?: string;
}

/**
 * Deterministically compile a decision into a Plan.
 *
 * Structural rules (documented so the trace is interpretable):
 *  - terminate_blocked / request_human_approval / terminate_success as the
 *    primary action produce a halted plan (no nodes).
 *  - Otherwise one main work node always exists.
 *  - request_artifact_investigation / search_memory add an investigation node
 *    that feeds the main node.
 *  - run_tests / run_tool add a verification node after the main node with
 *    guardTools enabled.
 *  - invoke_reviewer adds a review node after the main (or verification) node.
 *  - surface_uncertainty adds debate to the main node and asks for
 *    enumerated hypotheses.
 *  - merge_results, or any plan with more than one node, ends in a synthesize node.
 *  - retry_new_approach rewrites the main task to avoid the recorded failure.
 */
export function compilePlan(decision: OrchDecision, signals: TaskSignals, opts: CompileOptions): Plan {
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 6, 10));
  const id = "plan-" + (opts.planIdSeed ?? randomUUID().slice(0, 8));
  const base: Plan = { id, rootTask: signals.task, nodes: [], edges: [], replanDepth: signals.history.replanDepth, createdAt: Date.now(), plannerId: opts.plannerId };
  const has = (a: OrchAction) => decision.primary === a || decision.included.includes(a);

  if (decision.primary === "terminate_blocked") {
    return { ...base, halt: { kind: "blocked", reason: haltReason("blocked", signals) } };
  }
  if (decision.primary === "request_human_approval") {
    return { ...base, halt: { kind: "approval", reason: haltReason("approval", signals) } };
  }
  if (decision.primary === "terminate_success") {
    return { ...base, halt: { kind: "success", reason: haltReason("success", signals) } };
  }

  const nodes: PlanNode[] = [];
  const edges: PlanEdge[] = [];
  const mk = (nid: string, task: string, action: OrchAction, extra: Partial<PlanNode> = {}): PlanNode => ({
    id: nid, task, inputs: [], kind: "flight", status: "pending",
    swarmSize: decision.swarmSize, personality: decision.personality,
    hints: { action, ...(extra.hints ?? {}) }, ...extra,
  });
  const link = (from: string, to: string) => { edges.push({ from, to }); nodes.find((n) => n.id === to)!.inputs.push(from); };

  let prev: string | null = null;
  if ((has("request_artifact_investigation") || has("search_memory")) && nodes.length < maxNodes - 1) {
    const focus = has("search_memory") && signals.priorArtifacts > 0
      ? "Review the prior artifacts and the repository for facts directly relevant to the task; list what is established, what is contradicted, and what remains unknown."
      : "Investigate the repository and any error output before proposing changes: identify the concrete files, symbols and evidence involved; list competing explanations with the evidence for and against each.";
    nodes.push(mk("investigate", `${focus}\n\nTask context: ${signals.task}`, has("search_memory") ? "search_memory" : "request_artifact_investigation", { swarmSize: Math.min(decision.swarmSize, 3), personality: "cynical" }));
    prev = "investigate";
  }

  let mainTask = signals.task;
  if (has("retry_new_approach") && signals.history.failureReason) {
    mainTask = `${signals.task}\n\nA previous attempt failed: ${signals.history.failureReason}\nTake a materially different approach; do not repeat the failed strategy.`;
  }
  if (has("surface_uncertainty")) {
    mainTask = `${mainTask}\n\nState your assumptions explicitly. If more than one hypothesis is plausible, enumerate them with the evidence that would discriminate between them, and say which you are least sure about.`;
  }
  nodes.push(mk("main", mainTask, "spawn_flight", { hints: { action: "spawn_flight", debate: has("surface_uncertainty") || undefined } }));
  if (prev) link(prev, "main");
  prev = "main";

  if ((has("run_tests") || has("run_tool")) && nodes.length < maxNodes) {
    const verifyTask = has("run_tests")
      ? `Verify the result of the previous step against the repository's tests and build: state exactly which checks would pass or fail and why, citing concrete evidence.\n\nTask context: ${signals.task}`
      : `Verify the previous step's claims using the available verifier tools; report which claims are confirmed, refuted, or unverifiable.\n\nTask context: ${signals.task}`;
    nodes.push(mk("verify", verifyTask, has("run_tests") ? "run_tests" : "run_tool", { swarmSize: Math.min(decision.swarmSize, 2), personality: "stoic", hints: { action: has("run_tests") ? "run_tests" : "run_tool", guardTools: true } }));
    link(prev, "verify");
    prev = "verify";
  }

  if (has("invoke_reviewer") && nodes.length < maxNodes) {
    nodes.push(mk("review", `Critically review the previous step's output for correctness, missed cases, and unsupported claims${signals.securitySensitive ? ", with particular attention to security implications" : ""}. Reject anything not backed by evidence.\n\nTask context: ${signals.task}`, "invoke_reviewer", { swarmSize: Math.min(decision.swarmSize, 2), personality: "cynical" }));
    link(prev, "review");
    prev = "review";
  }

  if ((has("merge_results") || nodes.length > 1) && nodes.length < maxNodes) {
    nodes.push(mk("synthesize", `Synthesize the preceding steps into a single final deliverable for: ${signals.task}`, "merge_results", { kind: "synthesize", swarmSize: Math.min(decision.swarmSize, 2), personality: "stoic" }));
    link(prev, "synthesize");
  }

  return { ...base, nodes, edges };
}

function haltReason(kind: "blocked" | "approval" | "success", s: TaskSignals): string {
  if (kind === "blocked") {
    if (s.cues.mentionsBlocked) return "task text indicates the work is blocked on access, credentials or a human";
    if (s.approvalsPending > 0) return `${s.approvalsPending} approval(s) pending`;
    if (s.history.attempts >= 2) return `repeated failures (${s.history.attempts} attempts): ${s.history.failureReason ?? "no usable output"}`;
    return "planner judged the task cannot be completed with the available workers and tools";
  }
  if (kind === "approval") return s.cues.asksForApproval ? "task requires explicit human approval before proceeding" : "security-sensitive or irreversible work needs human sign-off";
  return s.cues.asksToStop ? "task asked to stop early; nothing further required" : "planner judged the task already satisfied by prior artifacts";
}

export type ActionEffectKind = "shaped" | "default" | "inert";
export interface ActionEffect {
  action: string;
  primary: boolean;
  /** shaped: changed the plan · default: the plan has this anyway · inert: selected but ignored by the compiler. */
  effect: ActionEffectKind;
  why: string;
}

const HALT_ACTIONS: ReadonlySet<string> = new Set(["terminate_blocked", "request_human_approval", "terminate_success"]);

/**
 * What each selected action actually did to the compiled plan.
 *
 * A decision lists every action above the inclusion threshold, but the
 * compiler acts on only some of them: a halt only as the primary action, a
 * retry only after a recorded failure, extra steps only under the node cap.
 * Showing the decision without this overstates how much the planner (fly or
 * otherwise) shaped the work. Mirrors the rules in compilePlan and decide.
 */
export function actionEffects(
  decision: Pick<OrchDecision, "primary" | "included">,
  signals: Pick<TaskSignals, "history" | "priorArtifacts">,
  plan: Pick<Plan, "halt" | "nodes">,
): ActionEffect[] {
  const selected: string[] = [decision.primary, ...decision.included];
  const has = (a: string) => selected.includes(a);
  const node = (id: string) => plan.nodes.some((n) => n.id === id);
  const capped = "dropped: the plan hit its node cap";
  return selected.map((action, i) => {
    const primary = i === 0;
    const e = (effect: ActionEffectKind, why: string): ActionEffect => ({ action, primary, effect, why });
    if (plan.halt) {
      return primary && HALT_ACTIONS.has(action) ? e("shaped", `halted the plan (${plan.halt.kind})`) : e("inert", "the plan halted before any work");
    }
    if (HALT_ACTIONS.has(action)) return e("inert", "halts only as the primary action");
    switch (action) {
      case "spawn_flight": return e("default", "every plan that runs has a main work step");
      case "increase_swarm_size": return e("shaped", "raised the swarm size");
      case "surface_uncertainty": return e("shaped", "debate on the main step, enumerated hypotheses, cynical workers");
      case "request_artifact_investigation":
        if (!node("investigate")) return e("inert", capped);
        return has("search_memory") ? e("default", "search_memory already added the investigation step") : e("shaped", "added an investigation step before the main work");
      case "search_memory":
        if (!node("investigate")) return e("inert", capped);
        return e("shaped", signals.priorArtifacts > 0 ? "added a step reviewing prior artifacts" : "added an investigation step (no prior artifacts to review)");
      case "retry_new_approach":
        if (signals.history.failureReason) return e("shaped", "rewrote the main task to avoid the recorded failure");
        if (signals.history.replanDepth > 0) return e("shaped", "rotated the worker personality away from the failed attempt");
        return e("inert", "no earlier failure to steer away from");
      case "run_tests": return node("verify") ? e("shaped", "added a verification step against tests and build") : e("inert", capped);
      case "run_tool":
        if (!node("verify")) return e("inert", capped);
        return has("run_tests") ? e("default", "run_tests already added the verification step") : e("shaped", "added a tool-verification step");
      case "invoke_reviewer": return node("review") ? e("shaped", "added a review step") : e("inert", capped);
      case "merge_results":
        if (!node("synthesize")) return e("inert", capped);
        return plan.nodes.length > 2 ? e("default", "a multi-step plan ends in synthesis anyway") : e("shaped", "added a synthesis step");
      default: return e("inert", "not a current orchestration action (older record)");
    }
  });
}
