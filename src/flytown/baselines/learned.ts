/**
 * Baseline #3 — small learned router: multinomial logistic regression from the
 * fixed feature vector to action scores. No biological topology.
 *
 * Weights live in a plain JSON file (versioned, inspectable, resettable). When
 * no weights exist the router is uniform, which makes it behave like the
 * random control until trained — that is intentional and reported.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { compilePlan, decide, normalizeScores, ORCH_ACTIONS, zeroScores, type ActionScores, type OrchAction } from "../actions.js";
import { signalsFor, type PlannerBackend, type PlanRequest, type PlanResponse } from "../planner-backend.js";
import { FEATURE_NAMES, featurize } from "../signals.js";
import { hashSeed, makeRng } from "../rng.js";
import { makeTrace } from "../trace.js";

export interface LinearRouterWeights {
  version: string;
  featureNames: readonly string[];
  actions: readonly string[];
  /** actions x features */
  w: number[][];
  bias: number[];
  trainedOn?: number;
}

export function uniformWeights(): LinearRouterWeights {
  return {
    version: "untrained",
    featureNames: FEATURE_NAMES,
    actions: ORCH_ACTIONS,
    w: ORCH_ACTIONS.map(() => FEATURE_NAMES.map(() => 0)),
    bias: ORCH_ACTIONS.map(() => 0),
  };
}

export function linearScores(weights: LinearRouterWeights, x: Float64Array): ActionScores {
  const logits = ORCH_ACTIONS.map((_, i) => {
    let z = weights.bias[i] ?? 0;
    const row = weights.w[i] ?? [];
    for (let j = 0; j < x.length; j++) z += (row[j] ?? 0) * x[j];
    return z;
  });
  const m = Math.max(...logits);
  const exps = logits.map((z) => Math.exp(z - m));
  const out = zeroScores();
  ORCH_ACTIONS.forEach((a, i) => { out[a] = exps[i]; });
  return normalizeScores(out);
}

export interface TrainingExample { features: number[]; action: OrchAction; reward: number }

/**
 * Reward-weighted multinomial logistic regression (plain SGD). Examples with
 * reward <= 0 push probability away from the taken action; reward > 0 pulls
 * toward it. Deterministic given example order.
 */
export function trainLinearRouter(examples: TrainingExample[], opts: { epochs?: number; lr?: number; l2?: number; init?: LinearRouterWeights } = {}): LinearRouterWeights {
  const epochs = opts.epochs ?? 30;
  const lr = opts.lr ?? 0.1;
  const l2 = opts.l2 ?? 1e-3;
  const w = opts.init ? opts.init.w.map((r) => [...r]) : ORCH_ACTIONS.map(() => FEATURE_NAMES.map(() => 0));
  const bias = opts.init ? [...opts.init.bias] : ORCH_ACTIONS.map(() => 0);
  for (let ep = 0; ep < epochs; ep++) {
    for (const ex of examples) {
      const x = Float64Array.from(ex.features);
      const p = linearScores({ version: "tmp", featureNames: FEATURE_NAMES, actions: ORCH_ACTIONS, w, bias }, x);
      const ai = ORCH_ACTIONS.indexOf(ex.action);
      const r = Math.max(-1, Math.min(1, ex.reward));
      for (let i = 0; i < ORCH_ACTIONS.length; i++) {
        const target = i === ai ? 1 : 0;
        // gradient of reward-weighted log-likelihood
        const g = r * (target - p[ORCH_ACTIONS[i]]);
        bias[i] += lr * g;
        for (let j = 0; j < x.length; j++) w[i][j] += lr * (g * x[j] - l2 * w[i][j]);
      }
    }
  }
  return { version: `trained-${Date.now().toString(36)}`, featureNames: FEATURE_NAMES, actions: ORCH_ACTIONS, w, bias, trainedOn: examples.length };
}

export async function loadRouterWeights(file: string): Promise<LinearRouterWeights> {
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as LinearRouterWeights;
    if (!Array.isArray(raw.w) || raw.w.length !== ORCH_ACTIONS.length) return uniformWeights();
    return raw;
  } catch {
    return uniformWeights();
  }
}

export async function saveRouterWeights(file: string, weights: LinearRouterWeights): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(weights, null, 2) + "\n", "utf8");
}

export function learnedPlannerBackend(opts: { weights?: LinearRouterWeights; weightsFile?: string; explore?: boolean } = {}): PlannerBackend {
  let cached: LinearRouterWeights | undefined = opts.weights;
  return {
    id: "learned",
    async plan(req: PlanRequest): Promise<PlanResponse> {
      if (!cached) cached = opts.weightsFile ? await loadRouterWeights(opts.weightsFile) : uniformWeights();
      const signals = await signalsFor(req);
      const x = featurize(signals);
      const scores = linearScores(cached, x);
      const runId = req.runId ?? `learned-${randomUUID().slice(0, 8)}`;
      const seed = hashSeed(runId, req.replanDepth ?? 0);
      const decision = decide(scores, signals, opts.explore ? { explore: { rng: makeRng(hashSeed(seed, "explore")) } } : {});
      const plan = compilePlan(decision, signals, { maxNodes: req.maxNodes, plannerId: "learned", planIdSeed: seed.toString(16) });
      const trace = makeTrace({
        req, plannerId: "learned", runId, seed: 0, signals, scores, decision, plan,
        features: Object.fromEntries(FEATURE_NAMES.map((n, i) => [n, x[i]])),
        learning: { enabled: false, applied: [] }, provenance: { learned: "ENGINEERING_CHOICE" }, notes: [`weights=${cached.version}`],
      });
      return { plan, trace };
    },
  };
}
