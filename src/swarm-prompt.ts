const APPROACH_HINTS = [
  "prefer brevity",
  "prefer explicitness and detail",
  "explore an alternative angle from any sibling attempts",
  "prioritize edge-case correctness over elegance",
  "prefer the simplest plausible answer",
  "prioritize robustness and defensiveness",
  "prefer the most general formulation",
  "prefer the most concrete, specific framing",
  "challenge any obvious framing of the task",
];

/**
 * Append a per-forager variant hint to decorrelate parallel swarm outputs.
 * Returns the bare task when swarmSize <= 1 (including non-finite). Throws
 * RangeError when swarmSize > 1 but index is not a non-negative integer.
 */
export function swarmVariant(
  task: string,
  index: number,
  swarmSize: number,
): string {
  if (!Number.isFinite(swarmSize) || swarmSize <= 1) return task;
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(
      `swarmVariant: index must be a non-negative integer, got ${index}`,
    );
  }
  const hint = APPROACH_HINTS[index % APPROACH_HINTS.length];
  return `${task}\n\n[Forager ${index + 1} of ${swarmSize}: ${hint}. Do not coordinate with siblings.]`;
}
