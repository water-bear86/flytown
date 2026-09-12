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
 * selection. Retrieval needs only the Kenyon-cell code to be task-specific.
 * The code is distinct for every task, but the mushroom-body memory experiment
 * (eval/hash-experiment.ts; docs/flytown/experiments, 2026-09-12) found it
 * preserves task similarity no better than a label-shuffled graph, and
 * retrieved valence was at chance on held-out tasks. This planner exists so
 * that result can be tested with real outcomes, not because it is expected
 * to help. Compare it with `rules+memory:shuffled`.
 *
 * MEASURED: the code (real PN→KC wiring), the plastic synapses (real KC→MBON
 *           edges), the compartments each DAN innervates.
 * INFERRED_FROM_LITERATURE: DAN-gated depression; appetitive/aversive DAN sets.
 * ENGINEERING_CHOICE: the modulation table below — how a retrieved valence
 *           becomes a change in action scores, the gain and the dead zone.
 * METAPHOR: task-as-odour.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compilePlan, decide, normalizeScores, ORCH_ACTIONS, type ActionScores } from "../actions.js";
import { signalsFor, type LearningPlannerBackend, type PlanRequest, type PlanResponse } from "../planner-backend.js";
import { makeTrace, type DecisionTrace } from "../trace.js";
import { hashSeed } from "../rng.js";
import { rulesScores } from "./rules.js";
import { FlyMemory, type RecallResult } from "../memory.js";
import { loadConnectome, randomDegreePreserving, shuffleLabels, type ConnectomeGraph } from "../connectome/artifact.js";
import type { PlasticState } from "../connectome/plasticity.js";

/** Actions to amplify when experience says "tasks like this go badly". */
const CAUTION: readonly string[] = ["request_artifact_investigation", "search_memory", "invoke_reviewer", "increase_swarm_size", "surface_uncertainty", "run_tests", "retry_new_approach"];
/**
 * Actions to amplify when experience says "tasks like this go fine": just do
 * the work. Deliberately NOT terminate_success — a memory that similar tasks
 * went well is no reason to declare this one already done.
 */
const DIRECTNESS: readonly string[] = ["spawn_flight"];

/**
 * Calibration: retrieved valence shifts on the real larval graph are small
 * (mean |shift| ≈ 0.01 over the training corpus), so the gain is set so a
 * typical retrieval produces a ~0.2 blend, and the dead zone sits below the
 * observed noise floor. Both are ENGINEERING_CHOICE, calibrated on the
 * training half of the corpus only.
 */
export const DEFAULT_MEMORY_GAIN = 20;
export const DEFAULT_MEMORY_DEAD_ZONE = 0.003;

/** The memory needs Kenyon cells and KC→MBON synapses, which only the larval artifact has. */
export const DEFAULT_MEMORY_CONNECTOME_ID = "l1-larva-winding2023-1";

export interface MemoryRulesOptions {
  /** A ready memory, or a loader called on first use (the registry loads the connectome lazily). */
  memory: FlyMemory | (() => Promise<FlyMemory>);
  /**
   * JSON file the stored associations persist to after every learn() and are
   * restored from on first use. Absent: the memory lives only in this process.
   */
  stateFile?: string;
  /** how strongly a unit of retrieved valence moves the scores (default DEFAULT_MEMORY_GAIN) */
  gain?: number;
  /** |valenceShift| below this is treated as "no memory" (default DEFAULT_MEMORY_DEAD_ZONE) */
  deadZone?: number;
  id?: string;
}

/** On-disk memory. Restored only onto the same graph: connectome, variant, seed and size must all match. */
interface StoredMemory {
  format: "flytown-memory-1";
  connectomeId: string;
  variant: string;
  variantSeed: number;
  nodes: number;
  edges: number;
  episodes: number;
  state: PlasticState;
}

/**
 * Blend the router's scores toward a caution or directness profile.
 *
 * Interpolation rather than multiplication, because a multiplicative nudge
 * can never introduce an action the router scored at exactly zero — and
 * "similar tasks went badly, so investigate first even though the rules did
 * not ask for it" is precisely the advice a memory should be able to give.
 * The blend is capped so memory advises and never overrides.
 */
export function applyMemoryModulation(scores: ActionScores, recall: RecallResult, opts: { gain?: number; deadZone?: number; maxBlend?: number } = {}): { scores: ActionScores; direction: "caution" | "directness" | "none"; magnitude: number } {
  const gain = opts.gain ?? DEFAULT_MEMORY_GAIN;
  const dead = opts.deadZone ?? DEFAULT_MEMORY_DEAD_ZONE;
  const maxBlend = opts.maxBlend ?? 0.5;
  const v = recall.valenceShift;
  if (!Number.isFinite(v) || Math.abs(v) < dead) return { scores, direction: "none", magnitude: 0 };
  // Negative shift = similar tasks were punished = be careful.
  const caution = v < 0;
  const magnitude = Math.min(maxBlend, Math.abs(v) * gain);
  const target = caution ? CAUTION : DIRECTNESS;
  const share = 1 / target.length;
  const out = { ...scores };
  for (const a of ORCH_ACTIONS) {
    const toward = target.includes(a) ? share : 0;
    out[a] = (1 - magnitude) * out[a] + magnitude * toward;
  }
  return { scores: normalizeScores(out), direction: caution ? "caution" : "directness", magnitude };
}

