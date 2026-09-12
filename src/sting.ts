import { makeWasp } from "./castes.js";
import { measureDrift } from "./drift.js";
import { callInsect } from "./openai-client.js";
import type { Morsel, Personality } from "./types.js";
import type { Compost } from "./compost.js";

export interface StingPassOptions {
  foragerMorsel: Morsel;
  originalTask: string;
  compost: Compost;
  personality?: Personality;
  flightId?: string;
}

export async function stingPass(opts: StingPassOptions): Promise<Morsel> {
  const wasp = makeWasp(opts.personality);
  const userPrompt =
    `Original task:\n${opts.originalTask}\n\n` +
    `Artifact under attack (a Forager's answer):\n${opts.foragerMorsel.output}\n\n` +
    `Produce a numbered list of distinct attacks, edge cases, or failure modes ` +
    `that would defeat or invalidate this artifact. Be ruthless and specific. ` +
    `If the artifact appears actually correct, say "NO DEFECTS FOUND" on its own line ` +
    `and explain in one sentence why your attempts failed.`;

  const { text: output, usage } = await callInsect(wasp, userPrompt);
  const drift = measureDrift(output);
  const morsel: Morsel = {
    id: "",
    flightId: opts.flightId,
    caste: "wasp",
    personality: wasp.personality,
    model: wasp.model,
    prompt: userPrompt,
    output,
    parentMorselIds: [opts.foragerMorsel.id],
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.compost.stash(morsel);
  return morsel;
}
