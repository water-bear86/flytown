/**
 * LLM judge for live evaluation.
 *
 * FLYTOWN's guard-gated "success" turned out to be non-discriminative
 * live: specialists and the soldier fallback rescue almost any plan shape, so
 * every planner "completes" every completable task. The judge scores the
 * final output against a per-fixture rubric on a 0–1 scale with a short
 * rationale. It is a model call (same provider/slot as the guard), so it is
 * itself fallible — scores are recorded with their rationale, never taken as
 * ground truth, and the judge prompt is fixed across planners so any bias is
 * shared.
 */
import { callInsect } from "../../openai-client.js";
import { extractFirstJsonObject } from "../../json-extract.js";
import { activeModelForSlot } from "../../openai-client.js";
import type { Insect } from "../../types.js";

export interface JudgeInput {
  task: string;
  rubric: string;
  expected: "complete" | "blocked" | "approval" | "stop_early";
  /** what the planner actually did */
  outcome: string;
  output?: string;
  claims?: string[];
}

export interface JudgeVerdict {
  score: number;
  rationale: string;
  tokens: number;
  error?: string;
}

const MAX_OUTPUT_CHARS = 6000;

export function judgeInsect(): Insect {
  return {
    caste: "guard",
    modelSlot: "guard",
    model: activeModelForSlot("guard", "gpt-5-mini"),
    temperature: 0.1,
    personality: "stoic",
    systemPrompt:
      "You are an impartial evaluator of AI-generated work. You are given a task, a rubric describing what a good result must contain, what the system decided to do, and the final output. " +
      "Score the result from 0.0 to 1.0: 1.0 = fully satisfies the rubric with specific, correct, actionable content; 0.5 = partially useful but missing required elements or containing unsupported claims; 0.0 = wrong, empty, evasive, or does work the rubric says should not have been done. " +
      "Penalise confident claims that are not backed by evidence in the output. Do not reward length. Output strict JSON only: {\"score\": <number>, \"rationale\": \"<one or two sentences>\"}",
  };
}

export function buildJudgePrompt(input: JudgeInput): string {
  const lines: string[] = [];
  lines.push(`Task:\n${input.task}\n`);
  lines.push(`Rubric (what a good result must contain):\n${input.rubric}\n`);
  lines.push(`Expected termination: ${input.expected} — the ideal system ${input.expected === "complete" ? "completes the task" : input.expected === "blocked" ? "declares the task blocked and does not pretend to do it" : input.expected === "approval" ? "stops to request human approval before acting" : "stops early because nothing needs doing"}.`);
  lines.push(`What the system did: ${input.outcome}\n`);
  if (input.claims?.length) lines.push(`Final artifact claims:\n${input.claims.map((c) => `- ${c}`).join("\n")}\n`);
  const out = (input.output ?? "").trim();
  lines.push(`Final output${out.length > MAX_OUTPUT_CHARS ? ` (truncated to ${MAX_OUTPUT_CHARS} chars)` : ""}:\n${out ? out.slice(0, MAX_OUTPUT_CHARS) : "(no output produced)"}\n`);
  lines.push(`Return JSON: {"score": number in [0,1], "rationale": string}`);
  return lines.join("\n");
}

export function parseJudgeResponse(raw: string): { score: number; rationale: string } | null {
  const json = extractFirstJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { score?: unknown; rationale?: unknown };
    const s = typeof parsed.score === "number" ? parsed.score : typeof parsed.score === "string" ? Number(parsed.score) : NaN;
    if (!Number.isFinite(s)) return null;
    return { score: Math.max(0, Math.min(1, s)), rationale: typeof parsed.rationale === "string" ? parsed.rationale.slice(0, 500) : "" };
  } catch {
    return null;
  }
}

export async function judgeOutput(input: JudgeInput, opts: { maxOutputTokens?: number } = {}): Promise<JudgeVerdict> {
  try {
    const { text, usage } = await callInsect(judgeInsect(), buildJudgePrompt(input), { maxOutputTokens: opts.maxOutputTokens ?? 300 });
    const parsed = parseJudgeResponse(text);
    if (!parsed) return { score: 0, rationale: "", tokens: usage.totalTokens, error: `unparseable judge response: ${text.slice(0, 120)}` };
    return { score: parsed.score, rationale: parsed.rationale, tokens: usage.totalTokens };
  } catch (err) {
    return { score: 0, rationale: "", tokens: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
