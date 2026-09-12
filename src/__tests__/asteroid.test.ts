import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { initTerrarium, resetTerrarium } from "../terrarium.js";

describe("Asteroid Mode", () => {
  it("obliterates persisted terrarium memory, keeps FLYTOWN research state, and recreates a fresh terrarium", async () => {
    const root = await mkdtemp(join(tmpdir(), "flytown-asteroid-"));
    try {
      const first = await initTerrarium(root);
      const flytownDir = join(root, ".flytown");
      await writeFile(join(first.compost.morselDir, "old-morsel.json"), "{}", "utf8");
      await mkdir(join(flytownDir, "runs"), { recursive: true });
      await writeFile(join(flytownDir, "runs", "old-run.json"), "{}", "utf8");
      await writeFile(join(flytownDir, "provider-secrets.json"), "{}", "utf8");
      // Decision traces, eval reports and learned weights share .flytown/ but are not terrarium memory.
      for (const sub of ["traces", "eval", "eval-compost", "weights"]) {
        await mkdir(join(flytownDir, sub), { recursive: true });
        await writeFile(join(flytownDir, sub, "keep.json"), "{}", "utf8");
      }

      const fresh = await resetTerrarium(root);
      const freshManifest = JSON.parse(readFileSync(fresh.manifestPath, "utf8"));

      assert.equal(existsSync(join(flytownDir, "runs", "old-run.json")), false);
      assert.equal(existsSync(join(flytownDir, "provider-secrets.json")), false);
      assert.equal(existsSync(join(fresh.compost.morselDir, "old-morsel.json")), false);
      assert.deepEqual(await readdir(fresh.compost.morselDir), []);
      for (const sub of ["traces", "eval", "eval-compost", "weights"]) {
        assert.equal(existsSync(join(flytownDir, sub, "keep.json")), true, `${sub} survives the reset`);
      }
      assert.equal(freshManifest.name, first.manifest.name);
      assert.ok(typeof freshManifest.createdAt === "string" && freshManifest.createdAt.length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
