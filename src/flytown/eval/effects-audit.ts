/**
 * Action-effect audit.
 *
 * For each planner, decide (no workers, no model calls) on every fixture and
 * count what the selected actions actually did to the compiled plan. This
 * separates "which actions did the planner score highest" from "how much did
 * the planner change the work": a primary action can be inert (a retry with
 * nothing to retry), or add nothing beyond the default plan.
 */
import { actionEffects, compilePlan, decide, normalizeScores } from "../actions.js";
import { resolvePlannerBackend } from "../registry.js";
import { scanRepo, type RepoSignals } from "../signals.js";
import { FIXTURES, type Fixture } from "./fixtures.js";
import type { Artifact, Plan } from "../../types.js";

export interface EffectAuditRow {
  planner: string;
  fixtures: number;
  primaryShaped: number;
  primaryDefault: number;
  primaryInert: number;
  /** Mean number of selected actions per decision (primary + included). */
  selectedPerDecision: number;
  /** Mean number of selected actions that changed the plan. */
  shapedPerDecision: number;
  /** Plans identical to the one built when spawn_flight is the only action. */
  planIsDefault: number;
  /** Plans identical to the rules planner's plan for the same fixture (null for rules itself). */
  planMatchesRules: number | null;
  halts: number;
  /** Mean gap between the top two action scores (near 0 = the choice is a coin flip). */
  meanTopMargin: number;
  primaries: Record<string, number>;
}

/** Structural identity of a plan: steps, their actions, swarm sizes, personalities, debate, and task text. */
export function planShape(p: Pick<Plan, "halt" | "nodes">): string {
  if (p.halt) return `halt:${p.halt.kind}`;
  return p.nodes.map((n) => [n.id, n.hints?.action ?? n.kind, n.swarmSize, n.personality, n.hints?.debate ? "debate" : "", n.task].join("|")).join(" > ");
}

export async function effectAudit(specs: string[], opts: { root: string; seed?: number; fixtures?: Fixture[] }): Promise<EffectAuditRow[]> {
  const fixtures = opts.fixtures ?? FIXTURES;
  const repos = new Map<string, RepoSignals>();
  for (const fx of fixtures) if (!repos.has(fx.repo)) repos.set(fx.repo, await scanRepo(fx.repo));
  const request = (fx: Fixture) => ({
    task: fx.task, cwd: fx.repo, repo: repos.get(fx.repo), extraSignals: fx.extra, maxNodes: 6, runId: `effects-${fx.id}`,
    parentArtifacts: Array.from({ length: fx.priorArtifacts ?? 0 }, (_, i): Artifact => ({ id: `p${i}`, flightId: "r", task: fx.task, outcome: "winner", claims: [], evidence: [], openQuestions: [], nextSteps: [], parentArtifactIds: [], keywords: [], timestamp: 0 })),
  });

  const rules = resolvePlannerBackend("rules", { root: opts.root, fallback: false });
  const rulesShape = new Map<string, string>();
  for (const fx of fixtures) rulesShape.set(fx.id, planShape((await rules.plan(request(fx))).plan));

  const rows: EffectAuditRow[] = [];
  for (const spec of specs) {
    const backend = resolvePlannerBackend(spec, { root: opts.root, seed: opts.seed ?? 1, fallback: false });
    const row: EffectAuditRow = { planner: spec, fixtures: fixtures.length, primaryShaped: 0, primaryDefault: 0, primaryInert: 0, selectedPerDecision: 0, shapedPerDecision: 0, planIsDefault: 0, planMatchesRules: spec === "rules" ? null : 0, halts: 0, meanTopMargin: 0, primaries: {} };
    for (const fx of fixtures) {
      const { plan, trace } = await backend.plan(request(fx));
      if (!trace) throw new Error(`${spec} produced no decision trace; only planners that score the action set can be audited`);
      const effects = actionEffects(trace.decision, trace.signals, plan);
      const primary = effects[0].effect;
      if (primary === "shaped") row.primaryShaped++; else if (primary === "default") row.primaryDefault++; else row.primaryInert++;
      row.selectedPerDecision += effects.length;
      row.shapedPerDecision += effects.filter((e) => e.effect === "shaped").length;
      const defaultPlan = compilePlan(decide(normalizeScores({ spawn_flight: 1 }), trace.signals), trace.signals, { plannerId: "default", planIdSeed: "default", maxNodes: 6 });
      if (planShape(defaultPlan) === planShape(plan)) row.planIsDefault++;
      if (row.planMatchesRules !== null && rulesShape.get(fx.id) === planShape(plan)) row.planMatchesRules++;
      if (plan.halt) row.halts++;
      const top = Object.values(trace.actionScores).sort((a, b) => b - a);
      row.meanTopMargin += (top[0] ?? 0) - (top[1] ?? 0);
      row.primaries[trace.decision.primary] = (row.primaries[trace.decision.primary] ?? 0) + 1;
    }
    row.selectedPerDecision /= fixtures.length;
    row.shapedPerDecision /= fixtures.length;
    row.meanTopMargin /= fixtures.length;
    rows.push(row);
  }
  return rows;
}
