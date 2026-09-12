import { mkdir, readFile, readdir, writeFile, access, rm } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Compost } from "./compost.js";
import { defaultProviderConfig, normalizeProviderConfig } from "./providers.js";
import type { TerrariumManifest } from "./types.js";

const TERRARIUM_DIRNAME = ".flytown";
const MANIFEST_FILE = "terrarium.json";

/**
 * Entries under `.flytown/` written by the FLYTOWN planner research tooling —
 * decision traces, evaluation reports and their composts, learned weights —
 * rather than by the terrarium itself. `resetTerrarium` leaves them in place.
 */
const RESEARCH_ENTRIES = new Set(["traces", "eval", "eval-compost", "weights"]);

/**
 * A Terrarium is a project root plus its `.flytown/` state: the manifest
 * (`terrarium.json`), the Compost record store, persisted runs and stored
 * provider secrets.
 */
export interface Terrarium {
  root: string;
  manifestPath: string;
  manifest: TerrariumManifest;
  compost: Compost;
  scope: "project" | "global";
}

export interface LoadTerrariumOptions {
  globalFallback?: boolean;
  initGlobalFallback?: boolean;
}

export async function initTerrarium(root: string): Promise<Terrarium> {
  const dir = join(root, TERRARIUM_DIRNAME);
  await mkdir(dir, { recursive: true });
  const compost = new Compost(join(dir, "compost"));
  await compost.init();

  const manifestPath = join(dir, MANIFEST_FILE);
  const manifest: TerrariumManifest = {
    name: pathBasename(root),
    version: 1,
    createdAt: new Date().toISOString(),
    defaultModelForager: process.env.FLYTOWN_MODEL_FORAGER ?? "gpt-5-mini",
    defaultModelSoldier: process.env.FLYTOWN_MODEL_SOLDIER ?? "gpt-5",
    defaultModelGuard: process.env.FLYTOWN_MODEL_GUARD ?? "gpt-5-mini",
    provider: defaultProviderConfig(),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    root,
    manifestPath,
    manifest,
    compost,
    scope: root === globalTerrariumRoot() ? "global" : "project",
  };
}

/**
 * Delete the terrarium's own state (manifest, compost, runs, provider secrets,
 * reward plugin) and initialize a fresh one. Research state listed in
 * RESEARCH_ENTRIES shares the `.flytown/` directory and is preserved.
 */
export async function resetTerrarium(root: string): Promise<Terrarium> {
  const dir = join(root, TERRARIUM_DIRNAME);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // nothing to reset yet
  }
  for (const name of entries) {
    if (RESEARCH_ENTRIES.has(name)) continue;
    await rm(join(dir, name), { recursive: true, force: true });
  }
  return initTerrarium(root);
}

export async function loadTerrarium(
  cwd: string,
  opts: LoadTerrariumOptions = {},
): Promise<Terrarium> {
  const root = await findTerrariumRoot(cwd);
  if (root) return loadTerrariumRoot(root, "project");

  if (opts.globalFallback) {
    const globalRoot = globalTerrariumRoot();
    if (await hasTerrariumManifest(globalRoot)) {
      return loadTerrariumRoot(globalRoot, "global");
    }
    if (opts.initGlobalFallback !== false) return initTerrarium(globalRoot);
  }

  const nextStep = opts.globalFallback
    ? "Run `flytown init` in a project folder, or let FLYTOWN create its global Terrarium (~/.flytown, or $FLYTOWN_HOME)."
    : "Run `flytown init` first.";
  throw new Error(`No Terrarium found above ${cwd}. ${nextStep}`);
}

/**
 * Root of the global fallback terrarium: `$FLYTOWN_HOME` when set, otherwise
 * `~/.flytown`. Like any root, its state lives in `<root>/.flytown/`.
 */
export function globalTerrariumRoot(): string {
  return process.env.FLYTOWN_HOME || join(homedir(), ".flytown");
}

async function loadTerrariumRoot(
  root: string,
  scope: Terrarium["scope"],
): Promise<Terrarium> {
  const manifestPath = join(root, TERRARIUM_DIRNAME, MANIFEST_FILE);
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as TerrariumManifest;
  manifest.provider = normalizeProviderConfig(manifest.provider);
  const compost = new Compost(join(root, TERRARIUM_DIRNAME, "compost"));
  // Defensive: ensure every compost subdirectory exists (idempotent).
  await compost.init();
  return { root, manifestPath, manifest, compost, scope };
}

async function hasTerrariumManifest(root: string): Promise<boolean> {
  try {
    await access(join(root, TERRARIUM_DIRNAME, MANIFEST_FILE), FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function saveTerrariumManifest(terrarium: Terrarium): Promise<void> {
  terrarium.manifest.provider = normalizeProviderConfig(terrarium.manifest.provider);
  await writeFile(terrarium.manifestPath, JSON.stringify(terrarium.manifest, null, 2), "utf8");
}

async function findTerrariumRoot(start: string): Promise<string | null> {
  let cur = start;
  while (true) {
    const candidate = join(cur, TERRARIUM_DIRNAME, MANIFEST_FILE);
    try {
      await access(candidate, FS.F_OK);
      return cur;
    } catch {
      // not here
    }
    const parent = pathDirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function pathBasename(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function pathDirname(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
  if (idx < 0) return p;
  return norm.slice(0, idx) || norm.slice(0, idx + 1);
}
