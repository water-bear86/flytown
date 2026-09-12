import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { serve, type ServeHandle } from "../server.js";
import { initTerrarium } from "../terrarium.js";
import { hostnameOf } from "../local-guard.js";

/**
 * The local server can spend the user's API budget, read files into memory
 * and change the provider's base URL and API key. These tests pin the
 * boundary so it cannot quietly regress: loopback-only binding, no remote
 * command execution, and refusal of foreign hosts and cross-site writes.
 */

let handle: ServeHandle;
let root: string;
let port: number;

/** Raw request so Host / Origin / Sec-Fetch-Site can be set exactly (fetch forbids some of these). */
function raw(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "flytown-security-"));
  await initTerrarium(root);
  handle = await serve({ cwd: root, port: 0, quiet: true });
  port = Number(new URL(handle.url).port);
});

after(async () => {
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

describe("local server boundary", () => {
  it("binds to loopback by default, not to every interface", () => {
    assert.match(handle.url, /^http:\/\/(127\.0\.0\.1|localhost):\d+/);
  });

  it("no longer exposes remote command execution or the removed shell endpoints", async () => {
    const host = `127.0.0.1:${port}`;
    const json = { "Content-Type": "application/json", Host: host };
    assert.equal((await raw({ method: "POST", path: "/api/cli", headers: json, body: JSON.stringify({ line: "secret list" }) })).status, 404);
    assert.equal((await raw({ method: "POST", path: "/api/asteroid", headers: json, body: JSON.stringify({ confirm: "ASTEROID" }) })).status, 404);
    assert.equal((await raw({ path: "/api/onboarding", headers: { Host: host } })).status, 404);
    assert.equal((await raw({ path: "/api/identity", headers: { Host: host } })).status, 404);
  });

  it("refuses requests addressed to a foreign Host (DNS rebinding)", async () => {
    const res = await raw({ path: "/api/fly/planners", headers: { Host: `attacker.example:${port}` } });
    assert.equal(res.status, 403);
    assert.equal((await raw({ path: "/api/fly/planners", headers: { Host: `localhost:${port}` } })).status, 200);
    assert.equal((await raw({ path: "/api/fly/planners", headers: { Host: `127.0.0.1:${port}` } })).status, 200);
  });

  it("refuses cross-origin and cross-site writes (CSRF)", async () => {
    const host = `127.0.0.1:${port}`;
    const body = JSON.stringify({ task: "" });
    const crossOrigin = await raw({ method: "POST", path: "/api/fly/plan", headers: { Host: host, "Content-Type": "application/json", Origin: "https://attacker.example" }, body });
    assert.equal(crossOrigin.status, 403);
    const crossSite = await raw({ method: "POST", path: "/api/fly/plan", headers: { Host: host, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, body });
    assert.equal(crossSite.status, 403);
    const provider = await raw({ method: "POST", path: "/api/provider", headers: { Host: host, "Content-Type": "application/json", Origin: "http://evil.localhost.example" }, body: JSON.stringify({ baseURL: "https://attacker.example/v1" }) });
    assert.equal(provider.status, 403, "provider base URL / key cannot be changed cross-origin");
  });

  it("refuses non-JSON write bodies that browsers can send without a preflight", async () => {
    const res = await raw({ method: "POST", path: "/api/fly/plan", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "text/plain" }, body: JSON.stringify({ task: "x" }) });
    assert.equal(res.status, 415);
  });

  it("still serves the app's own same-origin requests", async () => {
    const host = `127.0.0.1:${port}`;
    const res = await raw({ method: "POST", path: "/api/fly/plan", headers: { Host: host, "Content-Type": "application/json", Origin: `http://${host}`, "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ task: "" }) });
    assert.equal(res.status, 400, "reaches the handler (400: task is required), i.e. not blocked by the guard");
    assert.equal((await raw({ path: "/", headers: { Host: host } })).status, 200);
  });
});

describe("hostnameOf", () => {
  it("strips ports and handles IPv6 brackets", () => {
    assert.equal(hostnameOf("localhost:7777"), "localhost");
    assert.equal(hostnameOf("127.0.0.1"), "127.0.0.1");
    assert.equal(hostnameOf("[::1]:7777"), "[::1]");
    assert.equal(hostnameOf("Attacker.Example:80"), "attacker.example");
    assert.equal(hostnameOf(undefined), null);
  });
});
