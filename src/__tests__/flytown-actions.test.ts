import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { compilePlan, decide, normalizeScores, ORCH_ACTIONS, zeroScores } from "../flytown/actions.js";
import { validatePlan, topologicalOrder } from "../planner.js";
import type { TaskSignals } from "../flytown/signals.js";

function sig(over: Partial<TaskSignals> = {}): TaskSignals {
  return {
    task: "Fix the bug", taskLength: 11, deliverable: "code_change", keywords: ["fix", "bug"], complexity: 0.2, uncertainty: 0,
    securitySensitive: false, constraints: [], repo: { present: true, fileCount: 10, languages: {}, hasTests: true, hasPackageManifest: true, frameworks: [], truncated: false },
    failures: { testFailures: 0, runtimeErrors: 0, compileErrors: 0 }, pressure: 0, conflictingHypotheses: 0,
    history: { attempts: 0, replanDepth: 0 }, toolsAvailable: [], approvalsPending: 0, priorArtifacts: 0,
    cues: { mentionsBlocked: false, asksToStop: false, asksForApproval: false, misleadingHint: false },
    ...over,
  };
}

describe("normalizeScores", () => {
  it("normalises to a distribution and treats invalid values as zero", () => {
    const s = normalizeScores({ spawn_flight: 2, retry_new_approach: NaN, run_tests: -1, invoke_reviewer: 2 });
    assert.equal(s.spawn_flight, 0.5);
    assert.equal(s.invoke_reviewer, 0.5);
    assert.equal(s.retry_new_approach, 0);
    assert.equal(s.run_tests, 0);
  });
  it("falls back to uniform when everything is zero", () => {
    const s = normalizeScores(zeroScores());
    for (const a of ORCH_ACTIONS) assert.ok(Math.abs(s[a] - 1 / ORCH_ACTIONS.length) < 1e-12);
  });
});

describe("decide", () => {
  it("picks the argmax as primary and includes actions above the ratio", () => {
    const s = normalizeScores({ spawn_flight: 1, run_tests: 0.6, invoke_reviewer: 0.2 });
    const d = decide(s, sig());
    assert.equal(d.primary, "spawn_flight");
    assert.deepEqual(d.included, ["run_tests"]);
  });
  it("shrinks swarm size under pressure and grows it for increase_swarm_size", () => {
    const grow = decide(normalizeScores({ increase_swarm_size: 1 }), sig());
    assert.equal(grow.swarmSize, 5);
    const tight = decide(normalizeScores({ spawn_flight: 1 }), sig({ pressure: 0.8 }));
    assert.equal(tight.swarmSize, 1);
  });
  it("rotates personality on retry after a failed attempt", () => {
    const first = decide(normalizeScores({ spawn_flight: 1 }), sig());
    const retry = decide(normalizeScores({ retry_new_approach: 1 }), sig({ history: { attempts: 1, replanDepth: 1, lastOutcome: "failure", failureReason: "x" } }));
    assert.notEqual(first.personality, retry.personality);
  });
});

describe("compilePlan", () => {
  it("halts for terminate_blocked / approval / success without nodes", () => {
    for (const [action, kind] of [["terminate_blocked", "blocked"], ["request_human_approval", "approval"], ["terminate_success", "success"]] as const) {
      const p = compilePlan(decide(normalizeScores({ [action]: 1 }), sig()), sig(), { plannerId: "t", planIdSeed: "abc" });
      assert.equal(p.halt?.kind, kind);
      assert.equal(p.nodes.length, 0);
    }
  });
  it("builds investigate → main → verify → review → synthesize for a rich decision", () => {
    const s = normalizeScores({ spawn_flight: 1, request_artifact_investigation: 0.9, run_tests: 0.8, invoke_reviewer: 0.7 });
    const p = compilePlan(decide(s, sig()), sig(), { plannerId: "t", planIdSeed: "abc" });
    assert.deepEqual(p.nodes.map((n) => n.id), ["investigate", "main", "verify", "review", "synthesize"]);
    assert.deepEqual(p.nodes.map((n) => n.hints?.action), ["request_artifact_investigation", "spawn_flight", "run_tests", "invoke_reviewer", "merge_results"]);
    assert.equal(p.nodes.find((n) => n.id === "verify")?.hints?.guardTools, true);
    assert.equal(p.nodes.at(-1)?.kind, "synthesize");
    assert.ok(validatePlan(p).ok);
    assert.deepEqual(topologicalOrder(p).map((n) => n.id), ["investigate", "main", "verify", "review", "synthesize"]);
  });
  it("respects maxNodes", () => {
    const s = normalizeScores({ spawn_flight: 1, request_artifact_investigation: 0.9, run_tests: 0.8, invoke_reviewer: 0.7 });
    const p = compilePlan(decide(s, sig()), sig(), { plannerId: "t", maxNodes: 2, planIdSeed: "abc" });
    assert.ok(p.nodes.length <= 2);
    assert.ok(validatePlan(p).ok);
  });
  it("produces a single node plan for a plain spawn decision", () => {
    const p = compilePlan(decide(normalizeScores({ spawn_flight: 1 }), sig()), sig(), { plannerId: "t", planIdSeed: "abc" });
    assert.equal(p.nodes.length, 1);
    assert.equal(p.nodes[0].kind, "flight");
    assert.equal(p.halt, undefined);
  });
  it("is deterministic given a planIdSeed", () => {
    const s = normalizeScores({ spawn_flight: 1, surface_uncertainty: 0.8 });
    const a = compilePlan(decide(s, sig()), sig(), { plannerId: "t", planIdSeed: "same" });
    const b = compilePlan(decide(s, sig()), sig(), { plannerId: "t", planIdSeed: "same" });
    assert.equal(a.id, b.id);
    assert.deepEqual(a.nodes.map((n) => [n.id, n.task, n.swarmSize, n.personality, n.hints]), b.nodes.map((n) => [n.id, n.task, n.swarmSize, n.personality, n.hints]));
    assert.equal(a.nodes[0].hints?.debate, true);
  });
  it("rewrites the main task on retry with the failure reason", () => {
    const s = normalizeScores({ retry_new_approach: 1, spawn_flight: 0.9 });
    const p = compilePlan(decide(s, sig({ history: { attempts: 1, replanDepth: 1, lastOutcome: "failure", failureReason: "soldier fell over" } })), sig({ history: { attempts: 1, replanDepth: 1, lastOutcome: "failure", failureReason: "soldier fell over" } }), { plannerId: "t", planIdSeed: "x" });
    assert.ok(p.nodes[0].task.includes("soldier fell over"));
    assert.ok(p.nodes[0].task.includes("materially different approach"));
  });
});
