import { createHash } from "node:crypto";
import { makeScribe } from "./castes.js";
import { extractFirstJsonObject } from "./json-extract.js";
import { callInsect } from "./openai-client.js";
import type {
  Artifact,
  ArtifactClaim,
  ArtifactEvidence,
  Morsel,
  Flight,
  GuardVerdict,
} from "./types.js";

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","in","on","to","for","with","by","at",
  "is","are","was","were","be","been","it","this","that","these","those","as",
  "from","into","over","under","than","then","so","not","no","yes","do","does",
  "did","have","has","had","will","would","could","should","may","might","can",
  "you","your","i","we","they","them","their","my","our","its","there","here",
]);

/**
 * Build the user prompt the Scribe receives. Pure; safe to test.
 */
export function buildScribePrompt(opts: {
  flight: Pick<Flight, "id" | "task" | "outcome">;
  winnerMorsel?: Morsel | null;
  foragerMorsels: Morsel[];
  waspMorsels: Morsel[];
  soldierMorsel?: Morsel | null;
  verdicts: GuardVerdict[];
  parentArtifacts: Artifact[];
}): string {
  const lines: string[] = [];
  lines.push(`Flight ${opts.flight.id} — outcome=${opts.flight.outcome}`);
  lines.push(`Task:`);
  lines.push(opts.flight.task);
  lines.push("");

  if (opts.parentArtifacts.length > 0) {
    lines.push(`Prior artifacts cited (${opts.parentArtifacts.length}):`);
    for (const a of opts.parentArtifacts) {
      lines.push(`- artifact ${a.id} (flight ${a.flightId}): ${a.task.slice(0, 120)}`);
    }
    lines.push("");
  }

  if (opts.winnerMorsel) {
    lines.push(`Winning output (morsel ${opts.winnerMorsel.id}):`);
    lines.push(opts.winnerMorsel.output);
    lines.push("");
  }

  if (opts.soldierMorsel && opts.soldierMorsel.id !== opts.winnerMorsel?.id) {
    lines.push(`Soldier fallback output (morsel ${opts.soldierMorsel.id}):`);
    lines.push(opts.soldierMorsel.output);
    lines.push("");
  }

  if (opts.verdicts.length > 0) {
    lines.push(`Guard verdicts:`);
    for (const v of opts.verdicts) {
      lines.push(`- morsel ${v.morselId}: passed=${v.passed} score=${v.score.toFixed(2)} — ${v.critique}`);
    }
    lines.push("");
  }

  if (opts.waspMorsels.length > 0) {
    lines.push(`Wasp critiques (${opts.waspMorsels.length}):`);
    for (const g of opts.waspMorsels) {
      lines.push(`- ${g.output.slice(0, 400)}`);
    }
    lines.push("");
  }

  lines.push(
    `Now emit the Artifact JSON. Cite morsel ids in evidence where appropriate.`,
  );
  return lines.join("\n");
}

/**
 * Parse a JSON blob from the Scribe into a typed Artifact.
 * Forgiving: tolerates code fences, leading prose, missing fields.
 */
