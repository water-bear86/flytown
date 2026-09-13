import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { applyProviderPreset, describeProvider } from "../provider-setup.js";
import { resolveProviderRuntime, resolveProviderRuntimeForSlot } from "../providers.js";
import { setProviderSecretForRoot } from "../provider-secrets.js";
import { initTerrarium, saveTerrariumManifest } from "../terrarium.js";
import { preflightProvider } from "../flytown/eval/harness.js";

const NO_ENV = {};
const cleanup: string[] = [];
after(async () => { for (const d of cleanup) await rm(d, { recursive: true, force: true }); });

describe("provider presets carry the request fields they need", () => {
  it("DeepSeek disables thinking without any terrarium config", () => {
    const runtime = resolveProviderRuntime({ preset: "deepseek" }, NO_ENV, {});
    assert.deepEqual(runtime.requestParams, { thinking: { type: "disabled" } });
    assert.equal(resolveProviderRuntime({ preset: "openai" }, NO_ENV, {}).requestParams, undefined);
  });
  it("a terrarium's own requestParams override the preset's", () => {
    const runtime = resolveProviderRuntime({ preset: "deepseek", requestParams: { thinking: { type: "enabled" }, top_k: 5 } }, NO_ENV, {});
    assert.deepEqual(runtime.requestParams, { thinking: { type: "enabled" }, top_k: 5 });
  });
  it("a slot routed to DeepSeek gets the preset's fields even under another global provider", () => {
    const runtime = resolveProviderRuntimeForSlot("forager", { preset: "openai", routes: { forager: { preset: "deepseek" } } }, NO_ENV, {});
    assert.deepEqual(runtime.requestParams, { thinking: { type: "disabled" } });
  });
});

describe("applyProviderPreset", () => {
  it("points every chat slot at one model and resets routes", () => {
    const current = { preset: "openai" as const, routes: { guard: { preset: "groq" as const, model: "x" } }, models: { forager: "old" } };
    const next = applyProviderPreset(current, "deepseek", { model: "deepseek-v4-flash" });
    assert.equal(next.preset, "deepseek");
    assert.equal(next.apiKeyEnv, "DEEPSEEK_API_KEY");
    assert.equal(next.routes, undefined);
    assert.equal(next.models?.forager, "deepseek-v4-flash");
    assert.equal(next.models?.soldier, "deepseek-v4-flash");
    assert.equal(next.models?.embedding, undefined, "the embedding slot keeps the preset default");
    assert.ok(applyProviderPreset(current, "deepseek", { keepRoutes: true }).routes?.guard);
    assert.equal(applyProviderPreset(current, "deepseek", { soldierModel: "deepseek-v4-pro" }).models?.soldier, "deepseek-v4-pro");
  });
  it("drops provider-specific request fields when switching providers, keeps them otherwise", () => {
    const deepseek = { preset: "deepseek" as const, requestParams: { thinking: { type: "enabled" } } };
    assert.equal(applyProviderPreset(deepseek, "openai").requestParams, undefined);
    assert.deepEqual(applyProviderPreset(deepseek, "deepseek").requestParams, { thinking: { type: "enabled" } });
  });
  it("requires a base URL for the custom preset", () => {
    assert.throws(() => applyProviderPreset(undefined, "custom"), /base-url/);
    assert.equal(applyProviderPreset(undefined, "custom", { baseURL: "http://127.0.0.1:9/v1" }).baseURL, "http://127.0.0.1:9/v1");
  });
  it("describes the result without ever printing a key", () => {
    const config = applyProviderPreset(undefined, "deepseek");
    const missing = describeProvider(config, NO_ENV, {});
    assert.equal(missing.missingApiKey, "DEEPSEEK_API_KEY");
    assert.match(missing.lines.join("\n"), /flytown secret set DEEPSEEK_API_KEY/);
    const stored = describeProvider(config, NO_ENV, { DEEPSEEK_API_KEY: "sk-test-value-that-must-not-appear" });
    assert.equal(stored.missingApiKey, undefined);
    assert.doesNotMatch(stored.lines.join("\n"), /sk-test-value/);
  });
});

describe("a one-step DeepSeek setup sends what DeepSeek needs", () => {
  it("the live preflight reaches the provider with the model, key and thinking disabled", async () => {
    const seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const server: Server = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        seen.url = req.url; seen.auth = req.headers.authorization; seen.body = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 0, model: seen.body.model, choices: [{ index: 0, message: { role: "assistant", content: "ready" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const root = await mkdtemp(join(tmpdir(), "flytown-provider-"));
      cleanup.push(root);
      const w = await initTerrarium(root);
      w.manifest.provider = applyProviderPreset(w.manifest.provider, "deepseek", { model: "deepseek-v4-flash", baseURL: `http://127.0.0.1:${port}` });
      await saveTerrariumManifest(w);
      await setProviderSecretForRoot(root, "DEEPSEEK_API_KEY", "test-key-not-real");
      const result = await preflightProvider(root);
      assert.equal(result.ok, true, result.error);
      assert.equal(seen.url, "/chat/completions");
      assert.equal(seen.auth, "Bearer test-key-not-real");
      assert.equal(seen.body?.model, "deepseek-v4-flash");
      assert.deepEqual(seen.body?.thinking, { type: "disabled" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
