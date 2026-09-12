import { readFile, stat } from "node:fs/promises";
import { glob } from "glob";
import { relative } from "node:path";
import { makeScout } from "./castes.js";
import { measureDrift } from "./drift.js";
import { callInsect } from "./openai-client.js";
import type { Morsel, Personality } from "./types.js";
import type { Compost } from "./compost.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.flytown/**",
  "**/.git/**",
];

export interface ScoutOptions {
  task: string;
  scanGlobs: string[];
  cwd: string;
  compost: Compost;
  personality?: Personality;
  flightId?: string;
}

export interface FileEntry {
  path: string;
  content: string;
  truncated: boolean;
}

export async function gatherFiles(
  cwd: string,
  patterns: string[],
): Promise<FileEntry[]> {
  const matched = new Set<string>();
  for (const pattern of patterns) {
    const hits = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      ignore: IGNORE,
    });
    for (const h of hits) matched.add(h);
  }

  const out: FileEntry[] = [];
  let totalBytes = 0;
  for (const abs of [...matched].sort()) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    let content = await readFile(abs, "utf8");
    let truncated = false;
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES);
      truncated = true;
    }
    if (totalBytes + content.length > MAX_TOTAL_BYTES) {
      content = content.slice(0, MAX_TOTAL_BYTES - totalBytes);
      truncated = true;
    }
    totalBytes += content.length;
    out.push({ path: relative(cwd, abs), content, truncated });
  }
  return out;
}

export function formatContextDump(files: FileEntry[]): string {
  if (files.length === 0) return "(no files matched)";
  return files
    .map(
      (f) =>
        `=== ${f.path}${f.truncated ? " (truncated)" : ""} ===\n${f.content}`,
    )
    .join("\n\n");
}

export interface ScoutResult {
  morsel: Morsel;
  files: FileEntry[];
  facts: string;
}

/**
 * Scout pass: read the files matched by `scanGlobs` and have a Scout distil
 * only the facts the task needs. The result is stashed as one Morsel.
 */
export async function scout(opts: ScoutOptions): Promise<ScoutResult> {
  const files = await gatherFiles(opts.cwd, opts.scanGlobs);
  const dump = formatContextDump(files);
  const scoutInsect = makeScout(opts.personality);

  const fileWord = files.length === 1 ? "file" : "files";
  const userPrompt =
    `Task being prepared:\n${opts.task}\n\n` +
    `Context dump from the Terrarium (${files.length} ${fileWord}):\n` +
    dump +
    `\n\nReturn only the facts that matter for the task. Bullet points. Use "MISSING: ..." for anything needed but absent.`;

  const { text: output, usage } = await callInsect(scoutInsect, userPrompt);
  const drift = measureDrift(output);

  const morsel: Morsel = {
    id: "",
    flightId: opts.flightId,
    caste: "scout",
    personality: scoutInsect.personality,
    model: scoutInsect.model,
    prompt: userPrompt,
    output,
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.compost.stash(morsel);

  return { morsel, files, facts: output };
}

export async function previewScan(
  cwd: string,
  patterns: string[],
): Promise<string[]> {
  const out = new Set<string>();
  for (const p of patterns) {
    const hits = await glob(p, {
      cwd,
      absolute: false,
      nodir: true,
      ignore: IGNORE,
    });
    for (const h of hits) out.add(h);
  }
  return [...out].sort();
}
