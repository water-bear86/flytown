import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { serve, type ServeHandle } from "../server.js";
import { initWarren } from "../warren.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let handle: ServeHandle | undefined;
let warrenRoot: string | undefined;

async function startApp(): Promise<string> {
  warrenRoot = await mkdtemp(join(tmpdir(), "goblintown-app-test-"));
  await initWarren(warrenRoot);
  handle = await serve({ cwd: warrenRoot, port: 0 });
  return handle.url;
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  if (warrenRoot) await rm(warrenRoot, { recursive: true, force: true });
  warrenRoot = undefined;
});

describe("Tank app smoke", () => {
  it("bundles the approved shell state icons", () => {
    for (const asset of [
      "fullgoblinchat.svg",
      "sttgoblinchat.svg",
      "textgoblinchat.svg",
      "ttsonlygoblinchat.svg",
      "settingsclosed.svg",
      "settingsopen.svg",
    ]) {
      assert.equal(existsSync(join(repoRoot, "site/assets", asset)), true, `${asset} should be bundled`);
    }
  });

  it("returns useful app API errors instead of a broken chat state", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/api/chat", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "assistant", content: "ready" }] }),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "messages must end with a user message" });
  });

  it("persists onboarding dismissal on the server so it does not return every launch", async () => {
    const url = await startApp();
    const initial = await fetch(new URL("/api/onboarding", url));
    const initialBody = await initial.json();

    assert.equal(initial.status, 200);
    assert.equal(initialBody.done, false);

    const saved = await fetch(new URL("/api/onboarding", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    const savedBody = await saved.json();
    const after = await fetch(new URL("/api/onboarding", url));
    const afterBody = await after.json();

    assert.equal(saved.status, 200);
    assert.equal(savedBody.done, true);
    assert.equal(afterBody.done, true);
  });

  it("reports the Tank identity for MCP port ownership checks", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/api/identity", url));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.root, warrenRoot);
    assert.equal(body.scope, "project");
    assert.equal(body.autopilot, true);
    assert.match(String(body.manifestPath), /\.goblintown\/warren\.json$/);
  });
});
