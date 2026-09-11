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
import type { ConnectomeGraph, ConnectomeVariant } from "./connectome/artifact.js";

export const DEFAULT_CONNECTOME_ID = "fafb-v783-projectome-1";

export interface ResolveOptions {
  /** Warren / project root: weights and traces live under <root>/.flytown/. */
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
  const [kind, rest] = spec.split(":", 2);
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
];
