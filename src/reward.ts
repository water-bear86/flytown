import type { Morsel, GuardVerdict } from "./types.js";

/**
 * Sugar — the default reward for a candidate morsel:
 *
 *   sugar = clamp01(guardScore + passBonus)    passBonus = 0.1 when the guard passed it
 *
 * Sugar deliberately does not subtract a drift penalty. The caste names are
 * ordinary English words ("add a guard clause", "scout the codebase"), so
 * penalising outputs that mention them would punish correct answers. Drift is
 * still measured and recorded on every morsel (see drift.ts) as the detector
 * for the themed worker prompts leaking into outputs.
 */
export function sugar(_morsel: Morsel, verdict: GuardVerdict): number {
  const guardScore = clamp01(verdict.score);
  const passBonus = verdict.passed ? 0.1 : 0;
  return clamp01(guardScore + passBonus);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
