import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import {
  normalizeChatMessages,
  runSingleGoblinChat,
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
import { makeGoblin } from "./creatures.js";
import { performRite, type RiteStep } from "./rite.js";
import { callCreature } from "./openai-client.js";
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
  type Loot,
  type OutputFormat,
  type Personality,
  type ProviderConfig,
} from "./types.js";
import { executePlan, type PlanExecutionEvent } from "./plan-executor.js";
import { resolvePlannerBackend } from "./flytown/registry.js";
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
import { loadWarren, resetWarren, saveWarrenManifest, type Warren } from "./warren.js";
import { builtinTools } from "./tools.js";
import { flyPageHtml, registerFlyRoutes } from "./flytown/web.js";

export interface ServeOptions {
  cwd: string;
  port: number;
  autopilot?: boolean;
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

const DISCOVERY_OPEN_MEMBER_LIMIT = 3;
const ONBOARDING_VERSION = 3;
const DEFAULT_FIREBASE_CLIENT_CONFIG = {
  apiKey: "AIzaSyD2px9fRoSh6bwOBDIk2dGioYbxROQ6Leo",
  authDomain: "goblintown-88fd6.firebaseapp.com",
  projectId: "goblintown-88fd6",
  storageBucket: "goblintown-88fd6.firebasestorage.app",
  messagingSenderId: "904412921746",
  appId: "1:904412921746:web:a92c6ba51e292b0d858b4b",
  measurementId: "G-C1TSNGHXYG",
} as const;

function resolveAssetDir(warrenRoot: string): string | null {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(warrenRoot, "site", "assets"),
    join(warrenRoot, "dist", "site", "assets"),
    join(moduleDir, "..", "site", "assets"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "pigeon-walk-right.png"))) return dir;
  }
  return null;
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
    riteId: artifact.riteId,
    task: artifact.task,
    ref: artifact.evidence.find((e) => e.kind === "file")?.ref ?? artifact.riteId,
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