export class MemoryRulesBackend implements LearningPlannerBackend {
  readonly id: string;
  private loading?: Promise<FlyMemory>;
  private restored = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly opts: MemoryRulesOptions) {
    this.id = opts.id ?? "rules+memory";
  }

  /** The memory, with any stored associations restored, loaded on first use. */
  getMemory(): Promise<FlyMemory> {
    if (!this.loading) {
      this.loading = (async () => {
        const memory = typeof this.opts.memory === "function" ? await this.opts.memory() : this.opts.memory;
        const stored = this.opts.stateFile ? await readStoredMemory(this.opts.stateFile) : null;
        if (stored && storedMatches(stored, memory.graph)) {
          memory.restore(stored.state, stored.episodes);
          this.restored = stored.episodes;
        }
        return memory;
      })();
    }
    return this.loading;
  }

  async plan(req: PlanRequest): Promise<PlanResponse> {
    const memory = await this.getMemory();
    const signals = await signalsFor(req);
    const base = rulesScores(signals);
    const recall = memory.recall(signals);
    const mod = applyMemoryModulation(base, recall, this.opts);
    const decision = decide(mod.scores, signals);
    const runId = req.runId ?? `memrules-${randomUUID().slice(0, 8)}`;
    const seed = hashSeed(runId, req.replanDepth ?? 0);
    const plan = compilePlan(decision, signals, { maxNodes: req.maxNodes, plannerId: this.id, planIdSeed: seed.toString(16) });
    const trace = makeTrace({
      req, plannerId: this.id, runId, seed, signals, scores: mod.scores, decision, plan,
      provenance: {
        rules: "ENGINEERING_CHOICE",
        "memory.code": "MEASURED",
        "memory.plastic_site": "MEASURED",
        "memory.rule": "INFERRED_FROM_LITERATURE",
        "memory.modulation": "ENGINEERING_CHOICE",
      },
      notes: [
        `memory: ${memory.graph.id}${memory.graph.variant !== "real" ? ` (${memory.graph.variant})` : ""} · ${memory.episodes} episodes stored${this.restored ? ` (${this.restored} restored from ${this.opts.stateFile})` : ""}`,
        `recall: valenceShift=${recall.valenceShift.toFixed(4)} familiarity=${recall.familiarity.toFixed(2)} code=${recall.codeSize} → ${mod.direction}${mod.magnitude ? ` ×${mod.magnitude.toFixed(2)}` : ""}`,
      ],
    });
    return { plan, trace };
  }

  /** Store the outcome of a completed run at the KC→MBON synapses, and persist it. */
  async learn(trace: Pick<DecisionTrace, "signals">, reward: number): Promise<{ changed: number; valence: string }> {
    const memory = await this.getMemory();
    const out = memory.store(trace.signals, reward);
    const file = this.opts.stateFile;
    if (file) {
      // Serialised so concurrent runs cannot land an older state after a newer one.
      this.writes = this.writes.then(async () => {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(toStored(memory), null, 2) + "\n", "utf8");
      });
      await this.writes;
    }
    return out;
  }
}

function toStored(memory: FlyMemory): StoredMemory {
  const g = memory.graph;
  return { format: "flytown-memory-1", connectomeId: g.id, variant: g.variant, variantSeed: g.variantSeed, nodes: g.n, edges: g.src.length, episodes: memory.episodes, state: memory.state };
}

async function readStoredMemory(file: string): Promise<StoredMemory | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as StoredMemory;
    return parsed.format === "flytown-memory-1" ? parsed : null;
  } catch {
    return null;
  }
}

function storedMatches(s: StoredMemory, g: ConnectomeGraph): boolean {
  return s.connectomeId === g.id && s.variant === g.variant && s.variantSeed === g.variantSeed && s.nodes === g.n && s.edges === g.src.length;
}

export interface MemoryRulesSpec {
  id: string;
  root: string;
  connectomeId?: string;
  connectomeRoot?: string;
  /** Pre-loaded graph (tests / harness). */
  graph?: ConnectomeGraph;
  variant?: "real" | "shuffled" | "random_degree";
  variantSeed?: number;
}

/**
 * `rules+memory[:connectome=<id>][+shuffled|+random_degree]` as built by the
 * registry. Associations persist under <root>/.flytown/weights/, one file per
 * graph variant, so a null-model memory never restores the real one.
 */
export function memoryRulesPlannerBackend(spec: MemoryRulesSpec): MemoryRulesBackend {
  const connectomeId = spec.connectomeId ?? spec.graph?.id ?? DEFAULT_MEMORY_CONNECTOME_ID;
  const variant = spec.variant ?? "real";
  const seed = spec.variantSeed ?? 1;
  const suffix = variant === "real" ? "" : `-${variant}-s${seed}`;
  return new MemoryRulesBackend({
    id: spec.id,
    stateFile: join(spec.root, ".flytown", "weights", `memory-${connectomeId}${suffix}.json`),
    memory: async () => {
      let graph = spec.graph ?? (await loadConnectome(connectomeId, { root: spec.connectomeRoot }));
      if (variant === "shuffled") graph = shuffleLabels(graph, seed);
      else if (variant === "random_degree") graph = randomDegreePreserving(graph, seed);
      return new FlyMemory({ graph });
    },
  });
}
