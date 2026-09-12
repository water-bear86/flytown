import { makeGuard } from "./castes.js";
import { measureDrift } from "./drift.js";
import { callInsect } from "./openai-client.js";
import {
  builtinTools,
  parseToolCallsJson,
  renderToolCatalog,
  renderToolResults,
  runToolCalls,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "./tools.js";
import type { Morsel, Personality, GuardVerdict } from "./types.js";
import type { Compost } from "./compost.js";

export interface GuardReviewOptions {
  foragerMorsel: Morsel;
  originalTask: string;
  stingMorsel?: Morsel;
  compost: Compost;
  personality?: Personality;
  flightId?: string;
  /** Phase 5: enable tool-use round before verdict. */
  withTools?: boolean;
  /** Custom tool registry (defaults to builtinTools). */
  tools?: ToolDefinition[];
  /** Optional callback so the orchestrator/UI can show tool calls. */
  onToolCalls?: (calls: ToolCall[]) => void;
  onToolResults?: (results: ToolResult[]) => void;
}

export interface GuardReviewResult {
  verdict: GuardVerdict;
  guardMorsel: Morsel;
}

export async function guardReview(opts: GuardReviewOptions): Promise<GuardReviewResult> {
  const guard = makeGuard(opts.personality);
  const stingBlock = opts.stingMorsel
    ? `\n\nWasp sting report (treat findings as evidence against passing):\n${opts.stingMorsel.output}`
    : "";

  // Phase 5: optional tool-use round. Guard first decides which (if any) tools
  // to call, we run them, results are appended to the verdict prompt.
  let toolBlock = "";
  if (opts.withTools) {
    const tools = opts.tools ?? builtinTools;
    const catalogPrompt =
      `Original task:\n${opts.originalTask}\n\n` +
      `Forager output:\n${opts.foragerMorsel.output}` +
      stingBlock +
      `\n\nYou may invoke tools to verify the output before scoring it. Available tools:\n` +
      renderToolCatalog(tools) +
      `\n\nIf tools would help, output a JSON array of calls: ` +
      `[{"name":"<tool>","args":{...}}, ...] (max 4). ` +
      `If no tools are needed, output []. JSON only.`;
    try {
      const { text: catalogRaw } = await callInsect(
        { ...guard, systemPrompt: guard.systemPrompt + " You are now planning tool calls." },
        catalogPrompt,
        { maxOutputTokens: 400 },
      );
      const calls = parseToolCallsJson(catalogRaw, 4);
      if (calls.length > 0) {
        opts.onToolCalls?.(calls);
        const results = await runToolCalls(calls, tools);
        opts.onToolResults?.(results);
        toolBlock = `\n\nVerifier-tool results:\n${renderToolResults(results)}`;
      }
    } catch {
      // tool-use is best-effort; fall through to plain verdict
    }
  }

  const userPrompt =
    `Original task:\n${opts.originalTask}\n\n` +
    `Forager output:\n${opts.foragerMorsel.output}` +
    stingBlock +
    toolBlock +
    `\n\nReply with a single JSON object: { "passed": boolean, "score": number 0-1, "critique": string }.`;

  const { text: raw, usage } = await callInsect(guard, userPrompt);
  const parsed = parseLooseJson(raw);
  const verdict: GuardVerdict = {
    morselId: opts.foragerMorsel.id,
    passed: typeof parsed?.passed === "boolean" ? parsed.passed : false,
    score: clamp01(typeof parsed?.score === "number" ? parsed.score : 0),
    critique:
      typeof parsed?.critique === "string"
        ? parsed.critique
        : "(guard critique unparseable)",
  };

  const drift = measureDrift(raw);
  const parents = [opts.foragerMorsel.id];
  if (opts.stingMorsel) parents.push(opts.stingMorsel.id);

  const guardMorsel: Morsel = {
    id: "",
    flightId: opts.flightId,
    caste: "guard",
    personality: guard.personality,
    model: guard.model,
    prompt: userPrompt,
    output: raw,
    parentMorselIds: parents,
    timestamp: Date.now(),
    drift,
    usage,
  };
  await opts.compost.stash(guardMorsel);

  return { verdict, guardMorsel };
}

function parseLooseJson(s: string): {
  passed?: unknown;
  score?: unknown;
  critique?: unknown;
} | null {
  try {
    return JSON.parse(s);
  } catch {
    // not pure JSON; try extracting an object
  }
  const match = s.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  return null;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
