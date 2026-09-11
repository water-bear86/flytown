import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan } from "../plan-executor.js";
import { Hoard } from "../hoard.js";
import type { Plan } from "../types.js";
import { withFallback, type PlannerBackend } from "../flytown/planner-backend.js";
import { rulesPlannerBackend } from "../flytown/baselines/rules.js";
import { randomPlannerBackend } from "../flytown/baselines/random.js";
import { learnedPlannerBackend, trainLinearRouter, linearScores, uniformWeights } from "../flytown/baselines/learned.js";
import { FlyPlannerBackend } from "../flytown/fly-planner.js";
import { makeGraph } from "../flytown/connectome/artifact.js";
import { DEFAULT_ENGINE_PARAMS } from "../flytown/connectome/engine.js";
import { resolvePlannerBackend, parsePlannerSpec } from "../flytown/registry.js";
import { makeMockRiteRunner } from "../flytown/eval/mock-rite.js";
import { FIXTURES } from "../flytown/eval/fixtures.js";
import { readTrace, writeTrace } from "../flytown/trace.js";
import { replayTrace, diffPlans } from "../flytown/cli.js";
import { FEATURE_NAMES } from "../flytown/signals.js";

/** Synthetic mini-projectome with real FlyWire region names so the default adapters bind. */
export function miniBrain() {
  const nodes = ["AL_L", "AL_R", "LH_L", "LH_R", "MB_CA_L", "MB_CA_R", "MB_ML_L", "MB_VL_L", "EB", "FB", "PB", "LAL_L", "LAL_R", "SMP_L", "SLP_L", "GNG", "SAD", "AMMC_L", "PRW", "ME_L", "LO_L", "WED_L", "SPS_L"];
  const ix = (id: string) => nodes.indexOf(id);
  const edges: [number, number, number][] = [];
  const nt: Record<string, number[]> = { ACH: [], GABA: [], GLUT: [] };
  const add = (a: string, b: string, w: number, cls: "ACH" | "GABA" | "GLUT" = "ACH") => {
    edges.push([ix(a), ix(b), w]);
    for (const k of Object.keys(nt)) nt[k].push(k === cls ? w : 0);
  };
  add("AL_L", "MB_CA_L", 900); add("AL_L", "LH_L", 700); add("AL_R", "MB_CA_R", 900); add("AL_R", "LH_R", 700);
  add("MB_CA_L", "MB_ML_L", 500); add("MB_CA_L", "MB_VL_L", 500); add("MB_ML_L", "LAL_L", 200); add("MB_VL_L", "FB", 200);
  add("LH_L", "LAL_L", 300); add("LH_L", "SLP_L", 300); add("LH_R", "LAL_R", 300);
  add("ME_L", "LO_L", 800); add("LO_L", "WED_L", 300); add("LO_L", "SLP_L", 200);
  add("AMMC_L", "WED_L", 400); add("AMMC_L", "SAD", 400); add("SAD", "GNG", 400); add("GNG", "SPS_L", 300); add("PRW", "GNG", 300); add("PRW", "SMP_L", 200);
  add("EB", "PB", 400); add("PB", "FB", 400); add("FB", "LAL_L", 300); add("FB", "LAL_R", 300); add("EB", "LAL_L", 150, "GABA");
  add("SMP_L", "FB", 250); add("SLP_L", "SMP_L", 200); add("LAL_L", "SPS_L", 300); add("LAL_R", "SPS_L", 300); add("SPS_L", "GNG", 150, "GLUT");
  add("GNG", "PRW", 100, "GABA"); add("FB", "EB", 120, "GABA");
  return makeGraph({ id: "mini-brain-1", nodes, edges, nt });
}

async function tmpHoard() {
  const dir = await mkdtemp(join(tmpdir(), "flytown-plan-"));
  const hoard = new Hoard(join(dir, "hoard"));
  await hoard.init();
  return { dir, hoard };
}

