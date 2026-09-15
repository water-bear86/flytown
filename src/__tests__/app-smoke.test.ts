import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { RESEARCH_WALLETS, researchSiteHtml } from "../flytown/site.js";
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
    assert.match(html, /<button class="site-nav__fund-trigger" type="button" aria-expanded="false" aria-controls="fund-panel">/);
    assert.match(html, />Fund<span class="site-nav__fund-label-rest"> the Research<\/span>/);
    assert.match(html, /<div class="site-nav__fund-panel" id="fund-panel" role="group" aria-label="Research funding wallets">/);
    assert.match(html, />79TNuyFNZWhDeFF1RUNA5Xk9Pccvb7xPYqLukBxCeWbb<\/code>/);
    assert.match(html, />0xa2c0abd1a1fcb5aee12f80651ae7f646371a66ed<\/code>/);
    assert.doesNotMatch(html, /data-copy-ca|site-nav__ca|FLYTOWN contract address|FLYTOWN CA/);
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
    assert.match(html, /Six attempts\. Three brains\. The same answer\./);
    assert.match(html, /The male brain did no better than its shuffled copy\./);
    assert.match(html, /<code>p = 0\.504<\/code>/);
    assert.match(html, /The adult code beat shuffling, but not rewiring\./);
    assert.match(html, /The wiring was real\. The advantage wasn’t\./);
    assert.match(html, /measured biological wiring/);
    assert.match(html, /tested computational advantage was null/);
    assert.match(html, /not a universal claim about biology/);
    assert.match(html, /Join the FLYTOWN community on X/);
    assert.match(html, />Fund<span class="site-nav__fund-label-rest"> the Research<\/span>/);
    assert.match(html, /aria-label="Copy Solana wallet address"/);
    assert.match(html, /aria-label="Copy EVM wallet address"/);
  });

  it("shows the same wallets as the README's Donate section", async () => {
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    const donate = readme.slice(readme.lastIndexOf("## Donate"));
    assert.ok(donate.startsWith("## Donate"), "README ends with a Donate section");
    const readmeWallets = Object.fromEntries([...donate.matchAll(/^(sol|evm): (\S+)$/gm)].map((m) => [m[1].toUpperCase(), m[2]]));
    assert.deepEqual(Object.fromEntries(RESEARCH_WALLETS.map((w) => [w.chain, w.address])), readmeWallets);
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
