import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");
const cliSource = readFileSync(join(repoRoot, "src", "cli.ts"), "utf8");
const packageJson = readFileSync(join(repoRoot, "package.json"), "utf8");

describe("app shell", () => {
  it("provides single-forager (ask) and swarm (plan) run endpoints", () => {
    assert.match(serverSource, /app\.post\("\/api\/ask"/);
    assert.match(serverSource, /app\.post\("\/api\/plan"/);
    assert.match(serverSource, /app\.post\("\/api\/flight"/);
  });

  it("keeps local context ingestion and search APIs available", () => {
    assert.match(serverSource, /app\.post\("\/api\/context\/ingest"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/search"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/chats\/scan"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/chats\/import"/);
    assert.match(serverSource, /app\.post\("\/api\/context\/vectorize"/);
  });

  it("lets the CLI accept slash commands", () => {
    assert.match(cliSource, /parseSlashCommand/);
    assert.match(cliSource, /cmdSlash/);
    assert.match(cliSource, /cmd\.startsWith\("\/"\)/);
    assert.match(cliSource, /cmdContext/);
    assert.match(cliSource, /cmdContextScanChats/);
    assert.match(cliSource, /cmdContextImportChats/);
    assert.match(cliSource, /cmdContextVectorize/);
  });

  it("adds desktop application scripts and Electron metadata", () => {
    assert.match(packageJson, /"desktop"/);
    assert.match(packageJson, /"package:mac"/);
    assert.match(packageJson, /"dist:mac"/);
    assert.match(packageJson, /"dist:win"/);
    assert.match(packageJson, /"dist:linux"/);
    assert.match(packageJson, /"dist:desktop"/);
    assert.match(packageJson, /"electron"/);
    assert.match(packageJson, /"electron-builder"/);
    assert.match(packageJson, /"@electron\/packager"/);
    assert.match(packageJson, /"AppImage"/);
    assert.match(packageJson, /"nsis"/);
  });
});
