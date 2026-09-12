/**
 * Example reward plugin: rewards passed Guard verdicts and adds a small bonus
 * for low-drift outputs (few mentions of the caste names). Receives the
 * candidate Morsel and the Guard's verdict; FLYTOWN clamps the result to [0, 1].
 */
export default function reward(morsel, verdict) {
  const base = verdict.passed ? 0.82 : Math.max(0, verdict.score * 0.45);
  const driftBonus = 1 - Math.min(1, morsel?.drift?.driftRate ?? 0);
  const passBonus = verdict.passed ? 0.08 : 0;

  return Math.max(0, Math.min(1, base + driftBonus * 0.1 + passBonus));
}
