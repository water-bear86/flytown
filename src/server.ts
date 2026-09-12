import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import express, { type Request, type Response } from "express";
import {
  normalizeChatMessages,
  runSingleForagerChat,
} from "./chat.js";
import {
  chatRecordPreview,
  importChatRecords,
  scanChatImports,
  type ChatImportSource,
  vectorizeStoredArtifacts,
} from "./chat-import.js";
import { ingestContextPath } from "./context-ingest.js";
import { findRelevantArtifactsEmbedded } from "./embeddings.js";
import { makeForager } from "./castes.js";
import { performFlight, type FlightStep } from "./flight.js";
import { callInsect } from "./openai-client.js";
import { loadRewardPlugin } from "./reward-plugin.js";
import {
  appendRunEvent,
  buildResumePrompt,
  ensureRunDir,
  loadAllRuns,
  markRunFinished,
  markRunInterrupted,
  originalTaskForResume,
  saveRun,
  type RunRecord,
} from "./run-store.js";
import {
  type Artifact,
  type Morsel,
  type OutputFormat,
  type Personality,
  type ProviderConfig,
} from "./types.js";
import { executePlan, type PlanExecutionEvent } from "./plan-executor.js";
import { DEFAULT_PLANNER, resolvePlannerBackend } from "./flytown/registry.js";
import { writeTrace } from "./flytown/trace.js";
import { renderArtifactContext } from "./artifact.js";
import { exportRunAsMasTrace } from "./trace-export.js";
import { measureDrift } from "./drift.js";
import { normalizeOutputFormat } from "./formatting.js";
import {
  MODEL_SLOTS,
  PROVIDER_PRESETS,
  normalizeProviderConfig,
  resolveProviderRuntime,
} from "./providers.js";
import {
  clearProviderSecretForRoot,
  readProviderSecretsForRootSync,
  setProviderSecretForRoot,
} from "./provider-secrets.js";
import { loadTerrarium, saveTerrariumManifest, type Terrarium } from "./terrarium.js";
import { builtinTools } from "./tools.js";
import { flyPageHtml, registerFlyRoutes } from "./flytown/web.js";
import { LOOPBACK_HOSTNAMES, localGuard } from "./local-guard.js";

export interface ServeOptions {
  cwd: string;
  port: number;
  /**
   * Interface to bind. Default 127.0.0.1 — the server can spend API budget,
   * read files and change provider credentials, so it is reachable only from
   * this machine unless the user explicitly chooses otherwise.
   */
  host?: string;
  quiet?: boolean;
}

export interface ServeHandle {
  url: string;
  close: () => Promise<void>;
}

interface RunState {
  record: RunRecord;
  subscribers: Set<Response>;
}

interface StartRunOptions {
  bodyOverride?: Record<string, unknown>;
  resumedFromRunId?: string;
  originalTask?: string;
}

function runSummary(record: RunRecord): Omit<RunRecord, "events"> & { eventCount: number } {
  const { events, ...rest } = record;
  return {
    ...rest,
    eventCount: record.nextSeq ?? events.length,
  };
}

function contextArtifactPayload(artifact: Artifact): Record<string, unknown> {
  return {
    id: artifact.id,
    flightId: artifact.flightId,
    task: artifact.task,
    ref: artifact.evidence.find((e) => e.kind === "file")?.ref ?? artifact.flightId,
    claim: artifact.claims[0]?.text ?? artifact.task,
    keywords: artifact.keywords,
    timestamp: artifact.timestamp,
  };
}

function apiLimit(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function apiChatSource(raw: unknown): ChatImportSource | undefined {
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "codex" || value === "chatgpt" || value === "folder") return value;
  throw new Error("source must be codex, chatgpt, or folder");
}

function apiStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function sanitizeRunPayload(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    const clean = sanitizeJsonValue(value);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function sanitizeJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const clean = sanitizeJsonValue(child);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return undefined;
}

