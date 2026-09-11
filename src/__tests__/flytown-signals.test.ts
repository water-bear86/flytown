import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDeliverable, detectCues, deriveSignals, FEATURE_NAMES, featurize, scanRepo, estimateComplexity, estimateUncertainty, detectSecuritySensitivity } from "../flytown/signals.js";

describe("classifyDeliverable", () => {
  it("recognises the main deliverable kinds", () => {
    assert.equal(classifyDeliverable("Where is the game loop implemented?"), "answer");
    assert.equal(classifyDeliverable("Fix the crash when a player disconnects"), "code_change");
    assert.equal(classifyDeliverable("CI fails intermittently, figure out why"), "investigation");
    assert.equal(classifyDeliverable("Research and compare three ORM options"), "research");
    assert.equal(classifyDeliverable("Verify that the project builds and tests pass"), "verification");
  });
});

describe("cues and heuristics", () => {
  it("detects blocked / stop / approval / misleading cues", () => {
    assert.equal(detectCues("this is blocked on ops giving us the vault token").mentionsBlocked, true);
    assert.equal(detectCues("stop early if it already works").asksToStop, true);
    assert.equal(detectCues("confirm with me before making changes").asksForApproval, true);
    assert.equal(detectCues("It's clearly the cache TTL").misleadingHint, true);
    const none = detectCues("Add a README section");
    assert.deepEqual(none, { mentionsBlocked: false, asksToStop: false, asksForApproval: false, misleadingHint: false });
  });
  it("scores complexity, uncertainty and security sensitivity in [0,1]", () => {
    const c = estimateComplexity("Implement a middleware, a config option, wire it into the server, document it, and add tests. Also update foo.ts and bar.ts");
    assert.ok(c > 0.2 && c <= 1);
    assert.ok(estimateComplexity("hi") < 0.05);
    assert.ok(estimateUncertainty("Not sure if it's the runner or the mock? Maybe a race?") > 0.4);
    assert.equal(estimateUncertainty("Rename foo to bar"), 0);
    assert.equal(detectSecuritySensitivity("move API tokens to the keychain"), true);
    assert.equal(detectSecuritySensitivity("rename a variable"), false);
  });
});

describe("scanRepo + deriveSignals + featurize", () => {
  it("scans a temp repository and produces a fixed-length feature vector", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flytown-sig-"));
    await mkdir(join(dir, "src", "__tests__"), { recursive: true });
    await mkdir(join(dir, "node_modules", "junk"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "tsconfig.json"), "{}");
    await writeFile(join(dir, "src", "a.ts"), "");
    await writeFile(join(dir, "src", "__tests__", "a.test.ts"), "");
    await writeFile(join(dir, "node_modules", "junk", "x.js"), "");
    const repo = await scanRepo(dir);
    assert.equal(repo.present, true);
    assert.equal(repo.fileCount, 4);
    assert.equal(repo.hasTests, true);
    assert.equal(repo.hasPackageManifest, true);
    assert.ok(repo.frameworks.includes("typescript"));
    assert.equal(repo.languages.ts, 2);

    const s = await deriveSignals({ task: "Fix the failing test in src/a.ts", cwd: dir, extra: { testFailures: 2 }, replanDepth: 1, failureContext: { failedNodeId: "main", reason: "boom", partialPlan: { id: "p", rootTask: "t", nodes: [], edges: [], replanDepth: 0, createdAt: 0 } } });
    assert.equal(s.deliverable, "code_change");
    assert.equal(s.failures.testFailures, 2);
    assert.equal(s.history.replanDepth, 1);
    assert.equal(s.history.lastOutcome, "failure");
    const x = featurize(s);
    assert.equal(x.length, FEATURE_NAMES.length);
    for (const v of x) assert.ok(v >= 0 && v <= 1);
    assert.equal(x[FEATURE_NAMES.indexOf("deliv_code_change")], 1);
    assert.equal(x[FEATURE_NAMES.indexOf("prior_failure")], 1);
    assert.equal(x[FEATURE_NAMES.indexOf("repo_has_tests")], 1);
  });
  it("degrades gracefully when the repo is missing", async () => {
    const s = await deriveSignals({ task: "What is this?", cwd: "/definitely/not/a/real/path/xyz" });
    assert.equal(s.repo.present, false);
    assert.equal(s.repo.fileCount, 0);
  });
});
