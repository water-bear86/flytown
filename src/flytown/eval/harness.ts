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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan, type PlanOutcome } from "../../plan-executor.js";
import { Hoard } from "../../hoard.js";
import type { Artifact } from "../../types.js";
import type { OrchAction } from "../actions.js";
import type { PlannerBackend } from "../planner-backend.js";
import { parsePlannerSpec, resolveFlyOptions, resolvePlannerBackend, type ResolveOptions } from "../registry.js";
import { FEATURE_NAMES, scanRepo, type RepoSignals } from "../signals.js";
import { FlyPlannerBackend } from "../fly-planner.js";
import { learnedPlannerBackend, trainLinearRouter, uniformWeights, type LinearRouterWeights, type TrainingExample } from "../baselines/learned.js";
import { hashSeed, makeRng } from "../rng.js";
import { writeTrace, type DecisionTrace } from "../trace.js";
import { FIXTURES, fixtureAvailability, type Fixture, type FixtureCategory } from "./fixtures.js";
import { makeMockRiteRunner, type MockRiteStats } from "./mock-rite.js";

export interface HarnessOptions {
  planners: string[];
  fixtures?: Fixture[];
  seeds?: number[];
  maxReplan?: number;
  maxNodes?: number;
  /** Where hoards/traces/results go. Default: a temp dir. */
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
  rites: number;
  tokens: number;
  goblinCalls: number;
  failures: number;
  recovered: boolean;
  usedFallback: boolean;
  wallMs: number;
  runId: string;
  error?: string;
}

export interface PlannerSummary {
  planner: string;
  runs: number;
  completionRate: number;
  terminationAccuracy: number;
  meanTokens: number;
  meanRites: number;
  meanReplans: number;
  meanNodes: number;
  meanUnnecessary: number;
  recoveryRate: number;
  fallbackRate: number;
  errorRate: number;
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
}

export interface HarnessReport {
  createdAt: string;
  options: Omit<HarnessOptions, "onProgress" | "resolve">;
  fixtureAvailability: Record<string, boolean>;
  runs: RunResult[];
  summaries: PlannerSummary[];
  comparison?: Comparison;
  training: TrainingRecord[];
  outDir: string;
}

function isLearnable(spec: string): boolean {
  const { kind, flags } = parsePlannerSpec(spec);
  return kind === "learned" || (kind === "fly" && (!!flags.learning || !!flags.plastic));
}

export function rewardFor(correct: boolean, tokens: number): number {
  return correct ? Math.max(0, 1 - 0.2 * Math.min(1, tokens / 30_000)) : 0;
}

