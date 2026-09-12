/**
 * Task corpus for the hashing and memory experiments.
 *
 * These are short, authored task strings — eight per category over the same
 * ten categories as the fixture suite. They exist so the locality-sensitive
 * hash test has enough pairs to mean anything (80 tasks → 3,160 pairs, 280 of
 * them same-category) and so memory experiments can train on some tasks and
 * be tested on held-out tasks of the same kind.
 *
 * Honesty note: the corpus is authored by us, so "same category ⇒ similar
 * task" is true by construction. That makes the corpus useless for absolute
 * claims and fine for the comparison it is used for — real wiring versus
 * shuffled and rewired copies of the same graph, scored by the identical
 * procedure. `variant` marks which half of each category is used for training
 * and which is held out, so memory generalisation is measured across tasks
 * the memory never saw.
 */
import type { FixtureCategory } from "./fixtures.js";

export interface CorpusTask {
  id: string;
  category: FixtureCategory;
  task: string;
  /** "a" = training half, "b" = held-out half */
  variant: "a" | "b";
}

function group(category: FixtureCategory, tasks: string[]): CorpusTask[] {
  return tasks.map((task, i) => ({ id: `${category}-${i + 1}`, category, task, variant: i % 2 === 0 ? "a" : "b" }));
}

export const TASK_CORPUS: CorpusTask[] = [
  ...group("repo_question", [
    "Where is the game loop implemented in this repository and which module owns entity ticking?",
    "Which module owns the WebSocket relay and how do messages reach the game state?",
    "List the packages in this workspace and describe what each one is responsible for.",
    "Which file defines the HTTP routes and where is the request body parsed?",
    "Explain how configuration is loaded at startup and which file holds the defaults.",
    "Where does the build output go and which script produces it?",
    "Which module owns database access and what is the connection lifecycle?",
    "Describe the directory layout of this repository and what belongs where.",
  ]),
  ...group("small_bug_fix", [
    "Fix the crash when a player disconnects mid-tick: add the missing null guard and a regression test.",
    "Fix the off-by-one that drops the last item when the list has exactly one element, and update the test.",
    "Fix the timestamp comparison that fails across midnight and add a test for the boundary.",
    "Fix the missing await that lets the handler return before the write completes.",
    "Fix the incorrect default that makes the retry limit zero instead of three.",
    "Fix the unhandled rejection when the remote returns a 404 and add coverage.",
    "Fix the string comparison that is case-sensitive when it should not be, with a test.",
    "Fix the division by zero when the collection is empty and guard the caller.",
  ]),
  ...group("ambiguous_failure", [
    "CI fails intermittently with a timeout. Not sure if it's the test runner, a mock, or a real race. Figure out what is going on.",
    "The deployed app sometimes returns 500s after a cold start. Diagnose the likely cause and recommend the smallest change.",
    "Requests occasionally hang for thirty seconds and then succeed. No idea why. Investigate.",
    "The integration test passes locally and fails in CI, unclear whether it's environment or ordering. Find out.",
    "Memory grows slowly over hours until the process is restarted. Something leaks; work out what.",
    "Two users report lost updates under load, but the logs look clean. Investigate the write path.",
    "A background job silently stops processing after a while. Determine why it stalls.",
    "The health check flaps between healthy and unhealthy with no deploys. Diagnose it.",
  ]),
  ...group("misleading_hypothesis", [
    "Users report stale balances. It's clearly the cache TTL — I bet it's too high. Bump it down and ship.",
    "Players occasionally duplicate items. Probably a race in the inventory handler — just add a mutex there.",
    "The page is slow. Obviously the images are too big, so compress them and we're done.",
    "Logins fail sometimes. It's definitely the session store; just increase its size.",
    "The queue backs up every evening. Clearly we need more workers — scale it up.",
    "Search returns nothing for some queries. I suspect the index is stale, so just reindex.",
    "The build is slow. It must be the linter — disable it in CI.",
    "Timestamps look wrong in the report. Probably a timezone bug in the formatter; patch the formatter.",
  ]),
  ...group("multi_file_impl", [
    "Implement per-user rate limiting: middleware, a config option, server wiring, docs, and tests.",
    "Add a replay command that re-runs a stored trace deterministically and diffs the result, with docs and tests.",
    "Add structured logging across the request path with a level config, redaction, and tests.",
    "Implement soft delete for records: schema change, query filters, restore endpoint, and tests.",
    "Add pagination to the list endpoints: shared helper, route changes, client update, and tests.",
    "Implement an export feature that streams records to a file, wired into the CLI, with tests.",
    "Add a feature flag system with a config file, a runtime check helper, and test coverage.",
    "Implement retry with backoff around the outbound HTTP client, configurable, with tests.",
  ]),
  ...group("security_sensitive", [
    "Move API tokens from plaintext JSON to the OS keychain. This touches secret handling — confirm before changing anything.",
    "Harden chat message handling against injection before it reaches the command parser, with tests for XSS and SQL payloads.",
    "Review how session cookies are set and fix any missing security attributes, with tests.",
    "Add authorization checks to the admin endpoints and test that unauthorized callers are rejected.",
    "Rotate the signing key used for tokens and make the rotation safe for in-flight sessions — check with me first.",
    "Sanitize file paths in the upload handler so a caller cannot escape the upload directory.",
    "Audit the dependency list for known vulnerable versions and propose the minimal upgrade set.",
    "Remove the credential values that are currently written to the debug log, and add a redaction test.",
  ]),
  ...group("research_synthesis", [
    "Research and compare three options for replacing the hand-rolled SQL layer with an ORM, and recommend one.",
    "Survey the literature on rate-based versus spiking simulation of a connectome and recommend an approach for a prototype.",
    "Compare three queueing options for this workload and make a recommendation with trade-offs.",
    "Summarize the current approaches to schema migration in this ecosystem and pick one for us.",
    "Evaluate two testing frameworks against this codebase's constraints and recommend one.",
    "Review the options for client-side state management here and justify a choice.",
    "Compare hosted and self-hosted metrics pipelines for our scale and recommend a direction.",
    "Assess the trade-offs between monorepo and split repositories for this project.",
  ]),
  ...group("needs_runtime_check", [
    "Verify that the project builds and all tests pass after the latest changes, reporting exact output.",
    "Check whether the deployment configuration matches the environment variables the app actually reads.",
    "Confirm the CLI help output matches the documented commands and report any drift.",
    "Verify the migration applies cleanly to an empty database and report what it creates.",
    "Check that the published package contains the files it should and nothing it should not.",
    "Verify the health endpoint responds correctly when a dependency is unavailable.",
    "Confirm the lockfile is consistent with the manifest and report any mismatch.",
    "Check that the Docker image starts and serves a request, reporting the commands used.",
  ]),
  ...group("genuinely_blocked", [
    "Rotate the production database credentials and redeploy. We have no access to production secrets from here.",
    "Make the physics deterministic across platforms.",
    "Fix the failing customer integration — we do not have their API credentials or logs.",
    "Restore last week's deleted records; we have no backups and no snapshot access.",
    "Resolve the vendor's rate limiting on our behalf; the account is not ours to configure.",
    "Update the production DNS records to point at the new host. No registrar access from here.",
    "Diagnose the crash from the customer's device without the crash report or the device.",
    "Sign the release binaries; the signing certificate is not available in this environment.",
  ]),
  ...group("stop_early", [
    "Only if trivial: confirm the README already documents the fork provenance; stop early if it does.",
    "If the lockfile is already consistent with the manifest, stop early and say so; do not change anything.",
    "Check whether the license file is present; if it is, stop without further work.",
    "If the CI workflow already runs the test suite, stop early and report that.",
    "Confirm the changelog already mentions the latest release; if so, do nothing further.",
    "If the config already sets the timeout we want, stop and say so rather than editing.",
    "Check whether tests already cover the empty-input case; stop early if they do.",
    "If the docs already describe the new flag, stop without rewriting them.",
  ]),
];

export function corpusByVariant(variant: "a" | "b"): CorpusTask[] {
  return TASK_CORPUS.filter((t) => t.variant === variant);
}
