import { randomUUID } from "node:crypto";
import { makeForager } from "./castes.js";
import { measureDrift } from "./drift.js";
import { callInsect } from "./openai-client.js";
import { swarmVariant } from "./swarm-prompt.js";
import { sugar } from "./reward.js";
import { guardReview } from "./guard-review.js";
import type { Morsel, OutputFormat, Personality, Foray } from "./types.js";
import type { Compost } from "./compost.js";
import type { RewardFn } from "./reward-plugin.js";

export interface DispatchOptions {
  task: string;
  swarmSize: number;
  compost: Compost;
  personality?: Personality;
  rewardFn?: RewardFn;
  outputFormat?: OutputFormat;
}

export interface DispatchResult {
  foray: Foray;
  morsels: Morsel[];
  winner: Morsel;
}

/**
 * Foray: a lightweight run. A forager swarm answers the task in parallel, the
 * guard reviews each answer, and the highest-reward answer wins. No scout,
 * wasps, specialists, soldier or scribe.
 */
export async function dispatchForay(opts: DispatchOptions): Promise<DispatchResult> {
  const personality: Personality = opts.personality ?? "nerdy";
  const forayId = randomUUID().slice(0, 8);
  const foray: Foray = {
    id: forayId,
    task: opts.task,
    swarmSize: opts.swarmSize,
    personality,
    morselIds: [],
    guardVerdicts: {},
    startedAt: Date.now(),
  };

  const forager = makeForager(personality);
  const foragerJobs = Array.from({ length: opts.swarmSize }, async (_, i) => {
    const variantPrompt = swarmVariant(opts.task, i, opts.swarmSize);
    const { text: output, usage } = await callInsect(forager, variantPrompt, {
      outputFormat: opts.outputFormat,
    });
    const drift = measureDrift(output);
    const morsel: Morsel = {
      id: "",
      forayId,
      caste: "forager",
      personality: forager.personality,
      model: forager.model,
      prompt: variantPrompt,
      output,
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.compost.stash(morsel);
    return morsel;
  });

  const morsels = await Promise.all(foragerJobs);
  foray.morselIds = morsels.map((l) => l.id);

  const rewardFn = opts.rewardFn ?? sugar;
  for (const item of morsels) {
    const { verdict } = await guardReview({
      foragerMorsel: item,
      originalTask: opts.task,
      compost: opts.compost,
    });
    foray.guardVerdicts[item.id] = verdict;
    item.reward = rewardFn(item, verdict);
    await opts.compost.stash(item);
  }

  const winner = morsels.reduce((best, cur) =>
    (cur.reward ?? 0) > (best.reward ?? 0) ? cur : best,
  );
  foray.winnerMorselId = winner.id;
  foray.finishedAt = Date.now();
  await opts.compost.stashForay(foray);

  return { foray, morsels, winner };
}