export async function runHarness(opts: HarnessOptions): Promise<HarnessReport> {
  const fixtures = opts.fixtures ?? FIXTURES;
  const seeds = opts.seeds ?? [1, 2, 3];
  const root = opts.root ?? (await mkdtemp(join(tmpdir(), "flytown-eval-")));
  const outDir = join(root, ".flytown", "eval", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outDir, { recursive: true });
  const availability = await fixtureAvailability(fixtures);
  const repoCache = new Map<string, RepoSignals>();
  const log = opts.onProgress ?? (() => {});

  const runs: RunResult[] = [];
  const training: TrainingRecord[] = [];
  const epochs = opts.epochs ?? 0;
  const trainSeeds = opts.trainSeeds ?? seeds.map((s) => s + 1000);
  for (const spec of opts.planners) {
    const fallbacks: unknown[] = [];
    const resolveOpts: ResolveOptions = { root, seed: seeds[0], fallback: false, ...(opts.resolve ?? {}), onFallback: (e) => fallbacks.push(e) };
    let backend = resolvePlannerBackend(spec, resolveOpts);
    if (epochs > 0 && isLearnable(spec)) {
      for (const f of fixtures) if (!repoCache.has(f.repo)) repoCache.set(f.repo, await scanRepo(f.repo));
      backend = await trainBackend({ spec, resolveOpts, fixtures, trainSeeds, epochs, root, repoCache, availability, maxReplan: opts.maxReplan ?? 2, maxNodes: opts.maxNodes ?? 6, training, log });
    }
    for (const fixture of fixtures) {
      if (!repoCache.has(fixture.repo)) repoCache.set(fixture.repo, await scanRepo(fixture.repo));
      for (const seed of seeds) {
        const r = await runOne({ spec, backend, fixture, seed, root, repo: repoCache.get(fixture.repo)!, maxReplan: opts.maxReplan ?? 2, maxNodes: opts.maxNodes ?? 6, writeTraces: !!opts.writeTraces, available: availability[fixture.id] });
        r.usedFallback = fallbacks.length > 0;
        fallbacks.length = 0;
        runs.push(r);
        log(`${spec} ${fixture.id} seed=${seed} → ${r.outcome}${r.haltKind ? `(${r.haltKind})` : ""} nodes=${r.nodes} tokens=${r.tokens}${r.error ? ` ERROR ${r.error}` : ""}`);
      }
    }
  }

  const summaries = opts.planners.map((p) => summarize(p, runs.filter((r) => r.planner === p)));
  let comparison: Comparison | undefined;
  const pair = opts.compare ?? (opts.planners.includes("fly") && opts.planners.includes("fly:shuffled") ? ["fly", "fly:shuffled"] as [string, string] : undefined);
  if (pair && opts.planners.includes(pair[0]) && opts.planners.includes(pair[1])) comparison = compare(pair[0], pair[1], runs);

  const report: HarnessReport = {
    createdAt: new Date().toISOString(),
    options: { planners: opts.planners, seeds, maxReplan: opts.maxReplan ?? 2, maxNodes: opts.maxNodes ?? 6, root, writeTraces: !!opts.writeTraces, compare: pair, epochs, trainSeeds, fixtures: fixtures.map((f) => ({ ...f })) },
    fixtureAvailability: availability, runs, summaries, comparison, training, outDir,
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
async function trainBackend(a: { spec: string; resolveOpts: ResolveOptions; fixtures: Fixture[]; trainSeeds: number[]; epochs: number; root: string; repoCache: Map<string, RepoSignals>; availability: Record<string, boolean>; maxReplan: number; maxNodes: number; training: TrainingRecord[]; log: (m: string) => void }): Promise<PlannerBackend> {
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
    return new FlyPlannerBackend({ ...trainer.options, adapters, plasticState, learning: false, plastic: !!flyOpts.plastic, explore: false, weightsDir: undefined, id: a.spec });
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

async function runOne(a: { spec: string; backend: PlannerBackend; fixture: Fixture; seed: number; root: string; repo: RepoSignals; maxReplan: number; maxNodes: number; writeTraces: boolean; available: boolean }): Promise<RunResult> {
  const { fixture, seed } = a;
  const runId = `${a.spec.replace(/[^a-z0-9]+/gi, "_")}-${fixture.id}-s${seed}`;
  const hoard = new Hoard(join(a.root, ".flytown", "eval-hoard", runId));
  await hoard.init();
  const stats: MockRiteStats = { rites: 0, tokens: 0, goblinCalls: 0, failures: 0, actions: [] };
  const riteRunner = makeMockRiteRunner({ fixture, seed, stats });
  const parentArtifacts: Artifact[] = Array.from({ length: fixture.priorArtifacts ?? 0 }, (_, i) => ({
    id: `prior-${fixture.id}-${i}`, riteId: `prior-rite-${i}`, task: fixture.task, outcome: "winner",
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
  try {
    const res = await a.backend.plan({ task: fixture.task, cwd: fixture.repo, repo: a.repo, parentArtifacts, maxNodes: a.maxNodes, runId, extraSignals: fixture.extra, replanDepth: 0 });
    firstTrace = res.trace;
    if (res.trace) traces.push(res.trace);
    nodes = res.plan.nodes.length;
    // Wrap the backend so replans carry fixture signals and are traced too.
    const replanner: PlannerBackend = {
      id: a.backend.id,
      plan: async (req) => {
        const r = await a.backend.plan({ ...req, repo: a.repo, extraSignals: fixture.extra, runId: `${runId}-r${req.replanDepth ?? 0}` });
        if (r.trace) traces.push(r.trace);
        nodes += r.plan.nodes.length;
        return r;
      },
    };
    const exec = await executePlan({ plan: res.plan, cwd: fixture.repo, hoard, planner: replanner, riteRunner, maxReplanDepth: a.maxReplan, parentArtifacts });
    outcome = exec.outcome;
    haltKind = exec.halt?.kind;
    replans = exec.replans;
    if (a.backend instanceof FlyPlannerBackend && firstTrace) {
      await a.backend.learn(firstTrace, rewardFor(terminationOk(fixture.expected, outcome, haltKind), stats.tokens));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const wallMs = Date.now() - t0;
  if (a.writeTraces) for (const t of traces) { t.outcome = { planOutcome: outcome, replans, tokens: stats.tokens, wallMs }; await writeTrace(a.root, t); }
  const primary = (firstTrace?.decision.primary ?? "spawn_subrite") as OrchAction;
  const included = (firstTrace?.decision.included ?? []) as OrchAction[];
  const completed = outcome === "success";
  const terminationCorrect = terminationOk(fixture.expected, outcome, haltKind);
  const recovered = fixture.category === "misleading_hypothesis" && completed && stats.failures > 0;
  return {
    planner: a.spec, fixtureId: fixture.id, category: fixture.category, seed, repoAvailable: a.available,
    outcome, haltKind, expected: fixture.expected, terminationCorrect, completed, nodes, primary, included,
    scores: firstTrace?.actionScores,
    features: firstTrace?.features ? FEATURE_NAMES.map((n) => firstTrace!.features![n] ?? 0) : undefined,
    reward: rewardFor(terminationCorrect, stats.tokens),
    actionsRun: stats.actions, unnecessaryActions: countUnnecessary(fixture, stats.actions), replans,
    rites: stats.rites, tokens: stats.tokens, goblinCalls: stats.goblinCalls, failures: stats.failures, recovered,
    usedFallback: false, wallMs, runId, error,
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
  const firstSeed = ok.length ? Math.min(...ok.map((r) => r.seed)) : 0;
  const perFixture = ok.filter((r) => r.seed === firstSeed && r.scores);
  let jsSum = 0, jsN = 0;
  for (let i = 0; i < perFixture.length; i++) for (let j = i + 1; j < perFixture.length; j++) { jsSum += jsDivergence(perFixture[i].scores!, perFixture[j].scores!); jsN++; }
  const sensitivity = { distinctPrimaries: new Set(perFixture.map((r) => r.primary)).size, meanPairwiseJs: jsN ? jsSum / jsN : 0 };
  return {
    planner, runs: rs.length, sensitivity,
    completionRate: mean(ok.filter((r) => r.expected === "complete").map((r) => (r.completed ? 1 : 0))),
    terminationAccuracy: mean(ok.map((r) => (r.terminationCorrect ? 1 : 0))),
    meanTokens: mean(ok.map((r) => r.tokens)), meanRites: mean(ok.map((r) => r.rites)), meanReplans: mean(ok.map((r) => r.replans)),
    meanNodes: mean(ok.map((r) => r.nodes)), meanUnnecessary: mean(ok.map((r) => r.unnecessaryActions)),
    recoveryRate: mean(misleading.map((r) => (r.completed ? 1 : 0))),
    fallbackRate: mean(rs.map((r) => (r.usedFallback ? 1 : 0))), errorRate: mean(rs.map((r) => (r.error ? 1 : 0))),
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
  const completion: number[] = [], tokens: number[] = [];
  let identical = 0, pairs = 0;
  for (const [k, x] of ra) {
    const y = rb.get(k);
    if (!y) continue;
    pairs++;
    completion.push((x.terminationCorrect ? 1 : 0) - (y.terminationCorrect ? 1 : 0));
    tokens.push(x.tokens - y.tokens);
    if (x.primary === y.primary && x.included.join() === y.included.join()) identical++;
  }
  const c = pairedPermutation(completion, 5000, hashSeed(a, b, 1));
  const t = pairedPermutation(tokens, 5000, hashSeed(a, b, 2));
  const sa = summarize(a, runs.filter((r) => r.planner === a)), sb = summarize(b, runs.filter((r) => r.planner === b));
  return { a, b, pairs, completionDiff: c.diff, completionP: c.p, tokensDiff: t.diff, tokensP: t.p, primaryJsDivergence: jsDivergence(sa.primaryDistribution, sb.primaryDistribution), identicalDecisions: pairs ? identical / pairs : 0 };
}

export function renderReport(r: HarnessReport): string {
  const L: string[] = [];
  L.push(`# FLYTOWN evaluation report`, ``, `created: ${r.createdAt}  ·  seeds: ${r.options.seeds?.join(",")}  ·  fixtures: ${r.options.fixtures?.length}  ·  mock worker world (not live models)`, ``);
  const missing = Object.entries(r.fixtureAvailability).filter(([, ok]) => !ok).map(([id]) => id);
  if (missing.length) L.push(`> repositories missing on this machine for: ${missing.join(", ")} — those runs used empty repo signals.`, ``);
  L.push(`| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const s of r.summaries) L.push(`| ${s.planner} | ${s.runs} | ${pct(s.terminationAccuracy)} | ${pct(s.completionRate)} | ${pct(s.recoveryRate)} | ${s.meanTokens.toFixed(0)} | ${s.meanRites.toFixed(2)} | ${s.meanReplans.toFixed(2)} | ${s.meanNodes.toFixed(2)} | ${s.meanUnnecessary.toFixed(2)} | ${s.sensitivity.distinctPrimaries} / ${s.sensitivity.meanPairwiseJs.toFixed(3)} | ${pct(s.errorRate)} |`);
  L.push(``);
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
    L.push(`- primary-action JS divergence: ${c.primaryJsDivergence.toFixed(3)} bits  ·  identical decisions: ${pct(c.identicalDecisions)}`);
    const verdict = c.completionP < 0.05 || c.tokensP < 0.05
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