function inferRunRequest(record: RunRecord): { mode: "flight" | "plan"; payload: Record<string, unknown> } {
  const mode =
    record.mode ??
    (record.events.some((e) => e.kind.startsWith("plan:")) || record.swarmSize === 0
      ? "plan"
      : "flight");
  if (mode === "plan") {
    return {
      mode,
      payload: {
        task: record.task,
        maxNodes: 6,
        maxReplan: 2,
        remember: true,
      },
    };
  }
  return {
    mode,
    payload: {
      task: record.task,
      swarmSize: record.swarmSize || 3,
      scanGlobs: record.scanGlobs,
      personality: record.personality,
      noFallback: record.noFallback,
      remember: true,
    },
  };
}

export function resumePayloadForRun(
  record: RunRecord,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const next = sanitizeRunPayload({
    ...payload,
    task: buildResumePrompt(record),
    remember: true,
  });
  if (isBudgetExceededRun(record)) {
    next.swarmSize = 1;
    next.debate = false;
    next.guardTools = false;
    next.noSpecialist = true;
    next.maxOutputTokens = 800;
    const currentBudget =
      typeof next.budgetTokens === "number" && next.budgetTokens > 0
        ? next.budgetTokens
        : 12_000;
    next.budgetTokens = Math.max(12_000, Math.floor(currentBudget));
  }
  const cite = Array.isArray(payload.cite)
    ? payload.cite.filter((v): v is string => typeof v === "string")
    : [];
  if (record.finalFlightId) {
    next.cite = [...new Set([...cite, record.finalFlightId])];
  } else if (cite.length) {
    next.cite = cite;
  }
  return next;
}

function isBudgetExceededRun(record: RunRecord): boolean {
  return /budget exceeded/i.test(record.error ?? "");
}

