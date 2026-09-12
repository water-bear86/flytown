/**
 * `rules+memory` — the deterministic rules router with a mushroom-body prior.
 *
 * The rules router supplies task-dependent structure (it is the only planner
 * in this project that reliably does). The fly supplies *experience*: for the
 * task at hand it retrieves, from the KC→MBON synapses, whether tasks with a
 * similar Kenyon-cell code have gone well or badly, and that valence nudges
 * the action scores — caution when similar tasks went badly, directness when
 * they went well.
 *
 * Why this division of labour: three earlier experiments put the connectome in
 * the decision seat and found it task-invariant, which is fatal for action
 * selection but irrelevant for retrieval — retrieval only needs the *code* to
 * be task-specific, and the code demonstrably is (see `fly hash`).
 *
 * MEASURED: the code (real PN→KC wiring), the plastic synapses (real KC→MBON
 *           edges), the compartments each DAN innervates.
 * INFERRED_FROM_LITERATURE: DAN-gated depression; appetitive/aversive DAN sets.
 * ENGINEERING_CHOICE: the modulation table below — how a retrieved valence
 *           becomes a change in action scores, and the ±0.02 dead zone.
 * METAPHOR: task-as-odour.
 */
import { randomUUID } from "node:crypto";
import { compilePlan, decide, normalizeScores, ORCH_ACTIONS, type ActionScores } from "../actions.js";
import { signalsFor, type PlannerBackend, type PlanRequest, type PlanResponse } from "../planner-backend.js";
import type { TaskSignals } from "../signals.js";
import { makeTrace } from "../trace.js";
import { hashSeed } from "../rng.js";
import { rulesScores } from "./rules.js";
import { FlyMemory, type RecallResult } from "../memory.js";

/** Actions to amplify when experience says "tasks like this go badly". */
const CAUTION: readonly string[] = ["request_artifact_investigation", "search_memory", "invoke_reviewer", "increase_pack_size", "surface_uncertainty", "run_tests", "retry_new_approach"];
/** Actions to amplify when experience says "tasks like this go fine". */
const DIRECTNESS: readonly string[] = ["spawn_subrite", "terminate_success"];

export interface MemoryRulesOptions {
  memory: FlyMemory;
  /** how strongly a unit of retrieved valence moves the scores (default 1.5) */
  gain?: number;
  /** |valenceShift| below this is treated as "no memory" (default 0.02) */
  deadZone?: number;
  id?: string;
}

export function applyMemoryModulation(scores: ActionScores, recall: RecallResult, opts: { gain?: number; deadZone?: number } = {}): { scores: ActionScores; direction: "caution" | "directness" | "none"; magnitude: number } {
  const gain = opts.gain ?? 1.5;
  const dead = opts.deadZone ?? 0.02;
  const v = recall.valenceShift;
  if (!Number.isFinite(v) || Math.abs(v) < dead) return { scores, direction: "none", magnitude: 0 };
  // Negative shift = similar tasks were punished = be careful.
  const caution = v < 0;
  const magnitude = Math.min(1, Math.abs(v) * gain);
  const out = { ...scores };
  for (const a of ORCH_ACTIONS) {
    const boosted = caution ? CAUTION.includes(a) : DIRECTNESS.includes(a);
    const damped = caution ? DIRECTNESS.includes(a) : CAUTION.includes(a);
    if (boosted) out[a] = out[a] * (1 + magnitude);
    else if (damped) out[a] = out[a] * (1 - 0.5 * magnitude);
  }
  return { scores: normalizeScores(out), direction: caution ? "caution" : "directness", magnitude };
}

export class MemoryRulesBackend implements PlannerBackend {
  readonly id: string;
  constructor(private readonly opts: MemoryRulesOptions) {
    this.id = opts.id ?? "rules+memory";
  }

  async plan(req: PlanRequest): Promise<PlanResponse> {
    const signals = await signalsFor(req);
    const base = rulesScores(signals);
    const recall = this.opts.memory.recall(signals);
    const mod = applyMemoryModulation(base, recall, this.opts);
    const decision = decide(mod.scores, signals);
    const runId = req.runId ?? `memrules-${randomUUID().slice(0, 8)}`;
    const seed = hashSeed(runId, req.replanDepth ?? 0);
    const plan = compilePlan(decision, signals, { maxNodes: req.maxNodes, plannerId: this.id, planIdSeed: seed.toString(16) });
    const trace = makeTrace({
      req, plannerId: this.id, runId, seed: 0, signals, scores: mod.scores, decision, plan,
      provenance: {
        rules: "ENGINEERING_CHOICE",
        "memory.code": "MEASURED",
        "memory.plastic_site": "MEASURED",
        "memory.rule": "INFERRED_FROM_LITERATURE",
        "memory.modulation": "ENGINEERING_CHOICE",
      },
      notes: [
        `memory: ${this.opts.memory.graph.id}${this.opts.memory.graph.variant !== "real" ? ` (${this.opts.memory.graph.variant})` : ""} · ${this.opts.memory.episodes} episodes stored`,
        `recall: valenceShift=${recall.valenceShift.toFixed(4)} familiarity=${recall.familiarity.toFixed(2)} code=${recall.codeSize} → ${mod.direction}${mod.magnitude ? ` ×${mod.magnitude.toFixed(2)}` : ""}`,
      ],
    });
    return { plan, trace };
  }

  /** Store the outcome of a completed run at the KC→MBON synapses. */
  async learn(signals: TaskSignals, reward: number): Promise<{ changed: number; valence: string }> {
    return this.opts.memory.store(signals, reward);
  }

  get memory(): FlyMemory {
    return this.opts.memory;
  }
}
