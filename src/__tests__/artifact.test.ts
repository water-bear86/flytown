import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildScribePrompt,
  extractKeywords,
  findRelevantArtifacts,
  parseArtifactJson,
  renderArtifactContext,
  scoreArtifact,
} from "../artifact.js";
import type { Artifact, Morsel, Flight, GuardVerdict } from "../types.js";

const sampleMorsel = (over: Partial<Morsel> = {}): Morsel => ({
  id: "morsel-1",
  flightId: "flight-1",
  caste: "forager",
  personality: "nerdy",
  model: "gpt-5-mini",
  prompt: "p",
  output: "winning output",
  timestamp: Date.now(),
  drift: {
    casteMentions: { forager: 0, wasp: 0, scout: 0, guard: 0, soldier: 0, messenger: 0 },
    totalCasteWords: 0,
    outputWordCount: 2,
    driftRate: 0,
  },
  ...over,
});

const sampleFlight = (over: Partial<Flight> = {}): Flight => ({
  id: "flight-abc12345",
  task: "summarize the migration plan",
  scanGlobs: [],
  swarmSize: 3,
  personality: "nerdy",
  foragerMorselIds: [],
  stingMorselIds: {},
  guardVerdicts: {},
  outcome: "winner",
  startedAt: Date.now(),
  ...over,
});

describe("extractKeywords", () => {
  it("returns lowercased non-stopword tokens by frequency", () => {
    const k = extractKeywords("The Forager reviews the Migration plan for the migration script");
    assert.ok(k.includes("migration"));
    assert.ok(k.includes("forager"));
    assert.ok(!k.includes("the"));
    assert.equal(k[0], "migration", "most frequent should be first");
  });

  it("returns empty for stopwords-only input", () => {
    assert.deepEqual(extractKeywords("the and or but"), []);
  });
});

describe("scoreArtifact", () => {
  const now = 1_700_000_000_000;
  const fresh: Artifact = {
    id: "a-1", flightId: "r-1", task: "migrate db", outcome: "winner",
    claims: [], evidence: [], openQuestions: [], nextSteps: [],
    parentArtifactIds: [],
    keywords: ["migration", "database", "schema"],
    timestamp: now,
  };
  const stale: Artifact = { ...fresh, id: "a-2", timestamp: now - 30 * 86_400_000 };

  it("rewards keyword overlap", () => {
    const high = scoreArtifact(fresh, ["migration", "database"], now);
    const low  = scoreArtifact(fresh, ["sql"], now);
    assert.ok(high > low);
  });

  it("decays with age", () => {
    const fScore = scoreArtifact(fresh, ["migration"], now);
    const sScore = scoreArtifact(stale, ["migration"], now);
    assert.ok(fScore > sScore);
  });

  it("returns 0 when query is empty", () => {
    assert.equal(scoreArtifact(fresh, [], now), 0);
  });
});

describe("findRelevantArtifacts", () => {
  const now = 1_700_000_000_000;
  const make = (id: string, kw: string[], ageDays: number): Artifact => ({
    id, flightId: id, task: kw.join(" "), outcome: "winner",
    claims: [], evidence: [], openQuestions: [], nextSteps: [],
    parentArtifactIds: [], keywords: kw,
    timestamp: now - ageDays * 86_400_000,
  });

  it("ranks fresh, on-topic artifacts above stale or off-topic ones", () => {
    const arts = [
      make("a", ["migration", "database"], 0),
      make("b", ["css", "layout"], 0),
      make("c", ["migration", "database"], 60),
    ];
    const top = findRelevantArtifacts(arts, "migration database schema", 3, now);
    assert.equal(top[0].id, "a", "fresh on-topic should rank first");
    assert.ok(!top.some((t) => t.id === "b"), "off-topic should be filtered");
  });

  it("respects the limit", () => {
    const arts = [
      make("a", ["foo"], 0),
      make("b", ["foo"], 1),
      make("c", ["foo"], 2),
    ];
    const top = findRelevantArtifacts(arts, "foo", 2, now);
    assert.equal(top.length, 2);
  });
});