export function parseArtifactJson(
  raw: string,
  meta: {
    flightId: string;
    task: string;
    outcome: Flight["outcome"];
    winnerMorselId?: string;
    parentArtifactIds: string[];
  },
): Artifact {
  const json = extractFirstJsonObject(raw);
  let parsed: Record<string, unknown> = {};
  if (json) {
    try {
      parsed = JSON.parse(json) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  const claims = Array.isArray(parsed.claims)
    ? (parsed.claims as unknown[]).flatMap((c): ArtifactClaim[] => {
        if (!c || typeof c !== "object") return [];
        const obj = c as Record<string, unknown>;
        const text = typeof obj.text === "string" ? obj.text : "";
        if (!text) return [];
        const confRaw = obj.confidence;
        const confidence: ArtifactClaim["confidence"] =
          confRaw === "established" || confRaw === "likely" || confRaw === "speculative"
            ? confRaw
            : "likely";
        const evidenceIds = Array.isArray(obj.evidenceIds)
          ? (obj.evidenceIds as unknown[])
              .map((n) => Number(n))
              .filter((n) => Number.isInteger(n) && n >= 0)
          : undefined;
        return [{ text, confidence, evidenceIds }];
      })
    : [];

  const evidence = Array.isArray(parsed.evidence)
    ? (parsed.evidence as unknown[]).flatMap((e): ArtifactEvidence[] => {
        if (!e || typeof e !== "object") return [];
        const obj = e as Record<string, unknown>;
        const kindRaw = obj.kind;
        const kind: ArtifactEvidence["kind"] =
          kindRaw === "morsel" || kindRaw === "file" || kindRaw === "url" || kindRaw === "external"
            ? kindRaw
            : "external";
        const ref = typeof obj.ref === "string" ? obj.ref : "";
        if (!ref) return [];
        const snippet = typeof obj.snippet === "string" ? obj.snippet : undefined;
        return [{ kind, ref, snippet }];
      })
    : [];

  const stringList = (k: string): string[] =>
    Array.isArray(parsed[k])
      ? (parsed[k] as unknown[]).filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];

  let keywords = stringList("keywords").map((k) => k.toLowerCase());
  if (keywords.length === 0) keywords = extractKeywords(meta.task);

  const id = artifactId(meta.flightId, claims);

  return {
    id,
    flightId: meta.flightId,
    task: meta.task,
    outcome: meta.outcome,
    winnerMorselId: meta.winnerMorselId,
    claims,
    evidence,
    openQuestions: stringList("openQuestions"),
    nextSteps: stringList("nextSteps"),
    parentArtifactIds: meta.parentArtifactIds,
    keywords,
    timestamp: Date.now(),
  };
}

/** Run the Scribe LLM call and return the parsed Artifact. */
export async function scribe(opts: {
  flight: Flight;
  winnerMorsel?: Morsel | null;
  foragerMorsels: Morsel[];
  waspMorsels: Morsel[];
  soldierMorsel?: Morsel | null;
  verdicts: GuardVerdict[];
  parentArtifacts: Artifact[];
  maxOutputTokens?: number;
}): Promise<{ artifact: Artifact; usage: ReturnType<typeof Object> }> {
  const scribeInsect = makeScribe();
  const prompt = buildScribePrompt({
    flight: opts.flight,
    winnerMorsel: opts.winnerMorsel,
    foragerMorsels: opts.foragerMorsels,
    waspMorsels: opts.waspMorsels,
    soldierMorsel: opts.soldierMorsel,
    verdicts: opts.verdicts,
    parentArtifacts: opts.parentArtifacts,
  });
  const { text, usage } = await callInsect(scribeInsect, prompt, {
    maxOutputTokens: opts.maxOutputTokens ?? 1500,
  });
  const artifact = parseArtifactJson(text, {
    flightId: opts.flight.id,
    task: opts.flight.task,
    outcome: opts.flight.outcome,
    winnerMorselId: opts.winnerMorsel?.id,
    parentArtifactIds: opts.parentArtifacts.map((a) => a.id),
  });
  return { artifact, usage };
}

/* --------- Retrieval (v1: keyword overlap + recency) --------- */

export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k]) => k);
}

/**
 * Score an artifact's relevance to a query. Higher is better.
 * Combines keyword overlap with recency decay.
 */
export function scoreArtifact(artifact: Artifact, queryKeywords: string[], now: number): number {
  if (queryKeywords.length === 0) return 0;
  const set = new Set(artifact.keywords);
  let overlap = 0;
  for (const k of queryKeywords) if (set.has(k)) overlap++;
  if (overlap === 0) return 0; // zero overlap = irrelevant; recency is a tiebreaker only
  const overlapRatio = overlap / queryKeywords.length;
  const ageDays = Math.max(0, (now - artifact.timestamp) / 86_400_000);
  const recency = 1 / (1 + ageDays / 7); // half life ~ 1 week
  return overlapRatio * 0.75 + recency * 0.25;
}

export function findRelevantArtifacts(
  artifacts: Artifact[],
  queryText: string,
  limit: number,
  now: number = Date.now(),
): Artifact[] {
  const keywords = extractKeywords(queryText);
  if (keywords.length === 0) return [];
  return artifacts
    .map((a) => ({ a, score: scoreArtifact(a, keywords, now) }))
    .filter(({ score }) => score > 0.05)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ a }) => a);
}

/**
 * Render an artifact as a compact "Prior context" block to prepend to a forager
 * prompt. Designed to stay under ~500 tokens per artifact.
 */
export function renderArtifactContext(artifact: Artifact): string {
  const lines: string[] = [];
  lines.push(`### Prior artifact ${artifact.id} (flight ${artifact.flightId})`);
  lines.push(`Task: ${artifact.task}`);
  lines.push(`Outcome: ${artifact.outcome}`);
  if (artifact.claims.length > 0) {
    lines.push(`Established claims:`);
    for (const c of artifact.claims.slice(0, 8)) {
      lines.push(`- (${c.confidence}) ${c.text}`);
    }
  }
  if (artifact.openQuestions.length > 0) {
    lines.push(`Open questions:`);
    for (const q of artifact.openQuestions.slice(0, 5)) lines.push(`- ${q}`);
  }
  if (artifact.nextSteps.length > 0) {
    lines.push(`Suggested next steps:`);
    for (const n of artifact.nextSteps.slice(0, 5)) lines.push(`- ${n}`);
  }
  return lines.join("\n");
}

/* --------- internal helpers --------- */

function artifactId(flightId: string, claims: ArtifactClaim[]): string {
  const sig = claims.map((c) => c.text).join("|");
  return `${flightId.slice(0, 8)}-${createHash("sha256").update(sig).digest("hex").slice(0, 8)}`;
}
