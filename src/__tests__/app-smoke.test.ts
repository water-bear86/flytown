import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { researchSiteHtml } from "../flytown/site.js";
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
  it("renders a hosted public-site variant without exposing the local console", () => {
    const html = researchSiteHtml({
      consoleHref: "https://github.com/water-bear86/flytown/blob/master/docs/install/from-source.md",
      consoleLabel: "Run locally",
      consoleCtaLabel: "Run FLYTOWN locally",
    });

    assert.match(html, />Run locally<\/a>/);
    assert.match(html, />Run FLYTOWN locally<\/a>/);
    assert.match(html, /docs\/install\/from-source\.md/);
    assert.match(html, /https:\/\/github\.com\/water-bear86\/flytown/);
    assert.match(html, /https:\/\/x\.com\/i\/communities\/2017600885900062998/);
    assert.match(html, /data-copy-ca="Gzj71jijFzPhsDB3N7gV4CKpx69jaPsHS5cV4aSypump"/);
    assert.doesNotMatch(html, /href="\/fly"/);
  });

  it("serves the public research findings at /", async () => {
    const url = await startApp();
    const response = await fetch(url);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /\$FLYBRAIN didn’t launch itself/);
    assert.match(html, /The lie is the verb/);
    assert.match(html, /The token is real\. The agency story is not\./);
    assert.match(html, /The rig completed every decisive operation\./);
    assert.match(html, /cec385e7bf9fb8eca9898f48be5a327bcf6d9408/);
    assert.match(html, /rhprovider\.py#L178-L247/);
    assert.match(html, /Open full-resolution diagram/);
    assert.match(html, /Four attempts\. Three jobs\. The same answer\./);
    assert.match(html, /The wiring was real\. The advantage wasn’t\./);
    assert.match(html, /measured biological wiring/);
    assert.match(html, /tested computational advantage was null/);
    assert.match(html, /not a universal claim about biology/);
    assert.match(html, /Join the FLYTOWN community on X/);
    assert.match(html, /Copy FLYTOWN contract address/);
  });

  it("preserves the operational control surface at /fly", async () => {
    const url = await startApp();
    const response = await fetch(new URL("/fly", url));
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /<h1>FLYTOWN<\/h1>/);
    assert.match(html, /\/api\/flight\//);
  });

  it("serves self-hosted public-site assets under the existing CSP", async () => {
    const url = await startApp();
    const [styles, script, tokens, image, adultDiagram, larvalDiagram] = await Promise.all([
      fetch(new URL("/site/site.css", url)),
      fetch(new URL("/site/site.js", url)),
      fetch(new URL("/site/tokens.css", url)),
      fetch(new URL("/site/flytown-mayor.webp", url)),
      fetch(new URL("/site/diagrams/adult-projectome-circle.svg", url)),
      fetch(new URL("/site/diagrams/larval-class-circle.svg", url)),
    ]);

    assert.equal(styles.status, 200);
    assert.equal(script.status, 200);
    assert.equal(tokens.status, 200);
    assert.equal(image.status, 200);
    assert.equal(adultDiagram.status, 200);
    assert.equal(larvalDiagram.status, 200);
    assert.match(styles.headers.get("content-type") ?? "", /text\/css/);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.match(tokens.headers.get("content-type") ?? "", /text\/css/);
    assert.match(image.headers.get("content-type") ?? "", /image\/webp/);
    assert.match(adultDiagram.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(larvalDiagram.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.doesNotMatch(String(styles.headers.get("content-security-policy")), /fonts\.googleapis|cdn\./);
    assert.match(await script.text(), /navigator\.clipboard\.writeText\(address\)/);
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
