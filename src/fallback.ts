import { makeSoldier } from "./castes.js";
import { measureDrift } from "./drift.js";
import { callInsect, callInsectStream } from "./openai-client.js";
import { makeThinkingRelay } from "./streaming.js";
import type { Morsel, OutputFormat, Personality, GuardVerdict } from "./types.js";
import type { Compost } from "./compost.js";

export interface SoldierFallbackOptions {
  task: string;
  foragerMorsels: Morsel[];
  guardVerdicts: Record<string, GuardVerdict>;
  stingByForagerId?: Record<string, Morsel>;
  compost: Compost;
  personality?: Personality;
  flightId?: string;
  outputFormat?: OutputFormat;
  /** Optional live-thinking relay; receives the cumulative soldier text as it streams. */
  onThink?: (cumulativeText: string) => void;
}

/**
 * Soldier escalation: when the forager swarm (and any specialists) failed
 * guard review, one expensive Soldier call synthesizes a corrected answer
 * from every attempt, its guard critique and its wasp sting report.
 */
export async function soldierFallback(opts: SoldierFallbackOptions): Promise<Morsel> {
  const soldier = makeSoldier(opts.personality);

  const sections = opts.foragerMorsels.map((g, i) => {
    const v = opts.guardVerdicts[g.id];
    const sting = opts.stingByForagerId?.[g.id];
    return (
      `--- Attempt ${i + 1} (morsel ${g.id}, guard score ${v?.score?.toFixed(2) ?? "?"}, ${v?.passed ? "PASS" : "FAIL"}) ---\n` +
      `Forager output:\n${g.output}\n\n` +
      `Guard critique:\n${v?.critique ?? "(none)"}\n\n` +
      (sting
        ? `Wasp sting report:\n${sting.output}\n`
        : `Wasp sting report: (none)\n`)
    );
  });

  const userPrompt =
    `The Forager swarm failed Guard review on this task:\n\n${opts.task}\n\n` +
    `Below are all attempts, their critiques, and sting reports. ` +
    `Synthesize a single correct, complete answer. ` +
    `You may borrow from any attempt, but you must address every Guard critique and survive every Wasp attack. ` +
    `Do not narrate your synthesis — just deliver the corrected answer.\n\n` +
    sections.join("\n");

  let output: string;
  let usage;
  if (opts.onThink) {
    const relay = makeThinkingRelay(opts.onThink);
    const result = await callInsectStream(soldier, userPrompt, relay.onChunk, {
      outputFormat: opts.outputFormat,
    });
    relay.done();
    output = result.text;
    usage = result.usage;
  } else {
    const result = await callInsect(soldier, userPrompt, {
      outputFormat: opts.outputFormat,
    });
    output = result.text;
    usage = result.usage;
  }
  const drift = measureDrift(output);

  const morsel: Morsel = {
    id: "",
    flightId: opts.flightId,
    caste: "soldier",
    personality: soldier.personality,
    model: soldier.model,
    prompt: userPrompt,
    output,
    parentMorselIds: opts.foragerMorsels.map((g) => g.id),
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.compost.stash(morsel);
  return morsel;
}
