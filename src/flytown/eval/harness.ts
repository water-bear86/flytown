/**
 * Evaluation harness — matched trials of planner backends over the fixture
 * suite, with the deterministic mock worker world by default.
 *
 * Every planner sees identical fixtures, seeds, budgets and the same compiler;
 * only the decision substrate differs. Reports per-planner aggregates, per-
 * category breakdowns, action distributions, and a paired permutation test
 * between any two planners (by default fly vs fly:shuffled — the headline
 * falsification test from the proposal).
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan, type PlanOutcome, type FlightRunner } from "../../plan-executor.js";
import { performFlight } from "../../flight.js";
import { withProviderRoot } from "../../openai-client.js";
import { Compost } from "../../compost.js";
import type { Artifact } from "../../types.js";
import type { OrchAction } from "../actions.js";
import { canLearn, type PlannerBackend } from "../planner-backend.js";
import { parsePlannerSpec, resolveFlyOptions, resolvePlannerBackend, type ResolveOptions } from "../registry.js";
import { FEATURE_NAMES, scanRepo, type RepoSignals } from "../signals.js";
import { FlyPlannerBackend } from "../fly-planner.js";
import { learnedPlannerBackend, trainLinearRouter, uniformWeights, type LinearRouterWeights, type TrainingExample } from "../baselines/learned.js";
import { hashSeed, makeRng } from "../rng.js";
import { writeTrace, type DecisionTrace } from "../trace.js";
import { FIXTURES, FIXTURE_SUITE, fixtureAvailability, pinnedReposFor, rubricFor, type Fixture, type FixtureCategory } from "./fixtures.js";
import { judgeOutput } from "./judge.js";
import { makeMockFlightRunner, type MockFlightStats } from "./mock-flight.js";

/**
 * Live mode: flights run through the real FLYTOWN pipeline (Scout →
 * swarm → Wasp → Guard → Specialists → Soldier → Scribe) against the provider
 * configured in `terrariumRoot`'s `.flytown/terrarium.json`. Training epochs,
 * when requested, still use the mock world ("trained in simulation,
 * evaluated live"). Every cap below exists to keep a run bounded.
 */
export interface LiveOptions {
  terrariumRoot: string;
  /** cap on foragers per flight (default 2) */
  swarmSize?: number;
  /** cap on output tokens per model call (default 400) */
  maxOutputTokensPerCall?: number;
  /** token budget per plan run — flight phases stop once exceeded (default 40,000) */
  budgetTokensPerRun?: number;
  /** stop scheduling live runs once this many tokens have been spent in total (default 3,000,000) */
  maxTotalTokens?: number;
  /** repository globs the Scout may read for context (default README + manifest) */
  scanGlobs?: string[];
  /** allow verifier tool use during guard review when a node asks for it (default false) */
  guardTools?: boolean;
  /** score every live run's final output against its fixture rubric with the LLM judge (default true) */
  judge?: boolean;
  /**
   * Refuse to start unless the resolved provider passes a live smoke test
   * (default true). A whole 400k-token run was once wasted because a running
   * server had re-saved terrarium.json and dropped the provider's
   * `requestParams` — the model then spent its entire output budget on hidden
   * reasoning, every worker came back empty, and the numbers were garbage
   * that still looked like a result. Fail fast instead.
   */
  preflight?: boolean;
  /** feed the live reward (judge quality, or termination if no judge) back into learnable planners after each run (default false) */
  liveLearning?: boolean;
}

export interface HarnessOptions {
  planners: string[];
  fixtures?: Fixture[];
  /**
   * Live mode only: run even when some fixture repositories are not clean
   * checkouts of their pinned commits. Default false, because workers would
   * spend tokens on the wrong code or none.
   */
  allowMissingRepos?: boolean;
  seeds?: number[];
  maxReplan?: number;
  maxNodes?: number;
  live?: LiveOptions;
  /** Where composts/traces/results go. Default: a temp dir. */
  root?: string;
  resolve?: Partial<ResolveOptions>;
  /** Persist every decision trace (can be many files). Default false. */
  writeTraces?: boolean;
  /** Pair for the permutation test. Default ["fly", "fly:shuffled"] when both present. */
  compare?: [string, string];
  /**
   * Training epochs for learnable planners (`fly:...+learning`, `learned`).
   * Each epoch runs every fixture × trainSeeds with learning on; evaluation
   * then uses the frozen result on the evaluation seeds. 0 = no training.
   */
  epochs?: number;
  trainSeeds?: number[];
  /** Run each planner's fixture loop concurrently (live mode: bounded by the provider and the shared call semaphore). */
  parallelPlanners?: boolean;
  /** Max concurrent runs per planner (fixtures × seeds). Default 1. */
  parallelFixtures?: number;
  onProgress?: (msg: string) => void;
}

export interface TrainingRecord { planner: string; epoch: number; terminationAccuracy: number; meanReward: number }

