import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverSource = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

describe("cloud mode", () => {
  it("bundles the shared Goblintown Firebase project while preserving env overrides", () => {
    assert.match(serverSource, /DEFAULT_FIREBASE_CLIENT_CONFIG/);
    assert.match(serverSource, /goblintown-88fd6/);
    assert.match(serverSource, /AIzaSyD2px9fRoSh6bwOBDIk2dGioYbxROQ6Leo/);
    assert.match(serverSource, /trimmedEnv\("FIREBASE_API_KEY"\) \?\? DEFAULT_FIREBASE_CLIENT_CONFIG\.apiKey/);
    assert.match(serverSource, /trimmedEnv\("FIREBASE_AUTH_DOMAIN"\) \?\? DEFAULT_FIREBASE_CLIENT_CONFIG\.authDomain/);
    assert.match(serverSource, /enabled: true/);
  });
});
