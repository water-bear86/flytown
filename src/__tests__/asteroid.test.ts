import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { initWarren, resetWarren } from "../warren.js";

describe("Asteroid Mode", () => {
  it("obliterates persisted local warren memory and recreates a fresh warren", async () => {
    const root = await mkdtemp(join(tmpdir(), "goblintown-asteroid-"));
    try {
      const first = await initWarren(root);
      const goblintownDir = join(root, ".goblintown");
      await writeFile(join(first.hoard.lootDir, "old-loot.json"), "{}", "utf8");
      await mkdir(join(goblintownDir, "runs"), { recursive: true });
      await writeFile(join(goblintownDir, "runs", "old-run.json"), "{}", "utf8");
      await writeFile(join(goblintownDir, "provider-secrets.json"), "{}", "utf8");

      const fresh = await resetWarren(root);
      const freshManifest = JSON.parse(readFileSync(fresh.manifestPath, "utf8"));

      assert.equal(existsSync(join(goblintownDir, "runs", "old-run.json")), false);
      assert.equal(existsSync(join(goblintownDir, "provider-secrets.json")), false);
      assert.equal(existsSync(join(fresh.hoard.lootDir, "old-loot.json")), false);
      assert.deepEqual(await readdir(fresh.hoard.lootDir), []);
      assert.equal(freshManifest.name, first.manifest.name);
      assert.ok(typeof freshManifest.createdAt === "string" && freshManifest.createdAt.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
