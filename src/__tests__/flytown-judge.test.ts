import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildJudgePrompt, parseJudgeResponse } from "../flytown/eval/judge.js";
import { FIXTURES, RUBRICS, rubricFor } from "../flytown/eval/fixtures.js";

describe("LLM judge", () => {
  it("every fixture has a specific rubric", () => {
    for (const f of FIXTURES) assert.ok(RUBRICS[f.id], `missing rubric for ${f.id}`);
    assert.ok(rubricFor({ ...FIXTURES[0], id: "nope" }).includes("no fabricated evidence"));
  });
  it("parses strict and sloppy judge responses and clamps the score", () => {
    assert.deepEqual(parseJudgeResponse('{"score": 0.7, "rationale": "ok"}'), { score: 0.7, rationale: "ok" });
    assert.deepEqual(parseJudgeResponse('Sure! {"score": "1.4", "rationale": "great"} thanks'), { score: 1, rationale: "great" });
    assert.equal(parseJudgeResponse("no json here"), null);
    assert.equal(parseJudgeResponse('{"score": "abc"}'), null);
  });
  it("builds a prompt that carries task, rubric, expected termination and truncated output", () => {
    const p = buildJudgePrompt({ task: "T", rubric: "R", expected: "blocked", outcome: "did X", output: "x".repeat(10_000), claims: ["c1"] });
    assert.ok(p.includes("Task:\nT"));
    assert.ok(p.includes("Rubric"));
    assert.ok(p.includes("declares the task blocked"));
    assert.ok(p.includes("- c1"));
    assert.ok(p.includes("truncated to 6000"));
    assert.ok(p.length < 8000);
  });
});
