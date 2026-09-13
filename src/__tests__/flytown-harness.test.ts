import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHarness, pairedPermutation, jsDivergence, terminationOk } from "../flytown/eval/harness.js";
import { FIXTURES } from "../flytown/eval/fixtures.js";
import { miniBrain } from "./flytown-planner.test.js";

describe("harness statistics", () => {
  it("paired permutation: all-zero differences → p = 1; large consistent differences → small p", () => {
    assert.equal(pairedPermutation([0, 0, 0, 0]).p, 1);
    const strong = pairedPermutation(Array.from({ length: 30 }, () => 1));
    assert.ok(strong.p < 0.01, `p=${strong.p}`);
    assert.equal(strong.diff, 1);
  });
  it("JS divergence is 0 for identical distributions and positive otherwise", () => {
    assert.equal(jsDivergence({ a: 0.5, b: 0.5 }, { a: 0.5, b: 0.5 }), 0);
    assert.ok(jsDivergence({ a: 1 }, { b: 1 }) > 0.99);
  });
  it("termination scoring matches the fixture contract", () => {
    assert.equal(terminationOk("complete", "success"), true);
    assert.equal(terminationOk("complete", "halted", "success"), false);
    assert.equal(terminationOk("blocked", "halted", "blocked"), true);
    assert.equal(terminationOk("stop_early", "halted", "success"), true);
    assert.equal(terminationOk("approval", "halted", "blocked"), false);
  });
});

describe("runHarness (mock world)", () => {
  it("runs matched trials for several planners, writes a report, and is deterministic", async () => {
    const root = await mkdtemp(join(tmpdir(), "flytown-harness-"));
    const fixtures = FIXTURES.filter((f) => ["q-engine-layout", "flaky-contract-tests", "misleading-stale-balances", "blocked-prod-secrets", "stop-already-done"].includes(f.id));
    const opts = { planners: ["rules", "random", "fly", "fly:shuffled"], fixtures, seeds: [1, 2], root, resolve: { graph: miniBrain() }, compare: ["fly", "fly:shuffled"] as [string, string] };
    const a = await runHarness(opts);
    assert.equal(a.runs.length, 4 * fixtures.length * 2);
    assert.equal(a.summaries.length, 4);
    for (const s of a.summaries) {
      assert.equal(s.errorRate, 0, `${s.planner} had errors: ${JSON.stringify(a.runs.filter((r) => r.planner === s.planner && r.error).map((r) => r.error))}`);
      assert.ok(s.terminationAccuracy >= 0 && s.terminationAccuracy <= 1);
    }
    assert.ok(a.comparison);
    assert.ok(a.comparison!.completionP > 0 && a.comparison!.completionP <= 1);
    const md = await readFile(join(a.outDir, "report.md"), "utf8");
    assert.ok(md.includes("# FLYTOWN evaluation report"));
    assert.ok(md.includes("fly vs fly:shuffled"));
    const rules = a.summaries.find((s) => s.planner === "rules")!;
    assert.ok(rules.terminationAccuracy >= 0.6, `rules baseline should handle the obvious cases (got ${rules.terminationAccuracy})`);

    const b = await runHarness({ ...opts, root: await mkdtemp(join(tmpdir(), "flytown-harness-")) });
    const strip = (r: typeof a) => r.runs.map((x) => [x.planner, x.fixtureId, x.seed, x.outcome, x.haltKind, x.nodes, x.tokens, x.primary, x.included.join()]);
    assert.deepEqual(strip(b), strip(a), "same seeds → identical outcomes");
  });
});
