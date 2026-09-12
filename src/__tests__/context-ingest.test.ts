import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, describe, it } from "node:test";
import {
  buildContextArtifact,
  ingestContextPath,
  listIngestibleContextFiles,
} from "../context-ingest.js";
import { Compost } from "../compost.js";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flytown-context-"));
  tmpRoots.push(root);
  return root;
}

after(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("context ingestion", () => {
  it("builds stable file-backed artifacts from local text", () => {
    const artifact = buildContextArtifact({
      root: "/tmp/project",
      filePath: "/tmp/project/old-conversation.md",
      content:
        "# Swarm Mode\n\nCodex should expose slash commands and a compact plan view only for multi-agent runs.",
      timestamp: 1_700_000_000_000,
    });

    const again = buildContextArtifact({
      root: "/tmp/project",
      filePath: "/tmp/project/old-conversation.md",
      content:
        "# Swarm Mode\n\nCodex should expose slash commands and a compact plan view only for multi-agent runs.",
      timestamp: 9_999,
    });

    assert.equal(artifact.id, again.id);
    assert.match(artifact.id, /^ctx-[a-f0-9]{16}$/);
    assert.equal(artifact.flightId, `context:${artifact.id.slice(4)}`);
    assert.equal(artifact.outcome, "winner");
    assert.match(artifact.task, /old-conversation\.md/);
    assert.equal(artifact.evidence[0].kind, "file");
    assert.equal(artifact.evidence[0].ref, "old-conversation.md");
    assert.ok(artifact.evidence[0].snippet?.includes("Swarm Mode"));
    assert.ok(artifact.claims[0].text.includes("Swarm Mode"));
    assert.ok(artifact.keywords.includes("swarm"));
    assert.ok(artifact.keywords.includes("codex"));
  });

  it("lists only ingestible project files and skips generated folders", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".flytown", "compost"), { recursive: true });
    await writeFile(join(root, "notes", "codex.md"), "Codex swarm mode notes", "utf8");
    await writeFile(join(root, "notes", "binary.png"), "not really a png", "utf8");
    await writeFile(join(root, "node_modules", "pkg", "README.md"), "ignore", "utf8");
    await writeFile(join(root, ".flytown", "compost", "artifact.md"), "ignore", "utf8");

    const files = await listIngestibleContextFiles({ root, inputPath: root });

    assert.deepEqual(files.map((file) => file.relativePath), ["notes/codex.md"]);
  });

  it("stashes ingested artifacts into the Compost", async () => {
    const root = await tempRoot();
    const compost = new Compost(join(root, ".flytown", "compost"));
    await compost.init();
    await mkdir(join(root, "history"), { recursive: true });
    await writeFile(
      join(root, "history", "app-plan.md"),
      "The desktop app should keep single-forager mode separate from swarm mode.",
      "utf8",
    );
    await writeFile(
      join(root, "history", "project.json"),
      JSON.stringify({ project: "FLYTOWN", goal: "context memory" }),
      "utf8",
    );

    const result = await ingestContextPath({
      root,
      compost,
      inputPath: join(root, "history"),
      timestamp: 1_700_000_000_000,
    });

    assert.equal(result.artifacts.length, 2);
    assert.equal(result.skipped.length, 0);

    const all = await compost.allArtifacts();
    assert.equal(all.length, 2);
    assert.ok(all.some((artifact) => artifact.evidence[0].ref === "history/app-plan.md"));
    assert.ok(all.some((artifact) => artifact.evidence[0].ref === "history/project.json"));

    const stored = JSON.parse(
      await readFile(join(compost.artifactDir, `${result.artifacts[0].id}.json`), "utf8"),
    );
    assert.equal(stored.id, result.artifacts[0].id);
  });
});