describe("executePlan seam", () => {
  it("honours a halted plan without running any rite", async () => {
    const { dir, hoard } = await tmpHoard();
    const plan: Plan = { id: "p", rootTask: "t", nodes: [], edges: [], replanDepth: 0, createdAt: 0, halt: { kind: "blocked", reason: "no access" } };
    let rites = 0;
    const events: string[] = [];
    const res = await executePlan({ plan, cwd: dir, hoard, riteRunner: async () => { rites++; throw new Error("should not run"); }, onPlanEvent: (e) => events.push(e.kind) });
    assert.equal(res.outcome, "halted");
    assert.equal(res.halt?.kind, "blocked");
    assert.equal(rites, 0);
    assert.deepEqual(events, ["plan:start", "plan:halt", "plan:done"]);
  });
  it("replans through the injected planner backend and counts replans", async () => {
    const { dir, hoard } = await tmpHoard();
    const fixture = FIXTURES.find((f) => f.id === "misleading-cache")!;
    const runner = makeMockRiteRunner({ fixture, seed: 1 });
    const calls: number[] = [];
    const planner: PlannerBackend = {
      id: "stub",
      plan: async (req) => {
        calls.push(req.replanDepth ?? 0);
        return { plan: { id: `p${req.replanDepth}`, rootTask: req.task, replanDepth: req.replanDepth ?? 0, createdAt: 0, edges: [{ from: "investigate", to: "main" }], nodes: [
          { id: "investigate", task: "look", inputs: [], kind: "sub_rite", status: "pending", packSize: 2, hints: { action: "request_artifact_investigation" } },
          { id: "main", task: "do", inputs: ["investigate"], kind: "sub_rite", status: "pending", packSize: 3, hints: { action: "spawn_subrite" } },
        ] } };
      },
    };
    const first: Plan = { id: "p-first", rootTask: fixture.task, nodes: [{ id: "main", task: "do", inputs: [], kind: "sub_rite", status: "pending", packSize: 3, hints: { action: "spawn_subrite" } }], edges: [], replanDepth: 0, createdAt: 0 };
    const res = await executePlan({ plan: first, cwd: fixture.repo, hoard, planner, riteRunner: runner, maxReplanDepth: 2 });
    assert.ok(res.replans >= 1, "the misleading fixture forces at least one replan");
    assert.deepEqual(calls.slice(0, 1), [1]);
    assert.ok(["success", "failed"].includes(res.outcome));
  });
});

describe("baseline backends", () => {
  it("rules: halts on blocked, approval and stop-early fixtures; plans otherwise", async () => {
    const rules = rulesPlannerBackend();
    const expect = async (id: string, kind: string | undefined) => {
      const f = FIXTURES.find((x) => x.id === id)!;
      const prior = Array.from({ length: f.priorArtifacts ?? 0 }, (_, i) => ({ id: `a${i}`, riteId: "r", task: "t", outcome: "winner" as const, claims: [], evidence: [], openQuestions: [], nextSteps: [], parentArtifactIds: [], keywords: [], timestamp: 0 }));
      const { plan, trace } = await rules.plan({ task: f.task, cwd: f.repo, extraSignals: f.extra, parentArtifacts: prior, runId: `t-${id}`, repo: { present: true, fileCount: 100, languages: {}, hasTests: true, hasPackageManifest: true, frameworks: [], truncated: false } });
      assert.equal(plan.halt?.kind, kind, `${id}: expected halt ${kind}, got ${plan.halt?.kind} (primary ${trace?.decision.primary})`);
      assert.ok(trace, "rules emits a trace");
      assert.equal(trace!.request.task, f.task);
    };
    await expect("blocked-credentials", "blocked");
    await expect("blocked-repeated", "blocked");
    await expect("sec-token-storage", "approval");
    await expect("stop-already-done", "success");
    await expect("flaky-ci", undefined);
    await expect("impl-rate-limit", undefined);
  });
  it("random: identical seed + runId → identical plan; different seed → may differ", async () => {
    const a = randomPlannerBackend({ seed: 3 }), b = randomPlannerBackend({ seed: 3 }), c = randomPlannerBackend({ seed: 4 });
    const req = { task: "Fix the flaky test in the runner", cwd: "/nope", runId: "r1" };
    const [pa, pb, pc] = await Promise.all([a.plan(req), b.plan(req), c.plan(req)]);
    assert.deepEqual(pa.trace!.actionScores, pb.trace!.actionScores);
    assert.notDeepEqual(pa.trace!.actionScores, pc.trace!.actionScores);
  });
  it("learned: untrained is uniform, training moves probability toward rewarded actions", async () => {
    const x = new Float64Array(FEATURE_NAMES.length); x[FEATURE_NAMES.indexOf("cue_blocked")] = 1;
    const before = linearScores(uniformWeights(), x);
    assert.ok(Math.abs(before.terminate_blocked - before.spawn_subrite) < 1e-9);
    const w = trainLinearRouter([{ features: Array.from(x), action: "terminate_blocked", reward: 1 }, { features: Array.from(x), action: "spawn_subrite", reward: -1 }], { epochs: 50 });
    const after = linearScores(w, x);
    assert.ok(after.terminate_blocked > after.spawn_subrite * 2);
    const backend = learnedPlannerBackend({ weights: w });
    const res = await backend.plan({ task: "We are blocked on access to the vault", cwd: "/nope", runId: "l1" });
    assert.equal(res.plan.halt?.kind, "blocked");
  });
});