function inferRunRequest(record: RunRecord): { mode: "rite" | "plan"; payload: Record<string, unknown> } {
  const mode =
    record.mode ??
    (record.events.some((e) => e.kind.startsWith("plan:")) || record.packSize === 0
      ? "plan"
      : "rite");
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
      packSize: record.packSize || 3,
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
    next.packSize = 1;
    next.debate = false;
    next.trollTools = false;
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
  if (record.finalRiteId) {
    next.cite = [...new Set([...cite, record.finalRiteId])];
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
    "https://www.gstatic.com",
    "https://apis.google.com",
    "https://www.googleapis.com",
  ].join(" ");
  const connectSrc = [
    "'self'",
    "https://identitytoolkit.googleapis.com",
    "https://securetoken.googleapis.com",
    "https://firestore.googleapis.com",
    "https://www.googleapis.com",
    "https://*.googleapis.com",
    "https://*.firebaseio.com",
    "wss://*.firebaseio.com",
  ].join(" ");
  const frameSrc = [
    "'self'",
    "https://accounts.google.com",
    "https://*.google.com",
    "https://*.firebaseapp.com",
  ].join(" ");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    `frame-src ${frameSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

export async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const autopilot = opts.autopilot !== false;
  let warren = await loadWarren(opts.cwd);
  await saveWarrenManifest(warren);
  const assetDir = resolveAssetDir(warren.root);
  const app = express();
  const runs = new Map<string, RunState>();
  let runDir = await ensureRunDir(warren.root);

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

  app.use(express.json({ limit: "1mb" }));
  app.use("/assets", express.static(join(warren.root, "site/assets")));
  app.use((_req, res, next) => {
    res.setHeader("X-Goblintown-Warren", warren.manifest.name);
    res.setHeader("Content-Security-Policy", cspHeaderForRequest());
    next();
  });
  if (assetDir) {
    app.use(
      "/assets",
      express.static(assetDir, {
        fallthrough: true,
        maxAge: "1h",
      }),
    );
  }
  app.get("/", (_req, res) => {
    res.type("html").send(flyPageHtml(warren.manifest.name));
  });

  app.post("/api/rite", async (req, res) =>
    startRiteRun(warren, runs, runDir, req, res),
  );
  app.post("/api/goblin/single", async (req, res) =>
    startSingleGoblinRun(warren, req, res),
  );
  app.post("/api/plan", async (req, res) =>
    startPlanRun(warren, runs, runDir, req, res),
  );
  registerFlyRoutes(app, warren);
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
      body.modelSlot === "goblin" || body.modelSlot === "ogre"
        ? body.modelSlot
        : undefined;
    try {
      const result = await runSingleGoblinChat({
        messages,
        personality,
        modelSlot,
        maxOutputTokens,
        hoard: warren.hoard,
      });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get("/api/onboarding", (_req, res) => {
    res.json(onboardingPayload(warren));
  });
  app.get("/api/identity", (_req, res) => {
    res.json(tankIdentityPayload(warren, autopilot));
  });
  app.post("/api/onboarding", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.done !== true) {
      res.status(400).json({ error: "done=true is required" });
      return;
    }
    warren.manifest.onboarding = {
      version: ONBOARDING_VERSION,
      dismissedAt: new Date().toISOString(),
    };
    await saveWarrenManifest(warren);
    res.json(onboardingPayload(warren));
  });
  app.get("/api/rite/:runId/stream", (req, res) =>
    streamRiteRun(runs, req, res),
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
    resumeRun(warren, runs, runDir, req, res),
  );
  app.post("/api/asteroid", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const confirm = typeof body.confirm === "string" ? body.confirm : "";
    if (confirm !== "ASTEROID") {
      res.status(400).json({ error: "ASTEROID confirmation required" });
      return;
    }
    try {
      const root = warren.root;
      for (const state of runs.values()) {
        for (const subscriber of state.subscribers) {
          try {
            subscriber.end();
          } catch {
            // Subscriber may already be closed.
          }
        }
      }
      runs.clear();
      warren = await resetWarren(root);
      await saveWarrenManifest(warren);
      runDir = await ensureRunDir(warren.root);
      res.json({
        ok: true,
        warren: warren.manifest.name,
        createdAt: warren.manifest.createdAt,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get("/api/trace/:runId", (req, res) => {
    const state = runs.get(req.params.runId);
    if (!state) {
      // try by finalRiteId
      const byRite = [...runs.values()].find((r) => r.record.finalRiteId === req.params.runId);
      if (!byRite) {
        res.status(404).json({ error: "no run/rite for that id" });
        return;
      }
      res.json(exportRunAsMasTrace(byRite.record, warren.manifest.name));
      return;
    }
    res.json(exportRunAsMasTrace(state.record, warren.manifest.name));
  });
  app.get("/api/loot/:id", async (req, res) => {
    const loot = await warren.hoard.getLoot(req.params.id);
    if (!loot) {
      res.status(404).json({ error: "loot not found" });
      return;
    }
    res.json(loot);
  });
  app.get("/api/artifact/:id", async (req, res) => {
    const art = await warren.hoard.getArtifact(req.params.id);
    if (!art) {
      res.status(404).json({ error: "artifact not found" });
      return;
    }
    res.json(art);
  });
  app.get("/api/rite/:id/artifact", async (req, res) => {
    const art = await warren.hoard.getArtifactByRiteId(req.params.id);
    if (!art) {
      res.status(404).json({ error: "no artifact for that rite" });
      return;
    }
    res.json(art);
  });
  app.get("/api/artifacts", async (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    const all = (await warren.hoard.allArtifacts()).sort((a, b) => b.timestamp - a.timestamp);
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
        root: warren.root,
        hoard: warren.hoard,
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
      const all = await warren.hoard.allArtifacts();
      const matches = await findRelevantArtifactsEmbedded({
        artifacts: all,
        queryText: query,
        limit: apiLimit(body.limit, 10, 1, 100),
        hoard: warren.hoard,
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
        hoard: warren.hoard,
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
        hoard: warren.hoard,
        missingOnly: body.missingOnly === true || body.missingOnly === "true",
        limit: body.limit === undefined ? undefined : apiLimit(body.limit, 100, 1, 500),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  app.get("/api/warren/stats", async (_req, res) => {
    const [loot, rites] = await Promise.all([
      warren.hoard.allLoot(),
      warren.hoard.allRites(),
    ]);
    const driftSum = loot.reduce((s, l) => s + l.drift.driftRate, 0);
    const drift = loot.length ? driftSum / loot.length : 0;
    res.json({
      warren: warren.manifest.name,
      loot: loot.length,
      rites: rites.length,
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
    res.json(providerPayload(warren));
  });
  app.get("/api/firebase/config", (_req, res) => {
    res.json(firebaseClientConfigPayload());
  });
  app.post("/api/provider", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const config = normalizeProviderConfig(body);
    warren.manifest.provider = config;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
    const clearApiKey = body.clearApiKey === true;
    const apiKeyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
    if (apiKey !== undefined) {
      if (apiKey.length > 0) {
        await setProviderSecretForRoot(warren.root, apiKeyEnv, apiKey);
      } else {
        await clearProviderSecretForRoot(warren.root, apiKeyEnv);
      }
    } else if (clearApiKey) {
      await clearProviderSecretForRoot(warren.root, apiKeyEnv);
    }
    await saveWarrenManifest(warren);
    res.json(providerPayload(warren));
  });
  app.post("/api/cli", async (req, res) => {
    const body = (req.body ?? {}) as { line?: unknown };
    if (typeof body.line !== "string" || body.line.trim().length === 0) {
      res.status(400).json({ error: "line is required" });
      return;
    }
    const args = parseCliLine(body.line.trim());
    if (args.length === 0) {
      res.status(400).json({ error: "empty command" });
      return;
    }
    if (args[0] === "serve") {
      res.status(400).json({ error: "`serve` is already running in this UI session." });
      return;
    }
    const result = await runCliLine(warren.root, args);
    res.json(result);
  });

  app.use((_req, res) =>
    res.status(404).type("html").send("<!doctype html><title>404</title><h1>404</h1>"),
  );

  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(opts.port);
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
        process.stdout.write(
          `Hoard UI listening on http://localhost:${actualPort}/\n` +
            `Warren: ${warren.manifest.name}  (${warren.root})\n`,
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

async function startSingleGoblinRun(
  warren: Warren,
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
    body.outputFormat ?? warren.manifest.provider?.outputFormat,
  );
  const maxOutputTokens =
    typeof body.maxOutputTokens === "number" && body.maxOutputTokens > 0
      ? body.maxOutputTokens
      : undefined;
  const parentArtifacts = remember
    ? await findRelevantArtifactsEmbedded({
        artifacts: await warren.hoard.allArtifacts(),
        queryText: task,
        limit: 3,
        hoard: warren.hoard,
      })
    : [];
  const prompt = parentArtifacts.length
    ? `${parentArtifacts.map(renderArtifactContext).join("\n\n")}\n\nTask:\n${task}`
    : task;
  try {
    const creature = makeGoblin();
    const { text, usage } = await callCreature(creature, prompt, {
      outputFormat,
      maxOutputTokens,
    });
    const drift = measureDrift(text);
    const loot: Loot = {
      id: "",
      creatureKind: "goblin",
      personality: creature.personality,
      model: creature.model,
      prompt,
      output: text,
      timestamp: Date.now(),
      drift,
      usage,
    };
    const lootId = await warren.hoard.stash(loot);
    res.json({
      mode: "single",
      output: text,
      lootId,
      usage,
      parentArtifactIds: parentArtifacts.map((a) => a.id),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

async function startRiteRun(
  warren: Warren,
  runs: Map<string, RunState>,
  runDir: string,
  req: Request,
  res: Response,
  options: StartRunOptions = {},
): Promise<string | undefined> {
  const body = (options.bodyOverride ?? req.body ?? {}) as {
    task?: unknown;
    packSize?: unknown;
    scanGlobs?: unknown;
    personality?: unknown;
    noFallback?: unknown;
    noSpecialist?: unknown;
    specialistCap?: unknown;
    debate?: unknown;
    trollTools?: unknown;
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
  const packSize = typeof body.packSize === "number" ? body.packSize : 3;
  const noFallback = !!body.noFallback;
  const noSpecialist = !!body.noSpecialist;
  const specialistCap =
    typeof body.specialistCap === "number" && body.specialistCap > 0
      ? body.specialistCap
      : undefined;
  const debate = !!body.debate;
  const trollTools = !!body.trollTools;
  const budgetTokens =
    typeof body.budgetTokens === "number" && body.budgetTokens > 0
      ? body.budgetTokens
      : undefined;
  const maxOutputTokens =
    typeof body.maxOutputTokens === "number" && body.maxOutputTokens > 0
      ? body.maxOutputTokens
      : undefined;
  const citeRiteIds = Array.isArray(body.cite)
    ? (body.cite.filter((c) => typeof c === "string") as string[])
    : [];
  const remember = !!body.remember;
  const outputFormat = normalizeOutputFormat(
    body.outputFormat ?? warren.manifest.provider?.outputFormat,
  );

  const record: RunRecord = {
    runId,
    task: body.task,
    originalTask: options.originalTask,
    packSize,
    scanGlobs,
    personality,
    noFallback,
    mode: "rite",
    status: "running",
    request: {
      mode: "rite",
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

  // coalesce disk writes during bursty pack steps
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

  const rewardPlugin = await loadRewardPlugin(warren.root);
  if (rewardPlugin.source !== "builtin") {
    emit("reward-plugin", { source: rewardPlugin.source });
  }

  // Optional Phase 1 memory hookup from the rite form too.
  const parentArtifacts: Artifact[] = [];
  for (const r of citeRiteIds) {
    const a = await warren.hoard.getArtifactByRiteId(r);
    if (a) parentArtifacts.push(a);
  }
  if (remember) {
    const all = await warren.hoard.allArtifacts();
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: body.task,
      limit: 3,
      hoard: warren.hoard,
    })).filter(
      (a) => !parentArtifacts.some((p) => p.id === a.id),
    );
    parentArtifacts.push(...auto);
  }

  performRite({
    task: body.task,
    packSize,
    scanGlobs,
    cwd: warren.root,
    hoard: warren.hoard,
    personality,
    rewardFn: rewardPlugin.fn,
    noFallback,
    noSpecialist,
    specialistCap,
    debate,
    trollTools,
    tools: trollTools ? builtinTools : undefined,
    budgetTokens,
    maxOutputTokensPerCall: maxOutputTokens,
    outputFormat,
    parentArtifacts,
    onStep: (step: RiteStep) => emit("step", step),
  })
    .then(async (result) => {
      state.record.finalRiteId = result.rite.id;
      state.record.outcome = result.rite.outcome;
      emit("done", {
        riteId: result.rite.id,
        outcome: result.rite.outcome,
        winnerLootId: result.rite.winnerLootId,
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
  warren: Warren,
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
  const plannerSpec = typeof body.planner === "string" && body.planner.trim() ? body.planner.trim() : (warren.manifest.flytown?.planner ?? "llm");
  const maxNodes = typeof body.maxNodes === "number" ? body.maxNodes : 6;
  const maxReplan = typeof body.maxReplan === "number" ? body.maxReplan : 2;
  const budgetTokens = typeof body.budgetTokens === "number" ? body.budgetTokens : undefined;
  const outputFormat = normalizeOutputFormat(
    body.outputFormat ?? warren.manifest.provider?.outputFormat,
  );
  const cites = Array.isArray(body.cite) ? (body.cite.filter((c) => typeof c === "string") as string[]) : [];
  const remember = !!body.remember;

  const record: RunRecord = {
    runId,
    task: body.task,
    originalTask: options.originalTask,
    packSize: 0, // not directly meaningful for plans
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

  const rewardPlugin = await loadRewardPlugin(warren.root);

  // Memory load
  const parents: Artifact[] = [];
  for (const r of cites) {
    const a = await warren.hoard.getArtifactByRiteId(r);
    if (a) parents.push(a);
  }
  if (remember) {
    const all = await warren.hoard.allArtifacts();
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: body.task,
      limit: 3,
      hoard: warren.hoard,
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
        root: warren.root, seed: warren.manifest.flytown?.seed, connectome: warren.manifest.flytown?.connectome,
        learning: warren.manifest.flytown?.learning, fallback: warren.manifest.flytown?.fallbackToLlm !== false,
        onFallback: (err) => emit("plan:fallback", { from: plannerSpec, to: "llm", error: err instanceof Error ? err.message : String(err) }),
      });
      const planned = await planner.plan({
        task: body.task as string,
        cwd: warren.root,
        parentArtifacts: parents,
        maxNodes,
        budgetTokens,
        runId,
      });
      const { plan } = planned;
      if (planned.trace) {
        await writeTrace(warren.root, planned.trace);
        emit("plan:trace", { runId: planned.trace.runId, plannerId: planned.trace.plannerId, primary: planned.trace.decision.primary, included: planned.trace.decision.included, brain: planned.trace.brain ? { connectomeId: planned.trace.brain.connectomeId, variant: planned.trace.brain.variant, stats: planned.trace.brain.stats } : undefined });
      }
      emit("plan:built", { plan });
      const result = await executePlan({
        plan,
        cwd: warren.root,
        hoard: warren.hoard,
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
      state.record.finalRiteId = result.finalRiteId;
      emit("done", {
        riteId: result.finalRiteId,
        outcome: result.outcome,
        finalArtifactId: result.finalArtifact?.id,
        finalLootId: result.finalLootId,
        winnerLootId: result.finalLootId,
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
  warren: Warren,
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
      ? await startPlanRun(warren, runs, runDir, req, res, {
          bodyOverride: payload,
          resumedFromRunId: source.runId,
          originalTask: originalTaskForResume(source),
        })
      : await startRiteRun(warren, runs, runDir, req, res, {
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

function streamRiteRun(
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

function providerPayload(warren: Warren): {
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
  const config = normalizeProviderConfig(warren.manifest.provider);
  const storedSecrets = readProviderSecretsForRootSync(warren.root);
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

function onboardingPayload(warren: Warren): {
  done: boolean;
  version: number;
  dismissedAt?: string;
} {
  const onboarding = warren.manifest.onboarding ?? {};
  const dismissedAt = typeof onboarding.dismissedAt === "string" ? onboarding.dismissedAt : undefined;
  const done = onboarding.version === ONBOARDING_VERSION && !!dismissedAt;
  return {
    done,
    version: ONBOARDING_VERSION,
    ...(dismissedAt ? { dismissedAt } : {}),
  };
}

function tankIdentityPayload(warren: Warren, autopilot: boolean): Record<string, unknown> {
  return {
    ok: true,
    name: warren.manifest.name,
    root: warren.root,
    scope: warren.scope,
    manifestPath: warren.manifestPath,
    autopilot,
  };
}

function firebaseClientConfigPayload(): {
  enabled: boolean;
  config: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
    storageBucket?: string;
    messagingSenderId?: string;
    measurementId?: string;
  } | null;
} {
  const apiKey = trimmedEnv("FIREBASE_API_KEY") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.apiKey;
  const authDomain = trimmedEnv("FIREBASE_AUTH_DOMAIN") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.authDomain;
  const projectId = trimmedEnv("FIREBASE_PROJECT_ID") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.projectId;
  const appId = trimmedEnv("FIREBASE_APP_ID") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.appId;
  const enabled = !!(apiKey && authDomain && projectId && appId);
  if (!enabled) return { enabled: false, config: null };
  return {
    enabled: true,
    config: {
      apiKey,
      authDomain,
      projectId,
      appId,
      ...(trimmedEnv("FIREBASE_STORAGE_BUCKET") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.storageBucket
        ? { storageBucket: (trimmedEnv("FIREBASE_STORAGE_BUCKET") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.storageBucket) as string }
        : {}),
      ...(trimmedEnv("FIREBASE_MESSAGING_SENDER_ID") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.messagingSenderId
        ? { messagingSenderId: (trimmedEnv("FIREBASE_MESSAGING_SENDER_ID") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.messagingSenderId) as string }
        : {}),
      ...(trimmedEnv("FIREBASE_MEASUREMENT_ID") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.measurementId
        ? { measurementId: (trimmedEnv("FIREBASE_MEASUREMENT_ID") ?? DEFAULT_FIREBASE_CLIENT_CONFIG.measurementId) as string }
        : {}),
    },
  };
}

function trimmedEnv(name: string): string | null {
  const v = process.env[name];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function parseCliLine(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    out.push(raw.replace(/\\(["'`\\])/g, "$1"));
  }
  return out;
}

async function runCliLine(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; code: number; stdout: string; stderr: string; command: string }> {
  const cliPath = join(cwd, "dist", "cli.js");
  const command = ["node", cliPath, ...args].join(" ");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 500_000) stdout = stdout.slice(-500_000);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, 8 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      const exitCode = typeof code === "number" ? code : 1;
      resolve({
        ok: exitCode === 0,
        code: exitCode,
        stdout,
        stderr,
        command,
      });
    });
  });
}