export interface RunResult {
  planner: string;
  fixtureId: string;
  category: FixtureCategory;
  seed: number;
  repoAvailable: boolean;
  outcome: PlanOutcome;
  haltKind?: string;
  expected: Fixture["expected"];
  terminationCorrect: boolean;
  completed: boolean;
  nodes: number;
  primary: OrchAction;
  included: OrchAction[];
  /** first-decision action scores (for task-sensitivity statistics) */
  scores?: Record<string, number>;
  /** first-decision feature vector (FEATURE_NAMES order) when the planner exposes it */
  features?: number[];
  /** reward used for learning: termination-correct, discounted by simulated cost */
  reward: number;
  actionsRun: string[];
  unnecessaryActions: number;
  replans: number;
  flights: number;
  tokens: number;
  foragerCalls: number;
  failures: number;
  recovered: boolean;
  usedFallback: boolean;
  wallMs: number;
  runId: string;
  error?: string;
  mode: "mock" | "live";
  /** live mode: outcome of the final flight and the first claims of the final artifact, for human review */
  finalFlightOutcome?: string;
  finalClaims?: string[];
  /** live mode with judge: rubric score in [0,1] and the judge's rationale */
  quality?: number;
  judgeRationale?: string;
  judgeError?: string;
}

export interface PlannerSummary {
  planner: string;
  runs: number;
  completionRate: number;
  terminationAccuracy: number;
  meanTokens: number;
  meanFlights: number;
  meanReplans: number;
  meanNodes: number;
  meanUnnecessary: number;
  recoveryRate: number;
  fallbackRate: number;
  errorRate: number;
  /** live+judge: mean rubric score over judged runs (undefined in mock mode) */
  meanQuality?: number;
  judgedRuns?: number;
  /**
   * Task sensitivity: does the planner's first decision depend on the task?
   * distinctPrimaries = number of different primary actions across fixtures;
   * meanPairwiseJs = mean JS divergence (bits) between first-decision score
   * vectors of different fixtures (same seed). A constant policy scores 0.
   */
  sensitivity: { distinctPrimaries: number; meanPairwiseJs: number };
  primaryDistribution: Record<string, number>;
  byCategory: Record<string, { runs: number; completionRate: number; terminationAccuracy: number; meanTokens: number }>;
}

export interface Comparison {
  a: string;
  b: string;
  pairs: number;
  completionDiff: number;
  completionP: number;
  tokensDiff: number;
  tokensP: number;
  primaryJsDivergence: number;
  identicalDecisions: number;
  /** live+judge: paired difference in rubric quality */
  qualityDiff?: number;
  qualityP?: number;
  qualityPairs?: number;
}

export interface HarnessReport {
  createdAt: string;
  options: Omit<HarnessOptions, "onProgress" | "resolve">;
  fixtureAvailability: Record<string, boolean>;
  runs: RunResult[];
  summaries: PlannerSummary[];
  comparison?: Comparison;
  training: TrainingRecord[];
  /** live mode: the provider smoke test that gated the run */
  preflight?: PreflightResult;
  /** Which task suite ran and the exact repository commits it ran against. */
  suite: { name: string; repos: { name: string; url: string; commit: string }[] };
  outDir: string;
}

function isLearnable(spec: string): boolean {
  const { kind, flags } = parsePlannerSpec(spec);
  return kind === "learned" || (kind === "fly" && (!!flags.learning || !!flags.plastic));
}

export function rewardFor(correct: boolean, tokens: number): number {
  return correct ? Math.max(0, 1 - 0.2 * Math.min(1, tokens / 30_000)) : 0;
}

export interface PreflightResult {
  ok: boolean;
  provider: { id: string; baseURL?: string; model: string; apiKeySource: string; requestParams: string };
  replyChars: number;
  usage?: number;
  error?: string;
}

/**
 * One real model call through the configured provider before spending a
 * budget. Records the resolved provider settings in the report so a run's
 * validity is auditable after the fact.
 */
