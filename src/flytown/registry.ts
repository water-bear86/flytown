/**
 * Planner backend registry — turns a spec string into a PlannerBackend.
 *
 *   llm | rules | random | learned | fly
 *   fly:shuffled | fly:random_degree | fly:signless | fly:norecurrence
 *   fly:ablate=MB_CA,MB_ML | fly:learning | fly:shuffled+norecurrence
 *
 * The conventional LLM planner is always the fallback for fly variants unless
 * fallback is explicitly disabled — that is the kill switch.
 */
import { join } from "node:path";
import { llmPlannerBackend, withFallback, type PlannerBackend } from "./planner-backend.js";
import { rulesPlannerBackend } from "./baselines/rules.js";
import { randomPlannerBackend } from "./baselines/random.js";
import { learnedPlannerBackend } from "./baselines/learned.js";
import { FlyPlannerBackend, type FlyPlannerOptions } from "./fly-planner.js";
import { DEFAULT_CONNECTOME_ID, type ConnectomeGraph, type ConnectomeVariant } from "./connectome/artifact.js";

export { DEFAULT_CONNECTOME_ID };

/**
 * Default planner backend.
 *
 * Measured against the conventional LLM planner on the full 20-fixture suite,
 * 2 seeds, real workers (docs/flytown/experiments, live run 3, n=37 pairs):
 *
 *   - completable tasks: quality indistinguishable (+0.010, p = 0.89)
 *   - tasks whose right answer is to stop: rules won 7 of 7 pairs
 *     (+100 pts termination, p = 0.015) — the LLM planner decomposes
 *     everything and has no halt vocabulary at all
 *   - cost: 39% fewer tokens overall (66.8k vs 109.8k per plan, p < 0.0001),
 *     and 28k fewer even on completable tasks at equal quality
 *
 * So: same answers, meaningfully cheaper, and it knows when to stop. The LLM
 * planner stays one flag away (`--planner llm`) and remains the fallback for
 * every fly variant.
 */
export const DEFAULT_PLANNER = "rules";

export interface ResolveOptions {
  /** Terrarium / project root: weights and traces live under <root>/.flytown/. */
  root: string;
  seed?: number;
  connectome?: string;
  connectomeRoot?: string;
  /** Pre-loaded graph for tests / harness. */
  graph?: ConnectomeGraph;
  learning?: boolean;
  /** Wrap fly variants with the LLM planner as fallback. Default true. */
  fallback?: boolean;
  onFallback?: (err: unknown) => void;
}

export function parsePlannerSpec(spec: string): { kind: string; flags: Record<string, string | true> } {
  // Split on the FIRST colon only — flag values may themselves contain colons (ablate=flag:KC).
  const colon = spec.indexOf(":");
  const kind = colon < 0 ? spec : spec.slice(0, colon);
  const rest = colon < 0 ? "" : spec.slice(colon + 1);
  const flags: Record<string, string | true> = {};
  if (rest) {
    for (const part of rest.split("+")) {
      if (!part) continue;
      const [k, v] = part.split("=", 2);
      flags[k] = v === undefined ? true : v;
    }
  }
  return { kind: kind.trim(), flags };
}

/** Build FlyPlannerOptions from a `fly[:flags]` spec (exported for the harness's training loop). */
export function resolveFlyOptions(spec: string, opts: ResolveOptions): FlyPlannerOptions {
  const { kind, flags } = parsePlannerSpec(spec);
  if (kind !== "fly") throw new Error(`not a fly spec: ${spec}`);
  let variant: ConnectomeVariant = "real";
  if (flags.shuffled) variant = "shuffled";
  else if (flags.random_degree || flags.random) variant = "random_degree";
  else if (flags.signless) variant = "signless";
  const fly: FlyPlannerOptions = {
    connectomeId: (typeof flags.connectome === "string" ? flags.connectome : undefined) ?? opts.connectome ?? DEFAULT_CONNECTOME_ID,
    connectomeRoot: opts.connectomeRoot,
    graph: opts.graph,
    variant,
    variantSeed: opts.seed ?? 1,
    ablateRegions: typeof flags.ablate === "string" ? flags.ablate.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    engine: flags.norecurrence ? { recurrence: false } : undefined,
    learning: !!flags.learning || !!opts.learning,
    weightsDir: join(opts.root, ".flytown", "weights"),
  };
  if (typeof flags.steps === "string") fly.engine = { ...(fly.engine ?? {}), steps: Number(flags.steps) };
  if (typeof flags.gain === "string") fly.engine = { ...(fly.engine ?? {}), gain: Number(flags.gain) };
  if (typeof flags.leak === "string") fly.engine = { ...(fly.engine ?? {}), leak: Number(flags.leak) };
  if (typeof flags.div === "string") fly.engine = { ...(fly.engine ?? {}), divisive: Number(flags.div) };
  if (typeof flags.insteps === "string") fly.engine = { ...(fly.engine ?? {}), inputSteps: Number(flags.insteps) };
  if (typeof flags.lr === "string") fly.learningRate = Number(flags.lr);
  if (flags.noself) fly.excludeSelfEdges = true;
  if (flags.plastic) fly.plastic = true;
  if (flags.nosparse) fly.sparseGroups = [];
  else if (typeof flags.sparse === "string") {
    // sparse=0.05  or  sparse=flag:KC@0.05,class:LHN@0.2  ("+" already separates flags)
    fly.sparseGroups = flags.sparse.includes("@")
      ? flags.sparse.split(",").map((s) => { const [group, f] = s.split("@"); return { group, fraction: Number(f) }; })
      : [{ group: "flag:KC", fraction: Number(flags.sparse) }];
  }
  if (typeof flags.plr === "string") fly.plasticParams = { ...(fly.plasticParams ?? {}), lr: Number(flags.plr) };
  if (typeof flags.channels === "string") {
    // e.g. channels=aa:0.5,dd:0.5,da:0.25
    fly.channelWeights = Object.fromEntries(flags.channels.split(",").map((kv) => { const [k, v] = kv.split(":"); return [k, Number(v)]; }));
  }
  return fly;
}

export function resolvePlannerBackend(spec: string, opts: ResolveOptions): PlannerBackend {
  const { kind } = parsePlannerSpec(spec);
  switch (kind) {
    case "llm": return llmPlannerBackend();
    case "rules": return rulesPlannerBackend();
    case "random": return randomPlannerBackend({ seed: opts.seed });
    case "learned": return learnedPlannerBackend({ weightsFile: join(opts.root, ".flytown", "weights", "learned-router.json") });
    case "fly": {
      const backend = new FlyPlannerBackend(resolveFlyOptions(spec, opts));
      return opts.fallback === false ? backend : withFallback(backend, llmPlannerBackend(), opts.onFallback);
    }
    default:
      throw new Error(`unknown planner backend "${spec}" (expected llm|rules|random|learned|fly[:flags])`);
  }
}

export const KNOWN_PLANNER_SPECS = [
  "llm", "rules", "random", "learned",
  "fly", "fly:shuffled", "fly:random_degree", "fly:signless", "fly:norecurrence", "fly:learning",
  "fly:connectome=<id>", "fly:plastic", "fly:learning+plastic", "fly:ablate=<region|group,...>",
];