describe("fly planner", () => {
  it("plans end-to-end on a synthetic brain, emits a brain trace, and replays identically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flytown-fly-"));
    const fly = new FlyPlannerBackend({ connectomeId: "mini-brain-1", graph: miniBrain() });
    const f = FIXTURES.find((x) => x.id === "flaky-ci")!;
    const repo = { present: true, fileCount: 250, languages: { ts: 100 }, hasTests: true, hasPackageManifest: true, frameworks: ["typescript"], truncated: false };
    const res = await fly.plan({ task: f.task, cwd: f.repo, repo, extraSignals: f.extra, runId: "fly-1", maxNodes: 6 });
    assert.ok(res.trace?.brain, "brain trace present");
    const b = res.trace!.brain!;
    assert.equal(b.connectomeId, "mini-brain-1");
    assert.equal(b.variant, "real");
    assert.equal(b.steps.length, DEFAULT_ENGINE_PARAMS.steps);
    assert.ok(b.stats.activeRegions > 3, "activity spread beyond the input regions");
    assert.ok(b.input.AL_L > 0, "task drives the antennal lobe");
    assert.ok(Object.values(b.readoutContributions).some((c) => c.length > 0));
    assert.equal(res.trace!.provenance["connectome.topology"], "MEASURED");
    assert.equal(res.trace!.provenance["adapters.readout"], "METAPHOR");
    await writeTrace(dir, res.trace!);
    const stored = await readTrace(dir, "fly-1");
    assert.ok(stored);
    const fly2 = new FlyPlannerBackend({ connectomeId: "mini-brain-1", graph: miniBrain() });
    const again = await fly2.plan({ task: f.task, cwd: f.repo, repo, extraSignals: f.extra, runId: "fly-1", maxNodes: 6 });
    assert.deepEqual(diffPlans(stored!, again.plan, again.trace), []);
  });
  it("shuffled and ablated variants change the decision inputs but stay valid", async () => {
    const graph = miniBrain();
    const repo = { present: true, fileCount: 250, languages: {}, hasTests: true, hasPackageManifest: true, frameworks: [], truncated: false };
    const req = { task: "CI fails intermittently on the contracts package. Not sure if it's the runner or a real race. Figure out what is going on.", cwd: "/nope", repo, runId: "v1", extraSignals: { testFailures: 2 } };
    const real = await new FlyPlannerBackend({ connectomeId: "m", graph }).plan(req);
    const shuffled = await new FlyPlannerBackend({ connectomeId: "m", graph, variant: "shuffled", variantSeed: 5 }).plan(req);
    const ablated = await new FlyPlannerBackend({ connectomeId: "m", graph, ablateRegions: ["MB_CA", "EB"] }).plan(req);
    const norec = await new FlyPlannerBackend({ connectomeId: "m", graph, engine: { recurrence: false } }).plan(req);
    assert.equal(shuffled.trace!.brain!.variant, "shuffled");
    assert.deepEqual(ablated.trace!.brain!.ablatedRegions, ["EB", "MB_CA"]);
    assert.equal(norec.trace!.brain!.recurrence, false);
    assert.equal(norec.plan.plannerId, "fly:norecurrence");
    assert.equal(shuffled.plan.plannerId, "fly:shuffled");
    const finalReal = real.trace!.brain!.steps.at(-1)!.activity, finalShuf = shuffled.trace!.brain!.steps.at(-1)!.activity;
    assert.notDeepEqual(finalReal, finalShuf, "shuffling labels changes where activity lands");
    for (const r of [real, shuffled, ablated, norec]) assert.ok(r.plan.halt || r.plan.nodes.length > 0);
  });
  it("learning updates adapters only when enabled and persists versioned weights", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flytown-learn-"));
    const off = new FlyPlannerBackend({ connectomeId: "m", graph: miniBrain() });
    const res = await off.plan({ task: "Fix the bug", cwd: "/nope", runId: "x" });
    assert.equal(await off.learn(res.trace!, 1), null);
    const on = new FlyPlannerBackend({ connectomeId: "m", graph: miniBrain(), learning: true, weightsDir: dir });
    const r2 = await on.plan({ task: "Fix the bug", cwd: "/nope", runId: "y" });
    const w = await on.learn(r2.trace!, 1);
    assert.ok(w && w.adapters?.learning?.updates === 1);
    assert.deepEqual(r2.trace!.learning?.applied, [`readout.${r2.trace!.decision.primary}`]);
  });
  it("withFallback delegates to the LLM planner id when the primary throws", async () => {
    const broken: PlannerBackend = { id: "fly", plan: async () => { throw new Error("no artifact"); } };
    const stub: PlannerBackend = { id: "llm", plan: async (req) => ({ plan: { id: "s", rootTask: req.task, nodes: [], edges: [], replanDepth: 0, createdAt: 0, halt: { kind: "success", reason: "stub" } } }) };
    const errs: unknown[] = [];
    const res = await withFallback(broken, stub, (e) => errs.push(e)).plan({ task: "t", cwd: "/nope" });
    assert.equal(errs.length, 1);
    assert.equal(res.plan.plannerId, "llm(fallback-from:fly)");
  });
});