export async function preflightProvider(terrariumRoot: string): Promise<PreflightResult> {
  const { withProviderRoot, resolveActiveProviderRuntimeForSlot, callInsect } = await import("../../openai-client.js");
  const { makeForager } = await import("../../castes.js");
  const runtime = withProviderRoot(terrariumRoot, () => resolveActiveProviderRuntimeForSlot("forager"));
  const provider = {
    id: runtime.id, baseURL: runtime.baseURL, model: runtime.models.forager,
    apiKeySource: runtime.apiKeySource, requestParams: JSON.stringify(runtime.requestParams ?? {}),
  };
  try {
    const { text, usage } = await withProviderRoot(terrariumRoot, () =>
      callInsect(makeForager("stoic"), "Reply with exactly: ready", { maxOutputTokens: 64 }));
    const replyChars = text.trim().length;
    return { ok: replyChars > 0, provider, replyChars, usage: usage.totalTokens, error: replyChars > 0 ? undefined : "provider returned an empty response" };
  } catch (err) {
    return { ok: false, provider, replyChars: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runHarness(opts: HarnessOptions): Promise<HarnessReport> {
  const fixtures = opts.fixtures ?? FIXTURES;
  const seeds = opts.seeds ?? [1, 2, 3];
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "flytown-eval-")));
  const outDir = join(root, ".flytown", "eval", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });
  const availability = await fixtureAvailability(fixtures);
  const unavailable = fixtures.filter((f) => !availability[f.id]);
  if (opts.live && unavailable.length && !opts.allowMissingRepos) {
    const names = [...new Set(unavailable.map((f) => f.pinned ? `${f.pinned.name}@${f.pinned.commit.slice(0, 12)}` : f.repo))];
    throw new Error(`${unavailable.length} fixture(s) have no usable repository (${names.join(", ")}). A live run would spend tokens on missing or different code. Run \`flytown fly fixtures fetch\` first, or pass --allow-missing-repos.`);
  }
  const suite = {
    name: fixtures.every((f) => FIXTURES.some((x) => x.id === f.id && x.task === f.task && x.repo === f.repo)) ? FIXTURE_SUITE : "custom",
    repos: pinnedReposFor(fixtures).map((r) => ({ name: r.name, url: r.url, commit: r.commit })),
  };
  const repoCache = new Map<string, RepoSignals>();
  const log = opts.onProgress ?? (() => {});

  const runs: RunResult[] = [];
  const training: TrainingRecord[] = [];
  const epochs = opts.epochs ?? 0;
  const trainSeeds = opts.trainSeeds ?? seeds.map((s) => s + 1000);
  const liveBudget = { totalTokens: 0, cap: opts.live?.maxTotalTokens ?? 3_000_000 };
  let preflight: PreflightResult | undefined;
  if (opts.live && opts.live.preflight !== false) {
    preflight = await preflightProvider(opts.live.terrariumRoot);
    log(`preflight: ${preflight.ok ? "ok" : "FAILED"} · ${preflight.provider.id}/${preflight.provider.model} · key from ${preflight.provider.apiKeySource} · requestParams ${preflight.provider.requestParams} · reply ${preflight.replyChars} chars`);
    if (!preflight.ok) {
      throw new Error(`live preflight failed (${preflight.error}). Provider ${preflight.provider.id}/${preflight.provider.model}, requestParams ${preflight.provider.requestParams}. Refusing to spend a budget on a provider that cannot answer — check the Terrarium's provider config (a running server can re-save terrarium.json and drop requestParams) and the API key.`);
    }
    liveBudget.totalTokens += preflight.usage ?? 0;
  }
  for (const f of fixtures) if (!repoCache.has(f.repo)) repoCache.set(f.repo, await scanRepo(f.repo));
  const runPlanner = async (spec: string) => {
    const fallbacks: unknown[] = [];
    const resolveOpts: ResolveOptions = { root, seed: seeds[0], fallback: false, ...(opts.resolve ?? {}), onFallback: (e) => fallbacks.push(e) };
    let backend = resolvePlannerBackend(spec, resolveOpts);
    if (epochs > 0 && isLearnable(spec)) {
      backend = await trainBackend({ spec, resolveOpts, fixtures, trainSeeds, epochs, root, repoCache, availability, maxReplan: opts.maxReplan ?? 2, maxNodes: opts.maxNodes ?? 6, training, log, keepLearning: !!opts.live?.liveLearning });
    }
    const jobs: { fixture: Fixture; seed: number }[] = [];
    for (const fixture of fixtures) for (const seed of seeds) jobs.push({ fixture, seed });
    const runJob = async ({ fixture, seed }: { fixture: Fixture; seed: number }) => {
      if (opts.live && liveBudget.totalTokens >= liveBudget.cap) {
        runs.push({ planner: spec, fixtureId: fixture.id, category: fixture.category, seed, repoAvailable: availability[fixture.id], outcome: "failed", expected: fixture.expected, terminationCorrect: false, completed: false, nodes: 0, primary: "spawn_flight", included: [], reward: 0, actionsRun: [], unnecessaryActions: 0, replans: 0, flights: 0, tokens: 0, foragerCalls: 0, failures: 0, recovered: false, usedFallback: false, wallMs: 0, runId: `${spec}-${fixture.id}-s${seed}`, error: `live token budget exhausted (${liveBudget.totalTokens} ≥ ${liveBudget.cap})`, mode: "live" });
        return;
      }
      const r = await runOne({ spec, backend, fixture, seed, root, repo: repoCache.get(fixture.repo)!, maxReplan: opts.maxReplan ?? 2, maxNodes: opts.maxNodes ?? 6, writeTraces: !!opts.writeTraces, available: availability[fixture.id], live: opts.live });
      r.usedFallback = fallbacks.length > 0;
      fallbacks.length = 0;
      liveBudget.totalTokens += r.tokens;
      runs.push(r);
      log(`${spec} ${fixture.id} seed=${seed} → ${r.outcome}${r.haltKind ? `(${r.haltKind})` : ""} nodes=${r.nodes} flights=${r.flights} tokens=${r.tokens}${opts.live ? ` (total ${liveBudget.totalTokens})` : ""}${r.quality !== undefined ? ` quality=${r.quality.toFixed(2)}` : ""} ${r.wallMs}ms${r.error ? ` ERROR ${r.error}` : ""}`);
    };
    const width = Math.max(1, opts.parallelFixtures ?? 1);
    // Online (live) learning must see runs in order, so learnable planners stay sequential.
    const concurrency = opts.live?.liveLearning && isLearnable(spec) ? 1 : width;
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) { const job = jobs[next++]; await runJob(job); }
    });
    await Promise.all(workers);
  };
  if (opts.parallelPlanners) await Promise.all(opts.planners.map(runPlanner));
  else for (const spec of opts.planners) await runPlanner(spec);
  // Deterministic report order regardless of completion order.
  runs.sort((x, y) => opts.planners.indexOf(x.planner) - opts.planners.indexOf(y.planner) || fixtures.findIndex((f) => f.id === x.fixtureId) - fixtures.findIndex((f) => f.id === y.fixtureId) || x.seed - y.seed);

  const summaries = opts.planners.map((p) => summarize(p, runs.filter((r) => r.planner === p)));
  let comparison: Comparison | undefined;
  const pair = opts.compare ?? (opts.planners.includes("fly") && opts.planners.includes("fly:shuffled") ? ["fly", "fly:shuffled"] as [string, string] : undefined);
  if (pair && opts.planners.includes(pair[0]) && opts.planners.includes(pair[1])) comparison = compare(pair[0], pair[1], runs);

  const report: HarnessReport = {
    createdAt: new Date().toISOString(),
    options: { planners: opts.planners, seeds, maxReplan: opts.maxReplan ?? 2, maxNodes: opts.maxNodes ?? 6, root, writeTraces: !!opts.writeTraces, compare: pair, epochs, trainSeeds, live: opts.live, fixtures: fixtures.map((f) => ({ ...f })) },
    fixtureAvailability: availability, runs, summaries, comparison, training, preflight, suite, outDir,
  };
  await writeFile(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(join(outDir, "report.md"), renderReport(report), "utf8");
  return report;
}

