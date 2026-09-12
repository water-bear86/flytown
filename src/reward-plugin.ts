import { access } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sugar } from "./reward.js";
import type { Morsel, GuardVerdict } from "./types.js";

/** Scores a candidate morsel given the guard's verdict; must return a number in [0, 1]. */
export type RewardFn = (morsel: Morsel, verdict: GuardVerdict) => number;

export interface RewardPlugin {
  fn: RewardFn;
  source: string;
}

/**
 * Load `<root>/.flytown/reward.mjs` (or `reward.js`) when present; otherwise
 * the built-in `sugar` reward. Plugin results are clamped to [0, 1].
 */
export async function loadRewardPlugin(terrariumRoot: string): Promise<RewardPlugin> {
  for (const filename of ["reward.mjs", "reward.js"]) {
    const candidate = join(terrariumRoot, ".flytown", filename);
    try {
      await access(candidate, FS.F_OK);
    } catch {
      continue;
    }

    const url = pathToFileURL(candidate).href;
    const mod = (await import(url)) as { default?: unknown };
    const exported = mod.default;
    if (typeof exported !== "function") {
      throw new Error(
        `Reward plugin at ${candidate} must export a default function ` +
          `(morsel, verdict) => number; got ${typeof exported}.`,
      );
    }

    const wrapped: RewardFn = (morsel, verdict) => {
      const raw = (exported as RewardFn)(morsel, verdict);
      if (typeof raw !== "number" || Number.isNaN(raw)) return 0;
      return Math.max(0, Math.min(1, raw));
    };
    return { fn: wrapped, source: candidate };
  }

  return { fn: sugar, source: "builtin" };
}
