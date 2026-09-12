import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { makeForager, makeInsect } from "../castes.js";
import { CASTES, type Caste } from "../types.js";

// The FLYTOWN roster. Changing it is a deliberate protocol change (see
// docs/flytown/VOCABULARY.md); this test exists so it cannot happen quietly.
const ROSTER: Caste[] = ["forager", "wasp", "scout", "guard", "soldier", "messenger"];

describe("caste roster", () => {
  it("is exactly forager, wasp, scout, guard, soldier, messenger", () => {
    assert.deepEqual([...CASTES], ROSTER);
  });

  it("makeInsect builds an insect of every caste, framed as the FLYTOWN swarm", () => {
    for (const caste of CASTES) {
      const insect = makeInsect(caste);
      assert.equal(insect.caste, caste);
      assert.match(insect.systemPrompt, /in the FLYTOWN swarm/);
    }
  });
});

describe("makeForager", () => {
  it("supports the frenzied personality in the system prompt", () => {
    const forager = makeForager("frenzied");
    assert.equal(forager.personality, "frenzied");
    assert.match(forager.systemPrompt, /^You are a Forager in the FLYTOWN swarm\./);
    assert.match(forager.systemPrompt, /Personality: frenzied/);
    assert.match(forager.systemPrompt, /Your tone is frenzied: punchy, mischievous, and brutally practical\./);
  });
});
