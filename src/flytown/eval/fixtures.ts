/**
 * Evaluation task suite. Tasks reference real repositories on this machine
 * (per the user's preference) so repo signals are realistic; a fixture whose
 * repository is absent is still runnable in mock mode with an empty-repo
 * signal, and is flagged as such in results.
 *
 * Categories follow the proposal (Section 18). `expected` encodes what a
 * good planner *should* do at the termination level — the harness scores
 * termination quality against it. `traps` describe adversarial structure the
 * mock worker uses to punish naive plans (e.g. implementing before
 * investigating a misleading hypothesis).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";

export type FixtureCategory =
  | "repo_question" | "small_bug_fix" | "ambiguous_failure" | "misleading_hypothesis"
  | "multi_file_impl" | "security_sensitive" | "research_synthesis" | "needs_runtime_check"
  | "genuinely_blocked" | "stop_early";

export type ExpectedTermination = "complete" | "blocked" | "approval" | "stop_early";

export interface Fixture {
  id: string;
  category: FixtureCategory;
  task: string;
  repo: string;
  expected: ExpectedTermination;
  /** Mock-world difficulty knobs. */
  traps: {
    /** Success needs an investigation-type node before the main node. */
    needsInvestigation?: boolean;
    /** Success needs a verification node (run_tests/run_tool). */
    needsVerification?: boolean;
    /** Success needs a reviewer node (security etc). */
    needsReview?: boolean;
    /** Base per-node failure probability in the mock world. */
    baseFailure?: number;
    /** The first attempt on the main node always fails (misleading hypothesis). */
    firstMainAttemptFails?: boolean;
  };
  extra?: { testFailures?: number; runtimeErrors?: number; compileErrors?: number; approvalsPending?: number; pressure?: number; priorAttempts?: number; priorOutcome?: "success" | "failure" };
  priorArtifacts?: number;
}

const H = homedir();
const R = {
  blockmmo: join(H, "blockmmo"),
  flurry: join(H, "flurry"),
  sherwood: join(H, "goblintown-work", "goblintown-chatgpt-app"),
  flytown: join(H, "flytown"),
};

