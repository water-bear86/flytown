import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildSingleForagerChatPrompt,
  collectChatWebToolResults,
  detectFlightOffer,
  extractChatWebUrls,
  normalizeLikelyChatUrls,
  normalizeChatMessages,
} from "../chat.js";

describe("single forager chat", () => {
  it("normalizes only user and assistant messages", () => {
    const messages = normalizeChatMessages([
      { role: "system", content: "ignored" },
      { role: "user", content: "  hello  " },
      { role: "assistant", content: "hi" },
      { role: "user", content: "" },
      null,
    ]);

    assert.deepEqual(messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("builds a single-forager prompt from chat history", () => {
    const prompt = buildSingleForagerChatPrompt([
      { role: "user", content: "What changed?" },
      { role: "assistant", content: "The route changed." },
      { role: "user", content: "Summarize it." },
    ]);

    assert.match(prompt, /AI-first single-forager chat mode/);
    assert.match(prompt, /regular single LLM model call/);
    assert.match(prompt, /Do not run multi-agent FLYTOWN orchestration/);
    assert.match(prompt, /FLYTOWN vocabulary/);
    assert.match(prompt, /A flight is a full FLYTOWN run/);
    assert.match(prompt, /The web control surface \(`flytown serve`\) is the main app surface/);
    assert.match(prompt, /A morsel is a saved model output/);
    assert.match(prompt, /Be useful first, with a little FLYTOWN-native bite/);
    assert.match(prompt, /User: What changed\?/);
    assert.match(prompt, /Assistant: The route changed\./);
    assert.match(prompt, /User: Summarize it\./);
  });

  it("extracts public web URLs from the latest chat message", () => {
    const urls = extractChatWebUrls([
      { role: "user", content: "ignore https://old.example/a" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Check https://github.com/example/flytown, then https://example.com/docs." },
    ]);

    assert.deepEqual(urls, [
      "https://github.com/example/flytown",
      "https://example.com/docs",
    ]);
  });

  it("normalizes obvious GitHub issue URL typo suffixes", () => {
    assert.equal(
      normalizeLikelyChatUrls("Run https://github.com/aeyakovenko/percolator-cli/issues/72g please"),
      "Run https://github.com/aeyakovenko/percolator-cli/issues/72 please",
    );
    assert.deepEqual(
      extractChatWebUrls([
        { role: "user", content: "Solve https://github.com/aeyakovenko/percolator-cli/issues/72g" },
      ]),
      ["https://github.com/aeyakovenko/percolator-cli/issues/72"],
    );
    assert.equal(
      detectFlightOffer([
        { role: "user", content: "Lets run a flight to solve this bounty: https://github.com/aeyakovenko/percolator-cli/issues/72g" },
      ])?.task,
      "Lets run a flight to solve this bounty: https://github.com/aeyakovenko/percolator-cli/issues/72",
    );
  });

  it("adds fetched website context to the single-forager prompt", async () => {
    const results = await collectChatWebToolResults(
      [{ role: "user", content: "What is on https://github.com/example/repo?" }],
      async () =>
        new Response("<html><title>Repo Page</title><body><h1>Example Repo</h1><p>Important README text.</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const prompt = buildSingleForagerChatPrompt(
      [{ role: "user", content: "What is on https://github.com/example/repo?" }],
      results,
    );

    assert.equal(results.length, 1);
    assert.match(prompt, /Web tool results/);
    assert.match(prompt, /https:\/\/github.com\/example\/repo/);
    assert.match(prompt, /Repo Page/);
    assert.match(prompt, /Important README text/);
    assert.match(prompt, /cite the relevant URL/);
  });

  it("offers FLYTOWN for explicit requests", () => {
    const offer = detectFlightOffer([
      { role: "user", content: "Run FLYTOWN on this migration plan." },
    ]);

    assert.deepEqual(offer, {
      task: "Run FLYTOWN on this migration plan.",
      requested: true,
      reason: "explicit",
    });
  });

  it("treats explicit flight requests as run requests", () => {
    const offer = detectFlightOffer([
      { role: "user", content: "Run a flight about whether the Beatles are good." },
    ]);

    assert.deepEqual(offer, {
      task: "Run a flight about whether the Beatles are good.",
      requested: true,
      reason: "explicit",
    });
  });

  it("does not treat an ordinary mention of a flight as a run request", () => {
    const offer = detectFlightOffer([
      { role: "user", content: "What is the cheapest flight to Lisbon?" },
    ]);

    assert.equal(offer, undefined);
  });

  it("uses the previous user task for bare flight follow-ups", () => {
    const offer = detectFlightOffer([
      { role: "user", content: "Is Abbey Road better than Revolver?" },
      { role: "assistant", content: "Short answer: close call." },
      { role: "user", content: "do a flight" },
    ]);

    assert.deepEqual(offer, {
      task: "Is Abbey Road better than Revolver?",
      requested: true,
      reason: "explicit",
    });
  });

  it("offers FLYTOWN for complex tasks without auto-running it", () => {
    const offer = detectFlightOffer([
      {
        role: "user",
        content:
          "Audit this production migration plan, compare the risks, design a rollback strategy, and identify likely edge cases before implementation.",
      },
    ]);

    assert.equal(offer?.requested, false);
    assert.equal(offer?.reason, "complex");
  });

  it("does not offer FLYTOWN for simple chat", () => {
    const offer = detectFlightOffer([
      { role: "user", content: "What is this repo?" },
    ]);

    assert.equal(offer, undefined);
  });

  it("rejects prompts without a latest user message", () => {
    assert.throws(
      () => buildSingleForagerChatPrompt([{ role: "assistant", content: "ready" }]),
      /latest user message/,
    );
  });
});