describe("registry", () => {
  it("parses specs and resolves every known backend", () => {
    assert.deepEqual(parsePlannerSpec("fly:shuffled+norecurrence+ablate=MB_CA,EB"), { kind: "fly", flags: { shuffled: true, norecurrence: true, ablate: "MB_CA,EB" } });
    const root = "/tmp/flytown-registry";
    for (const spec of ["llm", "rules", "random", "learned", "fly", "fly:shuffled", "fly:random_degree", "fly:signless", "fly:norecurrence", "fly:ablate=MB_CA"]) {
      const b = resolvePlannerBackend(spec, { root, graph: miniBrain(), fallback: false });
      assert.ok(b.id.length > 0, spec);
    }
    assert.throws(() => resolvePlannerBackend("nope", { root }));
    assert.equal(resolvePlannerBackend("fly:ablate=MB_CA,EB", { root, graph: miniBrain(), fallback: false }).id, "fly:ablate=MB_CA+EB");
  });
  it("replayTrace reproduces a stored rules decision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flytown-replay-"));
    const rules = rulesPlannerBackend();
    const f = FIXTURES.find((x) => x.id === "sec-input-sanitize")!;
    const res = await rules.plan({ task: f.task, cwd: f.repo, runId: "rp", extraSignals: f.extra, repo: { present: true, fileCount: 40, languages: {}, hasTests: true, hasPackageManifest: false, frameworks: [], truncated: false } });
    await writeTrace(dir, res.trace!);
    const stored = (await readTrace(dir, "rp"))!;
    const again = await replayTrace(dir, stored);
    assert.deepEqual(diffPlans(stored, again.plan, again.trace), []);
  });
});