/**
 * Train a learnable backend for `epochs` passes over fixtures × trainSeeds,
 * then return a frozen evaluation backend carrying the learned weights.
 * The fly variant learns only its adapter weights (never the graph); the
 * learned baseline retrains its logistic router on-policy after each epoch.
 */
async function trainBackend(a: { spec: string; resolveOpts: ResolveOptions; fixtures: Fixture[]; trainSeeds: number[]; epochs: number; root: string; repoCache: Map<string, RepoSignals>; availability: Record<string, boolean>; maxReplan: number; maxNodes: number; training: TrainingRecord[]; log: (m: string) => void; keepLearning?: boolean }): Promise<PlannerBackend> {
  const { kind } = parsePlannerSpec(a.spec);
  const pass = async (backend: PlannerBackend, epoch: number) => {
    const results: RunResult[] = [];
    for (const fixture of a.fixtures) for (const seed of a.trainSeeds) {
      results.push(await runOne({ spec: a.spec, backend, fixture, seed, root: a.root, repo: a.repoCache.get(fixture.repo)!, maxReplan: a.maxReplan, maxNodes: a.maxNodes, writeTraces: false, available: a.availability[fixture.id] }));
    }
    const rec = { planner: a.spec, epoch, terminationAccuracy: mean(results.map((r) => (r.terminationCorrect ? 1 : 0))), meanReward: mean(results.map((r) => r.reward)) };
    a.training.push(rec);
    a.log(`train ${a.spec} epoch ${epoch}: acc=${(rec.terminationAccuracy * 100).toFixed(0)}% reward=${rec.meanReward.toFixed(3)}`);
    return results;
  };
  if (kind === "fly") {
    const flyOpts = resolveFlyOptions(a.spec, a.resolveOpts);
    const trainer = new FlyPlannerBackend({ ...flyOpts, explore: true, weightsDir: undefined });
    for (let e = 1; e <= a.epochs; e++) await pass(trainer, e);
    const adapters = await trainer.snapshotAdapters();
    const plasticState = trainer.snapshotPlastic();
    // Frozen evaluation backend: trained adapters and multipliers, no further updates, greedy.
    // keepLearning: online adapter learning continues during (live) evaluation, greedy decisions.
    return new FlyPlannerBackend({ ...trainer.options, adapters, plasticState, learning: !!a.keepLearning && !!flyOpts.learning, plastic: !!flyOpts.plastic, explore: false, weightsDir: undefined, id: a.spec });
  }
  let weights: LinearRouterWeights = uniformWeights();
  for (let e = 1; e <= a.epochs; e++) {
    const results = await pass(learnedPlannerBackend({ weights, explore: true }), e);
    const examples: TrainingExample[] = results.filter((r) => r.features).map((r) => ({ features: r.features!, action: r.primary, reward: r.reward > 0 ? r.reward : -0.5 }));
    weights = trainLinearRouter(examples, { init: weights, epochs: 5, lr: 0.2 });
  }
  const frozen = learnedPlannerBackend({ weights });
  return { id: a.spec, plan: (req) => frozen.plan(req) };
}