export const FIXTURES: Fixture[] = [
  // straightforward repository questions
  { id: "q-engine-layout", category: "repo_question", repo: R.blockmmo, expected: "complete",
    task: "Where is the game loop implemented in this repository and which module owns entity ticking? Explain the call path in a few sentences.",
    traps: { baseFailure: 0.05 } },
  { id: "q-workspace-packages", category: "repo_question", repo: R.flurry, expected: "complete",
    task: "List the packages in this pnpm workspace and describe what each one is responsible for.",
    traps: { baseFailure: 0.05 } },
  // small bug fixes
  { id: "fix-null-guard", category: "small_bug_fix", repo: R.blockmmo, expected: "complete",
    task: "Fix the crash when a player disconnects mid-tick: add the missing null guard in the entity update path and add a regression test.",
    traps: { needsVerification: true, baseFailure: 0.15 }, extra: { runtimeErrors: 1 } },
  { id: "fix-off-by-one", category: "small_bug_fix", repo: R.flytown, expected: "complete",
    task: "Fix the off-by-one in topologicalOrder that drops the last node when the plan has a single edge, and update planner.test.ts.",
    traps: { needsVerification: true, baseFailure: 0.15 }, extra: { testFailures: 1 } },
  // ambiguous failures requiring investigation
  { id: "flaky-ci", category: "ambiguous_failure", repo: R.flurry, expected: "complete",
    task: "CI fails intermittently on the contracts package with a timeout. Not sure if it's the test runner, the RPC mock, or a real race. Figure out what is going on and propose a fix.",
    traps: { needsInvestigation: true, baseFailure: 0.2 }, extra: { testFailures: 2 } },
  { id: "deploy-500s", category: "ambiguous_failure", repo: R.sherwood, expected: "complete",
    task: "The deployed app sometimes returns 500s after a cold start. Diagnose the likely cause from the repository and deployment config and recommend the smallest change.",
    traps: { needsInvestigation: true, baseFailure: 0.2 }, extra: { runtimeErrors: 2 } },
  // misleading initial hypotheses
  { id: "misleading-cache", category: "misleading_hypothesis", repo: R.flurry, expected: "complete",
    task: "Users report stale balances. It's clearly the cache TTL — I bet it's set too high. Bump it down and ship. (Investigate first if you must.)",
    traps: { needsInvestigation: true, firstMainAttemptFails: true, baseFailure: 0.15 } },
  { id: "misleading-race", category: "misleading_hypothesis", repo: R.blockmmo, expected: "complete",
    task: "Players occasionally duplicate items. Probably a race in the inventory handler — just add a mutex there.",
    traps: { needsInvestigation: true, firstMainAttemptFails: true, baseFailure: 0.15 } },
  // multi-file implementation
  { id: "impl-rate-limit", category: "multi_file_impl", repo: R.flurry, expected: "complete",
    task: "Implement per-user rate limiting for the API: add a middleware, a config option, wire it into the server, document it in the README, and add tests.",
    traps: { needsVerification: true, baseFailure: 0.25 } },
  { id: "impl-replay-cli", category: "multi_file_impl", repo: R.flytown, expected: "complete",
    task: "Add a `fly replay <runId>` CLI command that re-runs a stored decision trace deterministically and diffs the resulting plan against the stored one. Update docs and tests.",
    traps: { needsVerification: true, baseFailure: 0.25 } },
  // security-sensitive
  { id: "sec-token-storage", category: "security_sensitive", repo: R.flurry, expected: "approval",
    task: "Change how API tokens are stored: move them from plaintext JSON to the OS keychain. This touches auth and secret handling — confirm with me before making changes.",
    traps: { needsReview: true, baseFailure: 0.2 } },
  { id: "sec-input-sanitize", category: "security_sensitive", repo: R.blockmmo, expected: "complete",
    task: "Harden chat message handling against injection: sanitize user input before it reaches the command parser and add tests for the XSS and SQL cases.",
    traps: { needsReview: true, needsVerification: true, baseFailure: 0.2 } },
  // research synthesis
  { id: "research-orm", category: "research_synthesis", repo: R.flurry, expected: "complete",
    task: "Research and compare three options for replacing the hand-rolled SQL layer with an ORM, summarize trade-offs for this codebase, and recommend one.",
    traps: { baseFailure: 0.1 } },
  { id: "research-connectome-sim", category: "research_synthesis", repo: R.flytown, expected: "complete",
    task: "Survey the literature on rate-based versus spiking simulation of the Drosophila connectome and summarize which approach is defensible for a control-plane prototype.",
    traps: { baseFailure: 0.1 } },
  // needs runtime / tool check
  { id: "verify-build", category: "needs_runtime_check", repo: R.flytown, expected: "complete",
    task: "Verify that the project builds and all tests pass after the latest changes; report any failures with the exact command output.",
    traps: { needsVerification: true, baseFailure: 0.1 } },
  { id: "verify-deploy-config", category: "needs_runtime_check", repo: R.sherwood, expected: "complete",
    task: "Check whether the deployment configuration in this repository is consistent with the environment variables the app actually reads at runtime.",
    traps: { needsVerification: true, baseFailure: 0.1 } },
  // genuinely blocked
  { id: "blocked-credentials", category: "genuinely_blocked", repo: R.sherwood, expected: "blocked",
    task: "Rotate the production database credentials and redeploy. We have no access to the production secrets from here — this is blocked on ops giving us the vault token.",
    traps: { baseFailure: 0.9 }, extra: { approvalsPending: 1 } },
  { id: "blocked-repeated", category: "genuinely_blocked", repo: R.blockmmo, expected: "blocked",
    task: "Make the physics deterministic across platforms.",
    traps: { baseFailure: 0.95 }, extra: { priorAttempts: 2, priorOutcome: "failure" } },
  // stopping early is correct
  { id: "stop-already-done", category: "stop_early", repo: R.flytown, expected: "stop_early",
    task: "Only if trivial: confirm the README already documents the fork provenance; stop early if it does — don't rewrite anything.",
    traps: { baseFailure: 0.05 }, priorArtifacts: 1 },
  { id: "stop-no-op", category: "stop_early", repo: R.flurry, expected: "stop_early",
    task: "If the lockfile is already consistent with package.json, stop early and say so; do not continue with any changes.",
    traps: { baseFailure: 0.05 }, priorArtifacts: 1 },
];

export async function fixtureAvailability(fixtures = FIXTURES): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const f of fixtures) {
    try { out[f.id] = (await stat(f.repo)).isDirectory(); } catch { out[f.id] = false; }
  }
  return out;
}

export function fixturesByCategory(fixtures = FIXTURES): Record<FixtureCategory, Fixture[]> {
  const out = {} as Record<FixtureCategory, Fixture[]>;
  for (const f of fixtures) (out[f.category] ??= []).push(f);
  return out;
}
