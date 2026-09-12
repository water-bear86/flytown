import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  commandToCliArgs,
  commandToRunRequest,
  parseSlashCommand,
} from "../slash-commands.js";

describe("slash commands", () => {
  it("treats plain text as the selected default mode", () => {
    const parsed = parseSlashCommand("summarize this repository", {
      mode: "single",
    });

    assert.equal(parsed.kind, "run");
    assert.equal(parsed.mode, "single");
    assert.equal(parsed.task, "summarize this repository");
  });

  it("parses quoted /ask tasks as single-forager runs", () => {
    const parsed = parseSlashCommand('/ask "write the shortest useful answer"', {
      mode: "swarm",
    });

    assert.equal(parsed.kind, "ask");
    assert.equal(parsed.mode, "single");
    assert.equal(parsed.task, "write the shortest useful answer");
  });

  it("parses /swarm as swarm mode", () => {
    const parsed = parseSlashCommand('/swarm "ship a desktop app wrapper"', {
      mode: "single",
    });

    assert.equal(parsed.kind, "swarm");
    assert.equal(parsed.mode, "swarm");
    assert.equal(parsed.task, "ship a desktop app wrapper");
  });

  it("builds server run requests for single and swarm commands", () => {
    assert.deepEqual(
      commandToRunRequest(parseSlashCommand("/ask fix docs")),
      {
        endpoint: "/api/ask",
        payload: { task: "fix docs", remember: true, outputFormat: "markdown" },
        mode: "single",
      },
    );

    assert.deepEqual(
      commandToRunRequest(parseSlashCommand("/swarm fix docs")),
      {
        endpoint: "/api/plan",
        payload: {
          task: "fix docs",
          maxNodes: 6,
          maxReplan: 2,
          remember: true,
          outputFormat: "markdown",
        },
        mode: "swarm",
      },
    );
  });

  it("maps slash commands to existing CLI commands", () => {
    assert.deepEqual(commandToCliArgs(parseSlashCommand("/ask hello")), [
      "ask",
      "forager",
      "--task",
      "hello",
      "--format",
      "markdown",
    ]);
    assert.deepEqual(commandToCliArgs(parseSlashCommand("/swarm hello")), [
      "plan",
      "hello",
      "--remember",
      "--format",
      "markdown",
    ]);
  });

  it("parses context ingest and search commands without forcing an AI run", () => {
    const ingest = parseSlashCommand('/context ingest "./old conversations" --limit 12');
    assert.equal(ingest.kind, "context");
    assert.equal(ingest.task, 'ingest ./old conversations --limit 12');
    assert.deepEqual(ingest.args, ["ingest", "./old conversations", "--limit", "12"]);

    const search = parseSlashCommand('/context search "desktop app swarm"');
    assert.equal(search.kind, "context");
    assert.equal(search.task, "search desktop app swarm");
    assert.deepEqual(search.args, ["search", "desktop app swarm"]);
  });
});