describe("parseArtifactJson", () => {
  const meta = {
    flightId: "flight-abc12345",
    task: "do thing",
    outcome: "winner" as const,
    winnerMorselId: "morsel-1",
    parentArtifactIds: [],
  };

  it("parses a clean JSON object", () => {
    const json = JSON.stringify({
      claims: [{ text: "x", confidence: "established", evidenceIds: [0] }],
      evidence: [{ kind: "morsel", ref: "morsel-1", snippet: "..." }],
      openQuestions: ["why?"],
      nextSteps: ["do y"],
      keywords: ["alpha", "beta"],
    });
    const a = parseArtifactJson(json, meta);
    assert.equal(a.claims.length, 1);
    assert.equal(a.claims[0].text, "x");
    assert.equal(a.evidence[0].kind, "morsel");
    assert.deepEqual(a.openQuestions, ["why?"]);
    assert.deepEqual(a.keywords, ["alpha", "beta"]);
    assert.equal(a.flightId, "flight-abc12345");
    assert.equal(a.winnerMorselId, "morsel-1");
  });

  it("strips code fences and leading prose", () => {
    const json = "Here is the artifact:\n```json\n{ \"claims\": [], \"keywords\": [\"k\"] }\n```\n";
    const a = parseArtifactJson(json, meta);
    assert.deepEqual(a.keywords, ["k"]);
  });

  it("falls back to task-derived keywords when none provided", () => {
    const a = parseArtifactJson("{}", { ...meta, task: "migrate the database schema reliably" });
    assert.ok(a.keywords.length > 0);
    assert.ok(a.keywords.includes("migrate") || a.keywords.includes("database"));
  });

  it("tolerates malformed JSON without throwing", () => {
    const a = parseArtifactJson("not json at all", meta);
    assert.deepEqual(a.claims, []);
    assert.deepEqual(a.evidence, []);
  });

  it("coerces unknown confidence to 'likely'", () => {
    const a = parseArtifactJson(
      JSON.stringify({ claims: [{ text: "y", confidence: "nonsense" }] }),
      meta,
    );
    assert.equal(a.claims[0].confidence, "likely");
  });

  it("produces deterministic ids for identical inputs", () => {
    const json = JSON.stringify({
      claims: [{ text: "stable", confidence: "established" }],
    });
    const a1 = parseArtifactJson(json, meta);
    const a2 = parseArtifactJson(json, meta);
    assert.equal(a1.id, a2.id);
  });
});

describe("buildScribePrompt", () => {
  it("includes task, winning output, and verdicts", () => {
    const prompt = buildScribePrompt({
      flight: sampleFlight({ task: "FOOTASK" }),
      winnerMorsel: sampleMorsel({ id: "morsel-W", output: "FINAL" }),
      foragerMorsels: [sampleMorsel({ id: "morsel-W", output: "FINAL" })],
      waspMorsels: [],
      soldierMorsel: null,
      verdicts: [{ morselId: "morsel-W", passed: true, score: 0.9, critique: "good" }],
      parentArtifacts: [],
    });
    assert.ok(prompt.includes("FOOTASK"));
    assert.ok(prompt.includes("FINAL"));
    assert.ok(prompt.includes("good"));
    assert.ok(prompt.includes("Artifact JSON"));
  });

  it("lists parent artifacts when present", () => {
    const parent: Artifact = {
      id: "a-parent", flightId: "r-parent", task: "earlier task", outcome: "winner",
      claims: [], evidence: [], openQuestions: [], nextSteps: [],
      parentArtifactIds: [], keywords: [], timestamp: 0,
    };
    const prompt = buildScribePrompt({
      flight: sampleFlight(),
      winnerMorsel: null,
      foragerMorsels: [],
      waspMorsels: [],
      soldierMorsel: null,
      verdicts: [],
      parentArtifacts: [parent],
    });
    assert.ok(prompt.includes("a-parent"));
    assert.ok(prompt.includes("earlier task"));
  });
});

describe("renderArtifactContext", () => {
  it("renders a compact prior-context block", () => {
    const a: Artifact = {
      id: "a-1", flightId: "r-1", task: "T", outcome: "winner",
      claims: [
        { text: "claim one", confidence: "established" },
        { text: "claim two", confidence: "speculative" },
      ],
      evidence: [],
      openQuestions: ["q1"],
      nextSteps: ["s1"],
      parentArtifactIds: [],
      keywords: ["k"],
      timestamp: 0,
    };
    const out = renderArtifactContext(a);
    assert.ok(out.includes("a-1"));
    assert.ok(out.includes("claim one"));
    assert.ok(out.includes("(established)"));
    assert.ok(out.includes("q1"));
    assert.ok(out.includes("s1"));
  });
});
