/**
 * DecisionTrace — the auditable record of one planning decision.
 *
 * Written to <root>/.flytown/traces/<runId>.json. Cross-references the
 * worker pipeline's Plan/Flight/RunRecord ids so a single runId reconstructs
 * both "what the planner did" and "what the workers did as a result".
 *
 * Every biologically-flavoured field carries a provenance tag so the trace
 * itself distinguishes measured structure from our engineering choices.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plan } from "../types.js";
import { actionEffects, type ActionScores, type OrchDecision } from "./actions.js";
import type { PlanRequest } from "./planner-backend.js";
import type { ExternalSignals, TaskSignals } from "./signals.js";

export function makeTrace(args: {
  req: PlanRequest; plannerId: string; runId: string; seed: number;
  signals: TaskSignals; scores: ActionScores; decision: OrchDecision; plan: Plan;
  provenance: Record<string, ProvenanceTag>; notes?: string[]; features?: Record<string, number>;
  brain?: BrainActivityTrace; learning?: DecisionTrace["learning"];
}): DecisionTrace {
  const { req } = args;
  return {
    traceVersion: 1,
    runId: args.runId,
    plannerId: args.plannerId,
    createdAt: Date.now(),
    seed: args.seed,
    replanDepth: req.replanDepth ?? 0,
    request: {
      task: req.task, cwd: req.cwd, maxNodes: req.maxNodes, replanDepth: req.replanDepth ?? 0, budgetTokens: req.budgetTokens,
      extraSignals: req.extraSignals, priorArtifactIds: (req.parentArtifacts ?? []).map((a) => a.id),
      failureContext: req.failureContext ? { failedNodeId: req.failureContext.failedNodeId, reason: req.failureContext.reason } : undefined,
    },
    signals: args.signals,
    features: args.features,
    actionScores: args.scores,
    decision: { primary: args.decision.primary, included: args.decision.included, swarmSize: args.decision.swarmSize, personality: args.decision.personality },
    plan: args.plan,
    brain: args.brain,
    learning: args.learning,
    provenance: args.provenance,
    notes: args.notes ?? [],
  };
}

export type ProvenanceTag = "MEASURED" | "INFERRED_FROM_LITERATURE" | "ENGINEERING_CHOICE" | "METAPHOR";

export interface BrainActivityTrace {
  connectomeId: string;
  level?: "projectome" | "curated" | "neuron";
  variant: "real" | "shuffled" | "random_degree" | "ablated" | "signless";
  ablatedRegions: string[];
  recurrence: boolean;
  weightsVersion: string;
  plasticVersion?: string;
  engine: Record<string, number | string | boolean>;
  /** node id (small graphs) or group key (large graphs) -> injected input */
  input: Record<string, number>;
  /**
   * Per timestep activity. Graphs with ≤200 nodes store the full node vector
   * each step; larger graphs store per-group means for the first and last
   * step only (per-node state is reproducible via `fly replay`).
   */
  steps: { t: number; activity: Record<string, number> }[];
  /** per action: top contributing groups (group, contribution) */
  readoutContributions: Record<string, [string, number][]>;
  stats: { maxActivity: number; meanFinalActivity: number; activeRegions: number; steps: number };
  /** activity of the plastic pre-population (e.g. Kenyon cells) at decision time */
  eligibility?: Record<string, number>;
  /** max-normalised activity of every node in the readout populations at decision time */
  readoutActivity?: Record<string, number>;
  plastic?: { edges: number; meanMultiplier: number; minMultiplier: number; depressedEdges: number; rule: string };
}

/** Snapshot of the planning request so a trace can be replayed deterministically. */
export interface TraceRequest {
  task: string;
  cwd: string;
  maxNodes?: number;
  replanDepth: number;
  budgetTokens?: number;
  extraSignals?: Partial<ExternalSignals>;
  priorArtifactIds: string[];
  failureContext?: { failedNodeId: string; reason: string };
}

export interface DecisionTrace {
  traceVersion: 1;
  runId: string;
  plannerId: string;
  createdAt: number;
  seed: number;
  replanDepth: number;
  request: TraceRequest;
  signals: TaskSignals;
  features?: Record<string, number>;
  actionScores: ActionScores;
  decision: Omit<OrchDecision, "scores">;
  plan: Plan;
  brain?: BrainActivityTrace;
  /** Outcome is appended after execution when known. */
  outcome?: { planOutcome: string; reward?: number; replans?: number; finalFlightId?: string; tokens?: number; wallMs?: number };
  learning?: { enabled: boolean; applied: string[] };
  provenance: Record<string, ProvenanceTag>;
  /** Free-form notes, e.g. fallback reasons. */
  notes: string[];
}

