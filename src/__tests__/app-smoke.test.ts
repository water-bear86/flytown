import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { serve, type ServeHandle } from "../server.js";
import { initTerrarium } from "../terrarium.js";

let handle: ServeHandle | undefined;
let terrariumRoot: string | undefined;

async function startApp(): Promise<string> {
  terrariumRoot = await mkdtemp(join(tmpdir(), "flytown-app-test-"));
  await initTerrarium(terrariumRoot);
  handle = await serve({ cwd: terrariumRoot, port: 0 });
  return handle.url;
}

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  if (terrariumRoot) await rm(terrariumRoot, { recursive: true, force: true });
  terrariumRoot = undefined;
});

describe("app smoke", () => {
  it("serves the FLYTOWN control surface at /", async () => {
    const url = await startApp();
    const response = await fetch(url);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<h1>FLYTOWN<\/h1>/);
    assert.match(html, /\/api\/flight\//);
  });

  it("does not serve a Firebase client config", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/api/firebase/config", url));

    assert.equal(response.status, 404);
    assert.doesNotMatch(String(response.headers.get("content-security-policy")), /firebase|googleapis|gstatic/);
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

  it("labels what each selected action did to the plan", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/api/fly/plan", url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planner: "rules", task: "Fix the off-by-one in the pagination helper and add a regression test" }),
    });
    const body = await response.json() as { trace: { decision: { primary: string; included: string[] } }; effects: { action: string; primary: boolean; effect: string }[] };

    assert.equal(response.status, 200);
    assert.equal(body.effects.length, 1 + body.trace.decision.included.length);
    assert.equal(body.effects[0].action, body.trace.decision.primary);
    assert.equal(body.effects[0].primary, true);
    for (const e of body.effects) assert.ok(["shaped", "default", "inert"].includes(e.effect), e.effect);
  });

});
