import { CASTES, type Caste, type DriftReport } from "./types.js";

/**
 * Count mentions of the caste names (singular or plural, whole words,
 * case-insensitive) in a model output. Drift is reported, not penalised: it
 * detects the themed worker prompts leaking into what the models write.
 */
export function measureDrift(output: string): DriftReport {
  const lower = output.toLowerCase();
  const mentions: Record<Caste, number> = {
    forager: 0,
    wasp: 0,
    scout: 0,
    guard: 0,
    soldier: 0,
    messenger: 0,
  };

  for (const caste of CASTES) {
    const re = new RegExp(`\\b${caste}s?\\b`, "g");
    const matches = lower.match(re);
    mentions[caste] = matches ? matches.length : 0;
  }

  const totalCasteWords = CASTES.reduce(
    (sum, k) => sum + mentions[k],
    0,
  );
  const outputWordCount = output
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

  return {
    casteMentions: mentions,
    totalCasteWords,
    outputWordCount,
    driftRate: outputWordCount > 0 ? totalCasteWords / outputWordCount : 0,
  };
}

/** Fraction of output words that name a caste other than `selfCaste`. */
export function crossCasteDrift(
  output: string,
  selfCaste: Caste,
): number {
  const r = measureDrift(output);
  const cross = r.totalCasteWords - r.casteMentions[selfCaste];
  return r.outputWordCount > 0 ? cross / r.outputWordCount : 0;
}
