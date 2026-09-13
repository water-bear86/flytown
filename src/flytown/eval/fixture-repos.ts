/**
 * Evaluation repositories: public, pinned to exact commits, and fetched into a
 * local cache, so every machine evaluates planners against identical code.
 *
 * `flytown fly fixtures fetch` fills the cache. The harness treats a
 * repository as available only when its checkout is at the pinned commit with
 * no local changes; anything else would silently change the task.
 */
import { execFile } from "node:child_process";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface FixtureRepo {
  /** Short name, used in fixture definitions and the cache directory name. */
  name: string;
  /** Public clone URL. */
  url: string;
  /** Full 40-character commit the suite is pinned to. */
  commit: string;
}

/**
 * ready: at the pinned commit, no local changes · missing: not fetched ·
 * wrong-commit: a clean checkout of some other commit · modified: local
 * changes or untracked files · not-a-checkout: the directory is not its own
 * git checkout.
 */
export type FixtureRepoState = "ready" | "missing" | "wrong-commit" | "modified" | "not-a-checkout";

/** `$FLYTOWN_FIXTURES_DIR`, else `<$FLYTOWN_HOME or ~/.flytown>/fixtures`. */
export function fixturesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.FLYTOWN_FIXTURES_DIR || join(env.FLYTOWN_HOME || join(homedir(), ".flytown"), "fixtures");
}

export function fixtureRepoPath(repo: FixtureRepo, root: string = fixturesRoot()): string {
  return join(root, `${repo.name}-${repo.commit.slice(0, 12)}`);
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") throw new Error("git is not installed or not on PATH; it is needed to fetch the evaluation repositories");
    throw new Error(`git ${args.join(" ")} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

export async function fixtureRepoState(repo: FixtureRepo, root: string = fixturesRoot()): Promise<FixtureRepoState> {
  const dir = fixtureRepoPath(repo, root);
  try {
    if (!(await stat(dir)).isDirectory()) return "not-a-checkout";
  } catch {
    return "missing";
  }
  try {
    // A directory inside some other checkout would otherwise report that checkout's HEAD.
    const top = await git(["rev-parse", "--show-toplevel"], dir);
    if ((await realpath(top)) !== (await realpath(dir))) return "not-a-checkout";
  } catch {
    return "not-a-checkout";
  }
  if (await git(["status", "--porcelain"], dir)) return "modified";
  let head = "";
  try { head = await git(["rev-parse", "HEAD"], dir); } catch { return "wrong-commit"; }
  return head === repo.commit ? "ready" : "wrong-commit";
}

export interface FixtureFetchResult {
  repo: FixtureRepo;
  path: string;
  before: FixtureRepoState;
  after: FixtureRepoState;
  action: "kept" | "fetched" | "checked-out" | "reset" | "skipped";
}

/**
 * Bring every repository to its pinned commit. Only the pinned commit is
 * downloaded (a shallow fetch by commit id). Local changes are never discarded
 * unless `force` is set.
 */
export async function fetchFixtureRepos(repos: FixtureRepo[], opts: { root?: string; force?: boolean; log?: (line: string) => void } = {}): Promise<FixtureFetchResult[]> {
  const root = opts.root ?? fixturesRoot();
  const log = opts.log ?? (() => {});
  const results: FixtureFetchResult[] = [];
  for (const repo of repos) {
    const dir = fixtureRepoPath(repo, root);
    const before = await fixtureRepoState(repo, root);
    if (before === "ready") {
      results.push({ repo, path: dir, before, after: before, action: "kept" });
      continue;
    }
    if ((before === "modified" || before === "not-a-checkout") && !opts.force) {
      log(`${repo.name}: ${before} at ${dir}; left untouched (use --force to reset it)`);
      results.push({ repo, path: dir, before, after: before, action: "skipped" });
      continue;
    }
    if (before === "not-a-checkout") await rm(dir, { recursive: true, force: true });
    if (before === "missing" || before === "not-a-checkout") {
      await mkdir(dir, { recursive: true });
      await git(["init", "-q"], dir);
      await git(["remote", "add", "origin", repo.url], dir);
    } else {
      await git(["remote", "set-url", "origin", repo.url], dir);
    }
    log(`${repo.name}: fetching ${repo.commit.slice(0, 12)} from ${repo.url}`);
    await git(["fetch", "-q", "--depth", "1", "--no-tags", "origin", repo.commit], dir);
    await git(["checkout", "-q", "--force", "--detach", repo.commit], dir);
    if (before === "modified") await git(["clean", "-q", "-fdx"], dir);
    const after = await fixtureRepoState(repo, root);
    if (after !== "ready") throw new Error(`${repo.name}: expected a clean checkout of ${repo.commit} at ${dir}, found ${after}`);
    results.push({ repo, path: dir, before, after, action: before === "missing" || before === "not-a-checkout" ? "fetched" : before === "modified" ? "reset" : "checked-out" });
  }
  return results;
}
