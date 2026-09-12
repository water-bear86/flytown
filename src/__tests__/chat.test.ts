import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  buildSingleGoblinChatPrompt,
  collectChatWebToolResults,
  detectGoblintownOffer,
  extractChatWebUrls,
  normalizeLikelyChatUrls,
  normalizeChatMessages,
} from "../chat.js";

describe("single goblin chat", () => {
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

  it("builds a single-goblin prompt from chat history", () => {
    const prompt = buildSingleGoblinChatPrompt([
      { role: "user", content: "What changed?" },
      { role: "assistant", content: "The route changed." },
      { role: "user", content: "Summarize it." },
    ]);

    assert.match(prompt, /AI-first single Goblin chat mode/);
    assert.match(prompt, /regular single LLM model call/);
    assert.match(prompt, /Do not run multi-agent Goblintown orchestration/);
    assert.match(prompt, /Goblintown vocabulary/);
    assert.match(prompt, /A rite is a full Goblintown run/);
    assert.match(prompt, /The Tank is the main app surface/);
    assert.match(prompt, /Loot is a saved model output/);
    assert.match(prompt, /Be useful first, with a little Goblintown-native bite/);
    assert.match(prompt, /User: What changed\?/);
    assert.match(prompt, /Assistant: The route changed\./);
    assert.match(prompt, /User: Summarize it\./);
  });

  it("extracts public web URLs from the latest chat message", () => {
    const urls = extractChatWebUrls([
      { role: "user", content: "ignore https://old.example/a" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Check https://github.com/0xbl33p/goblintown, then https://example.com/docs." },
    ]);

    assert.deepEqual(urls, [
      "https://github.com/0xbl33p/goblintown",
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
      detectGoblintownOffer([
        { role: "user", content: "Lets run a rite to solve this bounty: https://github.com/aeyakovenko/percolator-cli/issues/72g" },
      ])?.task,
      "Lets run a rite to solve this bounty: https://github.com/aeyakovenko/percolator-cli/issues/72",
    );
  });

  it("adds fetched website context to the single-goblin prompt", async () => {
    const results = await collectChatWebToolResults(
      [{ role: "user", content: "What is on https://github.com/example/repo?" }],
      async () =>
        new Response("<html><title>Repo Page</title><body><h1>Example Repo</h1><p>Important README text.</p></body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const prompt = buildSingleGoblinChatPrompt(
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

  it("offers Goblintown for explicit requests", () => {
    const offer = detectGoblintownOffer([
      { role: "user", content: "Run Goblintown on this migration plan." },
    ]);

    assert.deepEqual(offer, {
      task: "Run Goblintown on this migration plan.",
      requested: true,
      reason: "explicit",
    });
  });

  it("treats explicit rite requests as run requests", () => {
    const offer = detectGoblintownOffer([
      { role: "user", content: "Run a rite about whether the Beatles are good." },
    ]);

    assert.deepEqual(offer, {
      task: "Run a rite about whether the Beatles are good.",
      requested: true,
      reason: "explicit",
    });
  });

  it("uses the previous user task for bare rite follow-ups", () => {
    const offer = detectGoblintownOffer([
      { role: "user", content: "Is Abbey Road better than Revolver?" },
      { role: "assistant", content: "Short answer: close call." },
      { role: "user", content: "do a rite" },
    ]);

    assert.deepEqual(offer, {
      task: "Is Abbey Road better than Revolver?",
      requested: true,
      reason: "explicit",
    });
  });

  it("offers Goblintown for complex tasks without auto-running it", () => {
    const offer = detectGoblintownOffer([
      {
        role: "user",
        content:
          "Audit this production migration plan, compare the risks, design a rollback strategy, and identify likely edge cases before implementation.",
      },
    ]);

    assert.equal(offer?.requested, false);
    assert.equal(offer?.reason, "complex");
  });

  it("does not offer Goblintown for simple chat", () => {
    const offer = detectGoblintownOffer([
      { role: "user", content: "What is this repo?" },
    ]);

    assert.equal(offer, undefined);
  });

  it("rejects prompts without a latest user message", () => {
    assert.throws(
      () => buildSingleGoblinChatPrompt([{ role: "assistant", content: "ready" }]),
      /latest user message/,
    );
  });
});
