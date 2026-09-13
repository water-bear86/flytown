import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { FIXTURES, FIXTURE_REPOS, FIXTURE_SUITE, RUBRICS, fixtureAvailability, fixturesByCategory, type Fixture } from "../flytown/eval/fixtures.js";
import { fetchFixtureRepos, fixtureRepoPath, fixtureRepoState, fixturesRoot, type FixtureRepo } from "../flytown/eval/fixture-repos.js";
import { runHarness, tildify } from "../flytown/eval/harness.js";

const git = promisify(execFile);
const cleanup: string[] = [];
after(async () => { for (const d of cleanup) await rm(d, { recursive: true, force: true }); });

async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

/** A local repository with two commits, served over file:// like a public remote. */
async function sourceRepo(): Promise<{ url: string; first: string; second: string }> {
  const dir = await tmp("flytown-src-");
  const run = (...args: string[]) => git("git", ["-C", dir, ...args]).then((r) => r.stdout.trim());
  await run("init", "-q");
  await run("config", "user.email", "test@example.invalid");
  await run("config", "user.name", "test");
  await run("config", "uploadpack.allowAnySHA1InWant", "true");
  await writeFile(join(dir, "a.txt"), "first\n");
  await run("add", "a.txt");
  await run("commit", "-q", "-m", "first");
  const first = await run("rev-parse", "HEAD");
  await writeFile(join(dir, "a.txt"), "second\n");
  await run("commit", "-q", "-am", "second");
  const second = await run("rev-parse", "HEAD");
  return { url: `file://${dir}`, first, second };
}

describe("suite public-v2", () => {
  it("has two tasks in each of the ten categories, each with a rubric", () => {
    assert.equal(FIXTURES.length, 20);
    const ids = new Set(FIXTURES.map((f) => f.id));
    assert.equal(ids.size, 20, "ids are unique");
    const byCategory = fixturesByCategory();
    assert.equal(Object.keys(byCategory).length, 10);
    for (const [category, list] of Object.entries(byCategory)) assert.equal(list.length, 2, category);
    for (const f of FIXTURES) assert.ok(RUBRICS[f.id], `rubric for ${f.id}`);
    for (const id of Object.keys(RUBRICS)) assert.ok(ids.has(id), `rubric ${id} has a fixture`);
  });
  it("runs every task against a public repository pinned to a full commit", () => {
    assert.equal(FIXTURE_SUITE, "public-v2");
    for (const repo of Object.values(FIXTURE_REPOS)) {
      assert.match(repo.url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/);
      assert.match(repo.commit, /^[0-9a-f]{40}$/);
    }
    for (const f of FIXTURES) {
      assert.ok(f.pinned, `${f.id} is pinned`);
      assert.equal(f.repo, fixtureRepoPath(f.pinned!), `${f.id} runs in the pinned checkout`);
    }
  });
  it("keeps fetched repositories under the FLYTOWN home, overridable", () => {
    assert.equal(fixturesRoot({ FLYTOWN_FIXTURES_DIR: "/x/fixtures" }), "/x/fixtures");
    assert.equal(fixturesRoot({ FLYTOWN_HOME: "/h/.flytown" }), join("/h/.flytown", "fixtures"));
  });
});

describe("pinned fixture repositories", () => {
  it("fetch downloads the pinned commit, keeps a ready checkout, and never discards edits without force", async () => {
    const src = await sourceRepo();
    const root = await tmp("flytown-fixtures-");
    const repo: FixtureRepo = { name: "demo", url: src.url, commit: src.first };
    const dir = fixtureRepoPath(repo, root);
    assert.equal(await fixtureRepoState(repo, root), "missing");

    const [fetched] = await fetchFixtureRepos([repo], { root });
    assert.equal(fetched.action, "fetched");
    assert.equal(fetched.after, "ready");
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "first\n", "the pinned commit, not the latest one");
    assert.equal((await fetchFixtureRepos([repo], { root }))[0].action, "kept");

    await writeFile(join(dir, "a.txt"), "edited\n");
    assert.equal(await fixtureRepoState(repo, root), "modified");
    const [skipped] = await fetchFixtureRepos([repo], { root });
    assert.equal(skipped.action, "skipped");
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "edited\n", "edits survive without --force");
    const [reset] = await fetchFixtureRepos([repo], { root, force: true });
    assert.equal(reset.action, "reset");
    assert.equal(await fixtureRepoState(repo, root), "ready");

    await git("git", ["-C", dir, "fetch", "-q", "--depth", "1", "origin", src.second]);
    await git("git", ["-C", dir, "checkout", "-q", "--detach", src.second]);
    assert.equal(await fixtureRepoState(repo, root), "wrong-commit");
    assert.equal((await fetchFixtureRepos([repo], { root }))[0].action, "checked-out");
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "first\n");
  });

  it("counts a pinned fixture as available only when its checkout is clean and at the pin", async () => {
    const src = await sourceRepo();
    const root = await tmp("flytown-fixtures-");
    const repo: FixtureRepo = { name: "demo", url: src.url, commit: src.first };
    const fixture: Fixture = { id: "demo-task", category: "repo_question", task: "Describe a.txt", repo: fixtureRepoPath(repo, root), pinned: repo, expected: "complete", traps: {} };
    assert.equal((await fixtureAvailability([fixture]))["demo-task"], false);
    await fetchFixtureRepos([repo], { root });
    assert.equal((await fixtureAvailability([fixture]))["demo-task"], true);
    await writeFile(join(fixture.repo, "untracked.txt"), "x\n");
    assert.equal((await fixtureAvailability([fixture]))["demo-task"], false, "local changes would change the task");
  });

  it("a live evaluation refuses to start without its repositories, before any provider call", async () => {
    const root = await tmp("flytown-live-refuse-");
    const repo: FixtureRepo = { name: "absent", url: "file:///nonexistent", commit: "0".repeat(40) };
    const fixture: Fixture = { id: "absent-task", category: "repo_question", task: "Anything", repo: fixtureRepoPath(repo, root), pinned: repo, expected: "complete", traps: {} };
    await assert.rejects(
      runHarness({ planners: ["rules"], fixtures: [fixture], seeds: [1], root, live: { terrariumRoot: root } }),
      /fly fixtures fetch/,
    );
  });

  it("records the suite and its pins in every report", async () => {
    const root = await tmp("flytown-suite-report-");
    const subset = FIXTURES.filter((f) => f.id === "q-engine-layout");
    const report = await runHarness({ planners: ["rules"], fixtures: subset, seeds: [1], root });
    assert.equal(report.suite.name, FIXTURE_SUITE);
    assert.deepEqual(report.suite.repos.map((r) => r.commit), [FIXTURE_REPOS.blockmmo.commit]);
    const md = await readFile(join(report.outDir, "report.md"), "utf8");
    assert.match(md, /suite: public-v2 · blockmmo@e2450b77e2b3/);
    const custom = await runHarness({ planners: ["rules"], fixtures: [{ ...subset[0], task: "a different task" }], seeds: [1], root });
    assert.equal(custom.suite.name, "custom");
  });

  it("reports show home-folder paths as ~", () => {
    assert.equal(tildify("/home/sam/flytown/.flytown", "/home/sam"), "~/flytown/.flytown");
    assert.equal(tildify("/home/samuel/x", "/home/sam"), "/home/samuel/x");
    assert.equal(tildify("/srv/data", "/home/sam"), "/srv/data");
  });
});