const DEFAULT_LIVE_GLOBS = ["README.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];

/** Real FLYTOWN pipeline as a FlightRunner, with the live caps applied and usage accounted. */
function makeLiveFlightRunner(live: LiveOptions, stats: MockFlightStats): FlightRunner {
  return async (ro) => {
    const action = ro.nodeHints?.action ?? "spawn_flight";
    stats.flights++;
    stats.actions.push(action);
    const res = await performFlight({
      ...ro,
      swarmSize: Math.max(1, Math.min(ro.swarmSize, live.swarmSize ?? 2)),
      scanGlobs: live.scanGlobs ?? DEFAULT_LIVE_GLOBS,
      maxOutputTokensPerCall: live.maxOutputTokensPerCall ?? 400,
      budgetTokens: live.budgetTokensPerRun ?? 40_000,
      guardTools: !!live.guardTools && !!ro.guardTools,
    });
    const tokens = res.allMorsels.reduce((s, l) => s + (l.usage?.totalTokens ?? 0), 0);
    stats.tokens += tokens;
    stats.foragerCalls += res.allMorsels.length;
    if (res.flight.outcome === "all_failed") stats.failures++;
    return res;
  };
}

async function runOne(a: { spec: string; backend: PlannerBackend; fixture: Fixture; seed: number; root: string; repo: RepoSignals; maxReplan: number; maxNodes: number; writeTraces: boolean; available: boolean; live?: LiveOptions }): Promise<RunResult> {
  if (a.live) return withProviderRoot(a.live.terrariumRoot, () => runOneInner(a));
  return runOneInner(a);
}

async function runOneInner(a: { spec: string; backend: PlannerBackend; fixture: Fixture; seed: number; root: string; repo: RepoSignals; maxReplan: number; maxNodes: number; writeTraces: boolean; available: boolean; live?: LiveOptions }): Promise<RunResult> {
  const { fixture, seed } = a;
  const runId = `${a.spec.replace(/[^a-z0-9]+/gi, "_")}-${fixture.id}-s${seed}`;
  const compost = new Compost(join(a.root, ".flytown", "eval-compost", runId));
  await compost.init();
  const stats: MockFlightStats = { flights: 0, tokens: 0, foragerCalls: 0, failures: 0, actions: [] };
  const flightRunner = a.live ? makeLiveFlightRunner(a.live, stats) : makeMockFlightRunner({ fixture, seed, stats });
  const parentArtifacts: Artifact[] = Array.from({ length: fixture.priorArtifacts ?? 0 }, (_, i) => ({
    id: `prior-${fixture.id}-${i}`, flightId: `prior-flight-${i}`, task: fixture.task, outcome: "winner",
    claims: [{ text: "prior finding", confidence: "established" }], evidence: [], openQuestions: [], nextSteps: [], parentArtifactIds: [], keywords: [], timestamp: 0,
  }));
  const traces: DecisionTrace[] = [];
  const t0 = Date.now();
  let error: string | undefined;
  let outcome: PlanOutcome = "failed";
  let haltKind: string | undefined;
  let replans = 0;
  let firstTrace: DecisionTrace | undefined;
  let nodes = 0;
  let finalFlightOutcome: string | undefined;
  let finalClaims: string[] | undefined;
  let quality: number | undefined;
  let judgeRationale: string | undefined;
  let judgeError: string | undefined;
  try {
    const res = await a.backend.plan({ task: fixture.task, cwd: fixture.repo, repo: a.repo, parentArtifacts, maxNodes: a.maxNodes, runId, extraSignals: fixture.extra, replanDepth: 0 });
    firstTrace = res.trace;
    if (res.trace) traces.push(res.trace);
    nodes = res.plan.nodes.length;
    stats.tokens += res.usage?.totalTokens ?? 0;
    // Wrap the backend so replans carry fixture signals and are traced too.
    const replanner: PlannerBackend = {
      id: a.backend.id,
      plan: async (req) => {
        const r = await a.backend.plan({ ...req, repo: a.repo, extraSignals: fixture.extra, runId: `${runId}-r${req.replanDepth ?? 0}` });
        if (r.trace) traces.push(r.trace);
        nodes += r.plan.nodes.length;
        stats.tokens += r.usage?.totalTokens ?? 0;
        return r;
      },
    };
    const exec = await executePlan({ plan: res.plan, cwd: fixture.repo, compost, planner: replanner, flightRunner, maxReplanDepth: a.maxReplan, parentArtifacts, budgetTokens: a.live?.budgetTokensPerRun, maxOutputTokensPerCall: a.live?.maxOutputTokensPerCall });
    outcome = exec.outcome;
    haltKind = exec.halt?.kind;
    replans = exec.replans;
    if (a.live) {
      finalClaims = exec.finalArtifact?.claims.slice(0, 3).map((c) => c.text);
      if (exec.finalFlightId) finalFlightOutcome = (await compost.getFlight(exec.finalFlightId))?.outcome;
      if (a.live.judge !== false) {
        const termOk = terminationOk(fixture.expected, outcome, haltKind);
        if (outcome === "halted") {
          // No output to judge: a halt is right or wrong by the fixture contract.
          quality = termOk ? 1 : 0;
          judgeRationale = `halted (${haltKind}); expected ${fixture.expected}`;
        } else if (outcome === "success") {
          const finalOutput = exec.finalMorselId ? (await compost.getMorsel(exec.finalMorselId))?.output : undefined;
          const verdict = await judgeOutput({
            task: fixture.task, rubric: rubricFor(fixture), expected: fixture.expected,
            outcome: `completed a ${exec.plan.nodes.length}-node plan (final flight outcome: ${finalFlightOutcome ?? "unknown"}); actions: ${stats.actions.join(" → ") || "none"}`,
            output: finalOutput, claims: exec.finalArtifact?.claims.map((c) => c.text),
          });
          stats.tokens += verdict.tokens;
          quality = verdict.error ? undefined : verdict.score;
          judgeRationale = verdict.rationale;
          judgeError = verdict.error;
        } else {
          quality = 0;
          judgeRationale = "plan failed";
        }
      }
    }
    const termCorrect = terminationOk(fixture.expected, outcome, haltKind);
    const liveReward = quality !== undefined ? 0.8 * quality + 0.2 * (termCorrect ? 1 : 0) : rewardFor(termCorrect, stats.tokens);
    if (canLearn(a.backend) && firstTrace && (!a.live || a.live.liveLearning)) {
      await a.backend.learn(firstTrace, a.live ? liveReward : rewardFor(termCorrect, stats.tokens));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = Date.now() - t0;
  if (a.writeTraces) for (const t of traces) { t.outcome = { planOutcome: outcome, replans, tokens: stats.tokens, wallMs, reward: quality }; await writeTrace(a.root, t); }
  const primary = (firstTrace?.decision.primary ?? "spawn_flight") as OrchAction;
  const included = (firstTrace?.decision.included ?? []) as OrchAction[];
  const completed = outcome === "success";
  const terminationCorrect = terminationOk(fixture.expected, outcome, haltKind);
  const recovered = fixture.category === "misleading_hypothesis" && completed && stats.failures > 0;
  return {
    planner: a.spec, fixtureId: fixture.id, category: fixture.category, seed, repoAvailable: a.available,
    outcome, haltKind, expected: fixture.expected, terminationCorrect, completed, nodes, primary, included,
    scores: firstTrace?.actionScores,
    features: firstTrace?.features ? FEATURE_NAMES.map((n) => firstTrace!.features![n] ?? 0) : undefined,
    reward: quality !== undefined ? 0.8 * quality + 0.2 * (terminationCorrect ? 1 : 0) : rewardFor(terminationCorrect, stats.tokens),
    actionsRun: stats.actions, unnecessaryActions: countUnnecessary(fixture, stats.actions), replans,
    flights: stats.flights, tokens: stats.tokens, foragerCalls: stats.foragerCalls, failures: stats.failures, recovered,
    usedFallback: false, wallMs, runId, error, mode: a.live ? "live" : "mock", finalFlightOutcome, finalClaims, quality, judgeRationale, judgeError,
  };
}

export function terminationOk(expected: Fixture["expected"], outcome: PlanOutcome, haltKind?: string): boolean {
  switch (expected) {
    case "complete": return outcome === "success";
    case "blocked": return outcome === "halted" && haltKind === "blocked";
    case "approval": return outcome === "halted" && haltKind === "approval";
    case "stop_early": return outcome === "halted" && haltKind === "success";
  }
}

function countUnnecessary(f: Fixture, actions: string[]): number {
  let n = 0;
  for (const a of actions) {
    if ((a === "request_artifact_investigation" || a === "search_memory") && !f.traps.needsInvestigation && f.category !== "research_synthesis") n++;
    if ((a === "run_tests" || a === "run_tool") && !f.traps.needsVerification) n++;
    if (a === "invoke_reviewer" && !f.traps.needsReview && f.category !== "security_sensitive") n++;
  }
  if (f.expected !== "complete" && actions.length > 0) n += actions.length;
  return n;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function summarize(planner: string, rs: RunResult[]): PlannerSummary {
  const ok = rs.filter((r) => !r.error);
  const dist: Record<string, number> = {};
  for (const r of ok) dist[r.primary] = (dist[r.primary] ?? 0) + 1;
  for (const k of Object.keys(dist)) dist[k] /= ok.length || 1;
  const byCategory: PlannerSummary["byCategory"] = {};
  for (const r of ok) {
    const c = (byCategory[r.category] ??= { runs: 0, completionRate: 0, terminationAccuracy: 0, meanTokens: 0 });
    c.runs++; c.completionRate += r.completed ? 1 : 0; c.terminationAccuracy += r.terminationCorrect ? 1 : 0; c.meanTokens += r.tokens;
  }
  for (const c of Object.values(byCategory)) { c.completionRate /= c.runs; c.terminationAccuracy /= c.runs; c.meanTokens /= c.runs; }
  const misleading = ok.filter((r) => r.category === "misleading_hypothesis");
  const judged = rs.filter((r) => r.quality !== undefined);
  const meanQuality = judged.length ? mean(judged.map((r) => r.quality!)) : undefined;
  const firstSeed = ok.length ? Math.min(...ok.map((r) => r.seed)) : 0;
  const perFixture = ok.filter((r) => r.seed === firstSeed && r.scores);
  let jsSum = 0, jsN = 0;
  for (let i = 0; i < perFixture.length; i++) for (let j = i + 1; j < perFixture.length; j++) { jsSum += jsDivergence(perFixture[i].scores!, perFixture[j].scores!); jsN++; }
  const sensitivity = { distinctPrimaries: new Set(perFixture.map((r) => r.primary)).size, meanPairwiseJs: jsN ? jsSum / jsN : 0 };
  return {
    planner, runs: rs.length, sensitivity,
    completionRate: mean(ok.filter((r) => r.expected === "complete").map((r) => (r.completed ? 1 : 0))),
    terminationAccuracy: mean(ok.map((r) => (r.terminationCorrect ? 1 : 0))),
    meanTokens: mean(ok.map((r) => r.tokens)), meanFlights: mean(ok.map((r) => r.flights)), meanReplans: mean(ok.map((r) => r.replans)),
    meanNodes: mean(ok.map((r) => r.nodes)), meanUnnecessary: mean(ok.map((r) => r.unnecessaryActions)),
    recoveryRate: mean(misleading.map((r) => (r.completed ? 1 : 0))),
    fallbackRate: mean(rs.map((r) => (r.usedFallback ? 1 : 0))), errorRate: mean(rs.map((r) => (r.error ? 1 : 0))),
    meanQuality, judgedRuns: judged.length || undefined,
    primaryDistribution: dist, byCategory,
  };
}

/** Paired permutation test (sign flips) on per-(fixture,seed) differences. */
export function pairedPermutation(diffs: number[], iterations = 5000, seed = 7): { diff: number; p: number } {
  const observed = mean(diffs);
  if (diffs.length === 0) return { diff: 0, p: 1 };
  const rng = makeRng(seed);
  let extreme = 0;
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (const d of diffs) s += rng.next() < 0.5 ? d : -d;
    if (Math.abs(s / diffs.length) >= Math.abs(observed) - 1e-12) extreme++;
  }
  return { diff: observed, p: (extreme + 1) / (iterations + 1) };
}

export function jsDivergence(p: Record<string, number>, q: Record<string, number>): number {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  const m: Record<string, number> = {};
  for (const k of keys) m[k] = ((p[k] ?? 0) + (q[k] ?? 0)) / 2;
  const kl = (x: Record<string, number>) => { let s = 0; for (const k of keys) { const v = x[k] ?? 0; if (v > 0) s += v * Math.log2(v / m[k]); } return s; };
  return (kl(p) + kl(q)) / 2;
}

export function compare(a: string, b: string, runs: RunResult[]): Comparison {
  const key = (r: RunResult) => `${r.fixtureId}|${r.seed}`;
  const ra = new Map(runs.filter((r) => r.planner === a && !r.error).map((r) => [key(r), r]));
  const rb = new Map(runs.filter((r) => r.planner === b && !r.error).map((r) => [key(r), r]));
  const completion: number[] = [], tokens: number[] = [], quality: number[] = [];
  let identical = 0, pairs = 0;
  for (const [k, x] of ra) {
    const y = rb.get(k);
    if (!y) continue;
    pairs++;
    completion.push((x.terminationCorrect ? 1 : 0) - (y.terminationCorrect ? 1 : 0));
    tokens.push(x.tokens - y.tokens);
    if (x.quality !== undefined && y.quality !== undefined) quality.push(x.quality - y.quality);
    if (x.primary === y.primary && x.included.join() === y.included.join()) identical++;
  }
  const c = pairedPermutation(completion, 5000, hashSeed(a, b, 1));
  const t = pairedPermutation(tokens, 5000, hashSeed(a, b, 2));
  const q = quality.length ? pairedPermutation(quality, 5000, hashSeed(a, b, 3)) : undefined;
  const sa = summarize(a, runs.filter((r) => r.planner === a)), sb = summarize(b, runs.filter((r) => r.planner === b));
  return {
    a, b, pairs, completionDiff: c.diff, completionP: c.p, tokensDiff: t.diff, tokensP: t.p,
    primaryJsDivergence: jsDivergence(sa.primaryDistribution, sb.primaryDistribution), identicalDecisions: pairs ? identical / pairs : 0,
    ...(q ? { qualityDiff: q.diff, qualityP: q.p, qualityPairs: quality.length } : {}),
  };
}

/** A path with the user's home folder shown as ~, so reports copied into docs carry no account names. */
export function tildify(path: string, home: string = homedir()): string {
  return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
}

export function renderReport(r: HarnessReport): string {
  const L: string[] = [];
  const live = r.options.live;
  L.push(`# FLYTOWN evaluation report`, ``, `created: ${r.createdAt}  ·  seeds: ${r.options.seeds?.join(",")}  ·  fixtures: ${r.options.fixtures?.length}  ·  ${live ? `**LIVE** — real FLYTOWN pipeline against the provider in ${tildify(live.terrariumRoot)} (swarm ≤ ${live.swarmSize ?? 2}, ≤ ${live.maxOutputTokensPerCall ?? 400} output tokens/call, ≤ ${live.budgetTokensPerRun ?? 40_000} tokens/run${r.options.epochs ? "; learnable planners trained in the mock world first" : ""})` : "mock worker world (not live models)"}`, ``);
  if (live && r.preflight) {
    const p = r.preflight.provider;
    L.push(`> provider (preflight ${r.preflight.ok ? "passed" : "FAILED"}): ${p.id} · ${p.model} · key from ${p.apiKeySource} · requestParams ${p.requestParams} · smoke reply ${r.preflight.replyChars} chars`, ``);
  }
  if (live) {
    const spent = r.runs.reduce((s, x) => s + x.tokens, 0);
    const wall = r.runs.reduce((s, x) => s + x.wallMs, 0);
    L.push(`> tokens spent: ${spent.toLocaleString()}  ·  wall time: ${(wall / 60_000).toFixed(1)} min  ·  ${r.runs.filter((x) => x.error?.includes("budget exhausted")).length} runs skipped by the total-token cap. Completion here means FLYTOWN's own guard-gated pipeline produced a winner for every node; halts are judged against each fixture's expected termination. No external judge yet — final claims are recorded per run in report.json for human review.`, ``);
  }
  if (r.suite) L.push(`> suite: ${r.suite.name}${r.suite.repos.length ? ` · ${r.suite.repos.map((x) => `${x.name}@${x.commit.slice(0, 12)}`).join(" · ")}` : ""}`, ``);
  const missing = Object.entries(r.fixtureAvailability).filter(([, ok]) => !ok).map(([id]) => id);
  if (missing.length) L.push(`> repositories not ready for: ${missing.join(", ")} — those runs used empty repo signals, so this report does not reproduce the suite. Run \`flytown fly fixtures fetch\`.`, ``);
  const judged = r.summaries.some((s) => s.meanQuality !== undefined);
  L.push(`| planner | runs |${judged ? " quality (judge) |" : ""} termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean flights | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |`);
  L.push(`|---|---|${judged ? "---|" : ""}---|---|---|---|---|---|---|---|---|---|`);
  for (const s of r.summaries) L.push(`| ${s.planner} | ${s.runs} |${judged ? ` ${s.meanQuality !== undefined ? `${s.meanQuality.toFixed(2)} (n=${s.judgedRuns})` : "–"} |` : ""} ${pct(s.terminationAccuracy)} | ${pct(s.completionRate)} | ${pct(s.recoveryRate)} | ${s.meanTokens.toFixed(0)} | ${s.meanFlights.toFixed(2)} | ${s.meanReplans.toFixed(2)} | ${s.meanNodes.toFixed(2)} | ${s.meanUnnecessary.toFixed(2)} | ${s.sensitivity.distinctPrimaries} / ${s.sensitivity.meanPairwiseJs.toFixed(3)} | ${pct(s.errorRate)} |`);
  L.push(``);
  if (judged) L.push(`> quality = LLM-judge rubric score in [0,1] per fixture (halts scored 1/0 by the fixture's expected termination; failed plans 0). The judge is a model call with a fixed prompt shared across planners — record, don't trust blindly; rationales are in report.json.`, ``);
  const constant = r.summaries.filter((s) => s.sensitivity.distinctPrimaries <= 1 && s.runs > 1).map((s) => s.planner);
  if (constant.length) L.push(`> **Constant-policy warning:** ${constant.join(", ")} made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.`, ``);
  if (r.training.length) {
    L.push(`## Training curves (epochs=${r.options.epochs}, train seeds ${r.options.trainSeeds?.join(",")} — disjoint from evaluation seeds)`, ``);
    const byPlanner = new Map<string, TrainingRecord[]>();
    for (const t of r.training) (byPlanner.get(t.planner) ?? byPlanner.set(t.planner, []).get(t.planner)!).push(t);
    for (const [p, recs] of byPlanner) L.push(`- ${p}: ${recs.map((t) => `e${t.epoch} ${(t.terminationAccuracy * 100).toFixed(0)}%`).join(" → ")}`);
    L.push(``);
  }
  if (r.comparison) {
    const c = r.comparison;
    L.push(`## ${c.a} vs ${c.b} (paired, n=${c.pairs})`, ``);
    L.push(`- termination-accuracy difference: ${(c.completionDiff * 100).toFixed(1)} pts, permutation p = ${c.completionP.toFixed(3)}`);
    L.push(`- token difference: ${c.tokensDiff.toFixed(0)}, permutation p = ${c.tokensP.toFixed(3)}`);
    if (c.qualityDiff !== undefined) L.push(`- judge-quality difference: ${c.qualityDiff.toFixed(3)} (n=${c.qualityPairs}), permutation p = ${c.qualityP!.toFixed(3)}`);
    L.push(`- primary-action JS divergence: ${c.primaryJsDivergence.toFixed(3)} bits  ·  identical decisions: ${pct(c.identicalDecisions)}`);
    const verdict = c.completionP < 0.05 || c.tokensP < 0.05 || (c.qualityP !== undefined && c.qualityP < 0.05)
      ? `**Distinguishable** on at least one primary metric at p<0.05.`
      : `**Not distinguishable** at p<0.05 on termination accuracy or tokens. Under this harness the real wiring is not shown to matter versus ${c.b}. Report this as the result; do not dress it up.`;
    L.push(``, verdict, ``);
  }
  L.push(`## Primary action distribution`, ``);
  const actions = [...new Set(r.summaries.flatMap((s) => Object.keys(s.primaryDistribution)))].sort();
  L.push(`| planner | ${actions.join(" | ")} |`, `|---|${actions.map(() => "---").join("|")}|`);
  for (const s of r.summaries) L.push(`| ${s.planner} | ${actions.map((a) => pct(s.primaryDistribution[a] ?? 0)).join(" | ")} |`);
  L.push(``, `## By category (termination accuracy)`, ``);
  const cats = [...new Set(r.runs.map((x) => x.category))];
  L.push(`| planner | ${cats.join(" | ")} |`, `|---|${cats.map(() => "---").join("|")}|`);
  for (const s of r.summaries) L.push(`| ${s.planner} | ${cats.map((c) => (s.byCategory[c] ? pct(s.byCategory[c].terminationAccuracy) : "–")).join(" | ")} |`);
  L.push(``);
  return L.join("\n") + "\n";
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
