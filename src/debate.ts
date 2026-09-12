/**
 * Phase 4 — Inter-agent debate round.
 *
 * After the initial forager swarm proposes, run one debate round where each
 * forager sees the others' outputs and may revise. This closes the O3
 * communication gap (per the LLM-MAS-RL survey): currently foragers work in
 * parallel sandboxes, never see each other's work. Debate is training-free
 * and on the order of one extra forager call per swarm member.
 *
 * Pure functions exported for testability:
 *   buildDebatePrompt — what each forager sees during the debate round.
 */
import { makeForager } from "./castes.js";
import { measureDrift } from "./drift.js";
import { callInsect, callInsectStream } from "./openai-client.js";
import { makeThinkingRelay } from "./streaming.js";
import type { Morsel, OutputFormat, Personality } from "./types.js";
import type { Compost } from "./compost.js";

export function buildDebatePrompt(opts: {
  task: string;
  selfIndex: number;
  selfOutput: string;
  selfPersonality: Personality;
  peerOutputs: { index: number; personality: Personality; output: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`Debate round.`);
  lines.push(``);
  lines.push(`Original task:`);
  lines.push(opts.task);
  lines.push(``);
  lines.push(`You are Forager #${opts.selfIndex} (${opts.selfPersonality}). Your first attempt was:`);
  lines.push(opts.selfOutput);
  lines.push(``);
  if (opts.peerOutputs.length > 0) {
    lines.push(`Your peers proposed:`);
    for (const p of opts.peerOutputs) {
      lines.push(`--- Peer Forager #${p.index} (${p.personality}) ---`);
      lines.push(truncate(p.output, 1200));
      lines.push(``);
    }
    lines.push(
      `Cross-examine all proposals (your own and peers'). Steal what is correct, reject what is wrong, fix what is incomplete. ` +
        `If a peer's approach is genuinely better, adopt it; if your own holds, reinforce it. ` +
        `Output a complete revised answer to the original task. No preamble, no narration of your reasoning.`,
    );
  } else {
    lines.push(`(no peer outputs — debate is degenerate; revise your own answer if you spot improvements.)`);
  }
  return lines.join("\n");
}

/**
 * Run one round of debate over the existing forager swarm. Each forager emits
 * a revised morsel which is stashed and returned alongside the original.
 *
 * Returns the *revised* morsels (one per original forager). Caller decides
 * whether to use them in place of, or in addition to, the originals.
 */
export async function runDebateRound(opts: {
  flightId: string;
  task: string;
  swarmMorsels: Morsel[];
  compost: Compost;
  maxOutputTokensPerCall?: number;
  outputFormat?: OutputFormat;
  onSpawn?: (index: number) => void;
  onDone?: (index: number, revisedMorsel: Morsel) => void;
  onThink?: (index: number, cumulativeText: string) => void;
}): Promise<{ revisedMorsels: Morsel[] }> {
  const jobs = opts.swarmMorsels.map((selfMorsel, i) => async () => {
    opts.onSpawn?.(i);
    const peers = opts.swarmMorsels
      .map((p, j) => ({ index: j, personality: p.personality, output: p.output }))
      .filter((_, j) => j !== i);
    const forager = makeForager(selfMorsel.personality);
    const userPrompt = buildDebatePrompt({
      task: opts.task,
      selfIndex: i,
      selfOutput: selfMorsel.output,
      selfPersonality: selfMorsel.personality,
      peerOutputs: peers,
    });

    let output: string;
    let usage;
    if (opts.onThink) {
      const onThink = opts.onThink;
      const relay = makeThinkingRelay((text) => onThink(i, text));
      const r = await callInsectStream(forager, userPrompt, relay.onChunk, {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      });
      relay.done();
      output = r.text;
      usage = r.usage;
    } else {
      const r = await callInsect(forager, userPrompt, {
        maxOutputTokens: opts.maxOutputTokensPerCall,
        outputFormat: opts.outputFormat,
      });
      output = r.text;
      usage = r.usage;
    }

    const drift = measureDrift(output);
    const revised: Morsel = {
      id: "",
      flightId: opts.flightId,
      caste: "forager",
      personality: selfMorsel.personality,
      model: forager.model,
      prompt: userPrompt,
      output,
      parentMorselIds: [selfMorsel.id, ...peers.map((p) => opts.swarmMorsels[p.index].id)],
      timestamp: Date.now(),
      drift,
      usage,
    };
    await opts.compost.stash(revised);
    opts.onDone?.(i, revised);
    return revised;
  });

  const revisedMorsels = await Promise.all(jobs.map((fn) => fn()));
  return { revisedMorsels };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