function cspHeaderForRequest(): string {
  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
  ].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const host = opts.host ?? "127.0.0.1";
  let terrarium = await loadTerrarium(opts.cwd);
  await saveTerrariumManifest(terrarium);
  const app = express();
  const runs = new Map<string, RunState>();
  let runDir = await ensureRunDir(terrarium.root);

  // Recover persisted runs. Anything still flagged in-progress when we boot is
  // terminal for that process, but remains resumable from its last checkpoint.
  const persisted = await loadAllRuns(runDir);
  for (const rec of persisted) {
    if (!rec.done) {
      markRunInterrupted(rec);
      await saveRun(runDir, rec);
    } else if (rec.eventsCompacted) {
      await saveRun(runDir, rec);
    }
    runs.set(rec.runId, { record: rec, subscribers: new Set() });
  }

  app.use(localGuard({ allowHosts: LOOPBACK_HOSTNAMES.has(host) || host === "0.0.0.0" || host === "::" ? [] : [host] }));
  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Flytown-Terrarium", terrarium.manifest.name);
    res.setHeader("Content-Security-Policy", cspHeaderForRequest());
    next();
  });
  app.get("/", (_req, res) => {
    res.type("html").send(flyPageHtml(terrarium.manifest.name));
  });

  app.post("/api/flight", async (req, res) =>
    startFlightRun(terrarium, runs, runDir, req, res),
  );
  app.post("/api/ask", async (req, res) =>
    startAskRun(terrarium, req, res),
  );
  app.post("/api/plan", async (req, res) =>
    startPlanRun(terrarium, runs, runDir, req, res),
  );
  registerFlyRoutes(app, terrarium);
  app.post("/api/chat", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const messages = normalizeChatMessages(body.messages);
    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      res.status(400).json({ error: "messages must end with a user message" });
      return;
    }
    const personality =
      typeof body.personality === "string"
        ? (body.personality as Personality)
        : "chipper";
    const rawMaxOutputTokens = Number(body.maxOutputTokens ?? 900);
    const maxOutputTokens = Number.isFinite(rawMaxOutputTokens)
      ? Math.max(64, Math.min(4000, Math.floor(rawMaxOutputTokens)))
      : 900;
    const modelSlot =
      body.modelSlot === "forager" || body.modelSlot === "soldier"
        ? body.modelSlot
        : undefined;
    try {
      const result = await runSingleForagerChat({
        messages,
        personality,
        modelSlot,
        maxOutputTokens,
        compost: terrarium.compost,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get("/api/flight/:runId/stream", (req, res) =>
    streamFlightRun(runs, req, res),
  );
  app.get("/api/runs", (_req, res) =>
    res.json(
      [...runs.values()]
        .map((r) => runSummary(r.record))
        .sort((a, b) => b.startedAt - a.startedAt),
    ),
  );
  app.get("/api/runs/:runId", (req, res) => {
    const state = runs.get(req.params.runId);
    if (!state) {
      res.status(404).json({ error: "no such run" });
      return;
    }
    const includeEvents = req.query.full === "1";
    res.json(includeEvents ? state.record : runSummary(state.record));
  });
  app.post("/api/runs/:runId/resume", async (req, res) =>
    resumeRun(terrarium, runs, runDir, req, res),
  );
  app.get("/api/trace/:runId", (req, res) => {
    const state = runs.get(req.params.runId);
    if (!state) {
      // try by finalFlightId
      const byFlight = [...runs.values()].find((r) => r.record.finalFlightId === req.params.runId);
      if (!byFlight) {
        res.status(404).json({ error: "no run/flight for that id" });
        return;
      }
      res.json(exportRunAsMasTrace(byFlight.record, terrarium.manifest.name));
      return;
    }
    res.json(exportRunAsMasTrace(state.record, terrarium.manifest.name));
  });
  app.get("/api/morsel/:id", async (req, res) => {
    const morsel = await terrarium.compost.getMorsel(req.params.id);
    if (!morsel) {
      res.status(404).json({ error: "morsel not found" });
      return;
    }
    res.json(morsel);
  });
  app.get("/api/artifact/:id", async (req, res) => {
    const art = await terrarium.compost.getArtifact(req.params.id);
    if (!art) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }
    res.json(art);
  });
  app.get("/api/flight/:id/artifact", async (req, res) => {
    const art = await terrarium.compost.getArtifactByFlightId(req.params.id);
    if (!art) {
      res.status(404).json({ error: "no artifact for that flight" });
      return;
    }
    res.json(art);
  });
  app.get("/api/artifacts", async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    const all = (await terrarium.compost.allArtifacts()).sort((a, b) => b.timestamp - a.timestamp);
    res.json(all.slice(0, Math.max(1, Math.min(500, limit))));
  });
  app.post("/api/context/ingest", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const inputPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!inputPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    try {
      const result = await ingestContextPath({
        root: terrarium.root,
        compost: terrarium.compost,
        inputPath,
        limit: apiLimit(body.limit, 80, 1, 500),
      });
      res.json({
        artifacts: result.artifacts.map(contextArtifactPayload),
        skipped: result.skipped,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/api/context/search", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    try {
      const all = await terrarium.compost.allArtifacts();
      const matches = await findRelevantArtifactsEmbedded({
        artifacts: all,
        queryText: query,
        limit: apiLimit(body.limit, 10, 1, 100),
        compost: terrarium.compost,
      });
      res.json({
        artifacts: matches.map(contextArtifactPayload),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/api/context/chats/scan", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await scanChatImports({
        source: apiChatSource(body.source),
        path: typeof body.path === "string" && body.path.trim() ? body.path.trim() : undefined,
        query: typeof body.query === "string" && body.query.trim() ? body.query.trim() : undefined,
        since: typeof body.since === "string" && body.since.trim() ? body.since.trim() : undefined,
        limit: apiLimit(body.limit, 50, 1, 500),
      });
      res.json({
        records: result.records.map(chatRecordPreview),
        skipped: result.skipped,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/api/context/chats/import", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = apiStringArray(body.ids);
    const importAll = body.all === true || body.all === "true";
    if (!importAll && ids.length === 0) {
      res.status(400).json({ error: "all=true or ids is required" });
      return;
    }
    try {
      const scan = await scanChatImports({
        source: apiChatSource(body.source),
        path: typeof body.path === "string" && body.path.trim() ? body.path.trim() : undefined,
        query: typeof body.query === "string" && body.query.trim() ? body.query.trim() : undefined,
        since: typeof body.since === "string" && body.since.trim() ? body.since.trim() : undefined,
        limit: apiLimit(body.limit, 50, 1, 500),
      });
      const result = await importChatRecords({
        compost: terrarium.compost,
        records: scan.records,
        ids: importAll ? undefined : ids,
        vectorize: body.noVectorize !== true && body.noVectorize !== "true",
        summarize: body.summarize === true || body.summarize === "true",
      });
      res.json({
        records: result.records.map(chatRecordPreview),
        artifacts: result.artifacts.map(contextArtifactPayload),
        vectorized: result.vectorized,
        skipped: [...scan.skipped, ...result.skipped.map((item) => ({ path: item.id, reason: item.reason }))],
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.post("/api/context/vectorize", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const result = await vectorizeStoredArtifacts({
        compost: terrarium.compost,
        missingOnly: body.missingOnly === true || body.missingOnly === "true",
        limit: body.limit === undefined ? undefined : apiLimit(body.limit, 100, 1, 500),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get("/api/terrarium/stats", async (_req, res) => {
    const [morsels, flights] = await Promise.all([
      terrarium.compost.allMorsels(),
      terrarium.compost.allFlights(),
    ]);
    const driftSum = morsels.reduce((s, l) => s + l.drift.driftRate, 0);
    const drift = morsels.length ? driftSum / morsels.length : 0;
    res.json({
      terrarium: terrarium.manifest.name,
      morsels: morsels.length,
      flights: flights.length,
      drift,
    });
  });
  app.get("/api/providers", (_req, res) => {
    res.json({
      presets: Object.values(PROVIDER_PRESETS).map((p) => ({
        id: p.id,
        label: p.label,
        baseURL: p.baseURL,
        apiKeyEnv: p.apiKeyEnv,
        local: !!p.local,
        models: p.models,
        note: p.note,
      })),
      modelSlots: MODEL_SLOTS,
    });
  });
  app.get("/api/provider", (_req, res) => {
    res.json(providerPayload(terrarium));
  });
  app.post("/api/provider", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const config = normalizeProviderConfig(body);
    terrarium.manifest.provider = config;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    const clearApiKey = body.clearApiKey === true;
    const apiKeyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
    if (apiKey !== undefined) {
      if (apiKey.length > 0) {
        await setProviderSecretForRoot(terrarium.root, apiKeyEnv, apiKey);
      } else {
        await clearProviderSecretForRoot(terrarium.root, apiKeyEnv);
      }
    } else if (clearApiKey) {
      await clearProviderSecretForRoot(terrarium.root, apiKeyEnv);
    }
    await saveTerrariumManifest(terrarium);
    res.json(providerPayload(terrarium));
  });
  app.use((_req, res) =>
    res.status(404).type("html").send("<!doctype html><title>404</title><h1>404</h1>"),
  );

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(opts.port, host);
    const cleanup = () => {
      listening.off("error", onError);
      listening.off("listening", onListening);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      const address = listening.address();
      const actualPort =
        typeof address === "object" && address ? address.port : opts.port;
      if (!opts.quiet) {
        const exposed = !LOOPBACK_HOSTNAMES.has(host);
        process.stdout.write(
          `FLYTOWN listening on http://${exposed ? host : "localhost"}:${actualPort}/\n` +
            (exposed ? `WARNING: bound to ${host}, not loopback — anyone who can reach this address can spend your API budget and read files through this server.\n` : "") +
            `Terrarium: ${terrarium.manifest.name}  (${terrarium.root})\n`,
        );
      }
      resolve(listening);
    };
    listening.once("error", onError);
    listening.once("listening", onListening);
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : opts.port;
  return {
    url: `http://localhost:${actualPort}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function startAskRun(
  terrarium: Terrarium,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    task?: unknown;
    remember?: unknown;
    outputFormat?: unknown;
    maxOutputTokens?: unknown;
  };
  if (typeof body.task !== "string" || body.task.trim().length === 0) {
    res.status(400).json({ error: "task is required" });
    return;
  }
  const task = body.task.trim();
  const remember = body.remember !== false;
  const outputFormat = normalizeOutputFormat(
    body.outputFormat ?? terrarium.manifest.provider?.outputFormat,
  );
  const maxOutputTokens =
    typeof body.maxOutputTokens === "number" && body.maxOutputTokens > 0
      ? body.maxOutputTokens
      : undefined;
  const parentArtifacts = remember
    ? await findRelevantArtifactsEmbedded({
        artifacts: await terrarium.compost.allArtifacts(),
        queryText: task,
        limit: 3,
        compost: terrarium.compost,
      })
    : [];
  const prompt = parentArtifacts.length
    ? `${parentArtifacts.map(renderArtifactContext).join("\n\n")}\n\nTask:\n${task}`
    : task;
  try {
    const insect = makeForager();
    const { text, usage } = await callInsect(insect, prompt, {
      outputFormat,
      maxOutputTokens,
    });
    const drift = measureDrift(text);
    const morsel: Morsel = {
      id: "",
      caste: "forager",
      personality: insect.personality,
      model: insect.model,
      prompt,
      output: text,
      timestamp: Date.now(),
      drift,
      usage,
    };
    const morselId = await terrarium.compost.stash(morsel);
    res.json({
      mode: "single",
      output: text,
      morselId,
      usage,
      parentArtifactIds: parentArtifacts.map((a) => a.id),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function startFlightRun(
  terrarium: Terrarium,
  runs: Map<string, RunState>,
  runDir: string,
  req: Request,
  res: Response,
  options: StartRunOptions = {},
): Promise<string | undefined> {
  const body = (options.bodyOverride ?? req.body ?? {}) as {
    task?: unknown;
    swarmSize?: unknown;
    scanGlobs?: unknown;
    personality?: unknown;
    noFallback?: unknown;
    noSpecialist?: unknown;
    specialistCap?: unknown;
    debate?: unknown;
    guardTools?: unknown;
    budgetTokens?: unknown;
    maxOutputTokens?: unknown;
    cite?: unknown;
    remember?: unknown;
    outputFormat?: unknown;
  };
  if (typeof body.task !== "string" || body.task.trim().length === 0) {
    res.status(400).json({ error: "task is required" });
    return undefined;
  }
  const runId = randomUUID().slice(0, 12);
  const personality =
    typeof body.personality === "string"
      ? (body.personality as Personality)
      : undefined;
  const scanGlobs = Array.isArray(body.scanGlobs)
    ? (body.scanGlobs.filter((g) => typeof g === "string") as string[])
    : [];
  const swarmSize = typeof body.swarmSize === "number" ? body.swarmSize : 3;
  const noFallback = !!body.noFallback;
  const noSpecialist = !!body.noSpecialist;
  const specialistCap =
    typeof body.specialistCap === "number" && body.specialistCap > 0
      ? body.specialistCap
      : undefined;
  const debate = !!body.debate;
  const guardTools = !!body.guardTools;
  const budgetTokens =
    typeof body.budgetTokens === "number" && body.budgetTokens > 0
      ? body.budgetTokens
      : undefined;
  const maxOutputTokens =
    typeof body.maxOutputTokens === "number" && body.maxOutputTokens > 0
      ? body.maxOutputTokens
      : undefined;
  const citeFlightIds = Array.isArray(body.cite)
    ? (body.cite.filter((c) => typeof c === "string") as string[])
    : [];
  const remember = !!body.remember;
  const outputFormat = normalizeOutputFormat(
    body.outputFormat ?? terrarium.manifest.provider?.outputFormat,
  );

  const record: RunRecord = {
    runId,
    task: body.task,
    originalTask: options.originalTask,
    swarmSize,
    scanGlobs,
    personality,
    noFallback,
    mode: "flight",
    status: "running",
    request: {
      mode: "flight",
      payload: sanitizeRunPayload(body),
    },
    resumedFromRunId: options.resumedFromRunId,
    events: [],
    done: false,
    startedAt: Date.now(),
  };
  await saveRun(runDir, record);

  const state: RunState = { record, subscribers: new Set() };
  runs.set(runId, state);

  // coalesce disk writes during bursty swarm steps
  let pendingSave: NodeJS.Timeout | null = null;
  const persist = () => {
    if (pendingSave) return;
    pendingSave = setTimeout(() => {
      pendingSave = null;
      void saveRun(runDir, state.record);
    }, 100);
  };
  const persistNow = async () => {
    if (pendingSave) {
      clearTimeout(pendingSave);
      pendingSave = null;
    }
    await saveRun(runDir, state.record);
  };

  const emit = (kind: string, data: unknown) => {
    const ev = appendRunEvent(state.record, kind, data);
    for (const sub of state.subscribers) writeSse(sub, ev);
    persist();
  };

  const finish = async (status: "done" | "error") => {
    markRunFinished(state.record, status);
    await persistNow();
    for (const sub of state.subscribers) {
      try {
        sub.end();
      } catch {
        // already closed
      }
    }
  };

  const rewardPlugin = await loadRewardPlugin(terrarium.root);
  if (rewardPlugin.source !== "builtin") {
    emit("reward-plugin", { source: rewardPlugin.source });
  }

  // Optional Phase 1 memory hookup from the flight form too.
  const parentArtifacts: Artifact[] = [];
  for (const r of citeFlightIds) {
    const a = await terrarium.compost.getArtifactByFlightId(r);
    if (a) parentArtifacts.push(a);
  }
  if (remember) {
    const all = await terrarium.compost.allArtifacts();
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: body.task,
      limit: 3,
      compost: terrarium.compost,
    })).filter(
      (a) => !parentArtifacts.some((p) => p.id === a.id),
    );
    parentArtifacts.push(...auto);
  }

  performFlight({
    task: body.task,
    swarmSize,
    scanGlobs,
    cwd: terrarium.root,
    compost: terrarium.compost,
    personality,
    rewardFn: rewardPlugin.fn,
    noFallback,
    noSpecialist,
    specialistCap,
    debate,
    guardTools,
    tools: guardTools ? builtinTools : undefined,
    budgetTokens,
    maxOutputTokensPerCall: maxOutputTokens,
    outputFormat,
    parentArtifacts,
    onStep: (step: FlightStep) => emit("step", step),
  })
    .then(async (result) => {
      state.record.finalFlightId = result.flight.id;
      state.record.outcome = result.flight.outcome;
      emit("done", {
        flightId: result.flight.id,
        outcome: result.flight.outcome,
        winnerMorselId: result.flight.winnerMorselId,
      });
      await finish("done");
    })
    .catch(async (err: unknown) => {
      state.record.error =
        err instanceof Error ? err.message : String(err);
      state.record.resumePrompt = buildResumePrompt(state.record);
      emit("error", { message: state.record.error });
      await finish("error");
    });

  res.json({ runId });
  return runId;
}

async function startPlanRun(
  terrarium: Terrarium,
  runs: Map<string, RunState>,
  runDir: string,
  req: Request,
  res: Response,
  options: StartRunOptions = {},
): Promise<string | undefined> {
  const body = (options.bodyOverride ?? req.body ?? {}) as {
    task?: unknown;
    maxNodes?: unknown;
    maxReplan?: unknown;
    cite?: unknown;
    remember?: unknown;
    budgetTokens?: unknown;
    outputFormat?: unknown;
    planner?: unknown;
  };
  if (typeof body.task !== "string" || body.task.trim().length === 0) {
    res.status(400).json({ error: "task is required" });
    return undefined;
  }
  const runId = randomUUID().slice(0, 12);
  const plannerSpec = typeof body.planner === "string" && body.planner.trim() ? body.planner.trim() : (terrarium.manifest.flytown?.planner ?? DEFAULT_PLANNER);
  const maxNodes = typeof body.maxNodes === "number" ? body.maxNodes : 6;
  const maxReplan = typeof body.maxReplan === "number" ? body.maxReplan : 2;
  const budgetTokens = typeof body.budgetTokens === "number" ? body.budgetTokens : undefined;
  const outputFormat = normalizeOutputFormat(
    body.outputFormat ?? terrarium.manifest.provider?.outputFormat,
  );
  const cites = Array.isArray(body.cite) ? (body.cite.filter((c) => typeof c === "string") as string[]) : [];
  const remember = !!body.remember;

  const record: RunRecord = {
    runId,
    task: body.task,
    originalTask: options.originalTask,
    swarmSize: 0, // not directly meaningful for plans
    scanGlobs: [],
    mode: "plan",
    status: "running",
    request: {
      mode: "plan",
      payload: sanitizeRunPayload(body),
    },
    resumedFromRunId: options.resumedFromRunId,
    events: [],
    done: false,
    startedAt: Date.now(),
  };
  await saveRun(runDir, record);
  const state: RunState = { record, subscribers: new Set() };
  runs.set(runId, state);

  let pendingSave: NodeJS.Timeout | null = null;
  const persist = () => {
    if (pendingSave) return;
    pendingSave = setTimeout(() => {
      pendingSave = null;
      void saveRun(runDir, state.record);
    }, 100);
  };
  const persistNow = async () => {
    if (pendingSave) { clearTimeout(pendingSave); pendingSave = null; }
    await saveRun(runDir, state.record);
  };
  const emit = (kind: string, data: unknown) => {
    const ev = appendRunEvent(state.record, kind, data);
    for (const sub of state.subscribers) writeSse(sub, ev);
    persist();
  };
  const finish = async (status: "done" | "error") => {
    markRunFinished(state.record, status);
    await persistNow();
    for (const sub of state.subscribers) {
      try { sub.end(); } catch { /* closed */ }
    }
  };

  const rewardPlugin = await loadRewardPlugin(terrarium.root);

  // Memory load
  const parents: Artifact[] = [];
  for (const r of cites) {
    const a = await terrarium.compost.getArtifactByFlightId(r);
    if (a) parents.push(a);
  }
  if (remember) {
    const all = await terrarium.compost.allArtifacts();
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: body.task,
      limit: 3,
      compost: terrarium.compost,
    })).filter(
      (a) => !parents.some((p) => p.id === a.id),
    );
    parents.push(...auto);
  }

  // Plan + execute, surfacing both planner events and step events
  void (async () => {
    try {
      emit("plan:planning", { task: body.task, parents: parents.length, planner: plannerSpec });
      const planner = resolvePlannerBackend(plannerSpec, {
        root: terrarium.root, seed: terrarium.manifest.flytown?.seed, connectome: terrarium.manifest.flytown?.connectome,
        learning: terrarium.manifest.flytown?.learning, fallback: terrarium.manifest.flytown?.fallbackToLlm !== false,
        onFallback: (err) => emit("plan:fallback", { from: plannerSpec, to: "llm", error: err instanceof Error ? err.message : String(err) }),
      });
      const planned = await planner.plan({
        task: body.task as string,
        cwd: terrarium.root,
        parentArtifacts: parents,
        maxNodes,
        budgetTokens,
        runId,
      });
      const { plan } = planned;
      if (planned.trace) {
        await writeTrace(terrarium.root, planned.trace);
        emit("plan:trace", { runId: planned.trace.runId, plannerId: planned.trace.plannerId, primary: planned.trace.decision.primary, included: planned.trace.decision.included, brain: planned.trace.brain ? { connectomeId: planned.trace.brain.connectomeId, variant: planned.trace.brain.variant, stats: planned.trace.brain.stats } : undefined });
      }
      emit("plan:built", { plan });
      const result = await executePlan({
        plan,
        cwd: terrarium.root,
        compost: terrarium.compost,
        rewardFn: rewardPlugin.fn,
        budgetTokens,
        outputFormat,
        parentArtifacts: parents,
        maxReplanDepth: maxReplan,
        planner,
        onPlanEvent: (ev: PlanExecutionEvent) => emit(ev.kind, ev),
        onStep: (nodeId, step) => emit("step", { nodeId, step }),
      });
      state.record.outcome = result.outcome === "success" ? "winner" : "all_failed";
      state.record.finalFlightId = result.finalFlightId;
      emit("done", {
        flightId: result.finalFlightId,
        outcome: result.outcome,
        finalArtifactId: result.finalArtifact?.id,
        finalMorselId: result.finalMorselId,
        winnerMorselId: result.finalMorselId,
      });
      await finish("done");
    } catch (err) {
      state.record.error = err instanceof Error ? err.message : String(err);
      state.record.resumePrompt = buildResumePrompt(state.record);
      emit("error", { message: state.record.error });
      await finish("error");
    }
  })();

  res.json({ runId });
  return runId;
}

async function resumeRun(
  terrarium: Terrarium,
  runs: Map<string, RunState>,
  runDir: string,
  req: Request,
  res: Response,
): Promise<void> {
  const sourceState = runs.get(req.params.runId);
  if (!sourceState) {
    res.status(404).json({ error: "no such run" });
    return;
  }
  const source = sourceState.record;
  const canResume =
    source.resumable === true ||
    source.status === "interrupted" ||
    source.status === "error";
  if (!canResume) {
    res.status(409).json({ error: "run is not resumable" });
    return;
  }

  const request = source.request ?? inferRunRequest(source);
  const payload = resumePayloadForRun(source, request.payload);
  const nextRunId =
    request.mode === "plan"
      ? await startPlanRun(terrarium, runs, runDir, req, res, {
          bodyOverride: payload,
          resumedFromRunId: source.runId,
          originalTask: originalTaskForResume(source),
        })
      : await startFlightRun(terrarium, runs, runDir, req, res, {
          bodyOverride: payload,
          resumedFromRunId: source.runId,
          originalTask: originalTaskForResume(source),
        });

  if (nextRunId) {
    source.resumedByRunId = nextRunId;
    source.resumable = false;
    await saveRun(runDir, source);
  }
}

function streamFlightRun(
  runs: Map<string, RunState>,
  req: Request,
  res: Response,
): void {
  const state = runs.get(req.params.runId);
  if (!state) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  for (const ev of state.record.events) writeSse(res, ev);
  // Marker: history catch-up is complete; live events follow (or stream closes if done).
  res.write(`event: replay-end\ndata: {}\n\n`);
  if (state.record.done) {
    res.end();
    return;
  }
  state.subscribers.add(res);
  req.on("close", () => state.subscribers.delete(res));
}

function writeSse(res: Response, ev: { seq: number; kind: string; data: unknown }): void {
  res.write(`id: ${ev.seq}\n`);
  res.write(`event: ${ev.kind}\n`);
  res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
}

function providerPayload(terrarium: Terrarium): {
  config: ProviderConfig;
  runtime: {
    id: string;
    label: string;
    baseURL?: string;
    apiKeyEnv: string;
    apiKeySource: "env" | "stored" | "dummy" | "none";
    hasStoredApiKey: boolean;
    hasApiKey: boolean;
    missingApiKey?: string;
    outputFormat: OutputFormat;
    models: Record<string, string>;
  };
} {
  const config = normalizeProviderConfig(terrarium.manifest.provider);
  const storedSecrets = readProviderSecretsForRootSync(terrarium.root);
  const runtime = resolveProviderRuntime(config, process.env, storedSecrets);
  return {
    config,
    runtime: {
      id: runtime.id,
      label: runtime.label,
      baseURL: runtime.baseURL,
      apiKeyEnv: runtime.apiKeyEnv,
      apiKeySource: runtime.apiKeySource,
      hasStoredApiKey: !!storedSecrets[runtime.apiKeyEnv],
      hasApiKey: runtime.apiKey.length > 0 && !runtime.missingApiKey,
      missingApiKey: runtime.missingApiKey,
      outputFormat: runtime.outputFormat,
      models: runtime.models,
    },
  };
}