export function traceDir(root: string): string {
  return join(root, ".flytown", "traces");
}

export async function writeTrace(root: string, trace: DecisionTrace): Promise<string> {
  const dir = traceDir(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sanitize(trace.runId)}.json`);
  await writeFile(file, JSON.stringify(trace, null, 2) + "\n", "utf8");
  return file;
}

export async function readTrace(root: string, runId: string): Promise<DecisionTrace | null> {
  try {
    const raw = await readFile(join(traceDir(root), `${sanitize(runId)}.json`), "utf8");
    return JSON.parse(raw) as DecisionTrace;
  } catch {
    return null;
  }
}

export async function listTraces(root: string): Promise<string[]> {
  try {
    const names = await readdir(traceDir(root));
    return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

export async function appendOutcome(root: string, runId: string, outcome: NonNullable<DecisionTrace["outcome"]>): Promise<void> {
  const t = await readTrace(root, runId);
  if (!t) return;
  t.outcome = { ...(t.outcome ?? {}), ...outcome };
  await writeTrace(root, t);
}

/** Plain-text rendering for the CLI — always available alongside any visual. */
export function renderTraceText(t: DecisionTrace): string {
  const lines: string[] = [];
  lines.push(`run ${t.runId} · planner=${t.plannerId} · seed=${t.seed} · replanDepth=${t.replanDepth}`);
  lines.push(`task: ${t.signals.task.slice(0, 160)}${t.signals.task.length > 160 ? "…" : ""}`);
  lines.push(`signals: deliverable=${t.signals.deliverable} complexity=${t.signals.complexity.toFixed(2)} uncertainty=${t.signals.uncertainty.toFixed(2)} pressure=${t.signals.pressure.toFixed(2)} repoFiles=${t.signals.repo.fileCount} tests=${t.signals.repo.hasTests} failures=${JSON.stringify(t.signals.failures)} attempts=${t.signals.history.attempts}`);
  const top = Object.entries(t.actionScores).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, v]) => `${a}=${v.toFixed(3)}`).join("  ");
  lines.push(`actions: ${top}`);
  lines.push(`decision: primary=${t.decision.primary} included=[${t.decision.included.join(",")}] swarm=${t.decision.swarmSize} personality=${t.decision.personality}`);
  for (const e of actionEffects(t.decision, t.signals, t.plan)) lines.push(`  ${e.effect.padEnd(7)} ${e.action}${e.primary ? " (primary)" : ""}: ${e.why}`);
  if (t.brain) {
    const b = t.brain;
    lines.push(`brain: ${b.connectomeId}${b.level ? ` (${b.level})` : ""} variant=${b.variant}${b.ablatedRegions.length ? ` ablated=[${b.ablatedRegions.join(",")}]` : ""} recurrence=${b.recurrence} steps=${b.stats.steps} active=${b.stats.activeRegions}/${b.engine.nodes ?? "?"} max=${b.stats.maxActivity.toFixed(3)}`);
    if (b.plastic) lines.push(`  plastic: ${b.plastic.edges} edges, ${b.plastic.depressedEdges} depressed, mean×${b.plastic.meanMultiplier.toFixed(3)} min×${b.plastic.minMultiplier.toFixed(3)}${b.plasticVersion ? ` (${b.plasticVersion})` : ""}`);
    const input = Object.entries(b.input).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, v]) => `${r}:${v.toFixed(2)}`).join(" ");
    lines.push(`  input → ${input}`);
    const last = b.steps[b.steps.length - 1];
    if (last) {
      const hot = Object.entries(last.activity).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r, v]) => `${r}:${v.toFixed(2)}`).join(" ");
      lines.push(`  final activity → ${hot}`);
    }
    const contrib = b.readoutContributions[t.decision.primary];
    if (contrib) lines.push(`  ${t.decision.primary} ← ${contrib.slice(0, 5).map(([r, c]) => `${r}(${c.toFixed(2)})`).join(" ")}`);
  }
  if (t.plan.halt) lines.push(`plan: HALT ${t.plan.halt.kind} — ${t.plan.halt.reason}`);
  else lines.push(`plan: ${t.plan.nodes.map((n) => `${n.id}[${n.hints?.action ?? n.kind},swarm=${n.swarmSize}]`).join(" → ")}`);
  if (t.outcome) lines.push(`outcome: ${JSON.stringify(t.outcome)}`);
  for (const n of t.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}
