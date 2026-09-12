import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import {
  normalizeChatMessages,
  runSingleGoblinChat,
} from "./chat.js";
import { CHAT_PERSONA_UI } from "./chat-persona.js";
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
  CREATURE_KINDS,
  type Artifact,
  type CreatureKind,
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
import { registerFlyRoutes } from "./flytown/web.js";

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
const require = createRequire(import.meta.url);
const MATTER_JS_BROWSER_PATH = require.resolve("matter-js/build/matter.min.js");
const MATTER_JS_BROWSER_SOURCE = `;(function(){var module=undefined;var exports=undefined;\n${readFileSync(MATTER_JS_BROWSER_PATH, "utf8")}\n}).call(window);`;

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
  app.get("/vendor/matter-js/matter.min.js", (_req, res) => {
    res.type("application/javascript").send(MATTER_JS_BROWSER_SOURCE);
  });

  app.get("/", async (_req, res) => renderHome(warren, runs, res, autopilot));
  app.get("/tank", async (_req, res) => renderHome(warren, runs, res, autopilot));
  app.get("/chat", (_req, res) =>
    autopilot
      ? res.redirect("/")
      : res.send(layout("Single Goblin Chat", chatPage())),
  );
  app.get("/rite/new", (_req, res) =>
    res.send(layout("New Rite", newRiteForm())),
  );
  app.get("/rite/:id", async (req, res) => renderRite(warren, req, res));
  app.get("/quest/:id", async (req, res) => renderQuest(warren, req, res));
  app.get("/loot/:id", async (req, res) => renderLoot(warren, req, res));
  app.get("/drift", async (_req, res) => renderDrift(warren, res));
  app.get("/runs", async (_req, res) => renderRuns(runs, res));

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
    res
      .status(404)
      .send(layout("Not Found", "<h1>404</h1><p>The Hoard does not contain that.</p>")),
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

async function renderRuns(
  runs: Map<string, RunState>,
  res: Response,
): Promise<void> {
  const records = [...runs.values()]
    .map((s) => s.record)
    .sort((a, b) => b.startedAt - a.startedAt);
  const rows = records
    .map((r) => {
      const runStatus = r.status ?? (r.done ? (r.error ? "error" : "done") : "running");
      const status = runStatus === "done"
        ? `<span class="tag tag-pass">done</span>`
        : runStatus === "running"
          ? `<span class="tag tag-winner">running</span>`
          : runStatus === "interrupted"
            ? `<span class="tag tag-fail">interrupted</span>`
            : `<span class="tag tag-fail">error</span>`;
      const link = r.finalRiteId
        ? `<a href="/rite/${esc(r.finalRiteId)}">${esc(r.finalRiteId)}</a>`
        : "—";
      const watchLabel = r.done ? "replay" : "watch live";
      const resume = r.resumable
        ? ` · <a href="/?run=${esc(r.runId)}">resume</a>`
        : "";
      return `<tr>
        <td><a href="/?run=${esc(r.runId)}" title="${watchLabel} in tank">${esc(r.runId)}</a></td>
        <td>${status}${resume}</td>
        <td>${link}</td>
        <td>${r.nextSeq ?? r.events.length}</td>
        <td>${esc(new Date(r.startedAt).toISOString())}</td>
        <td><pre style="margin:0; white-space: pre-wrap; word-break: break-word; max-width: 60ch;">${esc(r.task)}</pre></td>
      </tr>`;
    })
    .join("");
  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Runs (${records.length})</h1>
    <table>
      <tr><th>runId</th><th>status</th><th>rite</th><th>events</th><th>started</th><th>task</th></tr>
      ${rows || `<tr><td colspan="6" class="muted">none</td></tr>`}
    </table>
  `;
  res.send(layout("Runs", body));
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


async function renderHome(
  warren: Warren,
  runs: Map<string, RunState>,
  res: Response,
  autopilot: boolean,
): Promise<void> {
  const [rites, loot] = await Promise.all([
    warren.hoard.allRites(),
    warren.hoard.allLoot(),
  ]);
  const driftSum = loot.reduce((s, l) => s + l.drift.driftRate, 0);
  const drift = loot.length ? driftSum / loot.length : 0;
  res.send(tankHtml(warren.manifest.name, loot.length, rites.length, drift, runs, autopilot));
}

async function renderGoblinMode(
  warren: Warren,
  runs: Map<string, RunState>,
  res: Response,
): Promise<void> {
  const [rites, loot, artifacts] = await Promise.all([
    warren.hoard.allRites(),
    warren.hoard.allLoot(),
    warren.hoard.allArtifacts(),
  ]);
  const driftSum = loot.reduce((s, l) => s + l.drift.driftRate, 0);
  const drift = loot.length ? driftSum / loot.length : 0;
  res.send(
    goblinModeHtml({
      warrenName: warren.manifest.name,
      lootCount: loot.length,
      riteCount: rites.length,
      artifactCount: artifacts.length,
      runCount: runs.size,
      drift,
    }),
  );
}

async function renderRite(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const rite = await warren.hoard.getRite(req.params.id);
  if (!rite) {
    res.status(404).send(layout("Not Found", "<h1>Rite not found</h1>"));
    return;
  }
  const allLootIds = new Set<string>();
  if (rite.contextLootId) allLootIds.add(rite.contextLootId);
  for (const id of rite.goblinLootIds) allLootIds.add(id);
  for (const id of Object.values(rite.chaosLootIds)) allLootIds.add(id);
  if (rite.ogreLootId) allLootIds.add(rite.ogreLootId);

  const loots = await Promise.all(
    [...allLootIds].map((id) => warren.hoard.getLoot(id)),
  );
  const lootById = new Map(loots.filter((l) => l).map((l) => [l!.id, l!]));

  const goblinRows = rite.goblinLootIds
    .map((gid) => {
      const g = lootById.get(gid);
      const v = rite.trollVerdicts[gid];
      const chaosId = rite.chaosLootIds[gid];
      const tag = gid === rite.winnerLootId ? `<span class="tag tag-winner">winner</span>` : "";
      return `<tr>
        <td><a href="/loot/${esc(gid)}">${esc(gid)}</a> ${tag}</td>
        <td>${chaosId ? `<a href="/loot/${esc(chaosId)}">${esc(chaosId)}</a>` : "—"}</td>
        <td>${v ? v.score.toFixed(2) : "—"}</td>
        <td>${v ? (v.passed ? `<span class="tag tag-pass">PASS</span>` : `<span class="tag tag-fail">FAIL</span>`) : "—"}</td>
        <td>${g ? (g.reward ?? 0).toFixed(3) : "—"}</td>
        <td>${g ? g.drift.driftRate.toFixed(4) : "—"}</td>
        <td class="critique">${esc(truncate(v?.critique ?? "", 200))}</td>
      </tr>`;
    })
    .join("");

  const ogre = rite.ogreLootId ? lootById.get(rite.ogreLootId) : null;

  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Rite ${esc(rite.id)}</h1>
    <p class="muted">${esc(new Date(rite.startedAt).toISOString())} · pack=${rite.packSize} · personality=${esc(rite.personality)} · outcome=<span class="tag tag-${esc(rite.outcome)}">${esc(rite.outcome)}</span></p>
    <h2>Task</h2>
    <pre>${esc(rite.task)}</pre>

    ${
      rite.contextLootId
        ? `<h2>Raccoon scavenge</h2>
           <p><a href="/loot/${esc(rite.contextLootId)}">${esc(rite.contextLootId)}</a> · ${rite.scanGlobs.length} glob(s): ${rite.scanGlobs.map((g) => `<code>${esc(g)}</code>`).join(", ")}</p>`
        : ""
    }

    <h2>Pack & arbitration</h2>
    <table>
      <tr><th>Goblin</th><th>Gremlin</th><th>Troll</th><th></th><th>Shinies</th><th>Drift</th><th>Critique</th></tr>
      ${goblinRows}
    </table>

    ${
      ogre
        ? `<h2>Ogre fallback</h2>
           <p><a href="/loot/${esc(ogre.id)}">${esc(ogre.id)}</a> — synthesized from ${ogre.parentLootIds?.length ?? 0} failed attempts.</p>
           <pre>${esc(ogre.output)}</pre>`
        : ""
    }
  `;
  res.send(layout(`Rite ${rite.id}`, body));
}

async function renderQuest(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const quests = await warren.hoard.allQuests();
  const quest = quests.find((q) => q.id === req.params.id);
  if (!quest) {
    res.status(404).send(layout("Not Found", "<h1>Quest not found</h1>"));
    return;
  }
  const loots = await Promise.all(
    quest.lootIds.map((id) => warren.hoard.getLoot(id)),
  );

  const rows = loots
    .map((l) => {
      if (!l) return "";
      const v = quest.trollVerdicts[l.id];
      const tag = l.id === quest.winnerLootId ? `<span class="tag tag-winner">winner</span>` : "";
      return `<tr>
        <td><a href="/loot/${esc(l.id)}">${esc(l.id)}</a> ${tag}</td>
        <td>${v ? v.score.toFixed(2) : "—"}</td>
        <td>${v ? (v.passed ? `<span class="tag tag-pass">PASS</span>` : `<span class="tag tag-fail">FAIL</span>`) : "—"}</td>
        <td>${(l.reward ?? 0).toFixed(3)}</td>
        <td>${l.drift.driftRate.toFixed(4)}</td>
        <td class="critique">${esc(truncate(v?.critique ?? "", 200))}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Quest ${esc(quest.id)}</h1>
    <p class="muted">${esc(new Date(quest.startedAt).toISOString())} · pack=${quest.packSize} · personality=${esc(quest.personality)}</p>
    <h2>Task</h2>
    <pre>${esc(quest.task)}</pre>
    <h2>Pack</h2>
    <table>
      <tr><th>Loot</th><th>Troll</th><th></th><th>Shinies</th><th>Drift</th><th>Critique</th></tr>
      ${rows}
    </table>
  `;
  res.send(layout(`Quest ${quest.id}`, body));
}

async function renderLoot(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const loot = await warren.hoard.getLoot(req.params.id);
  if (!loot) {
    res.status(404).send(layout("Not Found", "<h1>Loot not found</h1>"));
    return;
  }
  const parents = loot.parentLootIds ?? [];
  const driftRows = CREATURE_KINDS.map(
    (k) => `<tr><td>${k}</td><td>${loot.drift.creatureMentions[k]}</td></tr>`,
  ).join("");

  const usageBlock = loot.usage
    ? ` · tokens p=${loot.usage.promptTokens}/c=${loot.usage.completionTokens}/t=${loot.usage.totalTokens}`
    : "";
  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Loot ${esc(loot.id)}</h1>
    <p class="muted">
      ${esc(loot.creatureKind)} · ${esc(loot.personality)} · ${esc(loot.model)} · ${esc(new Date(loot.timestamp).toISOString())}
      ${loot.reward !== undefined ? ` · shinies=${loot.reward.toFixed(3)}` : ""}${usageBlock}
    </p>

    ${
      parents.length > 0
        ? `<p>Parents: ${parents.map((p) => `<a href="/loot/${esc(p)}">${esc(p)}</a>`).join(", ")}</p>`
        : ""
    }
    ${loot.questId ? `<p>Quest: <a href="/quest/${esc(loot.questId)}">${esc(loot.questId)}</a></p>` : ""}
    ${loot.riteId ? `<p>Rite: <a href="/rite/${esc(loot.riteId)}">${esc(loot.riteId)}</a></p>` : ""}

    <h2>Output</h2>
    <pre>${esc(loot.output)}</pre>

    <h2>Prompt</h2>
    <pre>${esc(loot.prompt)}</pre>

    <h2>Drift</h2>
    <p>Cross-creature words: ${loot.drift.totalCreatureWords} / ${loot.drift.outputWordCount} words · rate=${loot.drift.driftRate.toFixed(4)}</p>
    <table><tr><th>Creature</th><th>Mentions</th></tr>${driftRows}</table>
  `;
  res.send(layout(`Loot ${loot.id}`, body));
}

async function renderDrift(warren: Warren, res: Response): Promise<void> {
  const all = await warren.hoard.allLoot();
  const byKind = new Map<CreatureKind, number[]>();
  for (const k of CREATURE_KINDS) byKind.set(k, []);
  for (const l of all) byKind.get(l.creatureKind)?.push(l.drift.driftRate);

  const rows = CREATURE_KINDS.map((k) => {
    const rates = byKind.get(k) ?? [];
    const avg = rates.length
      ? rates.reduce((a, b) => a + b, 0) / rates.length
      : 0;
    return `<tr><td>${k}</td><td>${rates.length}</td><td>${avg.toFixed(4)}</td></tr>`;
  }).join("");

  const body = `
    <p><a href="/">← Hoard</a></p>
    <h1>Drift report</h1>
    <p class="muted">Cross-creature mentions / total words. High = reward signal is leaking.</p>
    <table>
      <tr><th>Creature</th><th>n</th><th>avg drift rate</th></tr>
      ${rows}
    </table>
    <p class="muted">${all.length} total loot drops scanned.</p>
  `;
  res.send(layout("Drift", body));
}

function creatureCounts(
  loot: { creatureKind: CreatureKind }[],
): Record<CreatureKind, number> {
  const counts: Record<CreatureKind, number> = {
    goblin: 0,
    gremlin: 0,
    raccoon: 0,
    troll: 0,
    ogre: 0,
    pigeon: 0,
  };
  for (const l of loot) counts[l.creatureKind]++;
  return counts;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(title)} · Goblintown</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, Menlo, Consolas, monospace; background: #0d1410; color: #b9d3a8; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  h1, h2, h3 { color: #d8efb6; font-weight: 600; }
  h1 { border-bottom: 1px solid #2a3d22; padding-bottom: .5rem; }
  a { color: #8fcf52; }
  a:hover { color: #c2f37a; }
  pre { background: #0a0e08; padding: .8rem; border-left: 3px solid #2a3d22; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  code { background: #0a0e08; padding: 1px 4px; border-radius: 2px; }
  table { border-collapse: collapse; margin: .5rem 0 1.5rem; width: 100%; }
  th, td { border: 1px solid #1f2d18; padding: .35rem .6rem; text-align: left; vertical-align: top; }
  th { background: #14201a; }
  .muted { color: #5a7042; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .tag-pass { background: #1f3a14; color: #b6f37a; }
  .tag-fail { background: #3a1414; color: #f3a07a; }
  .tag-winner { background: #5a4a14; color: #f3df7a; }
  .tag-winner, .tag-ogre_fallback, .tag-all_failed { padding-left: 6px; padding-right: 6px; }
  .tag-ogre_fallback { background: #3a2914; color: #f3c07a; }
  .tag-all_failed { background: #3a1414; color: #f3a07a; }
  .critique { color: #98b878; font-style: italic; max-width: 30ch; }
  section { margin: 1.5rem 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function newRiteForm(): string {
  return `
    <p><a href="/">← Hoard</a></p>
    <h1>New rite</h1>
    <form id="rite-form">
      <p><label>Task<br><textarea name="task" rows="4" cols="80" placeholder="What should the goblins solve?" required></textarea></label></p>
      <p><label>Pack size <input name="packSize" type="number" value="3" min="1" max="9"></label>
         &nbsp;<label>Personality
           <select name="personality">
             <option value="nerdy">nerdy</option>
             <option value="cynical">cynical</option>
             <option value="chipper">chipper</option>
             <option value="stoic">stoic</option>
             <option value="feral">feral</option>
             <option value="goblin_mode">goblin_mode</option>
           </select>
         </label>
         &nbsp;<label><input type="checkbox" name="noFallback"> skip Ogre fallback</label>
      </p>
      <p><label>Scan globs (one per line — optional)<br><textarea name="scanGlobs" rows="3" cols="60" placeholder="src/**/*.ts"></textarea></label></p>
      <p><button type="submit">Begin rite</button></p>
    </form>
    <h2>Stream</h2>
    <pre id="log" style="min-height: 12em;">(idle)</pre>
    <p id="winner-link"></p>
    <script>
      const form = document.getElementById("rite-form");
      const log = document.getElementById("log");
      const winnerLink = document.getElementById("winner-link");
      function append(s) { log.textContent = (log.textContent === "(idle)" ? "" : log.textContent) + s + "\\n"; log.scrollTop = log.scrollHeight; }
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        log.textContent = "";
        winnerLink.innerHTML = "";
        const fd = new FormData(form);
        const scanGlobs = (fd.get("scanGlobs") || "").toString().split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
        const payload = {
          task: fd.get("task"),
          packSize: Number(fd.get("packSize") || 3),
          personality: fd.get("personality"),
          noFallback: !!fd.get("noFallback"),
          scanGlobs,
        };
        append("POST /api/rite ...");
        const startRes = await fetch("/api/rite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!startRes.ok) { append("error: " + (await startRes.text())); return; }
        const { runId } = await startRes.json();
        append("runId=" + runId + " — opening SSE stream");
        const es = new EventSource("/api/rite/" + runId + "/stream");
        es.addEventListener("step", (ev) => append("• " + JSON.stringify(JSON.parse(ev.data))));
        es.addEventListener("reward-plugin", (ev) => append("(reward plugin: " + JSON.parse(ev.data).source + ")"));
        es.addEventListener("done", (ev) => {
          const d = JSON.parse(ev.data);
          append("✔ done — outcome=" + d.outcome + " riteId=" + d.riteId);
          winnerLink.innerHTML = '<a href="/rite/' + d.riteId + '">→ view rite ' + d.riteId + '</a>';
          es.close();
        });
        es.addEventListener("error", (ev) => {
          let msg = "(connection error)";
          try { msg = JSON.parse(ev.data).message; } catch {}
          append("✖ error: " + msg);
          es.close();
        });
      });
    </script>
  `;
}

function chatPage(): string {
  return `
    <p><a href="/">&larr; Tank</a> · <a href="/runs">Runs</a></p>
    <h1>Single Goblin Chat</h1>
    <style>
      .chat-shell { display: grid; gap: .85rem; max-width: 860px; }
      .chat-toolbar { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; }
      .chat-toolbar label { display: inline-flex; align-items: center; gap: .4rem; }
      .chat-log { min-height: 360px; max-height: 58vh; overflow-y: auto; background: #0a0e08; border: 1px solid #1f2d18; padding: .9rem; }
      .chat-msg { margin: 0 0 .85rem; padding: .7rem .8rem; border-left: 3px solid #2a3d22; background: rgba(20, 32, 26, .55); white-space: pre-wrap; word-break: break-word; }
      .chat-msg.user { border-left-color: #8fcf52; }
      .chat-msg.assistant { border-left-color: #5a7042; }
      .chat-role { display: block; color: #5a7042; font-size: 11px; text-transform: uppercase; margin-bottom: .25rem; }
      .chat-compose { display: grid; gap: .5rem; }
      .chat-compose textarea, .chat-toolbar select, .chat-toolbar input { background: #0a0e08; color: #d8efb6; border: 1px solid #2a3d22; border-radius: 3px; padding: .55rem; font: inherit; }
      .chat-actions { display: flex; gap: .5rem; align-items: center; }
      .chat-actions button { background: #1f3a14; color: #d8efb6; border: 1px solid #416b26; border-radius: 3px; padding: .5rem .8rem; font: inherit; cursor: pointer; }
      .chat-actions button.secondary { background: #14201a; border-color: #2a3d22; }
      .chat-actions button:disabled { opacity: .55; cursor: wait; }
      .chat-offer { display: none; border: 1px solid #2a3d22; background: #101a12; padding: .75rem; }
      .chat-offer.open { display: flex; gap: .75rem; align-items: center; justify-content: space-between; flex-wrap: wrap; }
      .chat-offer button { background: #1f3a14; color: #d8efb6; border: 1px solid #416b26; border-radius: 3px; padding: .45rem .7rem; font: inherit; cursor: pointer; }
      .chat-status { color: #5a7042; }
    </style>
    <div class="chat-shell">
      <div class="chat-toolbar">
        <label>Personality
          <select id="chat-personality">
            <option value="chipper">chipper</option>
            <option value="nerdy">nerdy</option>
            <option value="stoic">stoic</option>
            <option value="cynical">cynical</option>
            <option value="feral">feral</option>
            <option value="goblin_mode">goblin_mode</option>
          </select>
        </label>
        <input id="chat-max" type="hidden" value="900">
        <span class="chat-status" id="chat-status">ready</span>
      </div>
      <div class="chat-log" id="chat-log" aria-live="polite"></div>
      <div class="chat-offer" id="chat-offer">
        <span id="chat-offer-text"></span>
        <button id="chat-offer-run" type="button">Run Goblintown</button>
      </div>
      <form class="chat-compose" id="chat-form">
        <textarea id="chat-input" rows="4" placeholder="Ask the single Goblin anything..." required></textarea>
        <div class="chat-actions">
          <button id="chat-send" type="submit" title="Send (Enter or Cmd/Ctrl+Enter)">Send</button>
          <button class="secondary" id="chat-clear" type="button">Clear</button>
        </div>
      </form>
    </div>
    <script>
      const messages = [];
      const log = document.getElementById("chat-log");
      const form = document.getElementById("chat-form");
      const input = document.getElementById("chat-input");
      const send = document.getElementById("chat-send");
      const clear = document.getElementById("chat-clear");
      const status = document.getElementById("chat-status");
      const personality = document.getElementById("chat-personality");
      const maxTokens = document.getElementById("chat-max");
      const offer = document.getElementById("chat-offer");
      const offerText = document.getElementById("chat-offer-text");
      const offerRun = document.getElementById("chat-offer-run");
      let offeredTask = "";

      function escHtml(value) {
        return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
      }

      function renderMessage(message, lootId) {
        const node = document.createElement("div");
        node.className = "chat-msg " + message.role;
        const loot = lootId ? ' <a href="/loot/' + encodeURIComponent(lootId) + '">loot</a>' : "";
        node.innerHTML = '<span class="chat-role">' + message.role + loot + '</span>' + escHtml(message.content);
        log.appendChild(node);
        log.scrollTop = log.scrollHeight;
      }

      function renderGoblintownOffer(nextOffer) {
        if (!nextOffer || !nextOffer.task) {
          offer.classList.remove("open");
          offeredTask = "";
          return;
        }
        offeredTask = nextOffer.task;
        offerText.textContent = nextOffer.requested
          ? "Goblintown requested. Start a full pack rite for this prompt?"
          : "This looks complex enough for the full Goblintown pack.";
        offer.classList.add("open");
      }

      function submitChatForm() {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
          return;
        }
        send.click();
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const content = input.value.trim();
        if (!content) return;
        const userMessage = { role: "user", content };
        messages.push(userMessage);
        renderMessage(userMessage);
        input.value = "";
        send.disabled = true;
        status.textContent = "thinking";
        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages,
              personality: personality.value,
              maxOutputTokens: Number(maxTokens.value || 900),
            }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || response.statusText);
          messages.push(body.message);
          renderMessage(body.message, body.lootId);
          renderGoblintownOffer(body.goblintownOffer);
          if (body.goblintownOffer && body.goblintownOffer.requested) {
            await startOfferedRite(body.goblintownOffer.task);
          } else {
            status.textContent = body.lootId ? "saved " + body.lootId : "ready";
          }
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : String(err);
        } finally {
          send.disabled = false;
          input.focus();
        }
      });

      clear.addEventListener("click", () => {
        messages.splice(0, messages.length);
        log.innerHTML = "";
        status.textContent = "ready";
        renderGoblintownOffer(null);
        input.focus();
      });

      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.shiftKey) return;
        if (event.metaKey || event.ctrlKey || !event.altKey) {
          event.preventDefault();
          submitChatForm();
        }
      });

      async function startOfferedRite(taskValue) {
        const task = (taskValue || offeredTask).trim();
        if (!task) return;
        offerRun.disabled = true;
        status.textContent = "starting Goblintown";
        try {
          const response = await fetch("/api/rite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              task,
              packSize: 3,
              personality: personality.value,
              remember: true,
            }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || response.statusText);
          status.innerHTML = 'Goblintown running: <a href="/?run=' + encodeURIComponent(body.runId) + '">open run</a>';
          offer.classList.remove("open");
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : String(err);
        } finally {
          offerRun.disabled = false;
        }
      }

      offerRun.addEventListener("click", () => startOfferedRite(offeredTask));
    </script>
  `;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function goblinModeHtml(stats: {
  warrenName: string;
  lootCount: number;
  riteCount: number;
  artifactCount: number;
  runCount: number;
  drift: number;
}): string {
  const initial = JSON.stringify(stats);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Goblin Mode · ${esc(stats.warrenName)}</title>
<style>
  :root {
    color-scheme: dark;
    --mud: #120f08;
    --peat: #1b160b;
    --rot: #261d0c;
    --moss: #8ba34a;
    --moss-hot: #c4e86a;
    --bog: #4e5f2a;
    --bone: #e7dfbd;
    --ash: #9b8f62;
    --line: #4b3a16;
    --bad: #d96f42;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; }
  body {
    background:
      radial-gradient(circle at 50% 42%, rgba(139, 163, 74, 0.09), transparent 34%),
      linear-gradient(180deg, #15130d 0%, var(--mud) 100%);
    color: var(--bone);
    font: 14px/1.45 ui-monospace, Menlo, Consolas, monospace;
  }
  .goblin-mode-shell {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 32px 18px;
  }
  .goblin-mode-core {
    width: min(880px, 94vw);
  }
  h1 {
    margin: 0 0 28px;
    text-align: center;
    font-size: clamp(24px, 4vw, 36px);
    line-height: 1.1;
    font-weight: 500;
    color: var(--bone);
    letter-spacing: 0;
    text-transform: lowercase;
  }
  .composer {
    background: rgba(31, 26, 14, 0.92);
    border: 1px solid rgba(139, 163, 74, 0.22);
    border-radius: 10px;
    box-shadow: 0 22px 80px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(231, 223, 189, 0.05);
    overflow: hidden;
  }
  .modebar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 12px;
    border-bottom: 1px solid rgba(139, 163, 74, 0.18);
    background: rgba(18, 15, 8, 0.52);
  }
  .segment {
    display: inline-grid;
    grid-template-columns: 1fr 1fr;
    border: 1px solid rgba(139, 163, 74, 0.32);
    border-radius: 8px;
    overflow: hidden;
  }
  .segment button,
  .send {
    border: 0;
    background: transparent;
    color: var(--ash);
    font: inherit;
    padding: 8px 11px;
    cursor: pointer;
  }
  .segment button[aria-pressed="true"] {
    background: rgba(139, 163, 74, 0.18);
    color: var(--moss-hot);
  }
  .composer-field {
    position: relative;
  }
  .tank-toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--ash);
    user-select: none;
  }
  .tank-toggle input { accent-color: var(--moss); }
  .send {
    position: absolute;
    right: 12px;
    bottom: 12px;
    border: 1px solid rgba(196, 232, 106, 0.34);
    border-radius: 8px;
    color: var(--moss-hot);
    background: rgba(139, 163, 74, 0.12);
    min-width: 48px;
  }
  textarea {
    width: 100%;
    min-height: 142px;
    resize: vertical;
    border: 0;
    outline: 0;
    padding: 18px 78px 50px 18px;
    background: transparent;
    color: var(--bone);
    font: 16px/1.45 ui-monospace, Menlo, Consolas, monospace;
  }
  textarea::placeholder { color: rgba(155, 143, 98, 0.72); }
  .status-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    padding: 10px 12px;
    border-top: 1px solid rgba(139, 163, 74, 0.16);
    color: var(--ash);
    font-size: 12px;
  }
  .status-row b { color: var(--moss-hot); font-weight: 500; }
  .output, .old-tank-box {
    margin-top: 14px;
    background: rgba(18, 15, 8, 0.82);
    border: 1px solid rgba(139, 163, 74, 0.22);
    border-radius: 8px;
    overflow: hidden;
  }
  .output[hidden], .old-tank-box[hidden] { display: none; }
  .panel-title {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 11px;
    color: var(--moss-hot);
    border-bottom: 1px solid rgba(139, 163, 74, 0.18);
    background: rgba(38, 29, 12, 0.7);
    font-size: 12px;
    text-transform: lowercase;
  }
  .import-controls {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr) minmax(0, 0.9fr) auto auto auto;
    gap: 8px;
    padding: 10px;
    border-bottom: 1px solid rgba(139, 163, 74, 0.18);
  }
  .import-controls select,
  .import-controls input[type="text"],
  .import-controls button {
    min-width: 0;
    border: 1px solid rgba(139, 163, 74, 0.28);
    border-radius: 7px;
    background: rgba(31, 26, 14, 0.88);
    color: var(--bone);
    font: inherit;
    padding: 7px 9px;
  }
  .import-controls button {
    cursor: pointer;
    color: var(--moss-hot);
    background: rgba(139, 163, 74, 0.12);
  }
  .import-controls label {
    grid-column: 1 / -1;
    color: var(--ash);
    font-size: 12px;
  }
  .chat-import-results {
    max-height: 190px;
    overflow: auto;
    padding: 8px 10px;
  }
  .chat-import-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 5px 0;
    color: var(--bone);
  }
  .chat-import-row input { margin-top: 3px; accent-color: var(--moss); }
  .chat-import-empty {
    margin: 0;
    color: var(--ash);
    white-space: pre-wrap;
  }
  pre {
    margin: 0;
    padding: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--bone);
    max-height: 46vh;
    overflow: auto;
  }
  .tank-grid {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    min-height: 210px;
  }
  .town-field {
    position: relative;
    min-height: 210px;
    border-right: 1px solid rgba(139, 163, 74, 0.18);
    background:
      linear-gradient(180deg, rgba(78, 95, 42, 0.14), transparent 56%),
      radial-gradient(circle at 50% 72%, rgba(139, 163, 74, 0.16), transparent 42%);
  }
  .town-title {
    position: absolute;
    left: 16px;
    top: 14px;
    color: rgba(231, 223, 189, 0.42);
    font-size: 12px;
  }
  .node-dot {
    position: absolute;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--bog);
    border: 1px solid var(--moss-hot);
    box-shadow: 0 0 22px rgba(196, 232, 106, 0.12);
  }
  .node-dot:nth-child(2) { left: 35%; top: 34%; }
  .node-dot:nth-child(3) { left: 52%; top: 52%; }
  .node-dot:nth-child(4) { left: 66%; top: 38%; }
  .node-dot.running { background: var(--moss-hot); }
  .node-dot.done { background: #58752e; }
  .node-dot.failed { background: var(--bad); }
  .tank-log { max-height: 210px; }
  .footer-links {
    margin-top: 12px;
    text-align: center;
    color: var(--ash);
    font-size: 12px;
  }
  .footer-links a { color: var(--moss-hot); }
  @media (max-width: 720px) {
    .import-controls { grid-template-columns: 1fr; }
    .tank-grid { grid-template-columns: 1fr; }
    .town-field { border-right: 0; border-bottom: 1px solid rgba(139, 163, 74, 0.18); }
  }
</style>
</head>
<body>
<main class="goblin-mode-shell">
  <section class="goblin-mode-core">
    <h1>single goblin fallback</h1>
    <form class="composer" id="goblin-form">
      <div class="modebar">
        <div class="segment" role="group" aria-label="Run mode">
          <button id="mode-single" type="button" aria-pressed="true">Single Goblin</button>
          <button id="mode-town" type="button" aria-pressed="false">Goblintown</button>
        </div>
        <label class="tank-toggle" title="Open the full Tank for Goblintown runs">
          <input id="old-tank-enabled" type="checkbox" disabled>
          Tank
        </label>
      </div>
      <div class="composer-field">
        <textarea id="goblin-input" autocomplete="off" spellcheck="true" placeholder="Do anything"></textarea>
        <button class="send" id="goblin-send" type="submit" title="Send (Cmd/Ctrl+Enter)" aria-label="Send prompt">run</button>
      </div>
      <div class="status-row">
        <span>${esc(stats.warrenName)}</span>
        <span>loot <b>${stats.lootCount}</b></span>
        <span>rites <b>${stats.riteCount}</b></span>
        <span>artifacts <b>${stats.artifactCount}</b></span>
        <span>runs <b>${stats.runCount}</b></span>
        <span>drift <b>${stats.drift.toFixed(4)}</b></span>
      </div>
    </form>

    <section class="old-tank-box" id="old-tank-box" hidden>
      <div class="panel-title"><span>tank</span><span id="tank-state">idle</span></div>
      <div class="tank-grid">
        <div class="town-field" aria-hidden="true">
          <div class="town-title">goblintown</div>
          <span class="node-dot" id="dot-planner"></span>
          <span class="node-dot" id="dot-worker"></span>
          <span class="node-dot" id="dot-scribe"></span>
        </div>
        <pre class="tank-log" id="tank-log">(waiting)</pre>
      </div>
    </section>

    <section class="output" id="output-panel" hidden>
      <div class="panel-title"><span id="output-title">output</span><span id="output-meta"></span></div>
      <pre id="output-text"></pre>
    </section>

    <section class="output chat-import-panel" id="chat-import-panel">
      <div class="panel-title"><span>chat hoard import</span><span id="chat-import-count">0 selected</span></div>
      <div class="import-controls">
        <select id="chat-source" aria-label="Chat source">
          <option value="codex">Codex</option>
          <option value="chatgpt">ChatGPT export</option>
          <option value="folder">Folder</option>
        </select>
        <input id="chat-path" type="text" placeholder="optional path or export zip">
        <input id="chat-query" type="text" placeholder="filter shiny words">
        <button id="chat-scan" type="button">Scan</button>
        <button id="chat-import-selected" type="button">Import Selected</button>
        <button id="chat-import-all" type="button">Import All</button>
        <label><input id="chat-summarize" type="checkbox"> AI summarize during import</label>
      </div>
      <div class="chat-import-results" id="chat-import-results">
        <p class="chat-import-empty">Scan previous chats, then import selected or import the whole pile.</p>
      </div>
    </section>

    <p class="footer-links">
      slash commands: /ask, /run, /town, /tank, /plan, /context ingest, /context search, /context scan chats, /context import chats, /history, /help ·
      <a href="/tank">legacy Tank</a> · <a href="/runs">runs</a>
    </p>
  </section>
</main>
<script>
const INITIAL = ${initial};
const $ = (id) => document.getElementById(id);
let selectedMode = "single";
let activeStream = null;
let lastChatScan = [];

function setMode(mode) {
  selectedMode = mode === "town" ? "town" : "single";
  $("mode-single").setAttribute("aria-pressed", selectedMode === "single" ? "true" : "false");
  $("mode-town").setAttribute("aria-pressed", selectedMode === "town" ? "true" : "false");
  $("old-tank-enabled").disabled = selectedMode !== "town";
  if (selectedMode !== "town") $("old-tank-enabled").checked = false;
}

function showOutput(title, text, meta) {
  $("output-panel").hidden = false;
  $("output-title").textContent = title;
  $("output-meta").textContent = meta || "";
  $("output-text").textContent = text || "";
}

function appendTank(text) {
  const log = $("tank-log");
  log.textContent = log.textContent === "(waiting)" ? text : log.textContent + "\\n" + text;
  log.scrollTop = log.scrollHeight;
}

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return { kind: "run", mode: selectedMode, tank: selectedMode === "town" && $("old-tank-enabled").checked, task: trimmed, args: trimmed ? [trimmed] : [] };
  }
  const parts = trimmed.match(/"[^"]*"|'[^']*'|\\S+/g) || [];
  const command = (parts.shift() || "/run").slice(1).toLowerCase();
  const tank = parts.includes("--tank") || command === "tank";
  const args = parts.filter((p) => p !== "--tank").map((p) => p.replace(/^["']|["']$/g, ""));
  const task = args.join(" ").trim();
  if (command === "ask" || command === "single" || command === "goblin") return { kind: "ask", mode: "single", tank: false, task, args };
  if (command === "town" || command === "goblintown" || command === "tank" || command === "plan") return { kind: command, mode: "town", tank, task, args };
  return { kind: command, mode: selectedMode, tank: selectedMode === "town" && ($("old-tank-enabled").checked || tank), task, args };
}

async function showHistory() {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(await res.text());
  const runs = await res.json();
  const lines = runs.slice(0, 10).map((r) => r.runId + " · " + (r.mode || "rite") + " · " + (r.status || (r.done ? "done" : "running")) + " · " + r.task);
  showOutput("history", lines.length ? lines.join("\\n") : "(no runs yet)", "");
}

function showHelp() {
  showOutput("help", [
    "/ask <task>        Single Goblin",
    "/run <task>        current selected mode",
    "/town <task>       Goblintown planner DAG",
    "/tank <task>       Goblintown with live Tank box",
    "/context ingest <path>    import old conversations/projects",
    "/context search <query>   search imported context",
    "/context scan chats       scan Codex or ChatGPT chat hoard",
    "/context import chats --all    import scanned chats as DAG memory",
    "/context vectorize --missing-only    precompute missing embeddings",
    "/history           recent runs",
    "/help              this list",
  ].join("\\n"), "");
}

function commandPositionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function commandLimit(args, fallback) {
  const idx = args.indexOf("--limit");
  if (idx < 0 || !args[idx + 1]) return fallback;
  const n = Number(args[idx + 1]);
  return Number.isFinite(n) ? Math.max(1, Math.min(500, Math.floor(n))) : fallback;
}

function commandFlag(args, name) {
  const idx = args.indexOf("--" + name);
  return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--") ? args[idx + 1] : "";
}

function commandHasFlag(args, name) {
  return args.includes("--" + name);
}

function contextChatPayloadFromArgs(args) {
  return {
    source: commandFlag(args, "source") || "codex",
    path: commandFlag(args, "path") || undefined,
    query: commandFlag(args, "query") || undefined,
    since: commandFlag(args, "since") || undefined,
    limit: commandLimit(args, 50),
  };
}

function chatImportPayload() {
  const path = $("chat-path").value.trim();
  const query = $("chat-query").value.trim();
  return {
    source: $("chat-source").value,
    path: path || undefined,
    query: query || undefined,
    limit: 50,
  };
}

function selectedChatIds() {
  return Array.from(document.querySelectorAll(".chat-import-choice:checked")).map((input) => input.value);
}

function updateChatSelectedCount() {
  $("chat-import-count").textContent = selectedChatIds().length + " selected";
}

function setChatImportText(text) {
  const box = $("chat-import-results");
  box.innerHTML = "";
  const p = document.createElement("p");
  p.className = "chat-import-empty";
  p.textContent = text;
  box.appendChild(p);
  updateChatSelectedCount();
}

function renderChatScan(records, skipped) {
  lastChatScan = records || [];
  const box = $("chat-import-results");
  box.innerHTML = "";
  if (!lastChatScan.length) {
    setChatImportText(skipped && skipped.length ? "No visible chats found. Skipped " + skipped.length + " path(s)." : "No visible chats found.");
    return;
  }
  for (const record of lastChatScan) {
    const row = document.createElement("label");
    row.className = "chat-import-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "chat-import-choice";
    checkbox.value = record.id;
    checkbox.checked = true;
    checkbox.onchange = updateChatSelectedCount;
    const text = document.createElement("span");
    text.textContent = record.source + " · " + (record.updatedAt || record.createdAt || "unknown") + " · " + record.title + " · " + record.messageCount + " messages";
    row.appendChild(checkbox);
    row.appendChild(text);
    box.appendChild(row);
  }
  if (skipped && skipped.length) {
    const note = document.createElement("p");
    note.className = "chat-import-empty";
    note.textContent = "Skipped " + skipped.length + " path(s).";
    box.appendChild(note);
  }
  updateChatSelectedCount();
}

async function scanChats() {
  setChatImportText("sniffing previous chats...");
  const res = await fetch("/api/context/chats/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatImportPayload()),
  });
  if (!res.ok) throw new Error(await res.text());
  const body = await res.json();
  renderChatScan(body.records || [], body.skipped || []);
}

async function importChats(all) {
  const ids = all ? [] : selectedChatIds();
  if (!all && ids.length === 0) {
    setChatImportText("Pick at least one chat, or use Import All.");
    return;
  }
  setChatImportText(all ? "importing the whole pile..." : "importing selected chats...");
  const res = await fetch("/api/context/chats/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...chatImportPayload(),
      all,
      ids,
      summarize: $("chat-summarize").checked,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
  const body = await res.json();
  const lines = [
    "Imported " + (body.records || []).length + " chat(s).",
    "Created " + (body.artifacts || []).length + " artifact(s).",
    "Vectorized " + (body.vectorized || 0) + " artifact(s).",
  ];
  if (body.warning) lines.push(body.warning);
  if (body.skipped && body.skipped.length) lines.push("Skipped " + body.skipped.length + " item(s).");
  setChatImportText(lines.join("\\n"));
}

async function handleContextCommand(command) {
  const positionals = commandPositionals(command.args || []);
  const action = positionals[0];
  if (action === "scan" && positionals[1] === "chats") {
    const res = await fetch("/api/context/chats/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contextChatPayloadFromArgs(command.args || [])),
    });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    const lines = (body.records || []).map((record) => record.id + " · " + record.source + " · " + record.title);
    showOutput("context scan chats", lines.length ? lines.join("\\n") : "No visible chats found.", "");
    renderChatScan(body.records || [], body.skipped || []);
    return;
  }
  if (action === "import" && positionals[1] === "chats") {
    const args = command.args || [];
    const ids = (commandFlag(args, "ids") || "").split(",").map((part) => part.trim()).filter(Boolean);
    const all = commandHasFlag(args, "all");
    if (!all && ids.length === 0) {
      showOutput("context import chats", "usage: /context import chats --all or --ids <id,...>", "");
      return;
    }
    const res = await fetch("/api/context/chats/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...contextChatPayloadFromArgs(args),
        all,
        ids,
        noVectorize: commandHasFlag(args, "no-vectorize"),
        summarize: commandHasFlag(args, "summarize"),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    showOutput(
      "context import chats",
      "Imported " + (body.records || []).length + " chat(s), " +
        (body.artifacts || []).length + " artifact(s), vectorized " +
        (body.vectorized || 0) + ".",
      "",
    );
    return;
  }
  if (action === "vectorize") {
    const args = command.args || [];
    const res = await fetch("/api/context/vectorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        missingOnly: commandHasFlag(args, "missing-only"),
        limit: commandLimit(args, 100),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    showOutput("context vectorize", "Scanned " + body.scanned + ", vectorized " + body.vectorized + ".", "");
    return;
  }
  if (action === "ingest") {
    const path = positionals[1];
    if (!path) {
      showOutput("context", "usage: /context ingest <path> [--limit N]", "");
      return;
    }
    showOutput("context ingest", "importing...", path);
    const res = await fetch("/api/context/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, limit: commandLimit(command.args || [], 80) }),
    });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    const lines = (body.artifacts || []).map((artifact) => artifact.id + " · " + artifact.ref);
    const skipped = body.skipped && body.skipped.length ? "\\nskipped " + body.skipped.length + " file(s)" : "";
    showOutput("context ingest", (lines.length ? lines.join("\\n") : "No files imported.") + skipped, path);
    return;
  }
  if (action === "search") {
    const query = positionals.slice(1).join(" ").trim();
    if (!query) {
      showOutput("context", "usage: /context search <query> [--limit N]", "");
      return;
    }
    const res = await fetch("/api/context/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: commandLimit(command.args || [], 10) }),
    });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    const lines = (body.artifacts || []).map((artifact) => artifact.id + " · " + artifact.ref + "\\n  " + artifact.claim);
    showOutput("context search", lines.length ? lines.join("\\n") : "No matching context artifacts found.", query);
    return;
  }
  showOutput("context", "usage: /context ingest <path> or /context search <query>", "");
}

function resetDots() {
  ["dot-planner", "dot-worker", "dot-scribe"].forEach((id) => {
    $(id).className = "node-dot";
  });
}

function openTownStream(runId, showTank) {
  if (activeStream) activeStream.close();
  if (showTank) {
    $("old-tank-box").hidden = false;
    $("tank-log").textContent = "(waiting)";
    $("tank-state").textContent = "running";
    resetDots();
  }
  const es = new EventSource("/api/rite/" + runId + "/stream");
  activeStream = es;
  es.addEventListener("plan:planning", () => {
    if (!showTank) return;
    $("dot-planner").classList.add("running");
    appendTank("planner thinking");
  });
  es.addEventListener("plan:built", (ev) => {
    if (!showTank) return;
    const data = JSON.parse(ev.data);
    $("dot-planner").className = "node-dot done";
    appendTank("DAG built: " + data.plan.nodes.length + " node(s)");
  });
  es.addEventListener("plan:node:start", (ev) => {
    if (!showTank) return;
    const data = JSON.parse(ev.data);
    $("dot-worker").className = "node-dot running";
    appendTank("node " + data.nodeId + " start");
  });
  es.addEventListener("plan:node:done", (ev) => {
    if (!showTank) return;
    const data = JSON.parse(ev.data);
    $("dot-worker").className = "node-dot done";
    appendTank("node " + data.nodeId + " done");
  });
  es.addEventListener("done", async (ev) => {
    const data = JSON.parse(ev.data);
    if (showTank) {
      $("dot-scribe").className = "node-dot done";
      $("tank-state").textContent = "done";
      appendTank("done: " + data.outcome);
    }
    es.close();
    activeStream = null;
    if (data.finalArtifactId) {
      const art = await fetch("/api/artifact/" + data.finalArtifactId).then((r) => r.ok ? r.json() : null);
      const claims = art && Array.isArray(art.claims) ? art.claims.map((c) => "- " + c.text).join("\\n") : "";
      showOutput("goblintown result", claims || "Run finished. Open /runs for full details.", data.riteId || runId);
    } else {
      showOutput("goblintown result", "Run finished. Open /runs for full details.", data.riteId || runId);
    }
  });
  es.addEventListener("error", () => {
    if (showTank) $("tank-state").textContent = "stream ended";
  });
}

$("mode-single").onclick = () => setMode("single");
$("mode-town").onclick = () => setMode("town");
$("chat-scan").onclick = () => scanChats().catch((err) => setChatImportText(err.message || String(err)));
$("chat-import-selected").onclick = () => importChats(false).catch((err) => setChatImportText(err.message || String(err)));
$("chat-import-all").onclick = () => importChats(true).catch((err) => setChatImportText(err.message || String(err)));

$("goblin-input").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    $("goblin-form").requestSubmit($("goblin-send"));
  }
});

$("goblin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const command = parseLine($("goblin-input").value);
  if (!command.task && !["history", "help"].includes(command.kind)) {
    showOutput("error", "Give the goblin a task.", "");
    return;
  }
  if (command.kind === "help") return showHelp();
  if (command.kind === "history") return showHistory().catch((err) => showOutput("error", err.message || String(err), ""));
  if (command.kind === "context") return handleContextCommand(command).catch((err) => showOutput("error", err.message || String(err), ""));

  setMode(command.mode);
  $("old-tank-enabled").checked = command.mode === "town" && command.tank;
  showOutput(command.mode === "town" ? "goblintown" : "single goblin", "running...", "");

  try {
    if (command.mode === "town") {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: command.task,
          maxNodes: 6,
          maxReplan: 2,
          remember: true,
          outputFormat: "markdown",
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      showOutput("goblintown", "run " + body.runId + " started", body.runId);
      openTownStream(body.runId, command.tank);
      return;
    }
    const res = await fetch("/api/goblin/single", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: command.task, remember: true, outputFormat: "markdown" }),
    });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    showOutput("single goblin", body.output, body.lootId ? "loot " + body.lootId : "");
  } catch (err) {
    showOutput("error", err.message || String(err), "");
  }
});
</script>
</body>
</html>`;
}

function sidebarRiteButtons(runs: Map<string, RunState>): string {
  const recentRuns = [...runs.values()]
    .sort((a, b) => b.record.startedAt - a.record.startedAt)
    .slice(0, 6);
  if (!recentRuns.length) {
    return `
          <button class="sidebar-item active" type="button" data-surface-kind="rite" data-run-id="sample-bounty-72" title="Bounty issue #72"><strong>Bounty issue #72</strong>${sidebarStatusGlyph("running")}</button>
          <button class="sidebar-item" type="button" data-surface-kind="rite" data-run-id="sample-provider-setup-audit" title="Provider setup audit"><strong>Provider setup audit</strong>${sidebarStatusGlyph("ready")}</button>
          <button class="sidebar-item" type="button" data-surface-kind="rite" data-run-id="sample-tank-ui-simplification" title="Tank UI simplification"><strong>Tank UI simplification</strong>${sidebarStatusGlyph("ready")}</button>`;
  }
  return recentRuns
    .map((state, index) => {
      const record = state.record;
      const status = record.status || (record.done ? "done" : "running");
      const active = index === 0 ? " active" : "";
      return `<button class="sidebar-item${active}" type="button" data-surface-kind="rite" data-run-id="${esc(record.runId)}" title="${esc(record.task || record.runId)}"><strong>${esc(record.task || record.runId)}</strong>${sidebarStatusGlyph(status)}</button>`;
    })
    .join("\n          ");
}

function sidebarStatusGlyph(status: string): string {
  switch (status) {
    case "done":
      return `<span class="sidebar-status sidebar-status-done" title="done" aria-label="done">✔︎</span>`;
    case "error":
    case "failed":
    case "all_failed":
      return `<span class="sidebar-status sidebar-status-failed" title="failed" aria-label="failed">∅</span>`;
    case "running":
    case "pending":
    case "ready":
    case "queued":
    case "interrupted":
    default:
      return `<span class="sidebar-status sidebar-status-running" title="${esc(status || "in progress")}" aria-label="${esc(status || "in progress")}">⏲</span>`;
  }
}

function tankHtml(
  warrenName: string,
  lootCount: number,
  riteCount: number,
  drift: number,
  runs: Map<string, RunState>,
  autopilot: boolean,
): string {
  const townIdentity = warrenName;
  const initial = JSON.stringify({
    warren: warrenName,
    townIdentity,
    loot: lootCount,
    rites: riteCount,
    drift,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Goblintown · ${esc(warrenName)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><text y='52' font-size='52'>%F0%9F%91%B9</text></svg>" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1410;
    --bg-deep: #0a0e08;
    --fg: #b9d3a8;
    --fg-bright: #d8efb6;
    --accent: #8fcf52;
    --accent-hot: #c2f37a;
    --muted: #5a7042;
    --muted-deep: #2e3e22;
    --muted-deeper: #1c2614;
    --line: #1f2d18;
    --line-soft: #14201a;
    --pass: #b6f37a;
    --fail: #f3a07a;
    --warn: #f3df7a;
    --bubble-bg: rgba(20, 32, 26, 0.78);
    --bubble-border: #2e4220;
    --sky: #131c14;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body {
    background: var(--bg); color: var(--fg);
    font: 14px/1.45 ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
    background-image:
      radial-gradient(circle at 20% 0%, rgba(143,207,82,0.05), transparent 40%),
      radial-gradient(circle at 80% 30%, rgba(143,207,82,0.03), transparent 50%);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100vh; padding: 0.45rem;
  }
  .warren {
    width: min(1560px, 99.2vw);
    height: min(900px, 97.5vh);
    background: var(--bg-deep);
    border: 2px solid var(--line);
    border-radius: 8px;
    box-shadow: inset 0 0 80px rgba(0,0,0,0.65), 0 0 0 4px var(--bg), 0 0 0 5px var(--line);
    display: grid; grid-template-rows: auto 1fr auto auto; overflow: hidden;
    position: relative;
  }
  .strip {
    border-bottom: 1px solid var(--line); padding: 0.55rem 1rem;
    display: flex; gap: 1.4rem; align-items: center;
    color: var(--muted); font-size: 0.78rem; letter-spacing: 0.06em; text-transform: uppercase;
  }
  .strip .name { color: var(--fg-bright); font-weight: 600; }
  .strip .grow { flex: 1; }
  .strip .clock { color: var(--muted); }
  .strip .tier { color: var(--warn); }
  .settings-popover {
    position: absolute;
    right: 1rem;
    top: 2.55rem;
    z-index: 34;
    width: min(360px, calc(100vw - 2rem));
    max-height: min(560px, calc(100vh - 3.25rem));
    overflow-y: scroll;
    scrollbar-gutter: stable;
    scrollbar-width: auto;
    scrollbar-color: rgba(143,207,82,0.62) rgba(3, 6, 3, 0.68);
    background: rgba(8, 11, 7, 0.98);
    border: 1px solid var(--accent);
    border-radius: 8px;
    box-shadow: 0 14px 44px rgba(0,0,0,0.7);
    padding: 0.65rem;
    display: none;
  }
  .settings-popover.open { display: block; }
  .settings-popover::-webkit-scrollbar { width: 14px; }
  .settings-popover::-webkit-scrollbar-track {
    background: rgba(143,207,82,0.12);
    border-left: 1px solid rgba(143,207,82,0.2);
  }
  .settings-popover::-webkit-scrollbar-thumb {
    background: rgba(143,207,82,0.58);
    border: 3px solid rgba(3, 6, 3, 0.86);
    border-radius: 999px;
  }
  .settings-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
    margin-bottom: 0.45rem;
    color: var(--fg-bright);
    font-size: 0.72rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .settings-title span:last-child {
    color: var(--muted);
    font-size: 0.66rem;
  }
  .settings-actions {
    display: grid;
    gap: 0.35rem;
  }
  .settings-popover .auth-chip,
  .settings-popover .provider-chip,
  .settings-popover .reset-chip,
  .settings-popover .settings-danger-action {
    width: 100%;
    border: 1px solid rgba(143,207,82,0.22);
    border-radius: 4px;
    background: rgba(6,10,6,0.72);
    color: var(--fg);
    padding: 0.48rem 0.55rem;
    font: inherit;
    cursor: pointer;
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr);
    gap: 0.55rem;
    align-items: center;
    text-align: left;
  }
  .settings-popover .auth-chip:hover,
  .settings-popover .provider-chip:hover,
  .settings-popover .reset-chip:hover,
  .settings-popover .reset-chip[aria-expanded="true"],
  .settings-popover .settings-danger-action:hover {
    border-color: var(--accent);
    color: var(--accent-hot);
  }
  .settings-popover .auth-chip span,
  .settings-popover .provider-chip span,
  .settings-popover .reset-chip span,
  .settings-popover .settings-danger-action span {
    color: var(--muted);
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .settings-popover .auth-chip strong,
  .settings-popover .provider-chip strong,
  .settings-popover .reset-chip strong,
  .settings-popover .settings-danger-action strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg-bright);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .settings-popover .provider-chip[data-missing="true"] strong {
    color: var(--fail);
  }
  .settings-reset-panel {
    display: none;
    gap: 0.35rem;
    padding: 0.5rem;
    border: 1px solid rgba(243,160,122,0.2);
    border-radius: 4px;
    background: rgba(32,12,12,0.34);
  }
  .settings-reset-panel.open {
    display: grid;
  }
  .settings-danger-label {
    display: block;
    color: var(--fail);
    font-size: 0.64rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .settings-popover .settings-danger-action {
    border-color: rgba(243,160,122,0.34);
    background: rgba(58,20,20,0.42);
  }
  .settings-popover .settings-danger-action strong {
    color: var(--fail);
  }
  .provider-chip {
    border: 1px solid var(--line);
    background: var(--bg-deep);
    color: var(--fg-bright);
    border-radius: 999px;
    padding: 0.32rem 0.65rem;
    font: inherit;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .provider-chip[data-missing="true"] { border-color: var(--fail); color: var(--fail); }
  .provider-chip:hover { border-color: var(--accent); color: var(--accent-hot); }
  .provider-popover {
    position: absolute;
    right: 1rem;
    top: 2.55rem;
    bottom: 0.75rem;
    width: min(820px, calc(100% - 2rem));
    overflow: hidden;
    scrollbar-gutter: stable;
    z-index: 30;
    background: rgb(10,14,8);
    border: 1px solid var(--accent);
    border-radius: 8px;
    box-shadow: 0 16px 50px rgba(0,0,0,0.75);
    padding: 0.75rem;
    flex-direction: column;
    min-height: 0;
    display: none;
  }
  .provider-popover.open { display: flex; }
  .provider-popover, .provider-popover * { box-sizing: border-box; }
  .provider-popover h3 {
    flex: 0 0 auto;
    margin: 0 0 0.55rem;
    color: var(--fg-bright);
    font-size: 0.88rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .provider-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: scroll;
    padding-right: 0.48rem;
    border-right: 1px solid rgba(143,207,82,0.16);
    scrollbar-gutter: stable;
    scrollbar-width: auto;
    scrollbar-color: rgba(143,207,82,0.62) rgba(3, 6, 3, 0.68);
  }
  .provider-scroll::-webkit-scrollbar { width: 14px; }
  .provider-scroll::-webkit-scrollbar-track {
    background: rgba(143,207,82,0.12);
    border-left: 1px solid rgba(143,207,82,0.2);
  }
  .provider-scroll::-webkit-scrollbar-thumb {
    background: rgba(143,207,82,0.58);
    border: 3px solid rgb(10,14,8);
    border-radius: 999px;
  }
  .provider-popover label {
    display: block;
    color: var(--muted);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin: 0.35rem 0 0.14rem;
  }
  .provider-popover input, .provider-popover select {
    width: 100%;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.34rem 0.48rem;
    font: inherit;
    font-size: 0.74rem;
  }
  .provider-popover input:focus, .provider-popover select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .provider-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.45rem;
    flex: 0 0 auto;
  }
  .provider-help {
    color: var(--muted);
    font-size: 0.66rem;
    line-height: 1.25;
    margin: 0.25rem 0 0.22rem;
  }
  .provider-workflow {
    margin: 0.5rem 0 0.6rem;
    border: 1px solid rgba(143,207,82,0.22);
    border-radius: 6px;
    background: rgba(3, 6, 3, 0.48);
    color: var(--muted);
    font-size: 0.68rem;
    line-height: 1.35;
    padding: 0.5rem 0.58rem;
  }
  .provider-workflow strong {
    display: block;
    color: var(--fg-bright);
    font-size: 0.72rem;
    margin-bottom: 0.16rem;
  }
  .provider-workflow code {
    color: var(--accent-hot);
    font-family: var(--mono);
    font-size: 0.66rem;
  }
  .provider-status {
    flex: 0 0 auto;
    margin: 0.48rem 0 0;
    padding-top: 0.42rem;
    border-top: 1px solid rgba(143,207,82,0.2);
    background: rgb(10,14,8);
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .provider-status strong { color: var(--fg-bright); }
  .provider-advanced { flex: 0 0 auto; min-height: 0; }
  .provider-advanced summary {
    cursor: pointer;
    color: var(--accent);
    margin-top: 0.55rem;
    font-size: 0.74rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .provider-routes-panel[open] {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .provider-route-list {
    flex: 1 1 0;
    display: grid;
    gap: 0.38rem;
    margin-top: 0.35rem;
    padding: 0.36rem 1rem 0.36rem 0.36rem;
    min-height: 7.5rem;
    max-height: clamp(8rem, 26vh, 13rem);
    overflow-x: hidden;
    overflow-y: scroll;
    border: 1px solid rgba(143,207,82,0.22);
    border-radius: 6px;
    background:
      linear-gradient(to left, rgba(143,207,82,0.16) 0 14px, transparent 14px),
      rgba(0,0,0,0.32);
    box-shadow: inset -14px 0 0 rgba(143,207,82,0.08);
    scrollbar-gutter: stable;
    scrollbar-width: auto;
    scrollbar-color: rgba(143,207,82,0.62) rgba(3, 6, 3, 0.68);
  }
  .provider-route-list::-webkit-scrollbar { width: 14px; }
  .provider-route-list::-webkit-scrollbar-track {
    background: rgba(143,207,82,0.1);
    border-left: 1px solid rgba(143,207,82,0.22);
    border-radius: 999px;
  }
  .provider-route-list::-webkit-scrollbar-thumb {
    background: rgba(143,207,82,0.62);
    border: 3px solid rgba(3, 6, 3, 0.92);
    border-radius: 999px;
  }
  .provider-route-row {
    display: grid;
    grid-template-columns: 5.2rem minmax(0, 1fr) minmax(0, 1fr) 5.2rem;
    gap: 0.38rem;
    align-items: end;
    border: 1px solid rgba(143,207,82,0.22);
    border-radius: 6px;
    background: rgba(3, 6, 3, 0.68);
    padding: 0.42rem;
  }
  .provider-route-row > * { min-width: 0; }
  .provider-route-row > div:nth-child(4) { grid-column: 2; }
  .provider-route-row label { margin-top: 0; }
  .provider-route-slot {
    color: var(--accent-hot);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding-bottom: 0.42rem;
  }
  .provider-route-extra {
    grid-column: 3 / -1;
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    gap: 0.38rem;
  }
  .provider-route-clear {
    white-space: nowrap;
    margin-bottom: 0.01rem;
    min-width: 0;
    width: 100%;
    padding: 0.46rem 0.35rem;
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    flex: 0 0 auto;
  }
  .provider-popover input::placeholder { color: rgba(180, 198, 170, 0.5); }
  .provider-actions {
    display: flex;
    flex: 0 0 auto;
    gap: 0.6rem;
    margin-top: 0.65rem;
    background: rgb(10,14,8);
  }
  @media (max-width: 760px) {
    .provider-grid,
    .provider-route-row,
    .provider-route-extra {
      grid-template-columns: 1fr;
    }
    .provider-popover { left: 0.6rem; right: 0.6rem; width: auto; }
    .provider-route-extra { grid-column: auto; }
    .provider-route-row > div:nth-child(4) { grid-column: auto; }
    .provider-route-slot { padding-bottom: 0; }
    body { padding: 0; }
    .warren {
      width: 100vw;
      height: 100vh;
      border-radius: 0;
      border-left: 0;
      border-right: 0;
    }
    .strip {
      gap: 0.55rem;
      padding: 0.48rem 0.55rem;
      overflow-x: auto;
      white-space: nowrap;
    }
    .strip .stat,
    .strip .tier {
      display: none;
    }
    .workarea {
      grid-template-columns: 96px 1fr;
    }
    .ops-sidebar {
      padding: 0.45rem 0.28rem;
    }
    .ops-actions .btn {
      min-height: 2rem;
      font-size: 0.5rem;
      padding: 0.32rem 0.14rem;
    }
    .chat-thread {
      padding: 0.85rem;
    }
    .chat-input-row {
      grid-template-columns: 1fr;
    }
    .chat-input-row button {
      width: 100%;
    }
    .chat-offer-inline.open {
      display: grid;
    }
  }
  .auth-chip {
    border: 1px solid var(--line);
    background: var(--bg-deep);
    color: var(--fg);
    padding: 0.18rem 0.55rem;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .auth-chip:hover { border-color: var(--accent); color: var(--accent-hot); }
  .auth-popover {
    position: absolute;
    right: 1rem;
    top: 2.55rem;
    z-index: 30;
    width: min(420px, calc(100vw - 2rem));
    background: rgba(8, 11, 7, 0.98);
    border: 1px solid var(--accent);
    box-shadow: 0 12px 42px rgba(0,0,0,0.6);
    padding: 0.9rem 1rem;
    display: none;
  }
  .auth-popover.open { display: block; }
  .auth-popover h3 {
    margin: 0 0 0.55rem;
    font-size: 0.76rem;
    color: var(--fg-bright);
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .auth-status {
    color: var(--muted);
    font-size: 0.74rem;
    margin: 0 0 0.7rem;
    line-height: 1.45;
  }
  .cloud-mode-panel {
    border: 1px solid rgba(143,207,82,0.2);
    background: rgba(6,10,6,0.56);
    border-radius: 4px;
    padding: 0.65rem;
    margin-bottom: 0.75rem;
  }
  .cloud-mode-panel h4 {
    margin: 0 0 0.35rem;
    color: var(--fg-bright);
    font-size: 0.68rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }
  .cloud-mode-panel p {
    margin: 0 0 0.55rem;
    color: var(--muted);
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .cloud-mode-panel .provider-actions {
    margin-top: 0;
  }
  .workarea {
    display: grid;
    grid-template-columns: 300px 1fr;
    min-height: 0;
    border-bottom: 1px solid var(--line);
    background: #0d0f0c;
  }
  .workarea.sidebar-collapsed { grid-template-columns: 52px 1fr; }
  .ops-sidebar {
    border-right: 1px solid var(--line);
    background:
      linear-gradient(180deg, rgba(124,255,91,0.045), transparent 34%),
      #151a14;
    padding: 1rem 0.9rem;
    display: flex;
    flex-direction: column;
    min-height: 0;
    gap: 1rem;
    overflow: auto;
  }
  .ops-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .ops-sidebar h3 {
    margin: 0;
    font-size: 1.2rem;
    color: #e6e2d3;
    letter-spacing: 0;
    text-transform: none;
  }
  .ops-toggle {
    padding: 0.2rem 0.42rem;
    border: 1px solid var(--line);
    background: var(--bg-deep);
    color: var(--muted);
    cursor: pointer;
    font-family: inherit;
    font-size: 0.7rem;
  }
  .ops-toggle:hover { border-color: var(--accent); color: var(--accent-hot); }
  .ops-main {
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    flex: 1 1 auto;
  }
  .ops-quick {
    display: flex;
    flex-direction: column;
    gap: 0.78rem;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-right: 0.15rem;
  }
  .ops-actions {
    display: grid;
    gap: 0.34rem;
    flex: 0 0 auto;
  }
  .ops-actions .btn {
    width: 100%;
    min-height: 1.45rem;
    padding: 0.12rem 0.16rem;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: #e6e2d3;
    font-size: 0.86rem;
    letter-spacing: 0;
    text-align: left;
    text-transform: none;
    transform: none;
  }
  .ops-actions .btn:hover,
  .ops-actions .btn.primary:hover {
    background: transparent;
    color: #7cff5b;
    transform: none;
  }
  .ops-actions .btn.primary {
    background: transparent;
    border: 0;
    color: #e6e2d3;
    font-weight: 600;
  }
  .sidebar-list {
    display: grid;
    gap: 0.34rem;
  }
  .sidebar-list.collapsed .sidebar-items {
    display: none;
  }
  .sidebar-label {
    margin: 0.45rem 0 0.15rem;
    color: #a8b09a;
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .sidebar-section-toggle {
    width: 100%;
    border: 0;
    background: transparent;
    color: #a8b09a;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0;
    font: inherit;
    font-size: 0.72rem;
    letter-spacing: 0.12em;
    text-align: left;
    text-transform: uppercase;
  }
  .sidebar-section-toggle::after {
    content: "⌄";
    color: #7cff5b;
    font-size: 0.72rem;
  }
  .sidebar-list.collapsed .sidebar-section-toggle::after {
    content: "›";
  }
  .sidebar-item {
    width: 100%;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: #e6e2d3;
    padding: 0.36rem 0.16rem;
    font: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.45rem;
  }
  .sidebar-item:hover {
    background: transparent;
    border-color: transparent;
    color: #7cff5b;
  }
  .sidebar-item.active {
    background: transparent;
    border-color: transparent;
    color: #e6e2d3;
  }
  .sidebar-item strong,
  .sidebar-item span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sidebar-item strong {
    min-width: 0;
  }
  .sidebar-status {
    justify-self: end;
    font-size: 0.78rem;
    font-weight: 750;
    line-height: 1;
  }
  .sidebar-status-done {
    color: #6dffb3;
  }
  .sidebar-status-failed {
    color: #ff5d73;
  }
  .sidebar-status-running {
    color: #ffb347;
  }
  .sidebar-settings {
    position: relative;
    margin-top: auto;
    flex: 0 0 auto;
    display: grid;
    gap: 0.6rem;
  }
  .sidebar-settings-card {
    display: none;
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 0.75rem);
    z-index: 18;
    border: 1px solid rgba(124,255,91,0.18);
    border-radius: 14px;
    background: #1d241b;
    box-shadow: 0 16px 48px rgba(0,0,0,0.36);
    padding: 0.75rem;
  }
  .sidebar-settings.open .sidebar-settings-card {
    display: grid;
    gap: 0.62rem;
  }
  .settings-card-head {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: #e6e2d3;
    font-weight: 750;
  }
  .settings-icon {
    width: 1.9rem;
    aspect-ratio: 210 / 246;
    height: auto;
    object-fit: contain;
    filter: brightness(0) saturate(100%) invert(91%) sepia(12%) saturate(401%) hue-rotate(26deg) brightness(101%) contrast(92%) drop-shadow(0 0 7px rgba(124,255,91,0.18));
    transition: filter 0.16s ease, opacity 0.16s ease;
  }
  .settings-joke {
    display: block;
    color: #a8b09a;
    font-size: 0.72rem;
  }
  .settings-link {
    border: 0;
    background: transparent;
    color: #e6e2d3;
    font: inherit;
    font-weight: 650;
    padding: 0.28rem 0;
    text-align: left;
    cursor: pointer;
  }
  .settings-link:hover,
  .settings-trigger:hover {
    color: #7cff5b;
  }
  .settings-trigger:hover .settings-icon,
  .settings-card-head .settings-icon {
    filter: brightness(0) saturate(100%) invert(86%) sepia(62%) saturate(724%) hue-rotate(43deg) brightness(108%) contrast(105%) drop-shadow(0 0 9px rgba(124,255,91,0.34));
  }
  .settings-trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    border: 0;
    background: transparent;
    color: #e6e2d3;
    font: inherit;
    font-weight: 650;
    padding: 0.2rem 0;
    text-align: left;
    cursor: pointer;
  }
  .sidebar-settings.open #settings-icon-closed { display: none; }
  .sidebar-settings:not(.open) #settings-icon-open { display: none; }
  .settings-sidebar-panel[hidden] {
    display: none;
  }
  .settings-sidebar-panel {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    align-content: start;
    gap: 0.72rem;
  }
  .settings-sidebar-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .settings-sidebar-head strong {
    color: #e6e2d3;
    font-size: 1rem;
  }
  .settings-back {
    border: 0;
    background: transparent;
    color: #a8b09a;
    cursor: pointer;
    font: inherit;
    padding: 0;
  }
  .settings-back:hover {
    color: #7cff5b;
  }
  .settings-sidebar-menu {
    display: grid;
    gap: 0.35rem;
  }
  .settings-sidebar-menu button {
    width: 100%;
    border: 0;
    background: transparent;
    color: #e6e2d3;
    cursor: pointer;
    font: inherit;
    padding: 0.34rem 0;
    text-align: left;
  }
  .settings-sidebar-menu button:hover,
  .settings-sidebar-menu button.active {
    color: #7cff5b;
  }
  .chat-main.settings-active .chat-composer {
    display: none;
  }
  .ops-sidebar.settings-mode .ops-main,
  .ops-sidebar.settings-mode .ops-head .ops-toggle {
    display: none;
  }
  .sr-only {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    padding: 0 !important;
    margin: -1px !important;
    overflow: hidden !important;
    clip: rect(0, 0, 0, 0) !important;
    white-space: nowrap !important;
    border: 0 !important;
  }
  .workarea.sidebar-collapsed .ops-main { display: none; }
  .workarea.sidebar-collapsed .ops-sidebar { padding: 0.7rem 0.35rem; }
  .workarea.sidebar-collapsed .ops-head {
    flex-direction: column;
    align-items: stretch;
  }
  .workarea.sidebar-collapsed .ops-sidebar h3 {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    text-align: center;
    margin: 0 auto;
    font-size: 0.62rem;
  }
  .workarea.sidebar-collapsed .ops-toggle { width: 100%; }

  .tank {
    position: relative; overflow: hidden;
    background: linear-gradient(180deg, var(--sky) 0%, #0c1310 65%, #0a0e08 100%);
  }
  .codex-chat-surface {
    background: #0d0f0c;
  }
  .tank.chat-mode {
    background:
      radial-gradient(circle at 12% 0%, rgba(124,255,91,0.08), transparent 30rem),
      #0d0f0c;
    overflow: hidden;
  }
  .tank:not(.chat-mode) .chat-main { display: none; }
  .tank.chat-mode .tank-logo-mark,
  .tank.chat-mode .star,
  .tank.chat-mode .mountains,
  .tank.chat-mode .skyline,
  .tank.chat-mode .smoke,
  .tank.chat-mode .banner,
  .tank.chat-mode .trees,
  .tank.chat-mode .lantern,
  .tank.chat-mode .ground,
  .tank.chat-mode .ground-shadow,
  .tank.chat-mode .pigeon-wire,
  .tank.chat-mode .gremlin-perch,
  .tank.chat-mode .ogre-cave,
  .tank.chat-mode .ogre-cave-label,
  .tank.chat-mode .workshop,
  .tank.chat-mode .troll-bridge,
  .tank.chat-mode .raccoon-dump,
  .tank.chat-mode .hoard,
  .tank.chat-mode .creature,
  .tank.chat-mode .pos-goblins,
  .tank.chat-mode .goblin-pile,
  .tank.chat-mode .bubble-layer,
  .tank.chat-mode .dag-panel,
  .tank.chat-mode .result-panel {
    display: none !important;
  }
  .chat-main {
    position: absolute;
    inset: 0;
    z-index: 12;
    display: flex;
    flex-direction: column;
    background: transparent;
  }
  .chat-thread {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: clamp(1rem, 3vw, 2.2rem);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .chat-thread.surface-hidden,
  .rite-surface[hidden] {
    display: none;
  }
  .settings-surface[hidden] {
    display: none;
  }
  .rite-surface {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: clamp(1rem, 3vw, 2.2rem);
  }
  .settings-surface {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: clamp(1rem, 3vw, 2.2rem);
  }
  .settings-surface-inner {
    width: min(980px, 100%);
  }
  .settings-surface-panel {
    min-height: 22rem;
    border: 1px solid rgba(124,255,91,0.16);
    border-radius: 8px;
    background: rgba(13,15,12,0.5);
    padding: 1rem;
  }
  .settings-surface-panel h2 {
    margin: 0 0 0.45rem;
    color: #e6e2d3;
    font-size: 1.1rem;
  }
  .settings-surface-panel p {
    margin: 0;
    color: #a8b09a;
  }
  .settings-surface-actions,
  .settings-surface-form {
    display: grid;
    gap: 0.55rem;
    margin-top: 0.85rem;
  }
  .settings-surface-actions {
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }
  .settings-surface-panel button,
  .settings-surface-panel input,
  .settings-surface-panel select {
    width: 100%;
    border: 1px solid rgba(124,255,91,0.22);
    border-radius: 4px;
    background: rgba(6,10,6,0.72);
    color: #e6e2d3;
    font: inherit;
    padding: 0.48rem 0.55rem;
  }
  .settings-surface-panel button {
    cursor: pointer;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .settings-surface-panel button:hover {
    border-color: #7cff5b;
    color: #7cff5b;
  }
  .settings-surface-panel .settings-embedded {
    position: static;
    inset: auto;
    width: 100%;
    max-height: none;
    box-shadow: none;
    margin: 0;
  }
  .settings-surface-panel .auth-popover.settings-embedded,
  .settings-surface-panel .settings-reset-panel.settings-embedded {
    display: block;
  }
  .settings-surface-panel .provider-popover.settings-embedded {
    display: flex;
  }
  .settings-surface-panel .settings-danger-action {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.45rem;
    align-items: center;
    text-align: left;
  }
  .settings-surface-panel .settings-danger-action span {
    color: #ffb347;
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .settings-surface-panel .settings-danger-action strong {
    color: #ff5d73;
  }
  .settings-import-results {
    display: grid;
    gap: 0.35rem;
    margin-top: 0.75rem;
    color: #a8b09a;
    font-size: 0.76rem;
  }
  .settings-import-results code {
    color: #7cff5b;
    font-size: 0.7rem;
  }
  .sidecar-surface {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: clamp(1rem, 3vw, 2.2rem);
    display: grid;
    align-content: start;
    gap: 1rem;
  }
  .sidecar-surface[hidden] {
    display: none;
  }
  .sidecar-shell {
    width: min(980px, 100%);
    display: grid;
    gap: 1rem;
  }
  .sidecar-head {
    border-bottom: 1px solid rgba(124,255,91,0.18);
    padding-bottom: 0.9rem;
  }
  .sidecar-kicker {
    display: block;
    color: #7cff5b;
    font-size: 0.66rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .sidecar-head h2 {
    margin: 0.2rem 0 0.25rem;
    color: #e6e2d3;
    font-size: clamp(1.45rem, 2.6vw, 2.35rem);
    letter-spacing: 0;
  }
  .sidecar-head p {
    margin: 0;
    color: #a8b09a;
    max-width: 68ch;
    line-height: 1.5;
  }
  .sidecar-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 0.8rem;
  }
  .sidecar-card {
    border: 1px solid rgba(124,255,91,0.16);
    border-radius: 8px;
    background: rgba(13,15,12,0.58);
    padding: 0.85rem;
  }
  .sidecar-card span {
    display: block;
    color: #7cff5b;
    font-size: 0.64rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .sidecar-card strong {
    display: block;
    margin-top: 0.2rem;
    color: #e6e2d3;
    font-size: 1rem;
  }
  .sidecar-card p {
    margin: 0.45rem 0 0;
    color: #a8b09a;
    font-size: 0.76rem;
    line-height: 1.45;
  }
  .sidecar-actions {
    display: flex;
    gap: 0.55rem;
    flex-wrap: wrap;
  }
  .sidecar-actions button {
    border: 1px solid rgba(124,255,91,0.3);
    border-radius: 8px;
    background: rgba(124,255,91,0.08);
    color: #e6e2d3;
    font: inherit;
    font-weight: 650;
    padding: 0.48rem 0.68rem;
    cursor: pointer;
  }
  .sidecar-actions button:hover {
    border-color: #7cff5b;
    color: #7cff5b;
  }
  .sidecar-hidden {
    display: none !important;
  }
  .rite-inline-inner {
    width: min(980px, 100%);
    margin: 0 auto;
    display: grid;
    gap: 1rem;
  }
  .rite-inline-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid rgba(124,255,91,0.18);
    padding-bottom: 0.85rem;
  }
  .rite-inline-kicker {
    display: block;
    color: #7cff5b;
    font-size: 0.66rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .rite-inline-head h2 {
    margin: 0.18rem 0 0;
    color: #e6e2d3;
    font-size: clamp(1.25rem, 2vw, 1.85rem);
    letter-spacing: 0;
  }
  .rite-inline-meta {
    margin-top: 0.2rem;
    color: #a8b09a;
  }
  .rite-inline-actions {
    display: flex;
    gap: 0.55rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .rite-inline-actions a,
  .rite-inline-actions button {
    border: 1px solid rgba(124,255,91,0.3);
    border-radius: 8px;
    background: rgba(124,255,91,0.08);
    color: #e6e2d3;
    font: inherit;
    font-weight: 650;
    text-decoration: none;
    padding: 0.48rem 0.68rem;
    cursor: pointer;
  }
  .rite-inline-actions a:hover,
  .rite-inline-actions button:hover {
    border-color: rgba(124,255,91,0.58);
    color: #7cff5b;
  }
  .rite-stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.65rem;
  }
  .rite-stat {
    border: 1px solid rgba(124,255,91,0.16);
    border-radius: 8px;
    background: rgba(29,36,27,0.72);
    padding: 0.75rem;
  }
  .rite-stat span {
    display: block;
    color: #7cff5b;
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .rite-stat strong {
    display: block;
    margin-top: 0.22rem;
    color: #e6e2d3;
    font-size: 0.95rem;
    font-weight: 650;
    word-break: break-word;
  }
  .inline-run-display,
  .rite-event {
    border: 1px solid rgba(124,255,91,0.16);
    border-radius: 8px;
    background: rgba(21,26,20,0.72);
  }
  .inline-run-display {
    display: grid;
    gap: 0.45rem;
    padding: 0.9rem;
  }
  .inline-run-display strong,
  .rite-discussion h3 {
    color: #e6e2d3;
  }
  .inline-run-display p {
    margin: 0;
    color: #a8b09a;
  }
  .rite-discussion {
    display: grid;
    gap: 0.72rem;
  }
  .rite-discussion h3 {
    margin: 0.2rem 0 0;
    font-size: 1.25rem;
  }
  .rite-event {
    border-left: 3px solid rgba(124,255,91,0.5);
    padding: 0.75rem 0.9rem;
  }
  .rite-event-title {
    display: block;
    color: #e6e2d3;
    font-weight: 750;
    margin-bottom: 0.22rem;
  }
  .rite-event-body {
    color: #a8b09a;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .rite-empty {
    color: #a8b09a;
    border-left-color: rgba(168,176,154,0.45);
  }
  .chat-message {
    width: min(840px, 100%);
    white-space: pre-wrap;
    word-break: break-word;
    border: 0;
    border-left: 3px solid rgba(124,255,91,0.35);
    border-radius: 0;
    padding: 0.35rem 0 0.35rem 0.95rem;
    background: transparent;
    color: #e6e2d3;
  }
  .chat-message.user {
    align-self: flex-end;
    border-left-color: rgba(198,140,255,0.5);
    background: transparent;
  }
  .chat-message.assistant,
  .chat-message.system {
    align-self: flex-start;
  }
  .chat-role {
    display: block;
    margin-bottom: 0.32rem;
    color: var(--muted);
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .chat-composer {
    flex: 0 0 auto;
    border-top: 1px solid var(--line);
    padding: 0.9rem clamp(0.8rem, 2vw, 1.4rem) 1.2rem;
    background: rgba(13,15,12,0.94);
  }
  .chat-composer-inner {
    width: min(920px, 100%);
    margin: 0 auto;
    display: grid;
    gap: 0.5rem;
    border: 1px solid rgba(168,176,154,0.18);
    border-radius: 18px;
    background: rgba(21,26,20,0.72);
    padding: 0.85rem 0.95rem;
  }
  .chat-offer-inline {
    display: none;
    border: 1px solid rgba(143,207,82,0.28);
    border-radius: 8px;
    background: rgba(16,26,18,0.92);
    padding: 0.62rem 0.7rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.7rem;
    color: var(--fg);
  }
  .chat-offer-inline.open { display: flex; }
  .chat-input-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 0.5rem;
    align-items: center;
  }
  .chat-input-row textarea {
    min-height: 3.2rem;
    max-height: 12rem;
    resize: vertical;
    width: 100%;
    background: transparent;
    color: #e6e2d3;
    border: 0;
    border-bottom: 1px solid rgba(168,176,154,0.22);
    border-radius: 0;
    padding: 0.55rem 0;
    font: inherit;
  }
  .chat-input-row textarea:focus {
    outline: none;
    border-color: #7cff5b;
  }
  .chat-input-row button:not(.sr-only),
  .chat-offer-inline button {
    min-height: 2.6rem;
    border: 1px solid rgba(124,255,91,0.42);
    background: rgba(124,255,91,0.12);
    color: #e6e2d3;
    border-radius: 999px;
    padding: 0.52rem 0.85rem;
    font: inherit;
    cursor: pointer;
  }
  .chat-input-row button[aria-pressed="true"] {
    border-color: var(--accent-hot);
    background: #4d5b1f;
    color: #fff7c2;
  }
  .rite-choice-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
    margin-top: 0.55rem;
    white-space: normal;
  }
  .rite-choice {
    border: 1px solid rgba(124,255,91,0.28);
    border-radius: 999px;
    background: rgba(124,255,91,0.08);
    color: #e6e2d3;
    font: inherit;
    padding: 0.38rem 0.68rem;
    cursor: pointer;
  }
  .rite-choice:hover {
    border-color: rgba(124,255,91,0.58);
    background: rgba(124,255,91,0.16);
    color: #7cff5b;
  }
  .chat-input-row button:disabled,
  .chat-offer-inline button:disabled {
    opacity: 0.55;
    cursor: wait;
  }
  .personality-picker {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .send-button {
    width: 2.8rem;
    height: 2.8rem;
    padding: 0 !important;
    background: #39ff14 !important;
    color: #0d0f0c !important;
    border-color: #39ff14 !important;
    font-size: 1.35rem !important;
    font-weight: 850 !important;
  }
  .personality-menu {
    display: none;
    position: absolute;
    right: 0;
    bottom: calc(100% + 0.55rem);
    min-width: 15rem;
    z-index: 24;
    border: 1px solid rgba(124,255,91,0.26);
    border-radius: 14px;
    background: rgba(21,26,20,0.98);
    box-shadow: 0 18px 55px rgba(0,0,0,0.5);
    padding: 0.42rem;
    left: 0;
    right: auto;
    min-width: 11rem;
  }
  .personality-picker:hover .personality-menu,
  .personality-picker:focus-within .personality-menu,
  .personality-picker.open .personality-menu {
    display: grid;
    gap: 0.08rem;
  }
  .personality-choice {
    display: grid;
    grid-template-columns: 2rem 1fr;
    align-items: center;
    gap: 0.65rem;
    border: 0;
    background: transparent;
    color: #e6e2d3;
    border-radius: 0;
    padding: 0.42rem 0.5rem;
    font: inherit;
    font-weight: 650;
    text-align: left;
  }
  .personality-choice {
    grid-template-columns: 1fr;
  }
  .personality-choice:hover,
  .personality-choice.active {
    color: #7cff5b;
    text-shadow: 0 0 12px rgba(124,255,91,0.22);
  }
  .personality-label {
    border: 0;
    background: transparent;
    color: #a8b09a;
    font: inherit;
    padding: 0;
    cursor: pointer;
  }
  .personality-label::after {
    content: " ^";
    color: transparent;
  }
  .personality-picker:hover .personality-label::after,
  .personality-picker:focus-within .personality-label::after {
    color: #7cff5b;
  }
  .chat-meta-row {
    display: flex;
    gap: 0.65rem;
    align-items: center;
    flex-wrap: wrap;
    color: var(--muted);
    font-size: 0.68rem;
  }
  .chat-meta-row select,
  .chat-meta-row input {
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--line);
    border-radius: 5px;
    padding: 0.28rem 0.38rem;
    font: inherit;
    font-size: 0.68rem;
  }
  .tank-logo-mark {
    position: absolute; top: 50%; left: 50%; z-index: 0;
    width: min(68%, 680px); max-height: 18%; object-fit: contain;
    opacity: 0.075; pointer-events: none; user-select: none;
    transform: translate(-50%, -50%);
    filter: saturate(0.8) brightness(0.75);
    mix-blend-mode: screen;
    animation: logo-float 18s ease-in-out infinite;
  }
  @keyframes logo-float {
    0%, 100% { transform: translate(-50%, -52%); opacity: 0.06; }
    50% { transform: translate(-50%, -48%); opacity: 0.09; }
  }

  .t1, .t2, .t3, .t4 { display: none; }
  .warren[data-visual-tier="1"] .t1 { display: block; }
  .warren[data-visual-tier="2"] .t1, .warren[data-visual-tier="2"] .t2 { display: block; }
  .warren[data-visual-tier="3"] .t1, .warren[data-visual-tier="3"] .t2, .warren[data-visual-tier="3"] .t3 { display: block; }
  .warren[data-visual-tier="4"] .t1, .warren[data-visual-tier="4"] .t2,
  .warren[data-visual-tier="4"] .t3, .warren[data-visual-tier="4"] .t4 { display: block; }
  .warren[data-visual-tier="2"] .t2-flex { display: flex; }
  .warren[data-visual-tier="3"] .t2-flex,
  .warren[data-visual-tier="3"] .t3-flex { display: flex; }
  .warren[data-visual-tier="4"] .t2-flex,
  .warren[data-visual-tier="4"] .t3-flex,
  .warren[data-visual-tier="4"] .t4-flex { display: flex; }
  .t2-flex, .t3-flex, .t4-flex { display: none; }

  .star { position: absolute; color: var(--muted-deep); font-size: 0.7rem; opacity: 0.6; animation: twinkle 4s ease-in-out infinite; }
  @keyframes twinkle { 0%,100% { opacity: 0.6; } 50% { opacity: 0.2; } }

  .mountains {
    position: absolute; top: 4%; left: 0; right: 0; text-align: center;
    font-size: 3.2rem; line-height: 1; filter: brightness(0.5) saturate(0.4); letter-spacing: -0.4em;
  }
  .skyline { position: absolute; left: 0; right: 0; text-align: center; line-height: 1; letter-spacing: 0.2em; }
  .skyline.back { top: 13%; font-size: 1.7rem; filter: brightness(0.55) saturate(0.6); }
  .skyline.mid  { top: 22%; font-size: 2.5rem; filter: brightness(0.85) saturate(0.85); }

  .banner {
    position: absolute; top: 5%; left: 50%; transform: translateX(-50%);
    color: var(--warn); font-size: 0.82rem; line-height: 1.05;
    text-align: center; white-space: pre; letter-spacing: 0.05em;
    text-shadow: 0 0 6px rgba(243,223,122,0.3);
  }

  .trees { position: absolute; bottom: 18%; font-size: 2.2rem; line-height: 1; filter: brightness(0.85); }
  .trees.left { left: 2%; }
  .trees.right { right: 2%; }

  .lantern {
    position: absolute; font-size: 1.4rem; opacity: 0;
    filter: drop-shadow(0 0 8px rgba(243,223,122,0.6));
    animation: flicker 2.4s ease-in-out infinite; transition: opacity .5s;
  }
  .warren[data-visual-tier="3"] .lantern,
  .warren[data-visual-tier="4"] .lantern { opacity: 1; }
  @keyframes flicker { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }

  .smoke {
    position: absolute; color: var(--muted); font-size: 0.85rem;
    opacity: 0; line-height: 1; animation: smoke 4s ease-out infinite; pointer-events: none;
  }
  .warren[data-visual-tier="2"] .smoke,
  .warren[data-visual-tier="3"] .smoke,
  .warren[data-visual-tier="4"] .smoke { opacity: 1; }
  @keyframes smoke {
    0%   { opacity: 0; transform: translateY(0) scale(0.9); }
    25%  { opacity: 0.6; }
    100% { opacity: 0; transform: translateY(-40px) scale(1.5); }
  }

  .ground {
    position: absolute; left: 0; right: 0; bottom: 5%; height: 4px;
    background: repeating-linear-gradient(90deg, var(--muted-deep) 0 14px, transparent 14px 22px);
  }
  .ground-shadow {
    position: absolute; left: 0; right: 0; bottom: 0; height: 5%;
    background: linear-gradient(180deg, transparent 0%, rgba(143,207,82,0.04) 100%);
  }

  .pigeon-wire { position: absolute; top: 7%; left: 4%; color: var(--muted-deep); font-size: 1.2rem; line-height: 1; white-space: pre; }
  .gremlin-perch { position: absolute; top: 12%; right: 7%; color: var(--muted-deep); font-size: 1.1rem; line-height: 1; white-space: pre; }
  .ogre-cave {
    position: absolute; top: 31%; left: 3%;
    width: 180px; height: 130px;
    border: 2px solid var(--muted-deep);
    border-radius: 90px 90px 0 0;
    background: radial-gradient(ellipse at 50% 60%, #060906 0%, #0a0e08 80%);
    box-shadow: inset 0 0 30px rgba(0,0,0,0.9);
  }
  .ogre-cave-label {
    position: absolute; top: 28%; left: 6%;
    color: var(--muted); font-size: 0.62rem; letter-spacing: 0.15em; text-transform: uppercase;
  }
  .workshop {
    position: absolute; bottom: 14%; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 0.2rem;
    color: var(--muted); font-size: 0.66rem; letter-spacing: 0.15em; text-transform: uppercase;
  }
  .workshop-fire {
    font-size: 2.2rem;
    filter: drop-shadow(0 0 12px rgba(243,160,82,0.5));
    animation: fire-flicker 0.7s ease-in-out infinite alternate;
  }
  @keyframes fire-flicker {
    from { transform: scale(1); filter: drop-shadow(0 0 12px rgba(243,160,82,0.5)); }
    to   { transform: scale(1.06); filter: drop-shadow(0 0 18px rgba(243,160,82,0.7)); }
  }
  .troll-bridge {
    position: absolute; bottom: 7%; right: 7%; width: 200px;
    color: var(--muted-deep); font-size: 0.72rem; line-height: 1.0;
    white-space: pre; text-align: center;
  }
  .raccoon-dump {
    position: absolute; bottom: 7%; left: 9%;
    font-size: 1.6rem; filter: brightness(0.7); line-height: 1;
  }

  .hoard {
    position: absolute; bottom: 22%; left: 50%; transform: translateX(-50%);
    font-size: 1.6rem; line-height: 1; opacity: 0;
    filter: drop-shadow(0 0 10px rgba(243,223,122,0.4));
    transition: opacity .5s; text-align: center; z-index: 2;
  }
  .warren[data-visual-tier="2"] .hoard { opacity: 0.7; }
  .warren[data-visual-tier="3"] .hoard { opacity: 0.9; }
  .warren[data-visual-tier="4"] .hoard { opacity: 1; }

  .creature {
    position: absolute; font-size: 2.6rem; line-height: 1; z-index: 4;
    transition: filter .25s, opacity .3s; user-select: none;
  }
  .creature .emoji { display: block; line-height: 1; }
  .creature .sprite-shell { display: none; margin: 0 auto; }
  .creature.pigeon-animated { font-size: 2.2rem; }
  .creature.pigeon-animated .emoji { display: none; }
  .creature.pigeon-animated .sprite-shell { display: block; width: 92px; height: 92px; }
  .creature.idle-sprite-animated .emoji { display: none; }
  .creature.idle-sprite-animated .idle-sprite { display: block; }
  .creature.raccoon-animated .emoji { display: none; }
  .creature.raccoon-animated .idle-sprite { display: block; width: 96px; height: 96px; }
  .creature.raccoon-animated[data-state="idle"] .emoji { display: none; }
  .creature.raccoon-animated[data-state="idle"] .idle-sprite { display: block; }
  .creature.raccoon-animated[data-state="active"] .idle-sprite { display: block; }
  .creature.troll-animated .emoji { display: block; }
  .creature.troll-animated .idle-sprite { display: none; width: 96px; height: 96px; }
  .creature.troll-animated[data-state="idle"] .emoji { display: none; }
  .creature.troll-animated[data-state="idle"] .idle-sprite { display: block; }
  .creature.gremlin-animated .idle-sprite { width: 96px; height: 96px; }
  .creature.ogre-animated .idle-sprite { width: 126px; height: 120px; }
  .pigeon-sprite {
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: auto;
  }
  .idle-sprite {
    width: 100%;
    height: 100%;
    display: block;
    image-rendering: pixelated;
  }
  .creature .label {
    display: block; margin-top: 0.15rem; text-align: center;
    color: var(--muted); font-size: 0.6rem;
    letter-spacing: 0.1em; text-transform: uppercase;
  }

  .creature[data-state="idle"] {
    animation: sway var(--sway-dur, 4s) ease-in-out infinite;
    animation-delay: var(--sway-delay, 0s);
  }
  @keyframes sway {
    0%, 100% { transform: translate(0, 0); }
    25%      { transform: translate(var(--sway-x, 2px), 0); }
    50%      { transform: translate(0, var(--sway-y, -2px)); }
    75%      { transform: translate(calc(var(--sway-x, 2px) * -1), 0); }
  }

  .creature[data-state="active"] { filter: drop-shadow(0 0 12px rgba(194,243,122,0.7)) brightness(1.2); }
  .creature[data-state="pass"]   { filter: drop-shadow(0 0 14px rgba(182,243,122,0.85)) brightness(1.25) saturate(1.2); }
  .creature[data-state="fail"]   { filter: drop-shadow(0 0 14px rgba(243,160,122,0.85)) hue-rotate(-30deg) brightness(0.95); }
  .creature[data-state="winner"] { filter: drop-shadow(0 0 18px rgba(243,223,122,0.95)) brightness(1.35) saturate(1.3); }
  .creature[data-state="cave"]   { filter: brightness(0.45) blur(0.4px); opacity: 0.7; }
  .creature.ogre-animated[data-state="cave"] { opacity: 1; filter: brightness(0.55) saturate(0.85); }

  .creature.pounce-a { animation: pounce-a 0.9s ease-in-out 1; }
  .creature.pounce-b { animation: pounce-b 1.0s cubic-bezier(.4,1.4,.5,1) 1; }
  .creature.pounce-c { animation: pounce-c 0.85s ease-out 1; }
  @keyframes pounce-a {
    0%   { transform: translate(0,0) rotate(0); }
    35%  { transform: translate(var(--px, -180px), var(--py, 110px)) rotate(-8deg) scale(1.25); filter: drop-shadow(0 0 18px rgba(243,160,122,.95)); }
    65%  { transform: translate(var(--px, -180px), var(--py, 110px)) rotate(0) scale(1.05); }
    100% { transform: translate(0,0) rotate(0); }
  }
  @keyframes pounce-b {
    0%   { transform: translate(0,0) scale(1); }
    25%  { transform: translate(0, -25px) scale(1.1); }
    55%  { transform: translate(var(--px, -200px), var(--py, 90px)) scale(1.3) rotate(15deg); filter: drop-shadow(0 0 20px rgba(243,160,122,.95)); }
    80%  { transform: translate(var(--px, -200px), var(--py, 90px)) scale(1) rotate(0); }
    100% { transform: translate(0,0) scale(1); }
  }
  @keyframes pounce-c {
    0%   { transform: translate(0,0); }
    30%  { transform: translate(var(--px, -160px), var(--py, 130px)) scale(1.4) rotate(-20deg); filter: drop-shadow(0 0 22px rgba(243,160,122,1)); }
    50%  { transform: translate(var(--px, -160px), var(--py, 130px)) scale(1.05); }
    70%  { transform: translate(calc(var(--px, -160px) * 0.4), calc(var(--py, 130px) * 0.4)); }
    100% { transform: translate(0,0); }
  }

  .creature.stomp-a { animation: stomp-a 1.3s ease-out 1; }
  .creature.stomp-b { animation: stomp-b 1.5s ease-out 1; }
  @keyframes stomp-a {
    0%   { opacity: 0.45; transform: translateX(140px); filter: brightness(0.8); }
    30%  { opacity: 1; transform: translateX(50px); filter: brightness(1.1); }
    45%  { transform: translateX(0) translateY(0); }
    55%  { transform: translateX(0) translateY(-9px); }
    65%  { transform: translateX(0) translateY(0); }
    100% { transform: translateX(0); opacity: 1; filter: drop-shadow(0 0 10px rgba(194,243,122,0.6)); }
  }
  @keyframes stomp-b {
    0%   { opacity: 0.45; transform: translateX(170px) translateY(-12px); filter: brightness(0.8); }
    25%  { opacity: 1; transform: translateX(70px); }
    40%  { transform: translateX(20px) translateY(-3px); }
    50%  { transform: translateX(0) translateY(3px); }
    60%  { transform: translateX(0) translateY(-11px); }
    72%  { transform: translateX(0) translateY(2px); }
    85%  { transform: translateX(0) translateY(-3px); }
    100% { transform: translate(0,0); opacity: 1; filter: drop-shadow(0 0 10px rgba(194,243,122,0.6)); }
  }

  .creature.scurry-a { animation: scurry-a 1.6s ease-in-out 1; }
  .creature.scurry-b { animation: scurry-b 1.8s ease-in-out 1; }
  @keyframes scurry-a {
    0%   { transform: translate(0,0); }
    20%  { transform: translate(calc(var(--sx, 220px) * 0.3), calc(var(--sy, -50px) * 0.3)); }
    40%  { transform: translate(var(--sx, 220px), var(--sy, -50px)); }
    60%  { transform: translate(var(--sx, 220px), var(--sy, -50px)); }
    100% { transform: translate(0,0); }
  }
  @keyframes scurry-b {
    0%   { transform: translate(0,0); }
    15%  { transform: translate(calc(var(--sx, 220px) * 0.2), -8px); }
    30%  { transform: translate(calc(var(--sx, 220px) * 0.5), calc(var(--sy, -50px) * 0.4)); }
    50%  { transform: translate(var(--sx, 220px), var(--sy, -50px)); }
    65%  { transform: translate(var(--sx, 220px), var(--sy, -50px)); }
    100% { transform: translate(0,0); }
  }

  .creature.gavel-a { animation: gavel-a 0.8s ease-in-out 2; }
  .creature.gavel-b { animation: gavel-b 1.0s ease-in-out 2; }
  @keyframes gavel-a { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-6deg); } 75% { transform: rotate(6deg); } }
  @keyframes gavel-b {
    0%,100% { transform: rotate(0) translateY(0); }
    20% { transform: rotate(-8deg) translateY(-2px); }
    60% { transform: rotate(10deg) translateY(0); }
    80% { transform: rotate(-3deg); }
  }

  .creature.hop { animation: hop 0.55s ease-out 1; }
  @keyframes hop {
    0%   { transform: translateY(0); }
    40%  { transform: translateY(-12px); }
    70%  { transform: translateY(3px); }
    100% { transform: translateY(0); }
  }

  .pos-pigeon  { top: 4%; left: 4%; }
  .creature.pos-pigeon[data-state="idle"] { animation: none; }
  .pos-gremlin { top: 9%;  right: 12%; }
  .pos-ogre    { top: 35%; left: 7%; }
  .pos-goblins { position: absolute; top: 28%; left: 50%; transform: translateX(-50%); width: min(92%, 760px); z-index: 4; }
  .pos-raccoon { bottom: 8%; left: 12%; }
  .pos-troll   { bottom: 11%; right: 11%; }

  .goblin-pile {
    position: relative; z-index: 2;
    display: flex; flex-wrap: wrap-reverse; gap: 0.45rem 0.7rem;
    align-items: flex-end; justify-content: center;
  }
  .goblin-pile .creature { position: static; font-size: 2.2rem; }
  .goblin-wrap {
    width: 92px; min-height: 112px;
    display: flex; flex-direction: column; align-items: center;
    transition: opacity 0.25s ease, transform 0.25s ease;
  }
  .goblin-wrap[data-home="true"] { opacity: 0; transform: translateY(10px) scale(0.72); pointer-events: none; }
  .goblin-wrap[data-home="false"] { opacity: 1; transform: translateY(0) scale(1); }
  .goblin-wrap[data-specialist="true"] .goblin-sprite { filter: invert(1) hue-rotate(160deg) saturate(1.45) contrast(1.08); }
  .goblin-wrap[data-specialist="true"] .personality { color: #9ef8ff; text-shadow: 0 0 8px rgba(158,248,255,0.42); }
  .goblin-sprite {
    width: 96px; height: 96px; display: block;
    image-rendering: pixelated;
  }
  .goblin-explosion {
    position: absolute; left: 50%; top: 42%; z-index: 5;
    width: min(58vw, 360px); height: auto;
    transform: translate(-50%, -50%) scale(0.96);
    opacity: 0; pointer-events: none;
    transition: opacity 0.12s ease, transform 0.18s ease;
  }
  .goblin-explosion.active { opacity: 1; transform: translate(-50%, -50%) scale(1.04); }
  .creature.goblin-sprite-animated .emoji { display: none; }
  .creature.goblin-sprite-animated .goblin-sprite { display: block; }
  .personality {
    margin-top: 0.15rem; font-size: 0.58rem; color: var(--muted);
    letter-spacing: 0.1em; text-transform: uppercase;
  }

  .bubble-layer { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
  .bubble {
    position: absolute; max-width: 22ch;
    padding: 0.45rem 0.65rem; background: var(--bubble-bg);
    border: 1px solid var(--bubble-border); border-radius: 6px;
    color: var(--fg-bright); font-size: 0.74rem; line-height: 1.35;
    box-shadow: 0 4px 16px rgba(0,0,0,0.55);
    backdrop-filter: blur(2px);
    opacity: 0; transform: translateY(6px);
    animation: bubble-in 0.25s ease-out forwards, bubble-out 0.4s ease-in forwards;
    animation-delay: 0s, 4s;
    word-break: break-word;
  }
  .bubble.kind-attack { border-color: #5a2a14; color: var(--fail); }
  .bubble.kind-pass   { border-color: #2a5a14; color: var(--pass); }
  .bubble.kind-fail   { border-color: #5a2a14; color: var(--fail); }
  .bubble.kind-win    { border-color: #5a4a14; color: var(--warn); }
  .bubble::after { content: ""; position: absolute; width: 0; height: 0; border: 6px solid transparent; }
  .bubble[data-tail="bl"]::after { bottom: -12px; left: 14px; border-top-color: var(--bubble-border); }
  .bubble[data-tail="br"]::after { bottom: -12px; right: 14px; border-top-color: var(--bubble-border); }
  .bubble[data-tail="bc"]::after { bottom: -12px; left: 50%; transform: translateX(-50%); border-top-color: var(--bubble-border); }
  .bubble[data-tail="tl"]::after { top: -12px; left: 14px; border-bottom-color: var(--bubble-border); }
  .bubble[data-tail="tc"]::after { top: -12px; left: 50%; transform: translateX(-50%); border-bottom-color: var(--bubble-border); }
  @keyframes bubble-in  { to { opacity: 1; transform: translateY(0); } }
  @keyframes bubble-out { to { opacity: 0; transform: translateY(-4px); } }

  /* DAG side panel (Phase 3): shows plan nodes with statuses */
  .dag-panel {
    position: absolute;
    top: 30%;
    right: 1%;
    width: 210px;
    background: rgba(10,14,8,0.94);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 0.5rem 0.6rem 0.6rem;
    color: var(--fg);
    font-size: 0.7rem;
    z-index: 18;
    display: none;
    box-shadow: 0 4px 18px rgba(0,0,0,0.5);
    max-height: 38%;
    overflow-y: auto;
  }
  .dag-panel.open { display: block; }
  .dag-panel.collapsed {
    max-height: 1.6rem;
    overflow: hidden;
    padding-bottom: 0.3rem;
  }
  .dag-panel.collapsed #dag-nodes { display: none; }
  .dag-panel h4 {
    margin: 0 0 0.4rem;
    color: var(--fg-bright);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    user-select: none;
  }
  .dag-panel h4 .toggle {
    color: var(--muted);
    font-size: 0.7rem;
    margin-left: 0.4rem;
  }
  .dag-panel h4:hover .toggle { color: var(--accent-hot); }
  .dag-node {
    display: flex; gap: 0.4rem; align-items: flex-start;
    padding: 3px 0;
    border-top: 1px dashed var(--line);
    line-height: 1.3;
  }
  .dag-node:first-of-type { border-top: none; }
  .dag-node .id {
    color: var(--muted); font-weight: 600;
    min-width: 2.5em;
  }
  .dag-node .text { flex: 1; word-break: break-word; }
  .dag-node[data-status="pending"]  .id { color: var(--muted); }
  .dag-node[data-status="running"]  .id { color: var(--accent-hot); animation: pulse-dot 1s ease-in-out infinite; }
  .dag-node[data-status="done"]     .id { color: var(--pass); }
  .dag-node[data-status="failed"]   .id { color: var(--fail); }
  .dag-node[data-status="skipped"]  .id { color: var(--muted-deep); }

  /* Live "thinking" bubble: sticky, updates in place as tokens stream */
  .think-bubble {
    position: absolute;
    max-width: 32ch;
    padding: 0.5rem 0.7rem;
    background: rgba(20, 32, 26, 0.78);
    border: 1px dashed var(--accent);
    border-radius: 6px;
    color: var(--fg-bright);
    font-size: 0.72rem;
    line-height: 1.4;
    box-shadow: 0 4px 18px rgba(0,0,0,0.6);
    backdrop-filter: blur(2px);
    pointer-events: none;
    z-index: 7;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .think-bubble::after {
    content: "▮";
    margin-left: 2px;
    color: var(--accent);
    animation: think-blink 1s steps(2) infinite;
  }
  @keyframes think-blink { 50% { opacity: 0; } }

  .ticker {
    border-top: 1px solid var(--line); padding: 0.55rem 1rem;
    color: var(--muted); font-size: 0.82rem;
    min-height: 2.3rem; display: flex; align-items: center; gap: 0.6rem;
  }
  .ticker .dot { color: var(--accent); }
  .ticker.live { color: var(--fg-bright); }
  .ticker.live .dot { color: var(--accent-hot); animation: pulse-dot 1s ease-in-out infinite; }
  @keyframes pulse-dot { 0%,100% { opacity: 0.5; } 50% { opacity: 1; } }

  .btn {
    flex: 1; padding: 0.75rem 1rem;
    border: 1px solid var(--line); background: var(--bg-deep); color: var(--fg-bright);
    font-family: inherit; font-size: 0.85rem; letter-spacing: 0.1em; text-transform: uppercase;
    cursor: pointer; text-decoration: none; text-align: center;
    transition: border-color .15s, color .15s, background .15s, transform .1s;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent-hot); transform: translateY(-1px); }
  .btn.primary { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
  .btn.primary:hover { background: var(--accent-hot); border-color: var(--accent-hot); color: var(--bg); }
  .btn.danger { border-color: var(--fail); background: #3a1414; color: var(--fail); font-weight: 600; }
  .btn.danger:hover { background: var(--fail); border-color: var(--fail); color: var(--bg); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  /* Result panel — drops in from bottom of tank */
  .result-panel {
    position: absolute; left: 0; right: 0; bottom: 0;
    background: rgba(10,14,8,0.97);
    border-top: 1px solid var(--accent);
    padding: 0.7rem 1rem 0.85rem;
    z-index: 15;
    max-height: 60%;
    transform: translateY(101%);
    transition: transform 0.35s ease-out;
    display: flex; flex-direction: column; gap: 0.45rem;
  }
  .result-panel.open { transform: translateY(0); }
  .result-header {
    display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap;
    font-size: 0.78rem;
  }
  .result-outcome {
    display: inline-block; padding: 2px 9px; border-radius: 3px;
    font-size: 0.68rem; letter-spacing: 0.1em;
    text-transform: uppercase; font-weight: 600;
  }
  .result-outcome.winner              { background: #1f3a14; color: var(--pass); }
  .result-outcome.specialist_recovery { background: #2a3a14; color: #c2f37a; }
  .result-outcome.ogre_fallback       { background: #3a2914; color: #f3c07a; }
  .result-outcome.all_failed          { background: #3a1414; color: var(--fail); }
  .result-task {
    color: var(--muted); font-style: italic; font-size: 0.78rem;
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .result-score { color: var(--warn); font-size: 0.78rem; white-space: nowrap; }
  .result-output {
    background: var(--bg-deep); padding: 0.55rem 0.75rem;
    font-size: 0.8rem; color: var(--fg-bright);
    max-height: 220px; overflow-y: auto;
    white-space: pre-wrap; word-break: break-word;
    border-left: 2px solid var(--muted); margin: 0;
    line-height: 1.45;
  }
  .result-actions {
    display: flex; gap: 0.6rem; align-items: center;
    font-size: 0.74rem;
  }
  .result-actions a { color: var(--accent); text-decoration: none; }
  .result-actions a:hover { color: var(--accent-hot); }
  .result-actions .grow { flex: 1; }
  .result-dismiss {
    padding: 3px 11px; background: var(--bg-deep);
    border: 1px solid var(--line); color: var(--muted);
    cursor: pointer; font-family: inherit; font-size: 0.7rem;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
  .result-dismiss:hover { border-color: var(--accent); color: var(--accent-hot); }
  .resume-panel {
    position: absolute;
    left: 1rem;
    right: 1rem;
    top: 1rem;
    z-index: 22;
    display: none;
    align-items: center;
    gap: 0.8rem;
    padding: 0.7rem 0.85rem;
    background: rgba(10,14,8,0.96);
    border: 1px solid var(--warn);
    box-shadow: 0 8px 28px rgba(0,0,0,0.55);
  }
  .resume-panel.open { display: flex; }
  .resume-copy {
    min-width: 0;
    flex: 1;
    color: var(--fg);
    font-size: 0.76rem;
    line-height: 1.35;
  }
  .resume-copy strong {
    display: block;
    color: var(--warn);
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 0.2rem;
  }
  .resume-copy span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .resume-actions {
    display: flex;
    gap: 0.45rem;
    flex: 0 0 auto;
  }
  .resume-actions .btn {
    flex: 0 0 auto;
    padding: 0.45rem 0.65rem;
    font-size: 0.68rem;
  }

  .asteroid-overlay {
    position: absolute;
    inset: 0;
    z-index: 76;
    display: none;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(8,11,7,0.68);
  }
  .asteroid-overlay.open { display: flex; }
  .asteroid-overlay.destroying { background: rgba(8,4,3,0.28); pointer-events: none; }
  .asteroid-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    opacity: 0;
    transition: opacity .2s ease;
  }
  .asteroid-overlay.destroying .asteroid-canvas { opacity: 1; }
  .asteroid-card {
    position: relative;
    z-index: 2;
    width: min(620px, calc(100% - 1.2rem));
    background: rgba(10,14,8,0.98);
    border: 1px solid var(--fail);
    box-shadow: 0 18px 54px rgba(0,0,0,0.78);
    padding: 1rem;
  }
  .asteroid-card h4 {
    margin: 0;
    color: var(--fail);
    font-size: 0.92rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .asteroid-card p {
    margin: 0.65rem 0 0;
    color: var(--fg);
    font-size: 0.8rem;
    line-height: 1.45;
  }
  .asteroid-card label {
    display: block;
    margin-top: 0.85rem;
    color: var(--muted);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .asteroid-card input {
    width: 100%;
    margin-top: 0.25rem;
    background: var(--bg);
    color: var(--fg-bright);
    border: 1px solid var(--line);
    border-radius: 3px;
    padding: 0.55rem 0.65rem;
    font-family: inherit;
    font-size: 0.86rem;
    letter-spacing: 0.08em;
  }
  .asteroid-card input:focus { outline: none; border-color: var(--fail); }
  .asteroid-actions {
    display: flex;
    gap: 0.55rem;
    margin-top: 0.9rem;
    flex-wrap: wrap;
  }
  .asteroid-actions .btn {
    flex: 1 1 150px;
    padding: 0.55rem 0.7rem;
    font-size: 0.68rem;
  }
  .asteroid-cloud-choice { display: none; }
  .asteroid-overlay.cloud-choice .asteroid-gate { display: none; }
  .asteroid-overlay.cloud-choice .asteroid-cloud-choice { display: block; }
  .asteroid-status {
    min-height: 1.2em;
    margin: 0.55rem 0 0;
    color: var(--warn);
    font-size: 0.72rem;
    line-height: 1.4;
  }
  .tank.asteroid-destroying {
    animation: asteroid-shake 0.12s linear infinite;
  }
  .tank.asteroid-destroying .skyline,
  .tank.asteroid-destroying .mountains,
  .tank.asteroid-destroying .workshop,
  .tank.asteroid-destroying .troll-bridge,
  .tank.asteroid-destroying .raccoon-dump,
  .tank.asteroid-destroying .creature,
  .tank.asteroid-destroying .hoard {
    filter: sepia(1) hue-rotate(-32deg) saturate(1.5) brightness(0.8);
  }
  @keyframes asteroid-shake {
    0% { transform: translate(0,0) rotate(0deg); }
    25% { transform: translate(2px,-1px) rotate(0.15deg); }
    50% { transform: translate(-2px,1px) rotate(-0.15deg); }
    75% { transform: translate(1px,2px) rotate(0.1deg); }
    100% { transform: translate(0,0) rotate(0deg); }
  }

  .ui-tooltip {
    position: fixed;
    z-index: 70;
    pointer-events: none;
    max-width: 34ch;
    background: rgba(8,11,7,0.97);
    border: 1px solid var(--accent);
    color: var(--fg-bright);
    font-size: 0.72rem;
    line-height: 1.4;
    padding: 0.42rem 0.55rem;
    box-shadow: 0 8px 28px rgba(0,0,0,0.6);
    opacity: 0;
    transform: translateY(4px);
    transition: opacity .12s ease, transform .12s ease;
  }
  .ui-tooltip.show { opacity: 1; transform: translateY(0); }
  .onboard-overlay {
    position: absolute;
    inset: 0;
    z-index: 65;
    background: rgba(8,11,7,0.84);
    display: none;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    pointer-events: none;
  }
  .onboard-overlay.open { display: flex; }
  .onboard-card {
    pointer-events: auto;
    width: min(560px, calc(100% - 1.2rem));
    background: rgba(10,14,8,0.98);
    border: 1px solid var(--accent);
    box-shadow: 0 14px 44px rgba(0,0,0,0.75);
    padding: 1rem;
  }
  .onboard-title {
    margin: 0;
    color: var(--fg-bright);
    font-size: 0.9rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .onboard-body {
    margin: 0.6rem 0 0;
    color: var(--fg);
    font-size: 0.79rem;
    line-height: 1.45;
  }
  .onboard-progress {
    margin: 0.35rem 0 0;
    color: var(--muted);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .onboard-actions {
    display: flex;
    gap: 0.55rem;
    margin-top: 0.85rem;
  }
  .onboard-cloud-actions {
    display: none;
    gap: 0.55rem;
    flex-wrap: wrap;
    margin-top: 0.85rem;
  }
  .onboard-cloud-actions.open {
    display: flex;
  }
  .onboard-cloud-actions .btn,
  .onboard-actions .btn {
    flex: 1 1 0;
  }
  .onboard-focus {
    position: relative;
    z-index: 68;
    outline: 2px solid rgba(143,207,82,0.72);
    outline-offset: 2px;
  }

  /* Rite form overlay */
  .rite-overlay {
    position: absolute; inset: 0;
    background: rgba(10,14,8,0.92);
    z-index: 20;
    display: none;
    align-items: center; justify-content: center;
    padding: 2rem;
  }
  .rite-overlay.open { display: flex; }
  .rite-form {
    background: var(--bg-deep); border: 1px solid var(--accent);
    padding: 1.2rem 1.5rem; border-radius: 6px;
    width: min(560px, 100%);
    max-height: min(720px, calc(100% - 2rem));
    overflow-y: auto;
    scrollbar-gutter: stable;
    box-shadow: 0 8px 40px rgba(0,0,0,0.7);
  }
  .rite-form h2 { margin: 0 0 0.8rem; color: var(--fg-bright); font-size: 1rem; letter-spacing: 0.06em; text-transform: uppercase; }
  .rite-form label { display: block; color: var(--muted); font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.2rem; }
  .rite-form textarea, .rite-form input, .rite-form select {
    width: 100%; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); padding: 0.5rem 0.6rem;
    font-family: inherit; font-size: 0.85rem; border-radius: 3px;
    margin-bottom: 0.8rem;
  }
  .rite-form textarea:focus, .rite-form input:focus, .rite-form select:focus {
    outline: none; border-color: var(--accent);
  }
  .rite-form .row { display: flex; gap: 0.8rem; }
  .rite-form .row > * { flex: 1; }
  .rite-form .check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--fg); margin-bottom: 0.8rem; }
  .rite-form .check input { width: auto; margin: 0; }
  .rite-form .actions { display: flex; gap: 0.6rem; margin-top: 0.5rem; }
</style>
</head>
<body>

<div class="warren" id="warren" data-tier="0" data-visual-tier="0">

  <div class="strip">
    <span class="name" id="town-identity">Goblintown · ${esc(townIdentity)}</span>
    <span class="grow"></span>
    <span class="tier" id="tier-display">tier 1 · unincorporated</span>
    <span class="clock" id="surface-mode">sidecar</span>
  </div>

  <div class="settings-popover" id="settings-popover">
    <div class="settings-title">
      <span>Settings</span>
      <span>town controls</span>
    </div>
    <div class="settings-actions">
      <button class="auth-chip" id="auth-chip" type="button" data-settings-label="Account">
        <span>Account</span><strong>Sign In ▾</strong>
      </button>
      <button class="provider-chip" id="provider-chip" type="button" data-settings-label="API">
        <span>API</span><strong>API ▾</strong>
      </button>
      <button class="reset-chip" id="reset-chip" type="button" aria-expanded="false" data-settings-label="Reset">
        <span>Reset</span><strong>Reset ▸</strong>
      </button>
      <div class="settings-reset-panel" id="settings-reset-panel" aria-hidden="true">
        <span class="settings-danger-label">Destructive Reset</span>
        <button class="settings-danger-action" id="btn-asteroid" type="button" data-settings-label="Asteroid">
          <span>Asteroid</span><strong>Asteroid Mode</strong>
        </button>
      </div>
    </div>
  </div>

  <div class="provider-popover" id="provider-popover">
    <h3>API Provider</h3>
    <div class="provider-scroll">
    <label for="provider-preset">Preset</label>
    <select id="provider-preset"></select>
    <div class="provider-workflow" id="provider-custom-workflow">
      <strong>Adding a non-standard AI provider?</strong>
      Use the installed repo skill <code>add-provider-package</code> at
      <code>.agents/skills/add-provider-package/SKILL.md</code>. Reinstall/update with
      <code>npx skills add https://github.com/vercel/ai --skill add-provider-package</code>;
      simple OpenAI-compatible APIs only need the Custom preset, base URL, key env, and model slots below.
    </div>
    <label for="provider-baseurl">Base URL</label>
    <input id="provider-baseurl" placeholder="https://api.example.com/v1">
    <div class="provider-grid">
      <div>
        <label for="provider-keyenv">Key env var</label>
        <input id="provider-keyenv" placeholder="OPENAI_API_KEY">
      </div>
      <div>
        <label for="provider-apikey">API key (saved locally)</label>
        <input id="provider-apikey" type="password" autocomplete="off" placeholder="sk-...">
      </div>
    </div>
    <div class="provider-grid">
      <div>
        <label for="provider-format">Forced format</label>
        <select id="provider-format">
          <option value="freeform">freeform</option>
          <option value="markdown">markdown</option>
          <option value="json">json object</option>
        </select>
      </div>
      <div>
        <label>&nbsp;</label>
        <button class="btn" type="button" id="provider-clear-key">Clear Saved Key</button>
      </div>
    </div>
    <details class="provider-advanced">
      <summary>default models</summary>
      <p class="provider-help">Optional fallback model names for slots that inherit the global provider.</p>
      <div class="provider-grid" id="provider-models"></div>
    </details>
    <details class="provider-advanced provider-routes-panel" open>
      <summary>menagerie routes</summary>
      <p class="provider-help">Override any creature slot with a different provider. Empty rows inherit the global provider.</p>
      <div class="provider-route-list" id="provider-routes"></div>
    </details>
    </div>
    <p class="provider-status" id="provider-status">Loading provider...</p>
    <div class="provider-actions">
      <button class="btn primary" type="button" id="provider-save">Save</button>
      <button class="btn" type="button" id="provider-cancel">Close</button>
    </div>
  </div>

  <div class="auth-popover" id="auth-popover">
    <h3>Sign-in & Cloud Collab</h3>
    <div class="cloud-mode-panel">
      <h4>Cloud Mode</h4>
      <p id="cloud-mode-status">Choose local-only or Goblintown Cloud.</p>
      <div class="provider-actions">
        <button class="btn" type="button" id="cloud-local-mode">Stay Local</button>
        <button class="btn primary" type="button" id="cloud-enable-mode">Use Goblintown Cloud</button>
      </div>
    </div>
    <p class="auth-status" id="auth-status">Loading auth state...</p>
    <div class="provider-actions">
      <button class="btn" type="button" id="auth-google-btn">Google</button>
      <button class="btn" type="button" id="auth-github-btn">GitHub</button>
      <button class="btn" type="button" id="auth-signout-btn">Sign Out</button>
    </div>
    <p class="auth-status" id="auth-note">Firebase mode needs sign-in and Firebase project config in env vars.</p>
  </div>

  <div id="settings-panel-dock" hidden></div>

  <div class="workarea goblin-shell" id="workarea">
  <aside class="ops-sidebar goblin-sidebar" id="ops-sidebar">
    <div class="ops-head">
      <h3>Goblintown</h3>
      <button class="ops-toggle" id="ops-toggle" type="button" aria-expanded="true" title="Collapse sidebar">◀</button>
    </div>
    <div class="ops-main" id="ops-main">
      <div class="ops-quick">
        <div class="ops-actions" aria-label="New work">
          <button class="btn primary" id="btn-rite" type="button" title="Start a new full rite">+ New rite</button>
          <button class="sr-only" id="btn-regular-rite" type="button" title="Start a regular rite">Regular</button>
          <button class="sr-only" id="btn-plan" type="button" title="Create a planned rite">Plan</button>
        </div>
        <section class="sidebar-list" data-sidebar-section="rites" aria-label="Rites">
          <button class="sidebar-section-toggle" type="button" data-sidebar-toggle="rites" aria-expanded="true">RITES</button>
          <div class="sidebar-items">
            ${sidebarRiteButtons(runs)}
          </div>
        </section>
      </div>
        <div class="sidebar-settings" id="sidebar-settings">
          <div class="sidebar-settings-card" id="sidebar-settings-card">
            <div class="settings-card-head">
              <img class="settings-icon" src="/assets/settingsopen.svg" alt="" aria-hidden="true" decoding="async">
              <span>Settings</span>
            </div>
            <button class="settings-link" id="btn-sidebar-full-settings" type="button">Settings</button>
            <a class="settings-link" href="/runs">Hoard</a>
            <span class="settings-joke">"Never trust a clean cache."</span>
          </div>
          <button class="settings-trigger" id="btn-sidebar-settings" type="button" aria-expanded="false" title="Open Settings">
            <img class="settings-icon" id="settings-icon-closed" src="/assets/settingsclosed.svg" alt="" aria-hidden="true" decoding="async">
            <img class="settings-icon" id="settings-icon-open" src="/assets/settingsopen.svg" alt="" aria-hidden="true" decoding="async">
            <span>Settings</span>
          </button>
        </div>
    </div>
    <div class="settings-sidebar-panel" id="settings-sidebar-panel" hidden>
      <div class="settings-sidebar-head">
        <strong>Settings</strong>
        <button class="settings-back" id="settings-sidebar-back" type="button">Back</button>
      </div>
      <nav class="settings-sidebar-menu" id="settings-sidebar-menu" aria-label="Settings sections">
        <button class="active" type="button" data-settings-section="account">Account</button>
        <button type="button" data-settings-section="api">API</button>
        <button type="button" data-settings-section="imports">Import Records</button>
        <button type="button" data-settings-section="reset">Reset</button>
        <a class="settings-fly-link" href="/fly" style="display:block;margin-top:8px;padding:8px 10px;border-radius:8px;text-decoration:none;color:inherit;background:rgba(255,255,255,0.06)">FLYTOWN control surface →</a>
      </nav>
    </div>
  </aside>

  <div class="tank${autopilot ? "" : " chat-mode codex-chat-surface sidecar-mode"}" id="tank">
    <section class="chat-main" id="chat-main" aria-label="Codex sidecar">
      ${autopilot ? "" : `<section class="sidecar-surface" id="sidecar-surface" aria-live="polite">
        <div class="sidecar-shell">
          <header class="sidecar-head">
            <span class="sidecar-kicker">Codex sidecar</span>
            <h2>Goblintown is waiting for Codex.</h2>
            <p>The prompt box moved into Codex. This app stays focused on rites, provider setup, imports, local memory, and live run inspection.</p>
          </header>
          <div class="sidecar-grid">
            <article class="sidecar-card">
              <span>Rites</span>
              <strong>Full pack still lives here</strong>
              <p>Start direct rites or planner runs, then watch transcripts, tool calls, and final artifacts in the Tank.</p>
            </article>
            <article class="sidecar-card">
              <span>Records</span>
              <strong>Chat imports stay local</strong>
              <p>Settings can still scan and import Codex sessions, ChatGPT exports, or folders into the Hoard.</p>
            </article>
          </div>
          <div class="sidecar-actions">
            <button id="sidecar-new-rite" type="button">New Rite</button>
            <button id="sidecar-new-plan" type="button">New Plan</button>
            <button id="sidecar-imports" type="button">Import Records</button>
            <button id="sidecar-provider" type="button">Provider Settings</button>
          </div>
        </div>
      </section>`}
      <div class="chat-thread surface-hidden" id="chat-thread" aria-live="polite" aria-hidden="true">
        <div class="chat-message assistant">
          <span class="chat-role">single goblin</span>
          ${CHAT_PERSONA_UI.intro}
        </div>
      </div>
      <div class="rite-surface" id="root-rite-surface" hidden aria-live="polite">
        <div class="rite-inline-inner">
          <header class="rite-inline-head">
            <div>
              <span class="rite-inline-kicker" id="root-rite-kicker">Rite</span>
              <h2 id="root-rite-title">Bounty issue #72</h2>
              <div class="rite-inline-meta" id="root-rite-meta">Selected from Rites</div>
            </div>
            <div class="rite-inline-actions">
              <a id="root-rite-export" href="/runs">Export</a>
              <button id="root-rite-resume" type="button">Resume</button>
            </div>
          </header>
          <div class="rite-stats" id="root-rite-stats"></div>
          <section class="inline-run-display" id="root-rite-live">
            <strong>Inline run display</strong>
            <p>Tool calls, tank activity, and run output appear here as the rite produces them.</p>
          </section>
          <section class="rite-discussion" id="root-rite-discussion">
            <h3>Discussion</h3>
          </section>
        </div>
      </div>
      <section class="settings-surface" id="settings-surface" hidden aria-live="polite">
        <div class="settings-surface-inner">
          <article class="settings-surface-panel" id="settings-surface-panel">
            <h2>Account</h2>
            <p>Choose a section from the Settings sidebar. Existing settings controls stay connected while this becomes the full settings workbench.</p>
          </article>
        </div>
      </section>
      ${autopilot ? "" : `<form class="chat-composer sidecar-hidden" id="root-chat-form" aria-hidden="true">
        <div class="chat-composer-inner">
          <div class="chat-offer-inline" id="root-chat-offer">
            <span id="root-chat-offer-text">This looks complex enough for the full Goblintown pack.</span>
            <button id="root-chat-offer-run" type="button">Run Goblintown</button>
          </div>
          <div class="chat-input-row">
            <textarea id="root-chat-input" rows="3" placeholder="Hidden compatibility prompt" required></textarea>
            <button id="root-chat-send" class="send-button" type="submit" title="Send (Enter)">↑</button>
          </div>
          <div class="chat-meta-row">
            <div class="personality-picker" id="personality-picker">
              <button id="root-chat-personality-label" class="personality-label" type="button" aria-haspopup="menu">goblin_mode</button>
              <div class="personality-menu" role="menu" aria-label="Personality">
                <button class="personality-choice" type="button" role="menuitem" data-personality="chipper">chipper</button>
                <button class="personality-choice" type="button" role="menuitem" data-personality="nerdy">nerdy</button>
                <button class="personality-choice" type="button" role="menuitem" data-personality="stoic">stoic</button>
                <button class="personality-choice" type="button" role="menuitem" data-personality="cynical">cynical</button>
                <button class="personality-choice" type="button" role="menuitem" data-personality="feral">feral</button>
                <button class="personality-choice active" type="button" role="menuitem" data-personality="goblin_mode">goblin_mode</button>
              </div>
            </div>
            <label class="sr-only">Model
              <select id="root-chat-model" title="Choose the chat model slot">
                <option value="inherit">provider default</option>
                <option value="goblin">goblin slot</option>
                <option value="ogre">ogre slot</option>
              </select>
            </label>
            <label class="sr-only">Personality
              <select id="root-chat-personality" title="Choose the single-goblin personality">
                <option value="chipper">chipper</option>
                <option value="nerdy">nerdy</option>
                <option value="stoic">stoic</option>
                <option value="cynical">cynical</option>
                <option value="feral">feral</option>
                <option value="goblin_mode" selected>goblin_mode</option>
              </select>
            </label>
            <input id="root-chat-max" class="sr-only" type="number" min="64" max="4000" value="900" title="Response length">
            <span id="root-chat-status">ready</span>
          </div>
        </div>
      </form>`}
    </section>
    <img class="tank-logo-mark" src="/assets/gtowntextmark.png" alt="" aria-hidden="true" decoding="async">

    <span class="star" style="top: 5%; left: 18%;">✦</span>
    <span class="star" style="top: 8%; left: 38%; animation-delay: -1s;">✦</span>
    <span class="star" style="top: 4%; left: 62%; animation-delay: -2s;">·</span>
    <span class="star" style="top: 9%; left: 75%; animation-delay: -3s;">✦</span>
    <span class="star" style="top: 6%; left: 88%;">·</span>

    <div class="mountains t4">🏔️ 🏔️ 🏔️ 🏔️ 🏔️</div>

    <div class="skyline back t3">🛖 🛖 🏚️ 🛖 🏚️ 🛖 🏚️ 🛖</div>

    <div class="skyline mid t1">🛖</div>
    <div class="skyline mid t2-flex" style="justify-content: center; gap: 1.2rem;">
      <span>🏚️</span><span>🛖</span><span>🏠</span>
    </div>
    <div class="skyline mid t3-flex" style="justify-content: center; gap: 1rem;">
      <span>🛖</span><span>🏚️</span><span>🛖</span><span>🏠</span><span>🛖</span>
    </div>
    <div class="skyline mid t4-flex" style="justify-content: center; gap: 0.9rem;">
      <span>🏚️</span><span>🛖</span><span>🏚️</span><span>🛖</span><span>🏠</span><span>🛖</span><span>🏚️</span>
    </div>

    <span class="smoke t2" style="top: 19%; left: 47%;">~</span>
    <span class="smoke t2" style="top: 19%; left: 41%; animation-delay: -1.4s;">~</span>
    <span class="smoke t2" style="top: 19%; left: 55%; animation-delay: -2.6s;">~</span>

    <pre class="banner t2">┌──── GOBLINTOWN ────┐
└── est. 2026 · MIT ─┘</pre>

    <div class="trees left t3">🌲🌲</div>
    <div class="trees right t3">🌲🌲</div>

    <span class="lantern" style="top: 36%; left: 26%;">🏮</span>
    <span class="lantern" style="top: 36%; right: 26%;">🏮</span>
    <span class="lantern" style="top: 56%; left: 18%; animation-delay: -1s;">🏮</span>

    <div class="ground"></div>
    <div class="ground-shadow"></div>

<pre class="pigeon-wire" id="pigeon-wire">═══════════════
        │
        │</pre>

<pre class="gremlin-perch">    │
    │
 ───┴───</pre>

    <div class="ogre-cave"></div>
    <div class="ogre-cave-label">ogre's cave</div>

    <div class="workshop">
      <div class="workshop-fire">🔥</div>
      <div>workshop</div>
    </div>

<pre class="troll-bridge">▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▌
▌                  ▐
~~~~~~~~~~~~~~~~~~~~</pre>

    <div class="raccoon-dump">🗑️ 📦</div>

    <div class="hoard" id="hoard"></div>

    <div class="resume-panel" id="resume-panel">
      <div class="resume-copy">
        <strong id="resume-title">Run can resume</strong>
        <span id="resume-detail"></span>
      </div>
      <div class="resume-actions">
        <button class="btn primary" type="button" id="resume-start">Resume</button>
        <button class="btn" type="button" id="resume-dismiss">Dismiss</button>
      </div>
    </div>

    <div class="asteroid-overlay" id="asteroid-overlay" aria-hidden="true">
      <canvas class="asteroid-canvas" id="asteroid-canvas" aria-hidden="true"></canvas>
      <div class="asteroid-card asteroid-gate">
        <h4>Asteroid Mode</h4>
        <p>This wipes this Goblintown's local memory and starts over at the tutorial.</p>
        <label for="asteroid-confirm">Type ASTEROID to arm</label>
        <input id="asteroid-confirm" autocomplete="off" spellcheck="false" inputmode="latin" placeholder="ASTEROID">
        <div class="asteroid-actions">
          <button class="btn danger" type="button" id="asteroid-arm" disabled>Arm Asteroid Mode</button>
          <button class="btn" type="button" id="asteroid-cancel">Cancel</button>
        </div>
        <p class="asteroid-status" id="asteroid-status"></p>
      </div>
      <div class="asteroid-card asteroid-cloud-choice">
        <h4>Cloud Data</h4>
        <p>Are you sure you want to delete your cloud data aswell</p>
        <div class="asteroid-actions">
          <button class="btn danger" type="button" id="asteroid-nuke-cloud">Yes, Nuke it</button>
          <button class="btn primary" type="button" id="asteroid-local-only">Just Destroy the Town</button>
          <button class="btn" type="button" id="asteroid-cloud-cancel">Cancel</button>
        </div>
        <p class="asteroid-status" id="asteroid-cloud-status"></p>
      </div>
    </div>

    <div class="creature pos-pigeon" id="c-pigeon" data-state="idle"
         style="--sway-dur: 3.6s; --sway-x: 3px; --sway-delay: -0.8s;">
      <canvas class="sprite-shell pigeon-sprite" id="c-pigeon-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">🐦</span>
      <span class="label">pigeon</span>
    </div>
    <div class="creature pos-gremlin" id="c-gremlin" data-state="idle"
         style="--sway-dur: 3.2s; --sway-x: 4px; --sway-delay: -2.1s;">
      <canvas class="sprite-shell idle-sprite" id="c-gremlin-sprite" width="130" height="130" aria-hidden="true"></canvas>
      <span class="emoji">😈</span>
      <span class="label">gremlin</span>
    </div>
    <div class="creature pos-ogre" id="c-ogre" data-state="cave"
         style="--sway-dur: 6s; --sway-x: 1px; font-size: 3rem;">
      <canvas class="sprite-shell idle-sprite" id="c-ogre-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">👹</span>
      <span class="label">ogre</span>
    </div>
    <div class="pos-goblins" id="c-goblins">
      <div class="goblin-pile" id="goblin-pile"></div>
      <canvas class="goblin-explosion" id="goblin-explosion" width="220" height="175" aria-hidden="true"></canvas>
    </div>
    <div class="creature pos-raccoon" id="c-raccoon" data-state="idle"
         style="--sway-dur: 4.4s; --sway-x: 3px; --sway-delay: -1.3s;">
      <canvas class="sprite-shell idle-sprite" id="c-raccoon-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">🦝</span>
      <span class="label">raccoon</span>
    </div>
    <div class="creature pos-troll" id="c-troll" data-state="idle"
         style="--sway-dur: 5.2s; --sway-x: 2px; --sway-delay: -3s; font-size: 2.8rem;">
      <canvas class="sprite-shell idle-sprite" id="c-troll-sprite" width="128" height="128" aria-hidden="true"></canvas>
      <span class="emoji">🧌</span>
      <span class="label">troll</span>
    </div>

    <div class="bubble-layer" id="bubble-layer"></div>

    <!-- DAG side panel (Phase 3 — only visible during a planned rite) -->
    <div class="dag-panel" id="dag-panel">
      <h4 id="dag-header"><span>plan</span><span class="toggle" id="dag-toggle">[hide]</span></h4>
      <div id="dag-nodes"></div>
    </div>

    <!-- Result panel (hidden until rite completes) -->
    <div class="result-panel" id="result-panel">
      <div class="result-header">
        <span class="result-outcome" id="result-outcome">—</span>
        <span class="result-task" id="result-task"></span>
        <span class="result-score" id="result-score"></span>
      </div>
      <pre class="result-output" id="result-output"></pre>
      <div class="result-actions">
        <a id="result-link" href="#">view full rite ↗</a>
        <span class="grow"></span>
        <button class="result-dismiss" id="result-dismiss">dismiss</button>
      </div>
    </div>

    <!-- Rite form overlay -->
    <div class="rite-overlay" id="rite-overlay">
      <form class="rite-form" id="rite-form">
        <h2>▶ New rite</h2>
        <label for="rf-task">Task</label>
        <textarea id="rf-task" name="task" rows="3" placeholder="What should the goblins solve?" required></textarea>
        <div class="row">
          <div>
            <label for="rf-pack">Pack size</label>
            <input id="rf-pack" name="packSize" type="number" value="3" min="1" max="6">
          </div>
          <div>
            <label for="rf-personality">Lead personality</label>
            <select id="rf-personality" name="personality">
              <option value="nerdy">nerdy</option>
              <option value="cynical">cynical</option>
              <option value="chipper">chipper</option>
              <option value="stoic">stoic</option>
              <option value="feral">feral</option>
              <option value="goblin_mode">goblin_mode</option>
            </select>
          </div>
        </div>
        <label for="rf-globs">Scan globs (one per line, optional)</label>
        <textarea id="rf-globs" name="scanGlobs" rows="2" placeholder="src/**/*.ts"></textarea>
        <div class="check">
          <input type="checkbox" id="rf-nofallback" name="noFallback">
          <label for="rf-nofallback" style="margin: 0; color: var(--fg);">skip ogre fallback</label>
        </div>
        <div class="check">
          <input type="checkbox" id="rf-debate" name="debate">
          <label for="rf-debate" style="margin: 0; color: var(--fg);">inter-agent debate round (Phase 4)</label>
        </div>
        <div class="check">
          <input type="checkbox" id="rf-troll-tools" name="trollTools">
          <label for="rf-troll-tools" style="margin: 0; color: var(--fg);">verifier tools for troll (Phase 5)</label>
        </div>
        <div class="check">
          <input type="checkbox" id="rf-remember" name="remember">
          <label for="rf-remember" style="margin: 0; color: var(--fg);">remember (load relevant prior artifacts)</label>
        </div>
        <div class="actions">
          <button type="submit" class="btn primary">Begin rite</button>
          <button type="button" class="btn" id="rf-cancel">Cancel</button>
        </div>
      </form>
    </div>

    <div class="onboard-overlay" id="onboard-overlay">
      <div class="onboard-card">
        <h4 class="onboard-title" id="onboard-title">Welcome to Goblintown</h4>
        <p class="onboard-body" id="onboard-body"></p>
        <p class="onboard-progress" id="onboard-progress">Step 1</p>
        <div class="onboard-cloud-actions" id="onboard-provider-actions">
          <button class="btn primary" type="button" data-onboard-provider="openai">OpenAI</button>
          <button class="btn" type="button" data-onboard-provider="deepseek">DeepSeek</button>
          <button class="btn" type="button" data-onboard-provider="lmstudio">LM Studio</button>
          <button class="btn" type="button" data-onboard-provider="ollama">Ollama</button>
          <button class="btn" type="button" data-onboard-provider="anthropic">Anthropic</button>
          <button class="btn" type="button" data-onboard-provider="custom">Add New</button>
        </div>
        <div class="onboard-cloud-actions" id="onboard-cloud-actions">
          <button class="btn" type="button" id="onboard-local-mode">Stay Local</button>
          <button class="btn primary" type="button" id="onboard-cloud-mode">Use Goblintown Cloud</button>
        </div>
        <div class="onboard-actions">
          <button class="btn" type="button" id="onboard-back">Back</button>
          <button class="btn" type="button" id="onboard-skip">Skip</button>
          <button class="btn primary" type="button" id="onboard-next">Next</button>
        </div>
      </div>
    </div>
  </div>
  </div>

  <div class="ticker" id="ticker">
    <span class="dot">●</span> <span id="ticker-text">idle</span>
    <span class="status-stats" id="status-stats">
      <b id="stat-loot">${lootCount}</b> loot · <b id="stat-rites">${riteCount}</b> rites · drift <b id="stat-drift">${drift.toFixed(3)}</b>
    </span>
  </div>

</div>

<script src="/vendor/matter-js/matter.min.js"></script>
<script>
const INITIAL = ${initial};

${autopilot ? `function missingElementProxy() {
  let proxy;
  const noop = function missingElement() { return proxy; };
  proxy = new Proxy(noop, {
    get: (_target, key) => {
      if (key === "then") return undefined;
      if (key === Symbol.toPrimitive) return () => "";
      return proxy;
    },
    set: () => true,
    apply: () => proxy,
  });
  return proxy;
}
` : ""}const $ = (id) => document.getElementById(id)${autopilot ? ` || missingElementProxy()` : ""};
const tank = $("tank");
const ticker = $("ticker");
const tickerText = $("ticker-text");
const rootChatMessages = [];
let rootChatOfferedTask = "";
const CHAT_PERSONA = ${JSON.stringify(CHAT_PERSONA_UI)};
const goblinPile = $("goblin-pile");
const goblinExplosion = $("goblin-explosion");
const goblinExplosionCtx = goblinExplosion ? goblinExplosion.getContext("2d") : null;
const bubbleLayer = $("bubble-layer");
const warren = $("warren");
const workarea = $("workarea");
const opsToggle = $("ops-toggle");
const settingsTrigger = $("btn-sidebar-settings");
const sidebarSettings = $("sidebar-settings");
const sidebarFullSettings = $("btn-sidebar-full-settings");
const settingsSidebarPanel = $("settings-sidebar-panel");
const settingsSidebarBack = $("settings-sidebar-back");
const settingsPopover = $("settings-popover");
const resetChip = $("reset-chip");
const settingsResetPanel = $("settings-reset-panel");

const rand  = (lo, hi) => lo + Math.random() * (hi - lo);
const irand = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick  = (arr)    => arr[Math.floor(Math.random() * arr.length)];

function setSettingsOpen(open) {
  settingsPopover.classList.toggle("open", !!open);
}

function setSidebarSettingsOpen(open) {
  sidebarSettings.classList.toggle("open", !!open);
  settingsTrigger.setAttribute("aria-expanded", open ? "true" : "false");
}

function setResetMenuOpen(open) {
  settingsResetPanel.classList.toggle("open", !!open);
  settingsResetPanel.setAttribute("aria-hidden", open ? "false" : "true");
  resetChip.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeResetMenu() {
  setResetMenuOpen(false);
}

function closeSettingsPopover() {
  setSettingsOpen(false);
  closeResetMenu();
}

function setSurfaceMode(mode) {
  $("surface-mode").textContent = mode;
}

function setSidebarSectionCollapsed(section, collapsed) {
  const root = document.querySelector('[data-sidebar-section="' + section + '"]');
  const toggle = document.querySelector('[data-sidebar-toggle="' + section + '"]');
  if (!root || !toggle) return;
  root.classList.toggle("collapsed", !!collapsed);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const section = button.getAttribute("data-sidebar-toggle") || "";
    const root = document.querySelector('[data-sidebar-section="' + section + '"]');
    setSidebarSectionCollapsed(section, !(root && root.classList.contains("collapsed")));
  });
});

document.querySelectorAll("[data-settings-section]").forEach((button) => {
  button.addEventListener("click", () => showSettingsSection(button.getAttribute("data-settings-section") || "account"));
});

function closeTopPopovers(exceptId) {
  ["auth-popover", "provider-popover"].forEach((id) => {
    if (id === exceptId) return;
    const panel = $(id);
    if (panel) panel.classList.remove("open");
  });
}

function setSettingsActionText(button, label, value) {
  if (!button) return;
  button.textContent = "";
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const valueEl = document.createElement("strong");
  valueEl.textContent = value;
  button.appendChild(labelEl);
  button.appendChild(valueEl);
}

function settingsActionValue(button) {
  if (!button) return "";
  const valueEl = button.querySelector("strong");
  return (valueEl ? valueEl.textContent : button.textContent) || "";
}

settingsTrigger.onclick = () => {
  closeTopPopovers("");
  showSettingsSurface();
};

sidebarFullSettings.onclick = () => {
  closeTopPopovers("");
  showSettingsSurface();
};

resetChip.onclick = () => {
  setResetMenuOpen(!settingsResetPanel.classList.contains("open"));
};

document.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  if (ev.target === settingsTrigger || settingsTrigger.contains(ev.target) || sidebarSettings.contains(ev.target)) return;
  if (settingsPopover.contains(ev.target)) return;
  closeSettingsPopover();
  setSidebarSettingsOpen(false);
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    closeSettingsPopover();
    setSidebarSettingsOpen(false);
  }
});

const RACCOON_SPRITE_CONFIG = {
  src: "/assets/raccoon-sleep.png",
  getUpSrc: "/assets/raccoon-get-up.png",
  scurrySrc: "/assets/raccoon-scurry.png",
  creatureId: "c-raccoon",
  canvasId: "c-raccoon-sprite",
  className: "raccoon-animated",
  cols: 16,
  rows: 1,
  totalFrames: 16,
  fps: 5,
  getUpFrames: 23,
  getUpFps: 12,
  scurryFrames: 10,
  scurryFps: 12,
};

const IDLE_CREATURE_SPRITES = [
  {
    src: "/assets/troll-idle.png",
    creatureId: "c-troll",
    canvasId: "c-troll-sprite",
    className: "troll-animated",
    cols: 24,
    rows: 1,
    totalFrames: 24,
    fps: 6,
    dedupeFrames: false,
  },
  {
    src: "/assets/gremlin-idle.png",
    creatureId: "c-gremlin",
    canvasId: "c-gremlin-sprite",
    className: "gremlin-animated",
    cols: 5,
    rows: 4,
    totalFrames: 20,
    frameOrder: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 17, 16, 15, 14, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
    fps: 6,
  },
  {
    src: "/assets/ogre-idle.png",
    creatureId: "c-ogre",
    canvasId: "c-ogre-sprite",
    className: "ogre-animated",
    cols: 8,
    rows: 4,
    totalFrames: 32,
    frameOrder: [0, 8, 16, 24, 1, 9, 17, 25, 2, 10, 18, 26, 3, 11, 19, 27, 4, 12, 20, 28, 5, 13, 21, 29, 6, 14, 22, 30, 7, 15, 23, 31],
    fps: 6,
  },
];

const GOBLIN_VARIANT_WEIGHTS = [
  { variant: "green", weight: 0.46 },
  { variant: "fire", weight: 0.27 },
  { variant: "spear", weight: 0.17 },
  { variant: "sceptre", weight: 0.10 },
];

const GOBLIN_ACTION_SHEETS = {
  green: {
    argue: { src: "/assets/goblin-green-argue.png", frames: 12, fps: 9 },
    defend: { src: "/assets/goblin-green-defend.png", frames: 12, fps: 10 },
    "go-home": { src: "/assets/goblin-green-go-home.png", frames: 12, fps: 10 },
    "come-out": { src: "/assets/goblin-green-come-out.png", frames: 12, fps: 10 },
  },
  fire: {
    argue: { src: "/assets/goblin-fire-argue.png", frames: 12, fps: 9 },
    defend: { src: "/assets/goblin-fire-defend.png", frames: 12, fps: 10 },
    "go-home": { src: "/assets/goblin-fire-go-home.png", frames: 14, fps: 10 },
    "come-out": { src: "/assets/goblin-fire-come-out.png", frames: 12, fps: 10 },
  },
  spear: {
    argue: { src: "/assets/goblin-spear-argue.png", frames: 12, fps: 9 },
    defend: { src: "/assets/goblin-spear-defend.png", frames: 12, fps: 10 },
    "go-home": { src: "/assets/goblin-spear-go-home.png", frames: 12, fps: 10 },
    "come-out": { src: "/assets/goblin-spear-come-out.png", frames: 13, fps: 10 },
  },
  sceptre: {
    argue: { src: "/assets/goblin-sceptre-argue.png", frames: 12, fps: 9 },
    defend: { src: "/assets/goblin-sceptre-defend.png", frames: 22, fps: 12 },
    "go-home": { src: "/assets/goblin-sceptre-go-home.png", frames: 12, fps: 10 },
    "come-out": { src: "/assets/goblin-sceptre-come-out.png", frames: 12, fps: 10 },
  },
};

const GOBLIN_EXPLOSION_SHEET = {
  src: "/assets/goblin-explosion.png",
  cols: 4,
  rows: 3,
  totalFrames: 10,
  fps: 14,
};

/* Pigeon sprite renderer */
const PIGEON_SPRITE_CONFIG = {
  rightSrc: "/assets/pigeon-walk-right.png",
  leftSrc: "/assets/pigeon-walk-left.png",
  cols: 5,
  rows: 5,
  totalFrames: 25,
};
const PIGEON_PECK_CONFIG = {
  src: "/assets/pigeon-peck.png",
  cols: 5,
  rows: 5,
  totalFrames: 25,
  firstMinIntervalMs: 1_500,
  firstMaxIntervalMs: 4_000,
  minIntervalMs: 14_000,
  maxIntervalMs: 35_000,
  fps: 8,
};
const PIGEON_WIRE_NUDGE_UP_PX = 12;
const pigeonSpriteCanvas = $("c-pigeon-sprite");
const pigeonSpriteCtx = pigeonSpriteCanvas ? pigeonSpriteCanvas.getContext("2d") : null;
const pigeonWire = $("pigeon-wire");
const pigeonEl = $("c-pigeon");
const pigeonSpriteState = {
  enabled: false,
  mode: "walk",
  visualState: "idle",
  facing: "right",
  frameCursor: 0,
  walkFrameOrder: [],
  peckFrameOrder: [],
  frameAccumulatorMs: 0,
  fps: 8,
  walkFps: 9,
  lastTickMs: 0,
  rafId: 0,
  images: { right: null, left: null, peck: null },
  flipLeftFromRight: false,
  railReady: false,
  railX: 0,
  railMinX: 0,
  railMaxX: 0,
  railTopPx: 0,
  railDir: 1,
  pendingTurnDir: 0,
  endPauseUntilMs: 0,
  endPauseMs: 260,
  nextPeckAtMs: 0,
  hasPeckedOnce: false,
  peckLoopsLeft: 0,
  peckStepBudget: 0,
};

function loadPigeonSheet(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load sprite sheet: " + src));
    img.src = src;
  });
}

const raccoonSpriteCanvas = $("c-raccoon-sprite");
const raccoonSpriteCtx = raccoonSpriteCanvas ? raccoonSpriteCanvas.getContext("2d") : null;
const raccoonEl = $("c-raccoon");
const raccoonSpriteState = {
  enabled: false,
  requestedState: "idle",
  mode: "sleep",
  facing: "right",
  frameCursor: 0,
  frameOrder: [],
  frameAccumulatorMs: 0,
  fps: RACCOON_SPRITE_CONFIG.fps,
  lastTickMs: 0,
  rafId: 0,
  images: { sleep: null, getUp: null, scurry: null },
};
let raccoonScurryTimer = 0;

function setRaccoonFacing(facing) {
  raccoonSpriteState.facing = facing === "left" ? "left" : "right";
}

function setRaccoonMode(mode) {
  const config = RACCOON_SPRITE_CONFIG;
  let fps = config.fps;
  let frameOrder = buildLinearFrameOrder(config.totalFrames);

  if (mode === "wake") {
    fps = config.getUpFps;
    frameOrder = buildLinearFrameOrder(config.getUpFrames);
  } else if (mode === "sleep-down") {
    fps = config.getUpFps;
    frameOrder = buildLinearFrameOrder(config.getUpFrames).reverse();
  } else if (mode === "awake") {
    fps = 1;
    frameOrder = [Math.max(0, config.getUpFrames - 1)];
  } else if (mode === "scurry") {
    fps = config.scurryFps;
    frameOrder = buildLinearFrameOrder(config.scurryFrames);
  }

  raccoonSpriteState.mode = mode;
  raccoonSpriteState.fps = fps;
  raccoonSpriteState.frameOrder = frameOrder.length ? frameOrder : [0];
  raccoonSpriteState.frameCursor = 0;
  raccoonSpriteState.frameAccumulatorMs = 0;
  drawRaccoonFrame();
}

function getRaccoonFrameSpec() {
  const config = RACCOON_SPRITE_CONFIG;
  if (raccoonSpriteState.mode === "wake" || raccoonSpriteState.mode === "sleep-down" || raccoonSpriteState.mode === "awake") {
    return {
      image: raccoonSpriteState.images.getUp || raccoonSpriteState.images.sleep,
      cols: raccoonSpriteState.images.getUp ? config.getUpFrames : config.cols,
      rows: 1,
      mirror: raccoonSpriteState.images.getUp && raccoonSpriteState.facing === "left",
    };
  }
  if (raccoonSpriteState.mode === "scurry") {
    return {
      image: raccoonSpriteState.images.scurry || raccoonSpriteState.images.getUp || raccoonSpriteState.images.sleep,
      cols: raccoonSpriteState.images.scurry ? config.scurryFrames : (raccoonSpriteState.images.getUp ? config.getUpFrames : config.cols),
      rows: 1,
      mirror: raccoonSpriteState.facing === "left",
    };
  }
  return {
    image: raccoonSpriteState.images.sleep,
    cols: config.cols,
    rows: config.rows,
    mirror: false,
  };
}

function drawRaccoonFrame() {
  if (!raccoonSpriteState.enabled || !raccoonSpriteCtx || !raccoonSpriteCanvas) return;
  const spec = getRaccoonFrameSpec();
  if (!spec.image) return;
  const order = raccoonSpriteState.frameOrder.length ? raccoonSpriteState.frameOrder : [0];
  const rawFrame = order[raccoonSpriteState.frameCursor % order.length] || 0;
  const frame = Math.max(0, Math.min(rawFrame, spec.cols * spec.rows - 1));
  const frameW = Math.floor(spec.image.naturalWidth / spec.cols);
  const frameH = Math.floor(spec.image.naturalHeight / spec.rows);
  if (!frameW || !frameH) return;

  const sx = (frame % spec.cols) * frameW;
  const sy = Math.floor(frame / spec.cols) * frameH;
  const dw = raccoonSpriteCanvas.width;
  const dh = raccoonSpriteCanvas.height;
  const scale = Math.min(dw / frameW, dh / frameH);
  const drawW = frameW * scale;
  const drawH = frameH * scale;
  const dx = (dw - drawW) / 2;
  const dy = dh - drawH;

  raccoonSpriteCtx.clearRect(0, 0, dw, dh);
  raccoonSpriteCtx.imageSmoothingEnabled = false;
  if (spec.mirror) {
    raccoonSpriteCtx.save();
    raccoonSpriteCtx.translate(dw, 0);
    raccoonSpriteCtx.scale(-1, 1);
    raccoonSpriteCtx.drawImage(spec.image, sx, sy, frameW, frameH, dx, dy, drawW, drawH);
    raccoonSpriteCtx.restore();
  } else {
    raccoonSpriteCtx.drawImage(spec.image, sx, sy, frameW, frameH, dx, dy, drawW, drawH);
  }
}

function finishRaccoonOneShot() {
  if (raccoonSpriteState.mode === "wake") {
    setRaccoonMode(raccoonSpriteState.requestedState === "idle" ? "sleep-down" : "awake");
    return true;
  }
  if (raccoonSpriteState.mode === "sleep-down") {
    setRaccoonMode("sleep");
    return true;
  }
  if (raccoonSpriteState.mode === "scurry") {
    setRaccoonMode(raccoonSpriteState.requestedState === "idle" ? "sleep-down" : "awake");
    return true;
  }
  return false;
}

function animateRaccoonSprite(ts) {
  if (!raccoonSpriteState.enabled) return;
  if (!raccoonSpriteState.lastTickMs) {
    raccoonSpriteState.lastTickMs = ts;
    drawRaccoonFrame();
  } else {
    const deltaMs = Math.max(0, ts - raccoonSpriteState.lastTickMs);
    raccoonSpriteState.lastTickMs = ts;
    const frameMs = 1000 / Math.max(1, raccoonSpriteState.fps || 6);
    raccoonSpriteState.frameAccumulatorMs += deltaMs;
    let advanced = 0;
    while (raccoonSpriteState.frameAccumulatorMs >= frameMs && advanced < 6) {
      raccoonSpriteState.frameAccumulatorMs -= frameMs;
      const orderLength = Math.max(1, raccoonSpriteState.frameOrder.length || 1);
      if (raccoonSpriteState.mode === "sleep") {
        raccoonSpriteState.frameCursor = (raccoonSpriteState.frameCursor + 1) % orderLength;
      } else if (raccoonSpriteState.mode === "awake") {
        raccoonSpriteState.frameCursor = 0;
      } else if (raccoonSpriteState.frameCursor < orderLength - 1) {
        raccoonSpriteState.frameCursor += 1;
      } else {
        finishRaccoonOneShot();
        break;
      }
      advanced += 1;
    }
    drawRaccoonFrame();
  }
  raccoonSpriteState.rafId = requestAnimationFrame(animateRaccoonSprite);
}

function playRaccoonTransition(direction) {
  if (!raccoonSpriteState.enabled) return false;
  const wantsDown = direction === "down";
  if (wantsDown && !raccoonSpriteState.images.getUp) {
    setRaccoonMode("sleep");
    return false;
  }
  if (!wantsDown && !raccoonSpriteState.images.getUp) {
    setRaccoonMode("sleep");
    return false;
  }
  setRaccoonMode(wantsDown ? "sleep-down" : "wake");
  return true;
}

function playRaccoonScurry(facing) {
  if (!raccoonSpriteState.enabled || !raccoonSpriteState.images.scurry) return false;
  setRaccoonFacing(facing);
  setRaccoonMode("scurry");
  return true;
}

function clearRaccoonScurryTimer() {
  if (raccoonScurryTimer) {
    clearTimeout(raccoonScurryTimer);
    raccoonScurryTimer = 0;
  }
}

function raccoonScurryDelayMs() {
  if (!raccoonSpriteState.enabled) return 0;
  if (
    raccoonSpriteState.mode === "sleep" ||
    raccoonSpriteState.mode === "sleep-down" ||
    raccoonSpriteState.mode === "wake"
  ) {
    return Math.ceil((RACCOON_SPRITE_CONFIG.getUpFrames / RACCOON_SPRITE_CONFIG.getUpFps) * 1000) + 80;
  }
  return 80;
}

function cueRaccoonScurryAfterWake() {
  if (
    raccoonSpriteState.enabled &&
    (raccoonSpriteState.mode === "sleep" || raccoonSpriteState.mode === "sleep-down")
  ) {
    setState("c-raccoon","active");
  }
  clearRaccoonScurryTimer();
  const delay = raccoonScurryDelayMs();
  raccoonScurryTimer = setTimeout(() => {
    raccoonScurryTimer = 0;
    scurryVariant();
  }, delay);
}

function cueRaccoonWork(options) {
  options = options || {};
  setState("c-raccoon","active");
  if (options.scurry) cueRaccoonScurryAfterWake();
}

function applyRaccoonStateVisual(state) {
  const wantsIdle = state === "idle";
  raccoonSpriteState.requestedState = wantsIdle ? "idle" : "active";
  if (!raccoonSpriteState.enabled) return;

  if (wantsIdle) {
    clearRaccoonScurryTimer();
    if (raccoonSpriteState.mode === "sleep" || raccoonSpriteState.mode === "sleep-down") return;
    playRaccoonTransition("down");
    return;
  }

  if (raccoonSpriteState.mode === "wake" || raccoonSpriteState.mode === "awake" || raccoonSpriteState.mode === "scurry") return;
  playRaccoonTransition("up");
}

async function bootRaccoonSprite() {
  if (!raccoonEl || !raccoonSpriteCanvas || !raccoonSpriteCtx) return;
  try {
    const sleep = await loadPigeonSheet(RACCOON_SPRITE_CONFIG.src);
    let getUp = null;
    let scurry = null;
    try {
      getUp = await loadPigeonSheet(RACCOON_SPRITE_CONFIG.getUpSrc);
    } catch {}
    try {
      scurry = await loadPigeonSheet(RACCOON_SPRITE_CONFIG.scurrySrc);
    } catch {}
    raccoonSpriteState.images.sleep = sleep;
    raccoonSpriteState.images.getUp = getUp;
    raccoonSpriteState.images.scurry = scurry;
    raccoonSpriteState.enabled = true;
    raccoonSpriteState.frameCursor = 0;
    raccoonSpriteState.frameAccumulatorMs = 0;
    raccoonSpriteState.lastTickMs = 0;
    raccoonEl.classList.add(RACCOON_SPRITE_CONFIG.className);
    setRaccoonMode((raccoonEl.dataset.state || "idle") === "idle" ? "sleep" : "awake");
    applyRaccoonStateVisual(raccoonEl.dataset.state || "idle");
    if (raccoonSpriteState.rafId) cancelAnimationFrame(raccoonSpriteState.rafId);
    raccoonSpriteState.rafId = requestAnimationFrame(animateRaccoonSprite);
  } catch (err) {
    console.warn("raccoon-sprite-disabled", err);
  }
}

function drawIdleCreatureFrame(state) {
  if (!state || !state.enabled || !state.ctx || !state.canvas || !state.image) return;
  const config = state.config;
  const order = state.frameOrder.length ? state.frameOrder : [0];
  const frame = order[state.frameCursor % order.length] || 0;
  const frameW = Math.floor(state.image.naturalWidth / config.cols);
  const frameH = Math.floor(state.image.naturalHeight / config.rows);
  if (!frameW || !frameH) return;

  const sx = (frame % config.cols) * frameW;
  const sy = Math.floor(frame / config.cols) * frameH;
  const dw = state.canvas.width;
  const dh = state.canvas.height;
  const scale = Math.min(dw / frameW, dh / frameH);
  const drawW = frameW * scale;
  const drawH = frameH * scale;
  const dx = (dw - drawW) / 2;
  const dy = dh - drawH;

  state.ctx.clearRect(0, 0, dw, dh);
  state.ctx.imageSmoothingEnabled = false;
  state.ctx.drawImage(state.image, sx, sy, frameW, frameH, dx, dy, drawW, drawH);
}

function animateIdleCreatureSprite(state, ts) {
  if (!state || !state.enabled) return;
  if (!state.lastTickMs) {
    state.lastTickMs = ts;
    drawIdleCreatureFrame(state);
  } else {
    const deltaMs = Math.max(0, ts - state.lastTickMs);
    state.lastTickMs = ts;
    const frameMs = 1000 / Math.max(1, state.config.fps || 6);
    state.frameAccumulatorMs += deltaMs;
    let advanced = 0;
    while (state.frameAccumulatorMs >= frameMs && advanced < 6) {
      state.frameAccumulatorMs -= frameMs;
      state.frameCursor = (state.frameCursor + 1) % Math.max(1, state.frameOrder.length || 1);
      advanced += 1;
    }
    drawIdleCreatureFrame(state);
  }
  state.rafId = requestAnimationFrame((nextTs) => animateIdleCreatureSprite(state, nextTs));
}

async function bootIdleCreatureSprite(config) {
  const creatureEl = $(config.creatureId);
  const canvas = $(config.canvasId);
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!creatureEl || !canvas || !ctx) return;
  try {
    const image = await loadPigeonSheet(config.src);
    const baseFrameOrder = Array.isArray(config.frameOrder) && config.frameOrder.length
      ? config.frameOrder
      : buildLinearFrameOrder(config.totalFrames);
    const frameOrder = config.dedupeFrames === false
      ? baseFrameOrder
      : dedupeAdjacentPigeonFrames(
          baseFrameOrder,
          image,
          config.cols,
          config.rows
        );
    const state = {
      config,
      canvas,
      ctx,
      image,
      enabled: true,
      frameCursor: 0,
      frameOrder,
      frameAccumulatorMs: 0,
      lastTickMs: 0,
      rafId: 0,
    };
    creatureEl.classList.add("idle-sprite-animated", config.className);
    drawIdleCreatureFrame(state);
    state.rafId = requestAnimationFrame((ts) => animateIdleCreatureSprite(state, ts));
  } catch (err) {
    console.warn(config.creatureId + "-sprite-disabled", err);
  }
}

function setPigeonFacing(facing) {
  pigeonSpriteState.facing = facing === "left" ? "left" : "right";
}

function setPigeonFps(fps) {
  const clamped = Math.max(2, Math.min(24, Number(fps) || 8));
  pigeonSpriteState.fps = clamped;
}

function buildPigeonFrameOrder(totalFrames) {
  const n = Math.max(1, Math.floor(totalFrames || 1));
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  // SNES-like cadence: decimate frames for choppier, readable motion.
  const seq = [];
  for (let i = 0; i < n; i += 2) seq.push(i);
  // Avoid the terminal duplicate-hitch frame in many sheets.
  if (seq.length > 1 && seq[seq.length - 1] === n - 1) seq.pop();
  return seq.length ? seq : [0];
}

function buildLinearFrameOrder(totalFrames) {
  const n = Math.max(1, Math.floor(totalFrames || 1));
  return Array.from({ length: n }, (_, i) => i);
}

function frameSignatureFromSheet(sheet, frameIndex, cols, rows) {
  const frameW = Math.floor(sheet.naturalWidth / cols);
  const frameH = Math.floor(sheet.naturalHeight / rows);
  if (!frameW || !frameH) return "";
  const sx = (frameIndex % cols) * frameW;
  const sy = Math.floor(frameIndex / cols) * frameH;

  const sampleSize = 12;
  const c = document.createElement("canvas");
  c.width = sampleSize;
  c.height = sampleSize;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, sampleSize, sampleSize);
  ctx.drawImage(sheet, sx, sy, frameW, frameH, 0, 0, sampleSize, sampleSize);
  const data = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

  let sig = "";
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    // Keep alpha + coarse luma to detect duplicate posed frames.
    if (a < 24) {
      sig += "00";
      continue;
    }
    const lum = ((data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8);
    sig += (a > 170 ? "2" : "1") + String((lum / 32) | 0);
  }
  return sig;
}

function dedupeAdjacentPigeonFrames(frameOrder, sheet, cols, rows) {
  if (!sheet || frameOrder.length <= 1) return frameOrder;
  const kept = [];
  let prevSig = "";
  for (const idx of frameOrder) {
    const sig = frameSignatureFromSheet(sheet, idx, cols, rows);
    if (!kept.length || sig !== prevSig) {
      kept.push(idx);
      prevSig = sig;
    }
  }
  return kept.length ? kept : frameOrder;
}

function nextPigeonPeckDelayMs(initial) {
  if (initial) {
    return Math.floor(
      rand(
        PIGEON_PECK_CONFIG.firstMinIntervalMs,
        PIGEON_PECK_CONFIG.firstMaxIntervalMs
      )
    );
  }
  return Math.floor(
    rand(PIGEON_PECK_CONFIG.minIntervalMs, PIGEON_PECK_CONFIG.maxIntervalMs)
  );
}

function scheduleNextPigeonPeck(ts, opts) {
  const now = Number.isFinite(ts) ? ts : performance.now();
  const initial = !!(opts && opts.initial && !pigeonSpriteState.hasPeckedOnce);
  pigeonSpriteState.nextPeckAtMs = now + nextPigeonPeckDelayMs(initial);
}

function queuePigeonPeckSoon(delayMs) {
  if (!pigeonSpriteState.enabled || !pigeonSpriteState.images.peck) return;
  if (!pigeonSpriteState.peckFrameOrder.length) return;
  const delay = Math.max(0, Number(delayMs) || 0);
  pigeonSpriteState.nextPeckAtMs = performance.now() + delay;
}

function startPigeonPeck(ts) {
  if (!pigeonSpriteState.images.peck) return false;
  if (!pigeonSpriteState.peckFrameOrder.length) return false;
  if (pigeonSpriteState.mode === "peck") return true;
  pigeonSpriteState.mode = "peck";
  pigeonSpriteState.frameCursor = 0;
  pigeonSpriteState.peckLoopsLeft = 2;
  pigeonSpriteState.peckStepBudget = Math.max(
    1,
    pigeonSpriteState.peckFrameOrder.length * pigeonSpriteState.peckLoopsLeft
  );
  pigeonSpriteState.hasPeckedOnce = true;
  pigeonSpriteState.pendingTurnDir = 0;
  pigeonSpriteState.endPauseUntilMs = 0;
  setPigeonFps(PIGEON_PECK_CONFIG.fps);
  pigeonSpriteState.nextPeckAtMs = Number.isFinite(ts) ? ts : performance.now();
  return true;
}

function finishPigeonPeck(ts) {
  pigeonSpriteState.mode = "walk";
  pigeonSpriteState.frameCursor = 0;
  pigeonSpriteState.peckLoopsLeft = 0;
  pigeonSpriteState.peckStepBudget = 0;
  setPigeonFps(pigeonSpriteState.walkFps);
  scheduleNextPigeonPeck(ts);
}

function updatePigeonRailBounds(forceReset) {
  if (!tank || !pigeonWire || !pigeonEl) return false;
  const tankRect = tank.getBoundingClientRect();
  const wireRect = pigeonWire.getBoundingClientRect();
  if (!wireRect.width || !tankRect.width) return false;
  const spriteRect = pigeonSpriteCanvas ? pigeonSpriteCanvas.getBoundingClientRect() : null;
  const spriteW = spriteRect && spriteRect.width ? spriteRect.width : 92;
  const spriteH = spriteRect && spriteRect.height ? spriteRect.height : 92;
  let railMinX = wireRect.left - tankRect.left - spriteW * 0.08;
  let railMaxX = wireRect.right - tankRect.left - spriteW * 0.92;
  if (railMaxX <= railMinX) railMaxX = railMinX + Math.max(10, spriteW * 0.2);
  const railTopPx = wireRect.top - tankRect.top - spriteH * 0.62 - PIGEON_WIRE_NUDGE_UP_PX;

  pigeonSpriteState.railMinX = railMinX;
  pigeonSpriteState.railMaxX = railMaxX;
  pigeonSpriteState.railTopPx = railTopPx;
  if (!pigeonSpriteState.railReady || forceReset) {
    pigeonSpriteState.railX = railMinX;
    pigeonSpriteState.railDir = 1;
    pigeonSpriteState.pendingTurnDir = 0;
    pigeonSpriteState.endPauseUntilMs = 0;
    pigeonSpriteState.railReady = true;
    setPigeonFacing("right");
  } else {
    pigeonSpriteState.railX = Math.max(railMinX, Math.min(railMaxX, pigeonSpriteState.railX));
  }
  pigeonEl.style.left = pigeonSpriteState.railX.toFixed(2) + "px";
  pigeonEl.style.top = railTopPx.toFixed(2) + "px";
  return true;
}

function getPigeonRailStepPx() {
  const span = Math.max(1, pigeonSpriteState.railMaxX - pigeonSpriteState.railMinX);
  const frameCount = Math.max(2, pigeonSpriteState.walkFrameOrder.length || 2);
  return span / (frameCount - 1);
}

function isAtPigeonEdgeForDirection() {
  const epsilon = 0.5;
  if (pigeonSpriteState.railDir > 0) {
    return pigeonSpriteState.railX >= pigeonSpriteState.railMaxX - epsilon;
  }
  return pigeonSpriteState.railX <= pigeonSpriteState.railMinX + epsilon;
}

function handlePigeonBoundaryPause(ts) {
  if (!pigeonSpriteState.enabled || !pigeonSpriteState.railReady) return false;
  if (pigeonSpriteState.frameCursor !== 0) return false;
  if (!isAtPigeonEdgeForDirection()) return false;

  if (pigeonSpriteState.pendingTurnDir === 0) {
    pigeonSpriteState.pendingTurnDir = pigeonSpriteState.railDir > 0 ? -1 : 1;
    pigeonSpriteState.endPauseUntilMs = ts + pigeonSpriteState.endPauseMs;
    return true;
  }

  if (ts < pigeonSpriteState.endPauseUntilMs) return true;

  pigeonSpriteState.railDir = pigeonSpriteState.pendingTurnDir;
  pigeonSpriteState.pendingTurnDir = 0;
  setPigeonFacing(pigeonSpriteState.railDir < 0 ? "left" : "right");
  return false;
}

function advancePigeonRailByFrame() {
  if (!pigeonSpriteState.enabled || !pigeonSpriteState.railReady || !pigeonEl) return;
  const step = getPigeonRailStepPx();
  pigeonSpriteState.railX += pigeonSpriteState.railDir * step;
  if (pigeonSpriteState.railDir > 0) {
    pigeonSpriteState.railX = Math.min(pigeonSpriteState.railMaxX, pigeonSpriteState.railX);
  } else {
    pigeonSpriteState.railX = Math.max(pigeonSpriteState.railMinX, pigeonSpriteState.railX);
  }
  pigeonEl.style.left = pigeonSpriteState.railX.toFixed(2) + "px";
}

function drawPigeonFrame() {
  if (!pigeonSpriteState.enabled || !pigeonSpriteCtx || !pigeonSpriteCanvas) return;
  const wantLeft = pigeonSpriteState.facing === "left";
  let sheet = null;
  let frameOrder = [0];
  let cols = PIGEON_SPRITE_CONFIG.cols;
  let rows = PIGEON_SPRITE_CONFIG.rows;
  let usingFallbackFlip = false;

  if (pigeonSpriteState.mode === "peck" && pigeonSpriteState.images.peck) {
    sheet = pigeonSpriteState.images.peck;
    frameOrder = pigeonSpriteState.peckFrameOrder.length
      ? pigeonSpriteState.peckFrameOrder
      : [0];
    cols = PIGEON_PECK_CONFIG.cols;
    rows = PIGEON_PECK_CONFIG.rows;
    usingFallbackFlip = wantLeft;
  } else {
    usingFallbackFlip = wantLeft && pigeonSpriteState.flipLeftFromRight;
    sheet = wantLeft
      ? (pigeonSpriteState.images.left || pigeonSpriteState.images.right)
      : (pigeonSpriteState.images.right || pigeonSpriteState.images.left);
    frameOrder = pigeonSpriteState.walkFrameOrder.length
      ? pigeonSpriteState.walkFrameOrder
      : [0];
  }
  if (!sheet) return;

  const frameIndex = ((Math.floor(pigeonSpriteState.frameCursor) % frameOrder.length) + frameOrder.length) % frameOrder.length;
  const frame = frameOrder[frameIndex];
  const frameW = Math.floor(sheet.naturalWidth / cols);
  const frameH = Math.floor(sheet.naturalHeight / rows);
  if (!frameW || !frameH) return;
  const sx = (frame % cols) * frameW;
  const sy = Math.floor(frame / cols) * frameH;
  const dw = pigeonSpriteCanvas.width;
  const dh = pigeonSpriteCanvas.height;

  pigeonSpriteCtx.clearRect(0, 0, dw, dh);
  pigeonSpriteCtx.imageSmoothingEnabled = true;
  if (usingFallbackFlip) {
    pigeonSpriteCtx.save();
    pigeonSpriteCtx.translate(dw, 0);
    pigeonSpriteCtx.scale(-1, 1);
    pigeonSpriteCtx.drawImage(sheet, sx, sy, frameW, frameH, 0, 0, dw, dh);
    pigeonSpriteCtx.restore();
  } else {
    pigeonSpriteCtx.drawImage(sheet, sx, sy, frameW, frameH, 0, 0, dw, dh);
  }
}

function applyPigeonStateVisual(state) {
  if (!pigeonSpriteState.enabled) return;
  pigeonSpriteState.visualState = state;
  switch (state) {
    case "active":
      pigeonSpriteState.walkFps = 12;
      break;
    case "winner":
      pigeonSpriteState.walkFps = 10;
      break;
    case "fail":
      pigeonSpriteState.walkFps = 8;
      break;
    default:
      pigeonSpriteState.walkFps = 9;
      break;
  }
  if (pigeonSpriteState.mode !== "peck") {
    setPigeonFps(pigeonSpriteState.walkFps);
  }
}

function animatePigeonSprite(ts) {
  if (!pigeonSpriteState.enabled) return;
  if (!pigeonSpriteState.lastTickMs) {
    pigeonSpriteState.lastTickMs = ts;
    drawPigeonFrame();
  } else {
    const deltaMs = Math.max(0, ts - pigeonSpriteState.lastTickMs);
    pigeonSpriteState.lastTickMs = ts;

    if (
      pigeonSpriteState.mode !== "peck" &&
      pigeonSpriteState.images.peck &&
      pigeonSpriteState.peckFrameOrder.length &&
      ts >= pigeonSpriteState.nextPeckAtMs &&
      pigeonSpriteState.visualState !== "active"
    ) {
      startPigeonPeck(ts);
    }

    const frameMs = 1000 / pigeonSpriteState.fps;
    pigeonSpriteState.frameAccumulatorMs += deltaMs;
    let advanced = 0;
    while (pigeonSpriteState.frameAccumulatorMs >= frameMs && advanced < 6) {
      if (pigeonSpriteState.mode !== "peck" && handlePigeonBoundaryPause(ts)) {
        pigeonSpriteState.frameAccumulatorMs = Math.min(pigeonSpriteState.frameAccumulatorMs, frameMs);
        break;
      }
      pigeonSpriteState.frameAccumulatorMs -= frameMs;
      const prevCursor = pigeonSpriteState.frameCursor;
      const currentFrameOrder =
        pigeonSpriteState.mode === "peck"
          ? (pigeonSpriteState.peckFrameOrder.length ? pigeonSpriteState.peckFrameOrder : [0])
          : (pigeonSpriteState.walkFrameOrder.length ? pigeonSpriteState.walkFrameOrder : [0]);
      pigeonSpriteState.frameCursor =
        (pigeonSpriteState.frameCursor + 1) %
        Math.max(1, currentFrameOrder.length);

      if (pigeonSpriteState.mode === "peck") {
        pigeonSpriteState.peckStepBudget = Math.max(0, pigeonSpriteState.peckStepBudget - 1);
        if (currentFrameOrder.length <= 1) {
          pigeonSpriteState.peckLoopsLeft = 0;
        } else if (pigeonSpriteState.frameCursor === 0 && prevCursor !== 0) {
          pigeonSpriteState.peckLoopsLeft = Math.max(
            0,
            pigeonSpriteState.peckLoopsLeft - 1
          );
        }
        if (
          pigeonSpriteState.peckLoopsLeft <= 0 ||
          pigeonSpriteState.peckStepBudget <= 0
        ) {
          finishPigeonPeck(ts);
        }
      } else {
        advancePigeonRailByFrame();
      }
      advanced += 1;
    }
    drawPigeonFrame();
  }
  pigeonSpriteState.rafId = requestAnimationFrame(animatePigeonSprite);
}

async function bootPigeonSprite() {
  if (!pigeonSpriteCanvas || !pigeonSpriteCtx) return;
  try {
    let right = null;
    let left = null;
    let peck = null;
    let flipLeftFromRight = false;
    try {
      right = await loadPigeonSheet(PIGEON_SPRITE_CONFIG.rightSrc);
    } catch {}
    try {
      left = await loadPigeonSheet(PIGEON_SPRITE_CONFIG.leftSrc);
    } catch {
      if (right) flipLeftFromRight = true;
    }
    try {
      peck = await loadPigeonSheet(PIGEON_PECK_CONFIG.src);
    } catch {}
    if (!right && left) right = left;
    if (!right && !left) throw new Error("pigeon sprite sheets not found");
    pigeonSpriteState.images.right = right;
    pigeonSpriteState.images.left = left;
    pigeonSpriteState.images.peck = peck;
    pigeonSpriteState.flipLeftFromRight = flipLeftFromRight;
    const walkBaseOrder = buildPigeonFrameOrder(PIGEON_SPRITE_CONFIG.totalFrames);
    const walkSheet = right || left;
    pigeonSpriteState.walkFrameOrder = dedupeAdjacentPigeonFrames(
      walkBaseOrder,
      walkSheet,
      PIGEON_SPRITE_CONFIG.cols,
      PIGEON_SPRITE_CONFIG.rows
    );
    // Keep peck cadence visually aligned with the SNES-like walk loop.
    const peckBaseOrder = buildPigeonFrameOrder(PIGEON_PECK_CONFIG.totalFrames);
    pigeonSpriteState.peckFrameOrder = peck
      ? dedupeAdjacentPigeonFrames(
          peckBaseOrder,
          peck,
          PIGEON_PECK_CONFIG.cols,
          PIGEON_PECK_CONFIG.rows
        )
      : [];
    pigeonSpriteState.frameCursor = 0;
    pigeonSpriteState.frameAccumulatorMs = 0;
    pigeonSpriteState.lastTickMs = 0;
    pigeonSpriteState.mode = "walk";
    pigeonSpriteState.walkFps = 9;
    setPigeonFps(pigeonSpriteState.walkFps);
    pigeonSpriteState.enabled = true;
    pigeonSpriteState.hasPeckedOnce = false;
    scheduleNextPigeonPeck(performance.now(), { initial: true });
    if (pigeonEl) pigeonEl.classList.add("pigeon-animated");
    updatePigeonRailBounds(true);
    drawPigeonFrame();
    if (pigeonSpriteState.rafId) cancelAnimationFrame(pigeonSpriteState.rafId);
    pigeonSpriteState.rafId = requestAnimationFrame(animatePigeonSprite);
  } catch (err) {
    console.warn("pigeon-sprite-disabled", err);
  }
}
void bootPigeonSprite();
void bootRaccoonSprite();
for (const config of IDLE_CREATURE_SPRITES) {
  void bootIdleCreatureSprite(config);
}
window.addEventListener("resize", () => {
  if (pigeonSpriteState.enabled) updatePigeonRailBounds(false);
});

function setSidebarCollapsed(collapsed) {
  workarea.classList.toggle("sidebar-collapsed", collapsed);
  opsToggle.textContent = collapsed ? "▶" : "◀";
  opsToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try { localStorage.setItem("goblintown.sidebarCollapsed", collapsed ? "1" : "0"); } catch {}
}
opsToggle.onclick = () => {
  const collapsed = !workarea.classList.contains("sidebar-collapsed");
  setSidebarCollapsed(collapsed);
};
try {
  setSidebarCollapsed(localStorage.getItem("goblintown.sidebarCollapsed") === "1");
} catch {
  setSidebarCollapsed(false);
}

/* Tooltips (delegated, works for dynamic content too) */
const tooltipEl = document.createElement("div");
tooltipEl.className = "ui-tooltip";
document.body.appendChild(tooltipEl);
let tooltipTarget = null;
window.addEventListener("securitypolicyviolation", (event) => {
  try {
    const statusEl = document.getElementById("auth-status");
    const blocked = event.blockedURI ? " from " + event.blockedURI : "";
    const msg = "CSP blocked " + event.violatedDirective + blocked;
    if (statusEl) statusEl.textContent = msg;
  } catch {
    // no-op
  }
});
function setTip(id, text) {
  const el = $(id);
  if (el && text) el.setAttribute("data-tip", text);
}
function setTipIfMissing(el, text) {
  if (!el || !text) return;
  if (!el.getAttribute("data-tip")) el.setAttribute("data-tip", text);
}
function applyFallbackTips() {
  document.querySelectorAll("button, input, select, textarea, a.btn, summary").forEach((el) => {
    if (el.getAttribute("data-tip")) return;
    const fromLabel = (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
    const fromText = (el.textContent || "").trim().replace(/\s+/g, " ");
    const tip = fromLabel || fromText;
    if (tip) el.setAttribute("data-tip", tip);
  });
}
function placeTooltip(target) {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, left));
  let top = rect.bottom + 8;
  if (top + tipRect.height > window.innerHeight - 8) top = rect.top - tipRect.height - 8;
  top = Math.max(8, top);
  tooltipEl.style.left = left + "px";
  tooltipEl.style.top = top + "px";
}
function showTooltip(target) {
  if (!target) return;
  const text = target.getAttribute("data-tip");
  if (!text) return;
  tooltipTarget = target;
  tooltipEl.textContent = text;
  tooltipEl.classList.add("show");
  placeTooltip(target);
}
function hideTooltip() {
  tooltipTarget = null;
  tooltipEl.classList.remove("show");
}
document.addEventListener("mouseover", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const target = ev.target.closest("[data-tip]");
  if (!target) return;
  showTooltip(target);
});
document.addEventListener("mouseout", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const from = ev.target.closest("[data-tip]");
  if (!from) return;
  const related = ev.relatedTarget instanceof Element ? ev.relatedTarget.closest("[data-tip]") : null;
  if (from !== related) hideTooltip();
});
document.addEventListener("focusin", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const target = ev.target.closest("[data-tip]");
  if (target) showTooltip(target);
});
document.addEventListener("focusout", () => hideTooltip());
window.addEventListener("scroll", () => {
  if (tooltipTarget) placeTooltip(tooltipTarget);
}, true);
window.addEventListener("resize", () => {
  if (tooltipTarget) placeTooltip(tooltipTarget);
});

/* Static tooltip copy */
[
  ["auth-chip", "Sign in with Firebase for cloud collaboration mode."],
  ["provider-chip", "Configure local provider, model slots, and API key storage."],
  ["reset-chip", "Open reset controls."],
  ["sidecar-new-rite", "Start a full Goblintown rite from the sidecar."],
  ["sidecar-new-plan", "Start a planned Goblintown DAG from the sidecar."],
  ["sidecar-imports", "Open local chat and record import settings."],
  ["sidecar-provider", "Open provider and model routing settings."],
  ["btn-sidebar-settings", "Open the settings menu."],
  ["ops-rites", "Open rite shortcuts and run history."],
  ["root-chat-input", "Write a chat message. Shift+Enter inserts a line break; Enter sends."],
  ["root-chat-send", "Send this chat message."],
  ["root-chat-model", "Choose which model slot this chat should use."],
  ["root-chat-personality", "Choose the personality for single-goblin replies."],
  ["root-chat-offer-run", "Launch this prompt in the full Tank."],
  ["btn-rite", "Start a new full Tank rite."],
  ["btn-regular-rite", "Start a regular full Tank rite."],
  ["btn-plan", "Create a planned multi-step rite."],
  ["btn-asteroid", "Open the destructive full reset flow."],
  ["ops-toggle", "Collapse or expand the command sidebar."],
  ["auth-google-btn", "Sign in with Google via Firebase Authentication."],
  ["auth-github-btn", "Sign in with GitHub via Firebase Authentication."],
  ["auth-signout-btn", "Sign out from Firebase and disable cloud write operations."],
  ["cloud-local-mode", "Keep this Goblintown local and turn off cloud features."],
  ["cloud-enable-mode", "Use the shared Goblintown Cloud backend for sign-in and collaboration metadata."],
  ["provider-preset", "Select a provider preset (OpenAI, LM Studio, Ollama, etc.)."],
  ["provider-baseurl", "Base API URL for the active provider preset."],
  ["provider-keyenv", "Environment variable name used for this provider key."],
  ["provider-apikey", "Optional key saved in a local secret file on this machine."],
  ["provider-format", "Force response format mode for downstream parsing."],
  ["provider-save", "Save provider settings to local config."],
  ["provider-cancel", "Close provider settings without applying changes now."],
  ["provider-clear-key", "Delete the locally stored provider API key."],
  ["rf-task", "Describe the task for this rite."],
  ["rf-pack", "How many goblins should run in the pack."],
  ["rf-personality", "Lead goblin personality style for the run."],
  ["rf-globs", "Optional file globs for scavenger context scan."],
  ["rf-nofallback", "Prevent ogre fallback if all goblins fail."],
  ["rf-debate", "Enable an inter-agent debate round before review."],
  ["rf-troll-tools", "Allow verifier tool usage in troll review."],
  ["rf-remember", "Load relevant previous artifacts into context."],
  ["rf-cancel", "Close the rite form."],
  ["result-link", "Open the full rite detail page."],
  ["result-dismiss", "Hide the result panel."],
  ["onboard-back", "Go to the previous onboarding step."],
  ["onboard-local-mode", "Start in local-only mode."],
  ["onboard-cloud-mode", "Start with Goblintown Cloud available."],
  ["onboard-skip", "Dismiss onboarding and continue directly to the app."],
  ["onboard-next", "Advance to the next onboarding step."],
].forEach((entry) => setTip(entry[0], entry[1]));
applyFallbackTips();

/* Town tier from real warren stats */
function tierOf(rites) {
  if (rites >= 80) return 7;
  if (rites >= 48) return 6;
  if (rites >= 24) return 5;
  if (rites >= 12) return 4;
  if (rites >= 6)  return 3;
  if (rites >= 2)  return 2;
  return 1;
}
const tierName = ["unincorporated","hamlet","village","town","city","metropolis","city-state","goblin empire"];
function applyStats(stats) {
  const t = tierOf(stats.rites);
  const visualTier = Math.min(4, Math.max(1, t));
  warren.dataset.tier = String(t);
  warren.dataset.visualTier = String(visualTier);
  $("stat-loot").textContent = stats.loot;
  $("stat-rites").textContent = stats.rites;
  $("stat-drift").textContent = (stats.drift ?? 0).toFixed(3);
  $("tier-display").textContent = "tier " + t + " · " + tierName[t - 1];
  const piles = ["", "💰", "💰💰", "💰💰💰", "💰💰💰💰💎"];
  $("hoard").textContent = piles[visualTier] || "";
  if (stats.rites === 0) setTicker("idle — unincorporated, awaiting first rite");
  else if (!ticker.classList.contains("live")) setTicker("idle — " + stats.rites + " rites in this town");
}
applyStats(INITIAL);

async function refreshStats() {
  try {
    const r = await fetch("/api/warren/stats");
    if (r.ok) applyStats(await r.json());
  } catch {}
}

/* Provider menu */
let providerPresets = [];
let modelSlots = [];
const providerChip = $("provider-chip");
const providerPopover = $("provider-popover");
const providerPreset = $("provider-preset");
const providerBaseUrl = $("provider-baseurl");
const providerKeyEnv = $("provider-keyenv");
const providerApiKey = $("provider-apikey");
const providerFormat = $("provider-format");
const providerModels = $("provider-models");
const providerRoutes = $("provider-routes");
const providerStatus = $("provider-status");

function providerById(id) {
  return providerPresets.find((p) => p.id === id) || providerPresets[0];
}
function addOption(select, value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  select.appendChild(option);
}
function providerModelForSlot(slot, models) {
  return (models && models[slot]) || "";
}
function renderProviderModels(models) {
  providerModels.innerHTML = "";
  for (const slot of modelSlots) {
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = slot;
    const input = document.createElement("input");
    input.dataset.slot = slot;
    input.value = (models && models[slot]) || "";
    input.placeholder = providerModelForSlot(slot, (providerById(providerPreset.value) || {}).models) || "inherit";
    wrap.appendChild(label);
    wrap.appendChild(input);
    providerModels.appendChild(wrap);
  }
}
function routeDefaultModel(slot, models, route) {
  const preset = route && route.preset ? providerById(route.preset) : null;
  return providerModelForSlot(slot, (preset || {}).models) || providerModelForSlot(slot, models);
}
function renderProviderRoutes(routes, models) {
  providerRoutes.innerHTML = "";
  for (const slot of modelSlots) {
    const route = (routes && routes[slot]) || {};
    const row = document.createElement("div");
    row.className = "provider-route-row";
    row.setAttribute("data-route-slot", slot);

    const slotLabel = document.createElement("div");
    slotLabel.className = "provider-route-slot";
    slotLabel.textContent = slot;

    const presetWrap = document.createElement("div");
    const presetLabel = document.createElement("label");
    presetLabel.textContent = "provider";
    const presetSelect = document.createElement("select");
    presetSelect.setAttribute("data-route-preset", "1");
    addOption(presetSelect, "", "inherit");
    for (const preset of providerPresets) addOption(presetSelect, preset.id, preset.label);
    presetSelect.value = route.preset || "";
    presetWrap.appendChild(presetLabel);
    presetWrap.appendChild(presetSelect);

    const modelWrap = document.createElement("div");
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "model";
    const modelInput = document.createElement("input");
    modelInput.setAttribute("data-route-model", "1");
    modelInput.value = route.model || "";
    modelInput.placeholder = routeDefaultModel(slot, models, route) || "inherit";
    modelWrap.appendChild(modelLabel);
    modelWrap.appendChild(modelInput);

    const formatWrap = document.createElement("div");
    const formatLabel = document.createElement("label");
    formatLabel.textContent = "format";
    const formatSelect = document.createElement("select");
    formatSelect.setAttribute("data-route-format", "1");
    addOption(formatSelect, "", "inherit");
    addOption(formatSelect, "freeform", "freeform");
    addOption(formatSelect, "markdown", "markdown");
    addOption(formatSelect, "json", "json");
    formatSelect.value = route.outputFormat || "";
    formatWrap.appendChild(formatLabel);
    formatWrap.appendChild(formatSelect);

    const clearButton = document.createElement("button");
    clearButton.className = "btn provider-route-clear";
    clearButton.type = "button";
    clearButton.textContent = "Clear";

    const extra = document.createElement("div");
    extra.className = "provider-route-extra";
    const baseWrap = document.createElement("div");
    const baseLabel = document.createElement("label");
    baseLabel.textContent = "base url";
    const baseInput = document.createElement("input");
    baseInput.setAttribute("data-route-baseurl", "1");
    baseInput.value = route.baseURL || "";
    const selectedPreset = route.preset ? providerById(route.preset) : null;
    baseInput.placeholder = (selectedPreset && selectedPreset.baseURL) || "inherit";
    baseWrap.appendChild(baseLabel);
    baseWrap.appendChild(baseInput);

    const keyWrap = document.createElement("div");
    const keyLabel = document.createElement("label");
    keyLabel.textContent = "key env";
    const keyInput = document.createElement("input");
    keyInput.setAttribute("data-route-keyenv", "1");
    keyInput.value = route.apiKeyEnv || "";
    keyInput.placeholder = (selectedPreset && selectedPreset.apiKeyEnv) || "inherit";
    keyWrap.appendChild(keyLabel);
    keyWrap.appendChild(keyInput);
    extra.appendChild(baseWrap);
    extra.appendChild(keyWrap);

    presetSelect.onchange = () => {
      const selected = presetSelect.value ? providerById(presetSelect.value) : null;
      modelInput.placeholder = providerModelForSlot(slot, (selected || {}).models) || providerModelForSlot(slot, models) || "inherit";
      baseInput.placeholder = (selected && selected.baseURL) || "inherit";
      keyInput.placeholder = (selected && selected.apiKeyEnv) || "inherit";
    };
    clearButton.onclick = () => {
      presetSelect.value = "";
      modelInput.value = "";
      formatSelect.value = "";
      baseInput.value = "";
      keyInput.value = "";
      presetSelect.onchange();
    };

    row.appendChild(slotLabel);
    row.appendChild(presetWrap);
    row.appendChild(modelWrap);
    row.appendChild(formatWrap);
    row.appendChild(clearButton);
    row.appendChild(extra);
    providerRoutes.appendChild(row);
  }
}
function collectProviderModels() {
  const models = {};
  providerModels.querySelectorAll("input[data-slot]").forEach((input) => {
    const value = input.value.trim();
    if (value) models[input.dataset.slot] = value;
  });
  return models;
}
function collectProviderRoutes() {
  const routes = {};
  providerRoutes.querySelectorAll("[data-route-slot]").forEach((row) => {
    const slot = row.getAttribute("data-route-slot");
    const preset = row.querySelector("[data-route-preset]").value;
    if (!slot || !preset) return;
    const route = { preset };
    const model = row.querySelector("[data-route-model]").value.trim();
    const baseURL = row.querySelector("[data-route-baseurl]").value.trim();
    const apiKeyEnv = row.querySelector("[data-route-keyenv]").value.trim();
    const outputFormat = row.querySelector("[data-route-format]").value;
    if (model) route.model = model;
    if (baseURL) route.baseURL = baseURL;
    if (apiKeyEnv) route.apiKeyEnv = apiKeyEnv;
    if (outputFormat) route.outputFormat = outputFormat;
    routes[slot] = route;
  });
  return routes;
}
function buildProviderPayload(extra) {
  return {
    preset: providerPreset.value,
    baseURL: providerBaseUrl.value.trim(),
    apiKeyEnv: providerKeyEnv.value.trim(),
    outputFormat: providerFormat.value,
    models: collectProviderModels(),
    routes: collectProviderRoutes(),
    ...(extra || {}),
  };
}
function applyProviderPayload(payload) {
  const config = payload.config || {};
  const runtime = payload.runtime || {};
  providerPreset.value = config.preset || runtime.id || "openai";
  providerBaseUrl.value = config.baseURL || runtime.baseURL || "";
  providerKeyEnv.value = config.apiKeyEnv || runtime.apiKeyEnv || "OPENAI_API_KEY";
  providerFormat.value = config.outputFormat || runtime.outputFormat || "freeform";
  const models = { ...(runtime.models || {}), ...(config.models || {}) };
  renderProviderModels(models);
  renderProviderRoutes(config.routes || {}, models);
  const missing = runtime.missingApiKey;
  setSettingsActionText(providerChip, "API", (runtime.label || "API") + " ▾");
  providerChip.dataset.missing = missing ? "true" : "false";
  providerApiKey.value = "";
  if (missing) {
    providerStatus.innerHTML = "Missing key: set <strong>" + missing + "</strong> in env or save locally.";
    return;
  }
  let source = "available";
  if (runtime.apiKeySource === "env") source = "from environment";
  else if (runtime.apiKeySource === "stored") source = "from local secret file";
  else if (runtime.apiKeySource === "dummy") source = "using local dummy key";
  providerStatus.innerHTML = "Using <strong>" + (runtime.label || "provider") + "</strong>, key " + source + ".";
}
async function loadProviderMenu() {
  try {
    const [providersRes, providerRes] = await Promise.all([
      fetch("/api/providers"),
      fetch("/api/provider"),
    ]);
    if (providersRes.ok) {
      const data = await providersRes.json();
      providerPresets = data.presets || [];
      modelSlots = data.modelSlots || [];
      providerPreset.innerHTML = "";
      for (const preset of providerPresets) {
        const option = document.createElement("option");
        option.value = preset.id;
        option.textContent = preset.label;
        providerPreset.appendChild(option);
      }
    }
    if (providerRes.ok) applyProviderPayload(await providerRes.json());
  } catch {
    providerStatus.textContent = "Provider menu unavailable.";
  }
}
providerPreset.onchange = () => {
  const preset = providerById(providerPreset.value);
  if (!preset) return;
  providerBaseUrl.value = preset.baseURL || "";
  providerKeyEnv.value = preset.apiKeyEnv || "OPENAI_API_KEY";
  renderProviderModels(preset.models || {});
  renderProviderRoutes(collectProviderRoutes(), preset.models || {});
};
providerChip.onclick = () => {
  closeSettingsPopover();
  closeTopPopovers("provider-popover");
  providerPopover.classList.toggle("open");
};
$("provider-cancel").onclick = () => providerPopover.classList.remove("open");
$("provider-save").onclick = async () => {
  const payload = buildProviderPayload();
  const enteredApiKey = providerApiKey.value.trim();
  if (enteredApiKey) payload.apiKey = enteredApiKey;
  providerStatus.textContent = "Saving...";
  try {
    const r = await fetch("/api/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(await r.text());
    applyProviderPayload(await r.json());
    providerPopover.classList.remove("open");
    setTicker("provider saved: " + settingsActionValue(providerChip).replace(" ▾", ""));
  } catch (err) {
    providerStatus.textContent = "Save failed: " + (err.message || err);
  }
};
$("provider-clear-key").onclick = async () => {
  providerStatus.textContent = "Clearing saved key...";
  try {
    const r = await fetch("/api/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildProviderPayload({ clearApiKey: true })),
    });
    if (!r.ok) throw new Error(await r.text());
    applyProviderPayload(await r.json());
    setTicker("saved key cleared");
  } catch (err) {
    providerStatus.textContent = "Clear failed: " + (err.message || err);
  }
};
loadProviderMenu();

/* Auth + Firebase collab */
const authChip = $("auth-chip");
const authPopover = $("auth-popover");
const authStatus = $("auth-status");
const authNote = $("auth-note");
const cloudModeStatus = $("cloud-mode-status");
const cloudLocalModeBtn = $("cloud-local-mode");
const cloudEnableModeBtn = $("cloud-enable-mode");
const authGoogleBtn = $("auth-google-btn");
const authGithubBtn = $("auth-github-btn");
const authSignoutBtn = $("auth-signout-btn");
const FIREBASE_JS_VERSION = "10.12.5";
const cloudModeStorageKey = "goblintown.cloudMode.v1";
const MEMBERSHIP_STATE_VALUES = new Set(["solo", "pending", "member", "owner", "deleted"]);
let firebaseState = {
  enabled: false,
  initialized: false,
  app: null,
  auth: null,
  db: null,
  user: null,
  userProfile: null,
  sdk: null,
  chatKeys: null,
  bootPromise: null,
};
let redirectResultChecked = false;

function readCloudModeChoice() {
  try {
    const value = localStorage.getItem(cloudModeStorageKey);
    return value === "cloud" || value === "local" ? value : "";
  } catch {
    return "";
  }
}

function isCloudModeEnabled() {
  return readCloudModeChoice() === "cloud";
}

async function disableCloudModeRuntime() {
  try {
    if (firebaseState.auth && firebaseState.sdk && firebaseState.user) {
      await firebaseState.sdk.auth.signOut(firebaseState.auth);
    }
  } catch (err) {
    authStatus.textContent = "Cloud sign-out failed: " + (err.message || err);
  }
  firebaseState.user = null;
  firebaseState.userProfile = null;
  firebaseState.chatKeys = null;
  updateAuthUi();
}

function bootFirebaseIfCloudMode() {
  if (!isCloudModeEnabled()) return;
  const boot = ensureFirebaseReady();
  void boot.catch((err) => {
    authStatus.textContent = "Firebase init failed: " + (err && err.message ? err.message : String(err));
  });
}

function setCloudModeChoice(mode) {
  const next = mode === "cloud" ? "cloud" : "local";
  try { localStorage.setItem(cloudModeStorageKey, next); } catch {}
  if (next === "cloud") {
    authStatus.textContent = "Cloud mode enabled. Sign in when you are ready.";
    updateAuthUi();
    bootFirebaseIfCloudMode();
    return;
  }
  void disableCloudModeRuntime();
}

function randomAlphaNum(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function maybeName(input) {
  const s = String(input || "").trim();
  if (!s) return "";
  return s.slice(0, 48);
}
function normalizeMembershipState(value) {
  const state = String(value || "").trim().toLowerCase();
  return MEMBERSHIP_STATE_VALUES.has(state) ? state : "";
}
function inferMembershipState(profile) {
  const explicit = normalizeMembershipState(profile && profile.membershipState);
  if (explicit) return explicit;
  if (String((profile && profile.pendingCountryId) || "").trim()) return "pending";
  if (String((profile && profile.countryId) || "").trim()) return "member";
  return "solo";
}
function updateAuthUi() {
  const signedIn = !!firebaseState.user;
  const cloudOn = isCloudModeEnabled();
  const enabled = !!firebaseState.enabled;
  cloudModeStatus.textContent = cloudOn
    ? "Goblintown Cloud is on. SSO, friend codes, discovery, group chats, and country metadata use the shared cloud backend."
    : "Local Only is on. Your town memory stays on this machine, and cloud sign-in/discovery/group chats stay off.";
  cloudLocalModeBtn.disabled = !cloudOn;
  cloudEnableModeBtn.disabled = cloudOn;
  cloudLocalModeBtn.classList.toggle("primary", !cloudOn);
  cloudEnableModeBtn.classList.toggle("primary", cloudOn);
  authGoogleBtn.disabled = !cloudOn || !enabled;
  authGithubBtn.disabled = !cloudOn || !enabled;
  authSignoutBtn.disabled = !cloudOn || !enabled || !signedIn;
  if (!cloudOn) {
    setSettingsActionText(authChip, "Account", "Local Only ▾");
    authStatus.textContent = "Cloud mode is off.";
    authNote.textContent = "Turn on Goblintown Cloud here when you want SSO, friend codes, discovery, and group chats.";
    return;
  }
  if (!firebaseState.bootPromise && !firebaseState.initialized && !enabled) {
    setSettingsActionText(authChip, "Account", "Cloud On ▾");
    authStatus.textContent = "Cloud mode is on. Firebase will initialize when you sign in.";
    authNote.textContent = "Use Google or GitHub to sync collaboration metadata through Goblintown Cloud.";
    return;
  }
  if (!enabled) {
    setSettingsActionText(authChip, "Account", "Cloud On ▾");
    authStatus.textContent = "Firebase is not configured on this server.";
    authNote.textContent =
      "Goblintown ships a default cloud config; env vars can override it for forks.";
    return;
  }
  if (!signedIn) {
    setSettingsActionText(authChip, "Account", "Sign In ▾");
    authStatus.textContent = "Signed out.";
    authNote.textContent = "Sign in to use Firebase collaboration and cloud friend/code flows.";
    return;
  }
  const profileName = maybeName(firebaseState.userProfile && firebaseState.userProfile.username);
  const display = profileName || maybeName(firebaseState.user.displayName) || "user";
  const code = firebaseState.userProfile && firebaseState.userProfile.friendCode
    ? " · code " + firebaseState.userProfile.friendCode
    : "";
  const state = normalizeMembershipState(firebaseState.userProfile && firebaseState.userProfile.membershipState);
  const stateText = state ? " · " + state : "";
  setSettingsActionText(authChip, "Account", display + " ▾");
  authStatus.textContent = "Signed in as " + display + code + stateText;
  authNote.textContent = "Cloud mode stores usernames, membership/discovery metadata, and encrypted group chat payloads.";
}

async function loadFirebaseSdk() {
  if (firebaseState.sdk) return firebaseState.sdk;
  const appMod = await import(
    "https://www.gstatic.com/firebasejs/" + FIREBASE_JS_VERSION + "/firebase-app.js"
  );
  const authMod = await import(
    "https://www.gstatic.com/firebasejs/" + FIREBASE_JS_VERSION + "/firebase-auth.js"
  );
  const storeMod = await import(
    "https://www.gstatic.com/firebasejs/" + FIREBASE_JS_VERSION + "/firebase-firestore.js"
  );
  firebaseState.sdk = {
    app: appMod,
    auth: authMod,
    store: storeMod,
  };
  return firebaseState.sdk;
}

async function ensureFirebaseReady() {
  if (firebaseState.bootPromise) return firebaseState.bootPromise;
  firebaseState.bootPromise = (async () => {
    const configRes = await fetch("/api/firebase/config");
    const cfg = await configRes.json().catch(() => ({ enabled: false, config: null }));
    firebaseState.enabled = !!cfg.enabled && !!cfg.config;
    if (!firebaseState.enabled) {
      updateAuthUi();
      return false;
    }
    const sdk = await loadFirebaseSdk();
    const app = sdk.app.initializeApp(cfg.config);
    const auth = sdk.auth.getAuth(app);
    const db = sdk.store.getFirestore(app);
    try {
      if (sdk.auth.browserLocalPersistence) {
        await sdk.auth.setPersistence(auth, sdk.auth.browserLocalPersistence);
      }
    } catch (err) {
      console.warn("firebase-persistence-setup-failed", err);
    }
    firebaseState.app = app;
    firebaseState.auth = auth;
    firebaseState.db = db;
    sdk.auth.onAuthStateChanged(auth, async (user) => {
      firebaseState.user = user || null;
      firebaseState.chatKeys = null;
      if (firebaseState.user) {
        try {
          await ensureFirebaseProfile(false);
        } catch (err) {
          console.error("firebase-profile-init-failed", err);
        }
      } else {
        firebaseState.userProfile = null;
      }
      updateAuthUi();
    });
    if (!redirectResultChecked) {
      redirectResultChecked = true;
      try {
        const redirectResult = await sdk.auth.getRedirectResult(auth);
        if (redirectResult && redirectResult.user) {
          const providerId = (redirectResult.providerId || "provider").replace(".com", "");
          authStatus.textContent = "Redirect sign-in complete (" + providerId + ").";
        }
      } catch (err) {
        const code = err && err.code ? String(err.code) : "";
        const hint = authErrorHint(code);
        authStatus.textContent =
          "Redirect sign-in failed" + (code ? " (" + code + ")" : "") + (hint ? " — " + hint : "");
      }
    }
    firebaseState.initialized = true;
    updateAuthUi();
    return true;
  })().catch((err) => {
    firebaseState.enabled = false;
    firebaseState.initialized = false;
    firebaseState.bootPromise = null;
    updateAuthUi();
    throw err;
  });
  return firebaseState.bootPromise;
}

async function ensureChatKeys() {
  if (!firebaseState.user) return null;
  if (firebaseState.chatKeys) return firebaseState.chatKeys;
  const sdk = firebaseState.sdk;
  if (!sdk) return null;
  const storageKey = "goblintown.chat-ecdh.v1." + firebaseState.user.uid;
  const saved = localStorage.getItem(storageKey);
  let privateKey = null;
  let publicKey = null;
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      privateKey = await crypto.subtle.importKey(
        "jwk",
        parsed.privateJwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      publicKey = await crypto.subtle.importKey(
        "jwk",
        parsed.publicJwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        [],
      );
      firebaseState.chatKeys = {
        privateKey,
        publicKey,
        publicJwk: parsed.publicJwk,
      };
      return firebaseState.chatKeys;
    } catch {
      localStorage.removeItem(storageKey);
    }
  }
  const generated = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  privateKey = generated.privateKey;
  publicKey = generated.publicKey;
  const privateJwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", publicKey);
  localStorage.setItem(storageKey, JSON.stringify({ privateJwk, publicJwk }));
  firebaseState.chatKeys = { privateKey, publicKey, publicJwk };
  return firebaseState.chatKeys;
}

async function ensureFirebaseProfile(forceRefresh) {
  if (!firebaseState.user || !firebaseState.db || !firebaseState.sdk) return null;
  if (firebaseState.userProfile && !forceRefresh) return firebaseState.userProfile;
  const store = firebaseState.sdk.store;
  const uid = firebaseState.user.uid;
  const ref = store.doc(firebaseState.db, "users", uid);
  const snap = await store.getDoc(ref);
  const usernameFallback = maybeName(firebaseState.user.displayName) || maybeName(INITIAL.warren) || "goblin";
  let profile = null;
  const chatKeys = await ensureChatKeys();
  const publicJwk = chatKeys ? chatKeys.publicJwk : null;
  if (!snap.exists()) {
    profile = {
      uid,
      username: usernameFallback,
      friendCode: randomAlphaNum(6),
      countryId: "",
      countryName: "",
      countryCode: "",
      pendingCountryId: "",
      pendingCountryName: "",
      pendingCountryCode: "",
      membershipState: "solo",
      countryModeEnabled: false,
      chatPublicJwk: publicJwk,
    };
    await store.setDoc(ref, {
      ...profile,
      createdAt: store.serverTimestamp(),
      updatedAt: store.serverTimestamp(),
    });
  } else {
    profile = snap.data();
    if (normalizeMembershipState(profile.membershipState) === "deleted") {
      firebaseState.userProfile = {
        ...profile,
        membershipState: "deleted",
        pendingCountryId: String(profile.pendingCountryId || ""),
        pendingCountryName: String(profile.pendingCountryName || ""),
        pendingCountryCode: String(profile.pendingCountryCode || ""),
      };
      updateAuthUi();
      return firebaseState.userProfile;
    }
    const patch = {};
    if (!profile.username) patch.username = usernameFallback;
    if (!profile.friendCode) patch.friendCode = randomAlphaNum(6);
    if (!Object.prototype.hasOwnProperty.call(profile, "countryModeEnabled")) patch.countryModeEnabled = false;
    if (!profile.countryId) patch.countryId = "";
    if (!profile.countryName) patch.countryName = "";
    if (!profile.countryCode) patch.countryCode = "";
    if (typeof profile.pendingCountryId !== "string") patch.pendingCountryId = "";
    if (typeof profile.pendingCountryName !== "string") patch.pendingCountryName = "";
    if (typeof profile.pendingCountryCode !== "string") patch.pendingCountryCode = "";
    const membershipState = inferMembershipState(profile);
    if (normalizeMembershipState(profile.membershipState) !== membershipState) {
      patch.membershipState = membershipState;
    }
    if (publicJwk && JSON.stringify(profile.chatPublicJwk || null) !== JSON.stringify(publicJwk)) {
      patch.chatPublicJwk = publicJwk;
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = store.serverTimestamp();
      await store.updateDoc(ref, patch);
      profile = { ...profile, ...patch };
    }
  }
  profile = {
    ...profile,
    membershipState: inferMembershipState(profile),
    pendingCountryId: String(profile.pendingCountryId || ""),
    pendingCountryName: String(profile.pendingCountryName || ""),
    pendingCountryCode: String(profile.pendingCountryCode || ""),
  };
  firebaseState.userProfile = profile;
  updateAuthUi();
  return profile;
}

authChip.onclick = () => {
  closeSettingsPopover();
  closeTopPopovers("auth-popover");
  authPopover.classList.toggle("open");
};
function authErrorHint(code) {
  if (code === "auth/unauthorized-domain") {
    return "Add localhost to Firebase Auth authorized domains.";
  }
  if (code === "auth/operation-not-allowed") {
    return "Enable this provider in Firebase Authentication > Sign-in method.";
  }
  if (code === "auth/configuration-not-found") {
    return "Firebase Auth is not provisioned. In Firebase Console open Authentication, click Get started, then enable Google/GitHub.";
  }
  if (code === "auth/popup-blocked") {
    return "Allow popups for localhost, or use redirect sign-in fallback.";
  }
  if (code === "auth/popup-closed-by-user") {
    return "Popup closed before completion; trying redirect sign-in may help.";
  }
  if (code === "auth/cancelled-popup-request") {
    return "Another popup was already open. Retry once.";
  }
  if (code === "auth/auth-domain-config-required") {
    return "Auth domain config is missing or invalid.";
  }
  if (code === "auth/network-request-failed") {
    return "Network failure during auth flow.";
  }
  return "";
}
function isPopupHostileRuntime() {
  const ua = (navigator.userAgent || "").toLowerCase();
  return ua.includes("wv") ||
    ua.includes("fban") ||
    ua.includes("fbav") ||
    ua.includes("instagram") ||
    ua.includes("line/") ||
    ua.includes("electron") ||
    ua.includes("codex");
}
async function signInWithProvider(kind) {
  if (!isCloudModeEnabled()) setCloudModeChoice("cloud");
  const ready = await ensureFirebaseReady();
  if (!ready || !firebaseState.auth || !firebaseState.sdk) return;
  const provider = kind === "github"
    ? new firebaseState.sdk.auth.GithubAuthProvider()
    : new firebaseState.sdk.auth.GoogleAuthProvider();
  const label = kind === "github" ? "GitHub" : "Google";
  const shouldRedirectFirst = isPopupHostileRuntime() || !firebaseState.initialized;
  if (shouldRedirectFirst) {
    authStatus.textContent = label + " sign-in via redirect...";
    await firebaseState.sdk.auth.signInWithRedirect(firebaseState.auth, provider);
    return;
  }
  try {
    await firebaseState.sdk.auth.signInWithPopup(firebaseState.auth, provider);
    return;
  } catch (err) {
    const code = (err && err.code) ? String(err.code) : "";
    const hint = authErrorHint(code);
    const message = err && err.message ? String(err.message) : "";
    authStatus.textContent = label + " popup failed" + (code ? " (" + code + ")" : "") +
      (hint ? " — " + hint : "");
    if (message && !code) authStatus.textContent += " — " + message;
    const fatal = new Set([
      "auth/unauthorized-domain",
      "auth/operation-not-allowed",
      "auth/auth-domain-config-required",
    ]);
    if (!fatal.has(code)) {
      authStatus.textContent += " Redirecting...";
      await firebaseState.sdk.auth.signInWithRedirect(firebaseState.auth, provider);
      return;
    }
  }
}
cloudLocalModeBtn.onclick = () => setCloudModeChoice("local");
cloudEnableModeBtn.onclick = () => setCloudModeChoice("cloud");
authGoogleBtn.onclick = () => signInWithProvider("google");
authGithubBtn.onclick = () => signInWithProvider("github");
authSignoutBtn.onclick = async () => {
  try {
    if (!firebaseState.auth || !firebaseState.sdk) return;
    await firebaseState.sdk.auth.signOut(firebaseState.auth);
  } catch (err) {
    authStatus.textContent = "Sign-out failed: " + (err.message || err);
  }
};
updateAuthUi();
bootFirebaseIfCloudMode();

/* Onboarding */
try {
const onboardOverlay = $("onboard-overlay");
const onboardTitle = $("onboard-title");
const onboardBody = $("onboard-body");
const onboardProgress = $("onboard-progress");
const onboardBack = $("onboard-back");
const onboardSkip = $("onboard-skip");
const onboardNext = $("onboard-next");
const onboardProviderActions = $("onboard-provider-actions");
const onboardCloudActions = $("onboard-cloud-actions");
const onboardLocalMode = $("onboard-local-mode");
const onboardCloudMode = $("onboard-cloud-mode");
const onboardingStorageKey = "goblintown.onboarding.v3";
const onboardingSteps = [
  {
    title: "AI Autopilot Tank",
    body: "This is the landing surface. Codex can configure rites with harness tokens right away; choose a local provider only when you want the Tank to spend your own provider.",
    providerChoice: true,
    targetId: "tank",
  },
  {
    title: "Choose Your Town",
    body: "Stay Local keeps this Goblintown on your machine. Goblintown Cloud adds SSO, friend codes, discovery, group chats, and shared country metadata through the official cloud backend.",
    cloudChoice: true,
  },
  {
    title: "Navigation Sidebar",
    body: "This sidebar keeps the main paths close: new rites, recent rite shortcuts, imports, and settings.",
    targetId: "ops-sidebar",
  },
  {
    title: "Start a Rite",
    body: "Use New Rite for direct execution, or Plan to decompose larger work before running.",
    targetId: "btn-rite",
  },
  {
    title: "Provider Settings",
    body: "Choose your local provider, set model slots, and store an API key in the local secret file.",
    targetId: "btn-sidebar-settings",
    popover: "provider",
  },
  {
    title: "You are ready",
    body: "Call the Goblintown plugin to open this Tank, then let Codex drive rites, plans, setup, imports, and inspection from the sidecar.",
    targetId: "tank",
  },
];
let onboardingIndex = 0;
let onboardingFocusEl = null;
function setTopPopover(name) {
  closeSettingsPopover();
  providerPopover.classList.remove("open");
  if (name === "provider") providerPopover.classList.add("open");
}
function clearOnboardingFocus() {
  if (onboardingFocusEl) onboardingFocusEl.classList.remove("onboard-focus");
  onboardingFocusEl = null;
}
function renderOnboardingStep() {
  const step = onboardingSteps[onboardingIndex];
  if (!step) return;
  const isProviderChoice = step.providerChoice === true;
  const isCloudChoice = step.cloudChoice === true;
  setTopPopover(step.popover || "");
  clearOnboardingFocus();
  const focusEl = step.targetId ? $(step.targetId) : null;
  if (focusEl) {
    onboardingFocusEl = focusEl;
    onboardingFocusEl.classList.add("onboard-focus");
    onboardingFocusEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  onboardTitle.textContent = step.title;
  onboardBody.textContent = step.body;
  onboardProgress.textContent = isCloudChoice
    ? "First run choice"
    : isProviderChoice
      ? "Choose an API"
      : "Step " + onboardingIndex + " of " + (onboardingSteps.length - 1);
  onboardProviderActions.classList.toggle("open", isProviderChoice);
  onboardCloudActions.classList.toggle("open", isCloudChoice);
  onboardBack.parentElement.style.display = isCloudChoice ? "none" : "flex";
  onboardBack.disabled = onboardingIndex <= 0 || (onboardingIndex <= 2 && readCloudModeChoice() !== "");
  onboardNext.textContent = onboardingIndex === onboardingSteps.length - 1 ? "Finish" : "Next";
}
function readLocalOnboardingDone() {
  try { return localStorage.getItem(onboardingStorageKey) === "done"; } catch { return false; }
}
async function saveOnboardingDone() {
  try { localStorage.setItem(onboardingStorageKey, "done"); } catch {}
  try {
    await fetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
  } catch {}
}
async function readOnboardingDone() {
  const localDone = readLocalOnboardingDone();
  try {
    const r = await fetch("/api/onboarding");
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.done === true) {
      try { localStorage.setItem(onboardingStorageKey, "done"); } catch {}
      return true;
    }
    if (r.ok && localDone) void saveOnboardingDone();
  } catch {}
  return localDone;
}
function closeOnboarding(markDone) {
  clearOnboardingFocus();
  setTopPopover("");
  onboardOverlay.classList.remove("open");
  if (markDone) {
    void saveOnboardingDone();
  }
}
async function maybeStartOnboarding() {
  const params = new URLSearchParams(window.location.search);
  const forced = params.get("onboarding") === "1";
  const done = await readOnboardingDone();
  if (done && !forced) return;
  onboardingIndex = 0;
  onboardOverlay.classList.add("open");
  renderOnboardingStep();
}
onboardBack.onclick = () => {
  if (onboardingIndex <= 0) return;
  if (onboardingIndex <= 2 && readCloudModeChoice() !== "") return;
  onboardingIndex -= 1;
  renderOnboardingStep();
};
onboardNext.onclick = () => {
  if (onboardingIndex >= onboardingSteps.length - 1) {
    closeOnboarding(true);
    return;
  }
  onboardingIndex += 1;
  renderOnboardingStep();
};
onboardSkip.onclick = () => closeOnboarding(true);
async function chooseOnboardingProvider(preset) {
  if (preset === "custom") {
    closeOnboarding(false);
    showSettingsSurface();
    showSettingsSection("api");
    setTimeout(() => providerPreset.focus(), 30);
    return;
  }
  await loadProviderMenu();
  providerPreset.value = preset;
  providerPreset.onchange();
  providerStatus.textContent = "Saving " + (providerById(preset)?.label || preset) + "...";
  try {
    const r = await fetch("/api/provider", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildProviderPayload()),
    });
    if (!r.ok) throw new Error(await r.text());
    applyProviderPayload(await r.json());
    onboardingIndex = readCloudModeChoice() ? 2 : 1;
    renderOnboardingStep();
  } catch (err) {
    providerStatus.textContent = "Provider save failed: " + (err.message || err);
    showSettingsSurface();
    showSettingsSection("api");
  }
}
onboardProviderActions.querySelectorAll("[data-onboard-provider]").forEach((button) => {
  button.addEventListener("click", () => chooseOnboardingProvider(button.getAttribute("data-onboard-provider") || "openai"));
});
onboardLocalMode.onclick = () => {
  setCloudModeChoice("local");
  onboardingIndex = 2;
  renderOnboardingStep();
};
onboardCloudMode.onclick = () => {
  setCloudModeChoice("cloud");
  onboardingIndex = 2;
  renderOnboardingStep();
};
setTimeout(maybeStartOnboarding, 120);
} catch (err) {
  console.error("onboarding-ui-init-failed", err);
}

/* Bubbles */
const MAX_BUBBLES = 6;
const BUBBLE_GAP = 8;
const activeBubbles = [];

function rectsOverlap(a, b, gap) {
  const g = gap || 0;
  return !(
    a.right + g <= b.left ||
    a.left >= b.right + g ||
    a.bottom + g <= b.top ||
    a.top >= b.bottom + g
  );
}

function bubbleOverlapArea(a, b) {
  const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return x * y;
}

function clampBubbleRect(left, top, width, height, tankRect) {
  const x = Math.max(8, Math.min(tankRect.width - width - 8, left));
  const y = Math.max(8, Math.min(tankRect.height - height - 8, top));
  return { left: x, top: y, right: x + width, bottom: y + height, width, height };
}

function getBubbleLayoutItems() {
  const seen = new Set();
  const items = [];
  const add = (el) => {
    if (!el || !el.isConnected || seen.has(el)) return;
    const target = el.__bubbleTarget;
    if (!target || !target.isConnected) return;
    seen.add(el);
    items.push({
      el,
      target,
      preferredWidth: el.__preferredWidth || 220,
    });
  };
  activeBubbles.forEach(add);
  Object.values(thinkingBubbles).forEach(add);
  return items;
}

function bubbleCandidatesForTarget(cx, targetTop, targetBottom, bw, bh, tankRect) {
  const above = targetTop - bh - 14;
  const below = targetBottom + 14;
  const candidates = [
    { left: cx - bw / 2, top: above, tail: "bc" },
    { left: cx - bw - 18, top: above - 6, tail: "br" },
    { left: cx + 18, top: above - 6, tail: "bl" },
    { left: cx - bw / 2, top: above - bh - BUBBLE_GAP, tail: "bc" },
    { left: cx - bw - 18, top: above - bh - BUBBLE_GAP, tail: "br" },
    { left: cx + 18, top: above - bh - BUBBLE_GAP, tail: "bl" },
    { left: cx - bw / 2, top: below, tail: "tc" },
    { left: cx - bw - 18, top: below + 6, tail: "tc" },
    { left: cx + 18, top: below + 6, tail: "tl" },
  ];
  const lanes = [
    cx - bw / 2,
    cx - bw - 18,
    cx + 18,
    tankRect.width / 2 - bw / 2,
    8,
    tankRect.width - bw - 8,
  ];
  const step = Math.max(42, Math.min(72, bh + BUBBLE_GAP));
  for (const left of lanes) {
    for (let top = Math.max(8, above); top >= 8; top -= step) {
      candidates.push({ left, top, tail: "bc" });
    }
    for (let top = Math.max(8, below); top <= tankRect.height - bh - 8; top += step) {
      candidates.push({ left, top, tail: "tc" });
    }
  }
  return candidates;
}

function placeBubbleAvoidingOverlap(item, placed, tankRect) {
  const b = item.el;
  const creatureEl = item.target;
  const cRect = creatureEl.getBoundingClientRect();
  const cx = cRect.left - tankRect.left + cRect.width / 2;
  const targetTop = cRect.top - tankRect.top;
  const targetBottom = cRect.bottom - tankRect.top;
  const bw = Math.min(item.preferredWidth || b.offsetWidth || 220, tankRect.width - 16);
  b.style.width = bw + "px";
  const bh = b.offsetHeight || 56;
  const candidates = bubbleCandidatesForTarget(cx, targetTop, targetBottom, bw, bh, tankRect)
    .map((candidate) => ({
      rect: clampBubbleRect(candidate.left, candidate.top, bw, bh, tankRect),
      tail: candidate.tail,
    }));

  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const collides = placed.some((rect) => rectsOverlap(candidate.rect, rect, BUBBLE_GAP));
    if (!collides) {
      best = candidate;
      break;
    }
    const overlap = placed.reduce((sum, rect) => sum + bubbleOverlapArea(candidate.rect, rect), 0);
    const distance = Math.abs(candidate.rect.left + bw / 2 - cx) + Math.abs(candidate.rect.bottom - targetTop);
    const score = overlap * 1000 + distance;
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  b.style.left = best.rect.left + "px";
  b.style.top = best.rect.top + "px";
  b.dataset.tail = best.tail;
  placed.push(best.rect);
}

function layoutBubbleLayer() {
  const tankRect = tank.getBoundingClientRect();
  if (!tankRect.width || !tankRect.height) return;
  const placed = [];
  for (const item of getBubbleLayoutItems()) {
    placeBubbleAvoidingOverlap(item, placed, tankRect);
  }
}

function positionBubbleAboveTarget(b, creatureEl, preferredWidth) {
  b.__bubbleTarget = creatureEl;
  b.__preferredWidth = preferredWidth || 220;
  layoutBubbleLayer();
}
function dispatchBubble(creatureEl, text, kind, lifetime) {
  if (!creatureEl) return;
  kind = kind || "say";
  lifetime = lifetime || 4400;

  const b = document.createElement("div");
  b.className = "bubble kind-" + kind;
  b.textContent = text;
  bubbleLayer.appendChild(b);
  positionBubbleAboveTarget(b, creatureEl, 200);

  activeBubbles.push(b);
  if (activeBubbles.length > MAX_BUBBLES) {
    const old = activeBubbles.shift();
    old.style.animation = "bubble-out 0.3s ease-in forwards";
    setTimeout(() => {
      old.remove();
      layoutBubbleLayer();
    }, 350);
  }
  layoutBubbleLayer();
  setTimeout(() => {
    b.remove();
    const i = activeBubbles.indexOf(b);
    if (i >= 0) activeBubbles.splice(i, 1);
    layoutBubbleLayer();
  }, lifetime + 400);
}

window.addEventListener("resize", layoutBubbleLayer);

/* Animations w/ variance */
function setState(id, state) {
  const el = $(id);
  if (!el) return;
  el.dataset.state = state;
  if (id === "c-pigeon") applyPigeonStateVisual(state);
  if (id === "c-raccoon") applyRaccoonStateVisual(state);
}
function playVariantAnim(id, variants, ms, varsObj) {
  const el = $(id);
  variants.forEach(v => el.classList.remove(v));
  if (varsObj) Object.keys(varsObj).forEach(k => el.style.setProperty(k, varsObj[k]));
  void el.offsetWidth;
  const chosen = pick(variants);
  el.classList.add(chosen);
  setTimeout(() => el.classList.remove(chosen), ms);
}
function pounceVariant() {
  playVariantAnim("c-gremlin", ["pounce-a","pounce-b","pounce-c"], 1100, {
    "--px": -irand(150, 230) + "px", "--py": irand(80, 140) + "px"
  });
}
function stompVariant() { playVariantAnim("c-ogre", ["stomp-a","stomp-b"], 1500); }
function scurryVariant() {
  const dir = Math.random() < 0.5 ? -1 : 1;
  const sx = dir * irand(180, 260);
  playRaccoonScurry(dir < 0 ? "left" : "right");
  playVariantAnim("c-raccoon", ["scurry-a","scurry-b"], 1800, {
    "--sx": sx + "px", "--sy": -irand(40, 80) + "px"
  });
}
function gavelVariant() { playVariantAnim("c-troll", ["gavel-a","gavel-b"], 1600); }
function hopGoblin(el) {
  if (el.id === "c-pigeon" && pigeonSpriteState.enabled) {
    setPigeonFps(Math.max(14, pigeonSpriteState.fps));
    setTimeout(() => applyPigeonStateVisual(pigeonSpriteState.visualState || "idle"), 480);
    return;
  }
  el.classList.remove("hop");
  void el.offsetWidth;
  el.classList.add("hop");
  setTimeout(() => el.classList.remove("hop"), 700);
}

function setTicker(text, live) {
  tickerText.textContent = text;
  ticker.classList.toggle("live", !!live);
}

const sampleInlineRites = {
  "sample-bounty-72": {
    runId: "sample-bounty-72",
    task: "GitHub issue #72",
    status: "running",
    verdict: "pending",
    lootCount: 4,
    events: [
      { type: "context", agent: "Context", content: "Fetched GitHub issue #72 and extracted README mismatch, manifest values, failing validation path, and open questions." },
      { type: "proposal", agent: "Goblin proposal 1", content: "Patch manifest defaults or README contract, then add a validation error that names the exact stale slot conflict." },
      { type: "critique", agent: "Review", content: "Do not only update docs. The CLI should explain why all markets fail and preserve compatibility for existing configs." },
      { type: "transcript", agent: "Full transcript continues", content: "Every event, model answer, critique, verdict, and final artifact remains readable here. No snippet-only run view." },
    ],
  },
  "sample-provider-setup-audit": {
    runId: "sample-provider-setup-audit",
    task: "Provider setup audit",
    status: "ready",
    verdict: "queued",
    lootCount: 0,
    events: [
      { type: "setup", agent: "Setup", content: "Audit OpenAI, DeepSeek, LM Studio, Ollama, Anthropic, and Add New provider routes from the walkthrough." },
    ],
  },
  "sample-tank-ui-simplification": {
    runId: "sample-tank-ui-simplification",
    task: "Tank UI simplification",
    status: "ready",
    verdict: "queued",
    lootCount: 0,
    events: [
      { type: "design", agent: "UI", content: "Keep the Tank inline inside the selected rite. No separate right utility panel." },
    ],
  },
};

function eventText(event) {
  if (!event) return "";
  if (typeof event === "string") return event;
  return event.content || event.text || event.message || event.output || event.error || JSON.stringify(event, null, 2);
}

function eventTitle(event, index) {
  if (!event || typeof event === "string") return "Event " + (index + 1);
  return event.agent || event.creature || event.role || event.type || event.kind || ("Event " + (index + 1));
}

function setSidebarSelection(kind, id) {
  document.querySelectorAll("[data-surface-kind]").forEach((button) => {
    const matchesKind = button.getAttribute("data-surface-kind") === kind;
    const matchesId = kind === "chat"
      ? button.getAttribute("data-chat-id") === id
      : button.getAttribute("data-run-id") === id;
    button.classList.toggle("active", matchesKind && matchesId);
  });
}

function showSidecarSurface() {
  if (${autopilot}) return;
  setSidebarSettingsMode(false);
  $("chat-main").classList.remove("settings-active");
  $("sidecar-surface").hidden = false;
  $("chat-thread").classList.add("surface-hidden");
  $("root-rite-surface").hidden = true;
  $("settings-surface").hidden = true;
  setSurfaceMode("sidecar");
}

function showRiteSurface() {
  setSidebarSettingsMode(false);
  ${autopilot ? `
  tank.classList.add("chat-mode");
  tank.classList.add("sidecar-mode");
` : ""}
  $("chat-main").classList.remove("settings-active");
  $("sidecar-surface").hidden = true;
  $("chat-thread").classList.add("surface-hidden");
  $("root-rite-surface").hidden = false;
  $("settings-surface").hidden = true;
}

function setSidebarSettingsMode(open) {
  $("ops-sidebar").classList.toggle("settings-mode", !!open);
  settingsSidebarPanel.hidden = !open;
}

let settingsImportRecords = [];
const settingsEmbeddedPanelIds = {
  account: "auth-popover",
  api: "provider-popover",
  reset: "settings-reset-panel",
};

function clearSettingsEmbeddedPanel() {
  const dock = $("settings-panel-dock");
  document.querySelectorAll(".settings-embedded").forEach((panel) => {
    panel.classList.remove("settings-embedded", "open");
    panel.removeAttribute("data-settings-embedded");
    panel.setAttribute("aria-hidden", "true");
    dock.appendChild(panel);
  });
  if (resetChip) resetChip.setAttribute("aria-expanded", "false");
}

function settingsSectionHtml(section) {
  const labels = {
    account: ["Account", "Sign in, cloud mode, and collaboration identity."],
    api: ["API", "LLM providers, model routing, and custom provider workflows."],
    reset: ["Reset", "Asteroid Mode and local/cloud cleanup controls."],
  };
  if (section === "imports") {
    return [
      "<h2>Import Records</h2>",
      "<p>Scan Codex sessions, ChatGPT exports, or a folder of chat records, then import them into searchable Hoard memory.</p>",
      "<div class=\\"settings-surface-form\\">",
      "<select id=\\"settings-import-source\\"><option value=\\"codex\\">Codex sessions</option><option value=\\"chatgpt\\">ChatGPT export</option><option value=\\"folder\\">Folder</option></select>",
      "<input id=\\"settings-import-path\\" placeholder=\\"Optional path for export or folder\\" />",
      "<input id=\\"settings-import-query\\" placeholder=\\"Optional filter text\\" />",
      "<div class=\\"settings-surface-actions\\">",
      "<button id=\\"settings-import-scan\\" type=\\"button\\">Scan</button>",
      "<button id=\\"settings-import-all\\" type=\\"button\\">Import All</button>",
      "</div>",
      "<div class=\\"settings-import-results\\" id=\\"settings-import-results\\">Ready to scan previous chats.</div>",
      "</div>",
    ].join("");
  }
  const [title, body] = labels[section] || labels.account;
  return "<h2>" + title + "</h2><p>" + body + "</p>";
}

function wireSettingsPanel(section) {
  const embeddedId = settingsEmbeddedPanelIds[section];
  if (embeddedId) {
    const panel = $(embeddedId);
    if (panel) {
      const target = $("settings-surface-panel");
      target.innerHTML = "";
      target.appendChild(panel);
      panel.classList.add("settings-embedded", "open");
      panel.dataset.settingsEmbedded = "true";
      panel.setAttribute("aria-hidden", "false");
      if (section === "account" && typeof updateAuthUi === "function") updateAuthUi();
      if (section === "api" && typeof loadProviderMenu === "function") void loadProviderMenu();
      if (section === "reset") {
        panel.classList.add("open");
        resetChip.setAttribute("aria-expanded", "true");
      }
    }
    return;
  }
  if (section === "imports") {
    $("settings-import-scan").onclick = () => scanSettingsImports();
    $("settings-import-all").onclick = () => importSettingsRecords(true);
  }
}

function settingsImportPayload() {
  return {
    source: $("settings-import-source").value,
    path: $("settings-import-path").value.trim(),
    query: $("settings-import-query").value.trim(),
    limit: 50,
  };
}

function renderSettingsImportRecords(records) {
  const target = $("settings-import-results");
  if (!records.length) {
    target.textContent = "No matching records found.";
    return;
  }
  target.innerHTML = records.slice(0, 10).map((record) =>
    "<div><code>" + record.id + "</code> " + (record.title || "Untitled chat") + "</div>"
  ).join("");
}

async function scanSettingsImports() {
  const target = $("settings-import-results");
  target.textContent = "Scanning previous chats...";
  const r = await fetch("/api/context/chats/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settingsImportPayload()),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || "chat import scan failed");
  settingsImportRecords = Array.isArray(body.records) ? body.records : [];
  renderSettingsImportRecords(settingsImportRecords);
}

async function importSettingsRecords(all) {
  const target = $("settings-import-results");
  target.textContent = "Importing records...";
  const payload = settingsImportPayload();
  payload.all = !!all;
  if (!all) payload.ids = settingsImportRecords.map((record) => record.id);
  const r = await fetch("/api/context/chats/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || "chat import failed");
  const count = Array.isArray(body.records) ? body.records.length : 0;
  const artifacts = Array.isArray(body.artifacts) ? body.artifacts.length : 0;
  target.textContent = "Imported " + count + " record(s), " + artifacts + " artifact(s).";
}

function showSettingsSection(section) {
  document.querySelectorAll("[data-settings-section]").forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-settings-section") === section);
  });
  clearSettingsEmbeddedPanel();
  $("settings-surface-panel").innerHTML = settingsSectionHtml(section);
  wireSettingsPanel(section);
}

function showSettingsSurface() {
  settingsPopover.classList.toggle("open", false);
  closeResetMenu();
  setSidebarSettingsOpen(false);
  setSidebarSettingsMode(true);
  ${autopilot ? `
  tank.classList.add("chat-mode");
  tank.classList.add("sidecar-mode");
` : `showSidecarMode();`}
  $("chat-main").classList.add("settings-active");
  $("sidecar-surface").hidden = true;
  $("chat-thread").classList.add("surface-hidden");
  $("root-rite-surface").hidden = true;
  $("settings-surface").hidden = false;
  setSurfaceMode("settings");
  showSettingsSection("account");
}

settingsSidebarBack.onclick = () => {
  setSidebarSettingsMode(false);
  $("chat-main").classList.remove("settings-active");
  ${autopilot ? `showTankMode()` : `showSidecarMode();
  showSidecarSurface()`};
};

function renderInlineRite(record) {
  const events = Array.isArray(record.events) ? record.events : [];
  $("root-rite-title").textContent = record.task || record.runId || "Selected rite";
  $("root-rite-kicker").textContent = record.done ? "Completed rite" : "Rite";
  $("root-rite-meta").textContent = record.runId ? "Run " + record.runId : "Selected from Rites";
  $("root-rite-export").href = record.runId ? "/runs#" + encodeURIComponent(record.runId) : "/runs";
  $("root-rite-resume").dataset.runId = record.runId || "";

  const stats = $("root-rite-stats");
  stats.innerHTML = "";
  [
    ["Status", record.status || (record.done ? "done" : "running")],
    ["Task", record.task || "selected rite"],
    ["Loot", String(record.lootCount || (Array.isArray(record.lootIds) ? record.lootIds.length : 0)) + " drops"],
    ["Verdict", record.verdict || (record.done ? "complete" : "pending")],
  ].forEach(([label, value]) => {
    const stat = document.createElement("div");
    stat.className = "rite-stat";
    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = value;
    stat.append(labelNode, valueNode);
    stats.appendChild(stat);
  });

  const live = $("root-rite-live");
  live.querySelector("p").textContent = record.done
    ? "This rite is complete. Its full discussion is preserved below."
    : "This rite is selected. Live tool output and Tank progress stay inline here while it runs.";

  const discussion = $("root-rite-discussion");
  discussion.innerHTML = "<h3>Discussion</h3>";
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "rite-event rite-empty";
    empty.textContent = "No transcript events are stored for this rite yet.";
    discussion.appendChild(empty);
    return;
  }
  events.forEach((event, index) => {
    const item = document.createElement("article");
    item.className = "rite-event";
    const title = document.createElement("strong");
    title.className = "rite-event-title";
    title.textContent = eventTitle(event, index);
    const body = document.createElement("div");
    body.className = "rite-event-body";
    body.textContent = eventText(event);
    item.append(title, body);
    discussion.appendChild(item);
  });
}

async function loadInlineRite(runId) {
  if (sampleInlineRites[runId]) {
    renderInlineRite(sampleInlineRites[runId]);
    return;
  }
  const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "?full=1");
  const record = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(record.error || "failed to load rite");
  renderInlineRite(record);
}

function selectSidebarSurface(kind, id) {
  showSidecarMode();
  setSidebarSelection(kind, id);
  if (kind === "rite") {
    showRiteSurface();
    setRootChatStatus("ready", "rite selected");
    loadInlineRite(id).catch((err) => {
      $("root-rite-discussion").innerHTML = "<h3>Discussion</h3>";
      const node = document.createElement("div");
      node.className = "rite-event rite-empty";
      node.textContent = chatErrorMessage(err);
      $("root-rite-discussion").appendChild(node);
    });
    return;
  }
  showSidecarSurface();
  setRootChatStatus("ready");
}

function showSidecarMode() {
  if (${autopilot}) { showTankMode(); return; }
  tank.classList.add("chat-mode");
  tank.classList.add("sidecar-mode");
  setSurfaceMode("sidecar");
  setLaunchButtonsDisabled(false);
}

function showTankMode() {
  tank.classList.remove("chat-mode");
  tank.classList.remove("sidecar-mode");
  setSurfaceMode("rite");
}

function appendRootChatMessage(role, content, opts) {
  const thread = $("chat-thread");
  const node = document.createElement("div");
  node.className = "chat-message " + role;
  const label = document.createElement("span");
  label.className = "chat-role";
  label.textContent = role === "user" ? "you" : role === "system" ? "goblintown" : "single goblin";
  node.appendChild(label);
  node.appendChild(document.createTextNode(content));
  if (opts && opts.href) {
    const link = document.createElement("a");
    link.href = opts.href;
    link.textContent = " Open";
    link.style.marginLeft = "0.35rem";
    node.appendChild(link);
  }
  thread.appendChild(node);
  thread.scrollTop = thread.scrollHeight;
  return node;
}

function chatPersonaPick(kind) {
  const options = CHAT_PERSONA[kind] || [];
  if (!options.length) return "";
  return options[rootChatMessages.length % options.length];
}

function setRootChatStatus(kind, detail) {
  const phrase = chatPersonaPick(kind) || kind;
  $("root-chat-status").textContent = detail ? phrase + " · " + detail : phrase;
}

function chatErrorMessage(err) {
  const message = err && err.message ? err.message : String(err);
  return chatPersonaPick("errorPrefix") + ": " + message;
}

function resetRootChat() {
  const thread = $("chat-thread");
  showSidecarSurface();
  rootChatMessages.splice(0, rootChatMessages.length);
  thread.innerHTML = "";
  appendRootChatMessage(
    "assistant",
    CHAT_PERSONA.intro,
  );
  setRootChatOffer(null);
  setRootChatStatus("ready");
  $("root-chat-input").value = "";
}

function setRootChatOffer(nextOffer) {
  const offer = $("root-chat-offer");
  const text = $("root-chat-offer-text");
  rootChatOfferedTask = nextOffer && nextOffer.task ? nextOffer.task : "";
  if (!rootChatOfferedTask) {
    offer.classList.remove("open");
    return;
  }
  text.textContent = nextOffer.requested
    ? "Goblintown requested. Start the full pack for this prompt?"
    : "This looks complex enough for the full Goblintown pack.";
  offer.classList.add("open");
}

function clearRiteChoiceRows() {
  document.querySelectorAll(".rite-choice-row").forEach((row) => row.remove());
}

function startNewRiteChatFlow() {
  setRootChatOffer(null);
  openRiteForm(false);
}

function handleRiteChoice(choice) {
  setRootChatOffer(null);
  clearRiteChoiceRows();
  setRootChatStatus("ready");
  switch (choice) {
    case "regular":
      openRiteForm(false);
      break;
    case "plan":
      openRiteForm(true);
      break;
    default:
      openRiteForm(false);
  }
}

async function startGoblintownFromChat(task) {
  const cleanTask = (task || "").trim();
  if (!cleanTask) return;
  const runButton = $("root-chat-offer-run");
  runButton.disabled = true;
  setRootChatStatus("riteStarting");
  showTankMode();
  hideResumePanel();
  lastTask = cleanTask;
  setLaunchButtonsDisabled(true);
  setSurfaceMode("rite running");
  resetRunStage(false, 3);
  setTicker("POSTing rite ...", true);
  try {
    const startRes = await fetch("/api/rite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: cleanTask,
        packSize: 3,
        personality: $("root-chat-personality").value,
        remember: true,
      }),
    });
    const body = await startRes.json().catch(() => ({}));
    if (!startRes.ok) throw new Error(body.error || startRes.statusText);
    setRootChatOffer(null);
    setTicker("rite " + body.runId + " started", true);
    rememberActiveRun(body.runId, false);
    history.replaceState(null, "", "/?run=" + encodeURIComponent(body.runId));
    openStream(body.runId, false);
  } catch (err) {
    $("root-chat-status").textContent = chatErrorMessage(err);
    showSidecarMode();
  } finally {
    runButton.disabled = false;
  }
}

$("btn-regular-rite").onclick = () => openRiteForm(false);

document.querySelectorAll("[data-surface-kind]").forEach((button) => {
  button.addEventListener("click", () => {
    const kind = button.getAttribute("data-surface-kind") || "chat";
    const id = kind === "chat" ? button.getAttribute("data-chat-id") : button.getAttribute("data-run-id");
    if (!id) return;
    history.replaceState(null, "", kind === "rite" ? "/?run=" + encodeURIComponent(id) : "/");
    selectSidebarSurface(kind, id);
  });
});

$("root-rite-resume").onclick = () => {
  const runId = $("root-rite-resume").dataset.runId || "";
  if (!runId || sampleInlineRites[runId]) {
    openRiteForm(false);
    return;
  }
  showTankMode();
  openStream(runId, false, { attach: true });
};

function setPersonalityMenuOpen(open) {
  $("personality-picker").classList.toggle("open", !!open);
}

$("root-chat-personality-label").onclick = () => {
  setPersonalityMenuOpen(!$("personality-picker").classList.contains("open"));
};

document.querySelectorAll(".personality-choice").forEach((button) => {
  button.addEventListener("click", () => {
    const value = button.getAttribute("data-personality") || "goblin_mode";
    $("root-chat-personality").value = value;
    $("root-chat-personality-label").textContent = value;
    document.querySelectorAll(".personality-choice").forEach((choice) => choice.classList.toggle("active", choice === button));
    setPersonalityMenuOpen(false);
  });
});

$("root-chat-input").addEventListener("keydown", (event) => {
  if (event.shiftKey && event.key === "Enter") return;
  if (event.key === "Enter") {
    event.preventDefault();
    $("root-chat-form").requestSubmit();
  }
});

$("root-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("root-chat-input");
  const send = $("root-chat-send");
  const status = $("root-chat-status");
  const content = input.value.trim();
  if (!content) return;
  const userMessage = { role: "user", content };
  rootChatMessages.push(userMessage);
  appendRootChatMessage("user", content);
  input.value = "";
  send.disabled = true;
  setRootChatStatus("thinking");
  setRootChatOffer(null);
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: rootChatMessages,
        personality: $("root-chat-personality").value,
        modelSlot: $("root-chat-model").value === "inherit" ? undefined : $("root-chat-model").value,
        maxOutputTokens: Number($("root-chat-max").value || 900),
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || response.statusText);
    if (!body.message || body.message.role !== "assistant" || !body.message.content) {
      throw new Error(chatPersonaPick("emptyResponse") || "chat returned no assistant message");
    }
    rootChatMessages.push(body.message);
    appendRootChatMessage("assistant", body.message.content);
    const speakingReply = speakRootChatMessage(body.message.content);
    if (body.goblintownOffer && body.goblintownOffer.requested) {
      appendRootChatMessage("system", chatPersonaPick("handoff") + ". " + chatPersonaPick("riteStarting") + "...");
      await startGoblintownFromChat(body.goblintownOffer.task);
    } else {
      setRootChatOffer(body.goblintownOffer);
    }
    if (body.lootId) setRootChatStatus("saved", body.lootId);
    else if (!speakingReply) setRootChatStatus("ready");
  } catch (err) {
    status.textContent = chatErrorMessage(err);
  } finally {
    send.disabled = false;
    input.focus();
    scheduleLiveVoiceRestart();
  }
});

$("root-chat-offer-run").onclick = () => startGoblintownFromChat(rootChatOfferedTask);

/* Goblin pile w/ personality labels (set per goblin from pack:goblin event) */
const goblinByIndex = {};
const goblinByLootId = {};
const specialistByIndex = {};
const specialistByLootId = {};
const goblinImageCache = new Map();

function pickGoblinVariant() {
  const roll = Math.random();
  let cursor = 0;
  for (const entry of GOBLIN_VARIANT_WEIGHTS) {
    cursor += entry.weight;
    if (roll <= cursor) return entry.variant;
  }
  return GOBLIN_VARIANT_WEIGHTS[GOBLIN_VARIANT_WEIGHTS.length - 1].variant;
}

function getGoblinSheet(variant, action) {
  const byVariant = GOBLIN_ACTION_SHEETS[variant] || GOBLIN_ACTION_SHEETS.green;
  return byVariant[action] || byVariant["come-out"];
}

function loadGoblinSheet(src) {
  if (!goblinImageCache.has(src)) {
    goblinImageCache.set(src, loadPigeonSheet(src));
  }
  return goblinImageCache.get(src);
}

function cleanupGoblinSlot(slot) {
  if (!slot) return;
  if (slot.rafId) cancelAnimationFrame(slot.rafId);
  if (slot.actionTimer) clearTimeout(slot.actionTimer);
  if (slot.goHomeTimer) clearTimeout(slot.goHomeTimer);
  slot.rafId = 0;
  slot.actionTimer = 0;
  slot.goHomeTimer = 0;
}

function drawGoblinFrame(slot) {
  if (!slot || !slot.ctx || !slot.canvas || !slot.image) return;
  const order = slot.frameOrder && slot.frameOrder.length ? slot.frameOrder : [0];
  const rawFrame = order[slot.frameCursor % order.length] || 0;
  const frame = Math.max(0, Math.min(rawFrame, slot.frames - 1));
  const frameW = Math.floor(slot.image.naturalWidth / slot.frames);
  const frameH = slot.image.naturalHeight;
  if (!frameW || !frameH) return;

  const dw = slot.canvas.width;
  const dh = slot.canvas.height;
  const scale = Math.min(dw / frameW, dh / frameH);
  const drawW = frameW * scale;
  const drawH = frameH * scale;
  const dx = (dw - drawW) / 2;
  const dy = dh - drawH;

  slot.ctx.clearRect(0, 0, dw, dh);
  slot.ctx.imageSmoothingEnabled = false;
  slot.ctx.drawImage(slot.image, frame * frameW, 0, frameW, frameH, dx, dy, drawW, drawH);
}

function tickGoblinAction(slot, ts) {
  if (!slot || !slot.image) return;
  if (!slot.lastTickMs) slot.lastTickMs = ts;
  const delta = Math.max(0, ts - slot.lastTickMs);
  slot.lastTickMs = ts;
  const frameMs = 1000 / Math.max(1, slot.fps || 10);
  slot.frameAccumulatorMs += delta;

  while (slot.frameAccumulatorMs >= frameMs) {
    slot.frameAccumulatorMs -= frameMs;
    if (slot.frameCursor < slot.frameOrder.length - 1) {
      slot.frameCursor += 1;
    } else if (slot.loop) {
      slot.frameCursor = 0;
    }
  }

  drawGoblinFrame(slot);
  if (slot.loop || slot.frameCursor < slot.frameOrder.length - 1) {
    slot.rafId = requestAnimationFrame((nextTs) => tickGoblinAction(slot, nextTs));
  } else {
    slot.rafId = 0;
  }
}

async function holdGoblinStanding(slot) {
  if (!slot || slot.wrap.dataset.home === "true") return;
  cleanupGoblinSlot(slot);
  const token = ++slot.actionToken;
  const sheet = getGoblinSheet(slot.variant, "come-out");
  try {
    const image = await loadGoblinSheet(sheet.src);
    if (token !== slot.actionToken) return;
    slot.image = image;
    slot.frames = sheet.frames;
    slot.frameOrder = [sheet.frames - 1];
    slot.frameCursor = 0;
    slot.loop = false;
    slot.el.dataset.action = "standing";
    slot.el.dataset.state = slot.el.dataset.state === "winner" ? "winner" : "idle";
    drawGoblinFrame(slot);
  } catch {
    slot.el.classList.remove("goblin-sprite-animated");
  }
}

async function playGoblinAction(slot, action, options) {
  if (!slot) return;
  options = options || {};
  cleanupGoblinSlot(slot);
  const token = ++slot.actionToken;
  const sheet = getGoblinSheet(slot.variant, action);
  slot.wrap.dataset.home = "false";
  slot.el.dataset.action = action;
  slot.el.dataset.state = options.state || "active";
  try {
    const image = await loadGoblinSheet(sheet.src);
    if (token !== slot.actionToken) return;
    slot.image = image;
    slot.frames = sheet.frames;
    slot.frameOrder = buildLinearFrameOrder(sheet.frames);
    slot.frameCursor = 0;
    slot.frameAccumulatorMs = 0;
    slot.lastTickMs = 0;
    slot.fps = sheet.fps;
    slot.loop = !!options.loop;
    drawGoblinFrame(slot);
    slot.rafId = requestAnimationFrame((ts) => tickGoblinAction(slot, ts));
    const duration = options.durationMs || Math.ceil((sheet.frames / sheet.fps) * 1000);
    slot.actionTimer = setTimeout(() => {
      if (token !== slot.actionToken) return;
      if (options.homeOnEnd) {
        cleanupGoblinSlot(slot);
        slot.wrap.dataset.home = "true";
        slot.wrap.dataset.specialist = "false";
        slot.el.dataset.state = "home";
        slot.tag.textContent = slot.personality || slot.variant;
        clearThinkingBubble("goblin#" + slot.index);
      } else if (options.loop) {
        holdGoblinStanding(slot);
      }
    }, duration + 80);
  } catch {
    slot.el.classList.remove("goblin-sprite-animated");
  }
}

function goHomeGoblinSlot(slot, delayMs) {
  if (!slot || slot.wrap.dataset.home === "true") return;
  if (slot.goHomeTimer) clearTimeout(slot.goHomeTimer);
  const delay = Math.max(0, delayMs || 0);
  slot.goHomeTimer = setTimeout(() => {
    slot.goHomeTimer = 0;
    clearAllTextBubbles();
    playGoblinAction(slot, "go-home", { homeOnEnd: true, state: "idle" });
  }, delay);
}

function bringGoblinOutForTurn(slot, action, options) {
  if (!slot) return;
  options = options || {};
  const state = options.state || "active";
  const actionDuration = options.durationMs || 1600;
  const homeDelay = typeof options.homeAfterMs === "number" ? options.homeAfterMs : 2600;
  const shouldLoop = !!options.loop && homeDelay < 0;
  const playTurnAction = () => {
    if (!slot || slot.wrap.dataset.home === "true") return;
    playGoblinAction(slot, action, { durationMs: actionDuration, loop: shouldLoop, state });
    if (homeDelay >= 0) goHomeGoblinSlot(slot, homeDelay);
  };
  if (slot.wrap.dataset.home === "true") {
    const comeOutDuration = options.comeOutDurationMs || 780;
    playGoblinAction(slot, "come-out", { state, durationMs: comeOutDuration });
    const comeOutToken = slot.actionToken;
    setTimeout(() => {
      if (slot.actionToken !== comeOutToken) return;
      playTurnAction();
    }, comeOutDuration + 90);
  } else {
    playTurnAction();
  }
}

function goHomeAllGoblins(delayMs) {
  clearAllTextBubbles();
  Object.values(goblinByIndex).forEach((slot) => goHomeGoblinSlot(slot, delayMs || 0));
}

let goblinExplosionToken = 0;

function hideGoblinExplosion() {
  goblinExplosionToken += 1;
  if (goblinExplosion) goblinExplosion.classList.remove("active");
  if (goblinExplosionCtx && goblinExplosion) {
    goblinExplosionCtx.clearRect(0, 0, goblinExplosion.width, goblinExplosion.height);
  }
}

function goblinSlotsForSpecialistMapping() {
  const slots = Object.values(goblinByIndex);
  const visible = slots.filter((slot) => slot && slot.wrap.dataset.home !== "true");
  return visible.length ? visible : slots;
}

function specialistSlotForIndex(index) {
  const slots = goblinSlotsForSpecialistMapping();
  if (!slots.length) return null;
  return slots[Math.abs(index || 0) % slots.length];
}

function resetGoblinSpecialistPresentation() {
  hideGoblinExplosion();
  Object.keys(specialistByIndex).forEach(k => delete specialistByIndex[k]);
  Object.keys(specialistByLootId).forEach(k => delete specialistByLootId[k]);
  Object.values(goblinByIndex).forEach((slot) => {
    slot.wrap.dataset.specialist = "false";
    slot.tag.textContent = slot.personality || slot.variant;
  });
}

function markGoblinSpecialists(count) {
  const slots = goblinSlotsForSpecialistMapping();
  if (!slots.length) return;
  const visible = Math.min(Math.max(1, count || 1), slots.length);
  Object.values(goblinByIndex).forEach((slot) => {
    slot.wrap.dataset.specialist = "false";
  });
  Object.keys(specialistByIndex).forEach(k => delete specialistByIndex[k]);
  Object.keys(specialistByLootId).forEach(k => delete specialistByLootId[k]);
  for (let i = 0; i < visible; i++) {
    const slot = specialistSlotForIndex(i);
    if (!slot) continue;
    slot.wrap.dataset.specialist = "true";
    slot.tag.textContent = "specialist";
    if (slot.el.dataset.state !== "winner") slot.el.dataset.state = "active";
    specialistByIndex[i] = slot;
  }
}

async function playGoblinExplosion() {
  if (!goblinExplosion || !goblinExplosionCtx) return;
  const token = ++goblinExplosionToken;
  const sheet = GOBLIN_EXPLOSION_SHEET;
  try {
    const image = await loadGoblinSheet(sheet.src);
    if (token !== goblinExplosionToken) return;
    goblinExplosion.classList.add("active");
    const frameW = image.naturalWidth / sheet.cols;
    const frameH = image.naturalHeight / sheet.rows;
    const drawFrame = (frame) => {
      const col = frame % sheet.cols;
      const row = Math.floor(frame / sheet.cols);
      const dw = goblinExplosion.width;
      const dh = goblinExplosion.height;
      const scale = Math.min(dw / frameW, dh / frameH);
      const drawW = frameW * scale;
      const drawH = frameH * scale;
      const dx = (dw - drawW) / 2;
      const dy = (dh - drawH) / 2;
      goblinExplosionCtx.clearRect(0, 0, dw, dh);
      goblinExplosionCtx.imageSmoothingEnabled = true;
      goblinExplosionCtx.drawImage(
        image,
        col * frameW,
        row * frameH,
        frameW,
        frameH,
        dx,
        dy,
        drawW,
        drawH,
      );
    };
    const frameMs = 1000 / Math.max(1, sheet.fps || 12);
    const startedAt = performance.now();
    const tick = (ts) => {
      if (token !== goblinExplosionToken) return;
      const frame = Math.min(sheet.totalFrames - 1, Math.floor((ts - startedAt) / frameMs));
      drawFrame(frame);
      if (frame < sheet.totalFrames - 1) {
        requestAnimationFrame(tick);
      } else {
        setTimeout(() => {
          if (token === goblinExplosionToken) hideGoblinExplosion();
        }, 180);
      }
    };
    requestAnimationFrame(tick);
  } catch {
    hideGoblinExplosion();
  }
}

function playGoblinSpecialistTransition(count) {
  playGoblinExplosion();
  setTimeout(() => markGoblinSpecialists(count), 260);
}

/* Live "thinking" bubbles (one per slot, updated in place) */
const thinkingBubbles = {};
function resolveThinkingTarget(slot) {
  if (slot === "ogre") return $("c-ogre");
  if (slot === "scribe") return $("c-pigeon");
  if (slot.indexOf("goblin#") === 0) {
    const idx = +slot.slice("goblin#".length);
    return goblinByIndex[idx] ? goblinByIndex[idx].el : null;
  }
  if (slot.indexOf("specialist#") === 0) {
    const idx = +slot.slice("specialist#".length);
    return specialistByIndex[idx] ? specialistByIndex[idx].el : null;
  }
  return null;
}
function updateThinkingBubble(slot, text) {
  const target = resolveThinkingTarget(slot);
  if (!target) return;
  if (slot.indexOf("goblin#") === 0 || slot.indexOf("specialist#") === 0) {
    const idx = +slot.slice("goblin#".length);
    const goblin = slot.indexOf("specialist#") === 0
      ? specialistSlotForIndex(+slot.slice("specialist#".length))
      : goblinByIndex[idx] || goblinByIndex[idx % Math.max(1, Object.keys(goblinByIndex).length)];
    if (goblin && (goblin.wrap.dataset.home === "true" || goblin.el.dataset.action !== "argue")) {
      bringGoblinOutForTurn(goblin, "argue", { durationMs: 1600, homeAfterMs: 2800 });
    } else if (goblin) {
      goHomeGoblinSlot(goblin, 2800);
    }
  }
  let b = thinkingBubbles[slot];
  if (!b) {
    b = document.createElement("div");
    b.className = "think-bubble";
    bubbleLayer.appendChild(b);
    thinkingBubbles[slot] = b;
  }
  const tankRect = tank.getBoundingClientRect();
  // Show tail of streaming text so the bubble doesn't grow unbounded
  const tail = text.length > 240 ? "…" + text.slice(-240) : text;
  b.textContent = tail;
  positionBubbleAboveTarget(b, target, Math.min(280, tankRect.width - 16));
}
function clearThinkingBubble(slot) {
  const b = thinkingBubbles[slot];
  if (b) {
    b.remove();
    delete thinkingBubbles[slot];
    layoutBubbleLayer();
  }
}
function clearAllThinkingBubbles() {
  Object.keys(thinkingBubbles).forEach(clearThinkingBubble);
}

function clearAllTextBubbles() {
  activeBubbles.splice(0).forEach((bubble) => bubble.remove());
  Object.keys(thinkingBubbles).forEach((slot) => {
    const bubble = thinkingBubbles[slot];
    if (bubble) bubble.remove();
    delete thinkingBubbles[slot];
  });
  bubbleLayer.querySelectorAll(".bubble,.think-bubble").forEach((bubble) => bubble.remove());
  layoutBubbleLayer();
}
function renderGoblinSlots(packSize) {
  Object.values(goblinByIndex).forEach(cleanupGoblinSlot);
  hideGoblinExplosion();
  goblinPile.innerHTML = "";
  Object.keys(goblinByIndex).forEach(k => delete goblinByIndex[k]);
  Object.keys(goblinByLootId).forEach(k => delete goblinByLootId[k]);
  Object.keys(specialistByIndex).forEach(k => delete specialistByIndex[k]);
  Object.keys(specialistByLootId).forEach(k => delete specialistByLootId[k]);
  const visible = Math.max(1, Math.floor(packSize || 1));
  for (let i = 0; i < visible; i++) {
    const variant = pickGoblinVariant();
    const wrap = document.createElement("div");
    wrap.className = "goblin-wrap";
    wrap.dataset.home = "true";
    wrap.dataset.specialist = "false";
    const div = document.createElement("div");
    div.className = "creature goblin goblin-sprite-animated";
    div.dataset.state = "home";
    div.dataset.variant = variant;
    div.style.setProperty("--sway-dur", (3 + Math.random() * 2.5).toFixed(2) + "s");
    div.style.setProperty("--sway-x", irand(2,4) + "px");
    div.style.setProperty("--sway-delay", (-Math.random() * 3).toFixed(2) + "s");
    const canvas = document.createElement("canvas");
    canvas.className = "goblin-sprite";
    canvas.width = 128;
    canvas.height = 128;
    canvas.setAttribute("aria-hidden", "true");
    div.appendChild(canvas);
    const emoji = document.createElement("span");
    emoji.className = "emoji";
    emoji.textContent = "👺";
    div.appendChild(emoji);
    const tag = document.createElement("span");
    tag.className = "personality";
    tag.textContent = variant;
    wrap.appendChild(div);
    wrap.appendChild(tag);
    goblinPile.appendChild(wrap);
    goblinByIndex[i] = {
      el: div,
      wrap,
      canvas,
      ctx: canvas.getContext("2d"),
      tag,
      index: i,
      variant,
      lootId: null,
      personality: null,
      image: null,
      frames: 1,
      fps: 10,
      frameOrder: [0],
      frameCursor: 0,
      frameAccumulatorMs: 0,
      lastTickMs: 0,
      rafId: 0,
      actionTimer: 0,
      goHomeTimer: 0,
      actionToken: 0,
      loop: false,
    };
  }
}

function setGoblinAll(state) {
  Object.values(goblinByIndex).forEach(g => g.el.dataset.state = state);
}

function resetCreatures() {
  ["c-raccoon","c-gremlin","c-troll","c-pigeon"].forEach(id => setState(id,"idle"));
  setState("c-ogre","cave");
  goHomeAllGoblins(0);
}

/* First-line snippet helper */
function firstLine(s, max) {
  if (!s) return "";
  const line = s.split(/\\r?\\n/).find(l => l.trim().length > 0) || s.slice(0, max);
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

const lootSnippetCache = new Map();

async function fetchLootSnippet(id, max) {
  const cached = lootSnippetCache.get(id);
  if (typeof cached === "string") {
    return firstLine(cached, max || 80);
  }
  try {
    const r = await fetch("/api/loot/" + id);
    if (!r.ok) return null;
    const loot = await r.json();
    const out = typeof loot.output === "string" ? loot.output : "";
    lootSnippetCache.set(id, out);
    return firstLine(out, max || 80);
  } catch { return null; }
}

/* Result panel */
let lastTask = null;
function showResultPanel(opts) {
  $("result-outcome").textContent = (opts.outcome || "result").replace("_", " ");
  $("result-outcome").className = "result-outcome " + (opts.outcome || "");
  $("result-task").textContent = opts.task || "(unknown task)";
  $("result-task").title = opts.task || "";
  $("result-output").textContent = opts.output || "(no output)";
  $("result-score").textContent = (opts.score != null) ? opts.score.toFixed(2) + " shinies" : "";
  $("result-link").href = opts.riteId ? "/rite/" + opts.riteId : "#";
  $("result-panel").classList.add("open");
}
function hideResultPanel() { $("result-panel").classList.remove("open"); }
$("result-dismiss").onclick = hideResultPanel;

const activeRunStorageKey = "goblintown.activeRun";
const resumePanel = $("resume-panel");
let resumeRecord = null;
let attachedRunId = null;

function rememberActiveRun(runId, isPlan) {
  try {
    localStorage.setItem(activeRunStorageKey, JSON.stringify({
      runId,
      isPlan: !!isPlan,
      at: Date.now(),
    }));
  } catch {}
}

function readRememberedRun() {
  try {
    const raw = localStorage.getItem(activeRunStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.runId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearRememberedRun(runId) {
  try {
    const remembered = readRememberedRun();
    if (!remembered || !runId || remembered.runId === runId) {
      localStorage.removeItem(activeRunStorageKey);
    }
  } catch {}
}

function resetRunStage(isPlan, packSize) {
  hideResultPanel();
  hideDag();
  resetCreatures();
  bubbleLayer.innerHTML = "";
  activeBubbles.length = 0;
  Object.keys(thinkingBubbles).forEach(s => delete thinkingBubbles[s]);
  renderGoblinSlots(isPlan ? 3 : Math.max(1, packSize || 3));
}

function setLaunchButtonsDisabled(disabled) {
  $("btn-rite").disabled = disabled;
  $("btn-plan").disabled = disabled;
}

function runModeFromRecord(record) {
  if (record.mode === "plan") return "plan";
  if (record.mode === "rite") return "rite";
  const events = record.events || [];
  return events.some((e) => typeof e.kind === "string" && e.kind.indexOf("plan:") === 0)
    ? "plan"
    : "rite";
}

function runStatus(record) {
  return record.status || (record.done ? (record.error ? "error" : "done") : "running");
}

function canResumeRecord(record) {
  const status = runStatus(record);
  return !!record.resumable || status === "interrupted" || status === "error";
}

function showResumePanel(record) {
  resumeRecord = record;
  resumePanel.dataset.runId = record.runId;
  resumePanel.dataset.mode = runModeFromRecord(record);
  $("resume-title").textContent =
    runStatus(record) === "interrupted" ? "Interrupted run" : "Run ended with an error";
  const phase = record.checkpoint && record.checkpoint.phase
    ? "Last checkpoint: " + record.checkpoint.phase + ". "
    : "";
  const detail = record.error || record.task || "";
  $("resume-detail").textContent = phase + detail;
  resumePanel.classList.add("open");
}

function hideResumePanel() {
  resumePanel.classList.remove("open");
}

$("resume-dismiss").onclick = hideResumePanel;
$("btn-asteroid").onclick = openAsteroidMode;

async function refreshResumePanel(runId, fallbackIsPlan) {
  try {
    const r = await fetch("/api/runs/" + runId + "?full=1");
    if (!r.ok) return;
    const record = await r.json();
    if (canResumeRecord(record)) {
      showResumePanel(record);
      setLaunchButtonsDisabled(false);
      setSurfaceMode((fallbackIsPlan ? "plan" : "rite") + " · " + runStatus(record));
    }
  } catch {}
}

const asteroidOverlay = $("asteroid-overlay");
const asteroidConfirm = $("asteroid-confirm");
const asteroidArm = $("asteroid-arm");
const asteroidCancel = $("asteroid-cancel");
const asteroidNukeCloud = $("asteroid-nuke-cloud");
const asteroidLocalOnly = $("asteroid-local-only");
const asteroidCloudCancel = $("asteroid-cloud-cancel");
const asteroidStatus = $("asteroid-status");
const asteroidCloudStatus = $("asteroid-cloud-status");
const asteroidCanvas = $("asteroid-canvas");

function setAsteroidBusy(busy) {
  [asteroidArm, asteroidCancel, asteroidNukeCloud, asteroidLocalOnly, asteroidCloudCancel]
    .filter(Boolean)
    .forEach((btn) => { btn.disabled = !!busy; });
  if (!busy && asteroidArm) asteroidArm.disabled = (asteroidConfirm.value || "").trim() !== "ASTEROID";
}

function openAsteroidMode() {
  closeSettingsPopover();
  providerPopover.classList.remove("open");
  $("rite-overlay").classList.remove("open");
  $("onboard-overlay").classList.remove("open");
  asteroidOverlay.classList.remove("cloud-choice", "destroying");
  asteroidOverlay.classList.add("open");
  asteroidOverlay.setAttribute("aria-hidden", "false");
  asteroidConfirm.value = "";
  asteroidStatus.textContent = "";
  asteroidCloudStatus.textContent = "";
  setAsteroidBusy(false);
  setTimeout(() => asteroidConfirm.focus(), 30);
}

function closeAsteroidMode() {
  asteroidOverlay.classList.remove("open", "cloud-choice", "destroying");
  asteroidOverlay.setAttribute("aria-hidden", "true");
  tank.classList.remove("asteroid-destroying");
  asteroidStatus.textContent = "";
  asteroidCloudStatus.textContent = "";
}

function showAsteroidCloudChoice() {
  if ((asteroidConfirm.value || "").trim() !== "ASTEROID") {
    asteroidStatus.textContent = "Type ASTEROID exactly to continue.";
    return;
  }
  asteroidStatus.textContent = "";
  asteroidCloudStatus.textContent = "";
  asteroidOverlay.classList.add("cloud-choice");
}

function clearGoblintownBrowserMemory() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.indexOf("goblintown.") === 0) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playAsteroidObliteration() {
  return new Promise((resolve) => {
    const Matter = window.Matter;
    const rect = tank.getBoundingClientRect();
    tank.classList.add("asteroid-destroying");
    asteroidOverlay.classList.add("destroying");
    if (!Matter || !asteroidCanvas || rect.width < 10 || rect.height < 10) {
      setTimeout(() => {
        tank.classList.remove("asteroid-destroying");
        asteroidOverlay.classList.remove("destroying");
        resolve();
      }, 1100);
      return;
    }

    const engine = Matter.Engine.create();
    engine.gravity.y = 1.1;
    const render = Matter.Render.create({
      canvas: asteroidCanvas,
      engine,
      options: {
        width: rect.width,
        height: rect.height,
        wireframes: false,
        background: "transparent",
        pixelRatio: window.devicePixelRatio || 1,
      },
    });
    const runner = Matter.Runner.create();
    const floor = Matter.Bodies.rectangle(rect.width / 2, rect.height + 18, rect.width + 80, 36, {
      isStatic: true,
      render: { fillStyle: "rgba(98,56,28,0.1)" },
    });
    const bodies = [floor];
    const selectors = [
      ".skyline",
      ".mountains",
      ".banner",
      ".trees",
      ".workshop",
      ".troll-bridge",
      ".raccoon-dump",
      ".hoard",
      ".creature",
      ".goblin-pile .creature",
    ];
    tank.querySelectorAll(selectors.join(",")).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      const x = r.left - rect.left + r.width / 2;
      const y = r.top - rect.top + r.height / 2;
      const body = Matter.Bodies.rectangle(x, y, Math.max(10, r.width), Math.max(10, r.height), {
        frictionAir: 0.025,
        restitution: 0.35,
        render: { fillStyle: "rgba(143,207,82,0.32)", strokeStyle: "rgba(243,160,122,0.65)", lineWidth: 1 },
      });
      Matter.Body.setVelocity(body, { x: rand(-1.6, 1.6), y: rand(-0.5, 0.5) });
      Matter.Body.setAngularVelocity(body, rand(-0.08, 0.08));
      bodies.push(body);
    });
    for (let i = 0; i < 9; i += 1) {
      const radius = rand(12, 32);
      const rock = Matter.Bodies.circle(rand(rect.width * 0.1, rect.width * 0.9), -60 - i * 34, radius, {
        density: 0.02,
        frictionAir: 0.004,
        restitution: 0.18,
        render: { fillStyle: i === 0 ? "#f3a07a" : "#8b4a32", strokeStyle: "#f3df7a", lineWidth: 1 },
      });
      Matter.Body.setVelocity(rock, { x: rand(-4, 4), y: rand(7, 13) });
      bodies.push(rock);
    }
    for (let i = 0; i < 26; i += 1) {
      const shard = Matter.Bodies.polygon(rand(0, rect.width), rand(-180, -20), irand(3, 5), rand(4, 10), {
        frictionAir: 0.02,
        restitution: 0.45,
        render: { fillStyle: "rgba(243,223,122,0.75)" },
      });
      Matter.Body.setVelocity(shard, { x: rand(-5, 5), y: rand(3, 10) });
      bodies.push(shard);
    }
    Matter.Composite.add(engine.world, bodies);
    Matter.Render.run(render);
    Matter.Runner.run(runner, engine);
    setTimeout(() => {
      Matter.Render.stop(render);
      Matter.Runner.stop(runner);
      Matter.World.clear(engine.world, false);
      Matter.Engine.clear(engine);
      const ctx = asteroidCanvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, asteroidCanvas.width, asteroidCanvas.height);
      tank.classList.remove("asteroid-destroying");
      asteroidOverlay.classList.remove("destroying");
      resolve();
    }, 1800);
  });
}

async function writeFirestoreBatches(store, db, rows, apply) {
  let batch = store.writeBatch(db);
  let count = 0;
  for (const row of rows) {
    apply(batch, row);
    count += 1;
    if (count >= 400) {
      await batch.commit();
      batch = store.writeBatch(db);
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

async function docsForQuery(store, queryRef) {
  const snap = await store.getDocs(queryRef);
  return snap.docs;
}

async function nukeCloudAccountData() {
  const ready = await ensureFirebaseReady();
  if (!ready) throw new Error("Firebase is not configured.");
  if (!firebaseState.user || !firebaseState.sdk || !firebaseState.db) {
    throw new Error("Sign in before nuking cloud data, or choose Just Destroy the Town.");
  }
  const store = firebaseState.sdk.store;
  const db = firebaseState.db;
  const uid = firebaseState.user.uid;
  const deletedName = "Deleted account";
  const profile = await ensureFirebaseProfile(true) || {};
  const userRef = store.doc(db, "users", uid);

  const friendDocs = await docsForQuery(
    store,
    store.query(store.collection(db, "users", uid, "friends"), store.limit(500)),
  );
  const friendIds = friendDocs.map((d) => d.id).filter(Boolean);
  await writeFirestoreBatches(store, db, [
    ...friendDocs.map((d) => d.ref),
    ...friendIds.map((friendId) => store.doc(db, "users", friendId, "friends", uid)),
  ], (batch, ref) => batch.delete(ref));

  const friendRequestDocs = [
    ...(await docsForQuery(
      store,
      store.query(store.collection(db, "friendRequests"), store.where("fromUid", "==", uid), store.limit(500)),
    )),
    ...(await docsForQuery(
      store,
      store.query(store.collection(db, "friendRequests"), store.where("toUid", "==", uid), store.limit(500)),
    )),
  ];
  const uniqueFriendRequests = [...new Map(friendRequestDocs.map((d) => [d.id, d])).values()];
  await writeFirestoreBatches(store, db, uniqueFriendRequests, (batch, docSnap) => {
    const row = docSnap.data();
    const patch = {
      status: "deleted",
      resolvedAt: store.serverTimestamp(),
      resolvedBy: uid,
      deletedAt: store.serverTimestamp(),
      updatedAt: store.serverTimestamp(),
    };
    if (row.fromUid === uid) {
      patch.fromName = deletedName;
      patch.fromCode = "";
      patch.fromChatPublicJwk = null;
    }
    if (row.toUid === uid) patch.toName = deletedName;
    batch.set(docSnap.ref, patch, { merge: true });
  });

  const joinRequestDocs = [
    ...(await docsForQuery(
      store,
      store.query(store.collection(db, "countryJoinRequests"), store.where("fromUid", "==", uid), store.limit(500)),
    )),
    ...(await docsForQuery(
      store,
      store.query(store.collection(db, "countryJoinRequests"), store.where("toOwnerUid", "==", uid), store.limit(500)),
    )),
  ];
  const uniqueJoinRequests = [...new Map(joinRequestDocs.map((d) => [d.id, d])).values()];
  await writeFirestoreBatches(store, db, uniqueJoinRequests, (batch, docSnap) => {
    const row = docSnap.data();
    const patch = {
      status: "deleted",
      resolvedAt: store.serverTimestamp(),
      resolvedBy: uid,
      deletedAt: store.serverTimestamp(),
      updatedAt: store.serverTimestamp(),
    };
    if (row.fromUid === uid) {
      patch.fromName = deletedName;
      patch.fromCode = "";
    }
    if (row.toOwnerUid === uid) patch.ownerDeletedAt = store.serverTimestamp();
    batch.set(docSnap.ref, patch, { merge: true });
  });

  const countryId = String(profile.countryId || "");
  if (countryId) {
    const countryRef = store.doc(db, "countries", countryId);
    const countrySnap = await store.getDoc(countryRef);
    if (countrySnap.exists()) {
      const country = countrySnap.data();
      const memberDocs = await docsForQuery(
        store,
        store.query(store.collection(db, "countries", countryId, "members"), store.limit(500)),
      );
      const ownMember = memberDocs.find((d) => d.id === uid);
      if (country.ownerUid === uid) {
        if (memberDocs.length <= 1) {
          await writeFirestoreBatches(store, db, [...memberDocs.map((d) => d.ref), countryRef], (batch, ref) => {
            batch.delete(ref);
          });
        } else {
          await writeFirestoreBatches(store, db, [
            ownMember ? { kind: "delete", ref: ownMember.ref } : null,
            { kind: "update", ref: countryRef },
          ].filter(Boolean), (batch, op) => {
            if (op.kind === "delete") {
              batch.delete(op.ref);
              return;
            }
            const patch = {
              ownerName: deletedName,
              ownerDeletedAt: store.serverTimestamp(),
              discoverable: false,
              updatedAt: store.serverTimestamp(),
            };
            if (ownMember) patch.memberCount = store.increment(-1);
            batch.set(op.ref, patch, { merge: true });
          });
        }
      } else if (ownMember) {
        await writeFirestoreBatches(store, db, [
          { kind: "delete", ref: ownMember.ref },
          { kind: "update", ref: countryRef },
        ], (batch, op) => {
          if (op.kind === "delete") batch.delete(op.ref);
          else batch.set(op.ref, { memberCount: store.increment(-1), updatedAt: store.serverTimestamp() }, { merge: true });
        });
      }
    }
  }

  const threadDocs = await docsForQuery(
    store,
    store.query(store.collection(db, "threads"), store.where("participants", "array-contains", uid), store.limit(300)),
  );
  for (const threadDoc of threadDocs) {
    const threadPatch = {};
    threadPatch["friendNames." + uid] = deletedName;
    threadPatch["unreadBy." + uid] = 0;
    threadPatch.updatedAt = store.serverTimestamp();
    await store.setDoc(threadDoc.ref, threadPatch, { merge: true });
    const fromDocs = await docsForQuery(
      store,
      store.query(
        store.collection(db, "threads", threadDoc.id, "messages"),
        store.where("fromUid", "==", uid),
        store.limit(500),
      ),
    );
    const toDocs = await docsForQuery(
      store,
      store.query(
        store.collection(db, "threads", threadDoc.id, "messages"),
        store.where("toUid", "==", uid),
        store.limit(500),
      ),
    );
    const messageDocs = [...new Map([...fromDocs, ...toDocs].map((d) => [d.id, d])).values()];
    await writeFirestoreBatches(store, db, messageDocs, (batch, docSnap) => {
      const row = docSnap.data();
      const patch = {};
      if (row.fromUid === uid) patch.fromName = deletedName;
      if (row.toUid === uid) {
        patch.toName = deletedName;
        patch.readAt = row.readAt || store.serverTimestamp();
      }
      if (Object.keys(patch).length > 0) batch.set(docSnap.ref, patch, { merge: true });
    });
  }

  await store.setDoc(userRef, {
    uid,
    username: deletedName,
    friendCode: "",
    countryId: "",
    countryName: "",
    countryCode: "",
    pendingCountryId: "",
    pendingCountryName: "",
    pendingCountryCode: "",
    membershipState: "deleted",
    countryModeEnabled: false,
    chatPublicJwk: null,
    deletedAt: store.serverTimestamp(),
    updatedAt: store.serverTimestamp(),
  }, { merge: true });
  const key = "goblintown.chat-ecdh.v1." + uid;
  try { localStorage.removeItem(key); } catch {}
  firebaseState.userProfile = null;
  firebaseState.chatKeys = null;
  if (firebaseState.auth && firebaseState.sdk) {
    await firebaseState.sdk.auth.signOut(firebaseState.auth);
  }
}

async function performAsteroidMode(nukeCloud) {
  const statusEl = nukeCloud ? asteroidCloudStatus : asteroidStatus;
  setAsteroidBusy(true);
  try {
    statusEl.textContent = nukeCloud ? "Nuking cloud data..." : "Destroying town...";
    if (nukeCloud) {
      await nukeCloudAccountData();
      statusEl.textContent = "Cloud data tombstoned. Asteroid inbound...";
    }
    await playAsteroidObliteration();
    const r = await fetch("/api/asteroid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "ASTEROID" }),
    });
    if (!r.ok) throw new Error(await r.text());
    if (resumeRecord && resumeRecord.runId) clearRememberedRun(resumeRecord.runId);
    clearGoblintownBrowserMemory();
    await waitMs(120);
    window.location.replace("/?onboarding=1");
  } catch (err) {
    tank.classList.remove("asteroid-destroying");
    asteroidOverlay.classList.remove("destroying");
    statusEl.textContent = "Asteroid Mode failed: " + (err.message || err);
    setAsteroidBusy(false);
  }
}

asteroidConfirm.addEventListener("input", () => {
  asteroidArm.disabled = (asteroidConfirm.value || "").trim() !== "ASTEROID";
});
asteroidConfirm.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    showAsteroidCloudChoice();
  }
});
asteroidArm.onclick = showAsteroidCloudChoice;
asteroidCancel.onclick = closeAsteroidMode;
asteroidCloudCancel.onclick = closeAsteroidMode;
asteroidLocalOnly.onclick = () => performAsteroidMode(false);
asteroidNukeCloud.onclick = () => performAsteroidMode(true);
asteroidOverlay.addEventListener("click", (ev) => {
  if (ev.target === asteroidOverlay && !asteroidOverlay.classList.contains("destroying")) closeAsteroidMode();
});

$("resume-start").onclick = async () => {
  const runId = resumePanel.dataset.runId;
  if (!runId) return;
  const isPlan = resumePanel.dataset.mode === "plan";
  $("resume-start").disabled = true;
  setTicker("resuming " + runId + " ...", true);
  try {
    const r = await fetch("/api/runs/" + runId + "/resume", { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    const body = await r.json();
    if (!body.runId) throw new Error("resume response missing runId");
    hideResumePanel();
    const packSize = resumeRecord && resumeRecord.packSize ? resumeRecord.packSize : 3;
    lastTask = resumeRecord ? resumeRecord.task : lastTask;
    showTankMode();
    resetRunStage(isPlan, packSize);
    setLaunchButtonsDisabled(true);
    setSurfaceMode(isPlan ? "plan running" : "rite running");
    rememberActiveRun(body.runId, isPlan);
    history.replaceState(null, "", "/?run=" + encodeURIComponent(body.runId));
    setTicker("resumed as " + body.runId, true);
    openStream(body.runId, isPlan);
  } catch (err) {
    setTicker("resume failed: " + (err.message || err));
    $("resume-start").disabled = false;
  }
};

async function showResultFromIds(riteId, lootId, outcome, task) {
  if (!lootId) {
    showResultPanel({ outcome, task, riteId, output: "(no winner loot recorded)" });
    return;
  }
  try {
    const r = await fetch("/api/loot/" + lootId);
    if (!r.ok) {
      showResultPanel({ outcome, task, riteId, lootId, output: "(loot not found)" });
      return;
    }
    const loot = await r.json();
    showResultPanel({
      outcome, task, riteId, lootId,
      output: loot.output,
      score: loot.reward,
    });
  } catch (e) {
    showResultPanel({ outcome, task, riteId, lootId, output: "(fetch failed: " + e.message + ")" });
  }
}

async function loadLastResult() {
  try {
    const r = await fetch("/api/runs");
    if (!r.ok) return;
    const runs = await r.json();
    const last = runs.find((rr) => rr.done && rr.finalRiteId);
    if (!last) return;
    let winnerLootId = null;
    try {
      const full = await fetch("/api/runs/" + last.runId + "?full=1");
      if (full.ok) {
        const record = await full.json();
        const doneEv = (record.events || []).slice().reverse().find((e) => e.kind === "done");
        winnerLootId = doneEv && doneEv.data && doneEv.data.winnerLootId;
      }
    } catch {}
    showResultFromIds(last.finalRiteId, winnerLootId, last.outcome || "winner", last.task);
  } catch {}
}

/* DAG side panel (Phase 3) */
const dagPanel = $("dag-panel");
const dagNodesEl = $("dag-nodes");
const dagNodeEls = {};
function showDag(plan) {
  dagNodesEl.innerHTML = "";
  Object.keys(dagNodeEls).forEach(k => delete dagNodeEls[k]);
  for (const n of plan.nodes) {
    const row = document.createElement("div");
    row.className = "dag-node";
    row.dataset.status = n.status || "pending";
    const id = document.createElement("span");
    id.className = "id"; id.textContent = n.id;
    const text = document.createElement("span");
    text.className = "text";
    const inputs = (n.inputs || []).length ? " ← " + n.inputs.join(",") : "";
    text.textContent = n.task + inputs;
    row.appendChild(id); row.appendChild(text);
    dagNodesEl.appendChild(row);
    dagNodeEls[n.id] = row;
  }
  dagPanel.classList.add("open");
}
function setDagNodeStatus(nodeId, status) {
  const el = dagNodeEls[nodeId];
  if (el) el.dataset.status = status;
}
function hideDag() { dagPanel.classList.remove("open"); dagPanel.classList.remove("collapsed"); }
$("dag-header").onclick = () => {
  const c = dagPanel.classList.toggle("collapsed");
  $("dag-toggle").textContent = c ? "[show]" : "[hide]";
};

/* Rite form overlay wiring */
let planMode = false;
function openRiteForm(asPlan) {
  closeSettingsPopover();
  closeTopPopovers();
  planMode = !!asPlan;
  $("rite-overlay").classList.add("open");
  $("rf-task").placeholder = planMode
    ? "What complex task should the planner decompose?"
    : "What should the goblins solve?";
  setTimeout(() => $("rf-task").focus(), 50);
}
function closeRiteForm() { $("rite-overlay").classList.remove("open"); }
$("btn-rite").onclick = () => openRiteForm(false);
$("btn-plan").onclick = () => openRiteForm(true);
$("sidecar-new-rite").onclick = () => openRiteForm(false);
$("sidecar-new-plan").onclick = () => openRiteForm(true);
$("sidecar-imports").onclick = () => {
  showSettingsSurface();
  showSettingsSection("imports");
};
$("sidecar-provider").onclick = () => {
  showSettingsSurface();
  showSettingsSection("api");
};
$("rf-cancel").onclick = closeRiteForm;
$("rite-overlay").addEventListener("click", (e) => { if (e.target === $("rite-overlay")) closeRiteForm(); });

/* Rite/plan submission */
let activeStream = null;
$("rite-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const scanGlobs = (fd.get("scanGlobs") || "").toString()
    .split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
  const isPlan = planMode;
  const payload = isPlan
    ? {
        task: fd.get("task"),
        maxNodes: 6,
        maxReplan: 2,
        remember: !!fd.get("remember"),
      }
    : {
        task: fd.get("task"),
        packSize: Number(fd.get("packSize") || 3),
        personality: fd.get("personality"),
        noFallback: !!fd.get("noFallback"),
        debate: !!fd.get("debate"),
        trollTools: !!fd.get("trollTools"),
        remember: !!fd.get("remember"),
        scanGlobs,
      };
  closeRiteForm();
  hideResumePanel();
  lastTask = payload.task;
  showTankMode();
  setLaunchButtonsDisabled(true);
  setSurfaceMode(isPlan ? "plan running" : "rite running");
  resetRunStage(isPlan, payload.packSize);
  setTicker(isPlan ? "POSTing plan ..." : "POSTing rite ...", true);

  try {
    const startRes = await fetch(isPlan ? "/api/plan" : "/api/rite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!startRes.ok) throw new Error(await startRes.text());
    const { runId } = await startRes.json();
    setTicker((isPlan ? "plan " : "rite ") + runId + " started", true);
    rememberActiveRun(runId, isPlan);
    history.replaceState(null, "", "/?run=" + encodeURIComponent(runId));
    openStream(runId, isPlan);
  } catch (err) {
    setTicker("error: " + (err.message || err));
    setLaunchButtonsDisabled(false);
    setSurfaceMode("sidecar");
  }
});

/* When attaching to an existing run, we replay history first then go live.
 * During replay, skip thinking-token deltas (4000+ would thrash the DOM)
 * and just keep the latest text per slot for a one-shot bubble update. */
let replaying = false;
const replayLatestThinking = {};
function openStream(runId, isPlan, opts) {
  showTankMode();
  if (activeStream) { activeStream.close(); activeStream = null; }
  const isAttach = !!(opts && opts.attach);
  const terminalAttach = !!(opts && opts.terminal);
  let replayEnded = false;
  attachedRunId = runId;
  replaying = isAttach;
  Object.keys(replayLatestThinking).forEach(k => delete replayLatestThinking[k]);

  const es = new EventSource("/api/rite/" + runId + "/stream");
  activeStream = es;

  es.addEventListener("replay-end", () => {
    replaying = false;
    replayEnded = true;
    // Flush the last thinking text per slot once, so the user sees where each
    // creature got to during the replayed period.
    if (!terminalAttach) {
      Object.keys(replayLatestThinking).forEach((slot) => {
        updateThinkingBubble(slot, replayLatestThinking[slot]);
      });
    }
    if (!terminalAttach) setTicker("(live) — caught up", true);
  });

  es.addEventListener("step", async (ev) => {
    const data = JSON.parse(ev.data);
    if (isPlan && data && data.nodeId && data.step) {
      // plan-wrapped sub-rite step: surface node id in ticker
      if (!replaying) setTicker("[" + data.nodeId + "] " + (data.step.kind || ""), true);
      if (replaying && data.step.kind === "thinking") {
        replayLatestThinking[data.step.slot] = data.step.text;
        return;
      }
      handleStep(data.step, { replay: replaying });
    } else {
      if (replaying && data && data.kind === "thinking") {
        replayLatestThinking[data.slot] = data.text;
        return;
      }
      handleStep(data, { replay: replaying });
    }
  });
  es.addEventListener("plan:planning", () => setTicker("planner thinking...", true));
  es.addEventListener("plan:built", (ev) => {
    const d = JSON.parse(ev.data);
    showDag(d.plan);
    setTicker("plan: " + d.plan.nodes.length + " node(s)", true);
  });
  es.addEventListener("plan:start", () => {});
  es.addEventListener("plan:node:start", (ev) => {
    const d = JSON.parse(ev.data);
    setDagNodeStatus(d.nodeId, "running");
    setTicker("plan node " + d.nodeId + " starting", true);
  });
  es.addEventListener("plan:node:done", (ev) => {
    const d = JSON.parse(ev.data);
    setDagNodeStatus(d.nodeId, "done");
    setTicker("plan node " + d.nodeId + " done · " + d.outcome, true);
  });
  es.addEventListener("plan:node:failed", (ev) => {
    const d = JSON.parse(ev.data);
    setDagNodeStatus(d.nodeId, "failed");
    setTicker("plan node " + d.nodeId + " failed: " + d.reason, true);
  });
  es.addEventListener("plan:replan", (ev) => {
    const d = JSON.parse(ev.data);
    setTicker("replanning (depth " + d.depth + ")", true);
  });
  es.addEventListener("plan:done", (ev) => {
    const d = JSON.parse(ev.data);
    setTicker("plan " + d.outcome, true);
  });
  es.addEventListener("done", async (ev) => {
    const d = JSON.parse(ev.data);
    const label = isPlan ? "plan done" : "rite done";
    setTicker(label + " · " + d.outcome + (d.riteId ? " · " + d.riteId : ""));
    es.close();
    activeStream = null;
    clearRememberedRun(runId);
    hideResumePanel();
    setLaunchButtonsDisabled(false);
    setSurfaceMode("sidecar");
    setTimeout(refreshStats, 400);
    setTimeout(() => {
      ["c-raccoon","c-gremlin","c-troll","c-pigeon"].forEach(id => setState(id,"idle"));
      setState("c-ogre","cave");
      goHomeAllGoblins(0);
      hideDag();
    }, 4000);
    if (d.riteId) {
      // For plans: prefer the final synthesize node's loot if present.
      let lootId = d.winnerLootId;
      if (!lootId && d.finalArtifactId) {
        try {
          const r = await fetch("/api/artifact/" + d.finalArtifactId);
          if (r.ok) {
            const a = await r.json();
            lootId = a.winnerLootId;
          }
        } catch {}
      }
      showResultFromIds(d.riteId, lootId, d.outcome, lastTask);
      appendRootChatMessage(
        "system",
        "Goblintown finished: " + d.outcome + (d.riteId ? " (" + d.riteId + ")" : ""),
        d.riteId ? { href: "/rite/" + d.riteId } : null,
      );
    }
    setTimeout(showSidecarMode, 1200);
  });
  es.addEventListener("error", (ev) => {
    if (terminalAttach && replayEnded) {
      es.close();
      activeStream = null;
      return;
    }
    let msg = "(connection error)";
    try { msg = JSON.parse(ev.data).message; } catch {}
    setTicker("error: " + msg);
    es.close();
    activeStream = null;
    setLaunchButtonsDisabled(false);
    setSurfaceMode("sidecar");
    goHomeAllGoblins(300);
    setTimeout(() => refreshResumePanel(runId, isPlan), 350);
  });
}

async function handleStep(step, opts) {
  const replay = !!(opts && opts.replay);
  switch (step.kind) {
    case "thinking":
      updateThinkingBubble(step.slot, step.text);
      return;
    case "scavenge:start":
      cueRaccoonWork();
      setTicker("raccoon scanning corpus", true);
      dispatchBubble($("c-raccoon"), "foraging " + (step.globs || []).join(", "));
      break;
    case "scavenge:done":
      cueRaccoonScurryAfterWake();
      setTicker("raccoon → goblins", true);
      dispatchBubble($("c-raccoon"), "scanned " + step.fileCount + " file" + (step.fileCount === 1 ? "" : "s"));
      break;
    case "artifacts:loaded":
      cueRaccoonWork({ scurry: !replay });
      setTicker("raccoon recalled " + step.count + " prior artifact" + (step.count === 1 ? "" : "s"), true);
      dispatchBubble($("c-raccoon"), "📜 loaded " + step.count + " prior artifact" + (step.count === 1 ? "" : "s"));
      break;
    case "pack:start":
      setTicker("pack of " + step.size + " dispatched", true);
      renderGoblinSlots(step.size);
      break;
    case "pack:goblin": {
      const slot = goblinByIndex[step.index] || goblinByIndex[step.index % Math.max(1, Object.keys(goblinByIndex).length)];
      if (slot) {
        slot.lootId = step.lootId;
        goblinByLootId[step.lootId] = slot;
        if (step.personality) {
          slot.personality = step.personality;
          slot.tag.textContent = step.personality;
        }
        if (!replay) bringGoblinOutForTurn(slot, "argue", { durationMs: 1600, homeAfterMs: 2400 });
        clearThinkingBubble("goblin#" + step.index);
        if (!replay) {
          const snippet = await fetchLootSnippet(step.lootId, 70);
          if (snippet) dispatchBubble(slot.el, snippet);
        }
      }
      break;
    }
    case "debate:start":
      setTicker("debate round " + step.round + " · " + step.size + " goblins exchanging", true);
      break;
    case "debate:goblin": {
      const slot = goblinByIndex[step.index];
      if (slot) {
        slot.lootId = step.lootId;
        goblinByLootId[step.lootId] = slot;
        clearThinkingBubble("goblin#" + step.index);
        if (!replay) {
          bringGoblinOutForTurn(slot, "argue", { durationMs: 1600, homeAfterMs: 2400 });
          const snippet = await fetchLootSnippet(step.lootId, 70);
          if (snippet) dispatchBubble(slot.el, "↻ " + snippet);
        }
      }
      break;
    }
    case "debate:done":
      setTicker("debate round " + step.round + " concluded", true);
      break;
    case "chaos:start":
      setState("c-gremlin","active");
      pounceVariant();
      setTicker("gremlin attacking", true);
      break;
    case "chaos:done": {
      if (!replay) {
        const snippet = await fetchLootSnippet(step.gremlinId, 70);
        if (snippet) dispatchBubble($("c-gremlin"), snippet, "attack");
        const slot = goblinByLootId[step.goblinId];
        if (slot) bringGoblinOutForTurn(slot, "defend", { durationMs: 1400, homeAfterMs: 2200 });
      }
      setState("c-gremlin","idle");
      break;
    }
    case "review:start":
      setState("c-troll","active");
      gavelVariant();
      setTicker("troll reviewing", true);
      dispatchBubble($("c-troll"), "weighing the verdict...");
      break;
    case "tool:calls":
      setTicker("troll invoking " + step.calls.length + " tool(s)", true);
      dispatchBubble($("c-troll"), "🔧 " + step.calls.map(function(c){return c.name;}).join(", "));
      break;
    case "tool:results":
      setTicker("tool results received", true);
      dispatchBubble($("c-troll"), "🔧 " + step.results.map(function(r){return r.name+"="+(r.ok?"ok":"err");}).join(", "));
      break;
    case "review:verdict": {
      const v = step.verdict;
      const passed = v.passed;
      setState("c-troll", passed ? "pass" : "fail");
      setTicker("troll: " + (passed ? "PASS" : "FAIL") + " · " + v.score.toFixed(2), true);
      const text = (v.critique || (passed ? "passes spec" : "rejected")) + " · " + v.score.toFixed(2);
      dispatchBubble($("c-troll"), text, passed ? "pass" : "fail");
      // Mark winning goblin if known
      const slot = goblinByLootId[v.lootId];
      if (slot && passed) {
        bringGoblinOutForTurn(slot, "argue", { state: "winner", durationMs: 1500, homeAfterMs: 3200 });
        dispatchBubble(slot.el, "👑 winner · " + v.score.toFixed(2) + " shinies", "win");
      } else if (slot && !passed) {
        bringGoblinOutForTurn(slot, "defend", { state: "fail", durationMs: 1300, homeAfterMs: 2400 });
      }
      break;
    }
    case "specialist:cluster:start":
      setTicker("clustering failure modes 🔬", true);
      dispatchBubble($("c-troll"), "the pack has failed me. analyzing...", "fail");
      break;
    case "specialist:cluster:done": {
      const names = (step.clusters || []).map((c) => c.name).join(", ");
      if (!(step.clusters || []).length) {
        setTicker("no specialist clusters returned", true);
        dispatchBubble($("c-troll"), "no repair focus found", "fail");
        break;
      }
      setTicker("clusters: " + names, true);
      if (replay) markGoblinSpecialists(step.clusters.length);
      else playGoblinSpecialistTransition(step.clusters.length);
      break;
    }
    case "specialist:cluster:empty":
      setTicker("specialist recovery skipped: " + step.reason, true);
      dispatchBubble($("c-troll"), "specialists skipped: " + step.reason, "fail");
      break;
    case "specialist:cluster:error":
      setTicker("specialist recovery failed", true);
      dispatchBubble($("c-troll"), "specialist error: " + String(step.message || "").slice(0, 90), "fail");
      break;
    case "specialist:spawn": {
      specialistByIndex[step.index] = specialistSlotForIndex(step.index);
      const slot = specialistByIndex[step.index];
      if (slot) {
        slot.wrap.dataset.specialist = "true";
        slot.tag.textContent = "specialist";
        slot.el.dataset.state = "active";
        if (!replay) {
          bringGoblinOutForTurn(slot, "argue", { durationMs: 1500, homeAfterMs: 2800 });
          hopGoblin(slot.el);
          dispatchBubble(slot.el, "focus: " + step.focus.slice(0, 60));
        }
      }
      setTicker("specialist #" + (step.index + 1) + " spawned", true);
      break;
    }
    case "specialist:done": {
      const slot = specialistByIndex[step.index] || specialistSlotForIndex(step.index);
      if (slot) specialistByIndex[step.index] = slot;
      specialistByLootId[step.lootId] = slot;
      clearThinkingBubble("specialist#" + step.index);
      if (!replay && slot) {
        const snippet = await fetchLootSnippet(step.lootId, 70);
        if (snippet) {
          bringGoblinOutForTurn(slot, "argue", { durationMs: 1600, homeAfterMs: 2600 });
          dispatchBubble(slot.el, snippet);
        }
      }
      break;
    }
    case "specialist:verdict": {
      const slot = specialistByIndex[step.index] || specialistSlotForIndex(step.index);
      if (slot) {
        specialistByIndex[step.index] = slot;
        if (step.verdict.passed) {
          bringGoblinOutForTurn(slot, "argue", { state: "winner", durationMs: 1500, homeAfterMs: 3200 });
          dispatchBubble(slot.el, "👑 specialist won · " + step.verdict.score.toFixed(2), "win");
        } else {
          bringGoblinOutForTurn(slot, "defend", { state: "fail", durationMs: 1300, homeAfterMs: 2400 });
        }
      }
      setTicker(
        "specialist #" + (step.index + 1) + " " + (step.verdict.passed ? "PASS" : "FAIL") +
          " · " + step.verdict.score.toFixed(2),
        true,
      );
      break;
    }
    case "fallback:start":
      stompVariant();
      setState("c-ogre","active");
      setTicker("ogre fallback — synthesizing...", true);
      // Seed the live thinking bubble so the user sees the ogre is working,
      // even before the first token chunk arrives. (Streaming will overwrite it.)
      updateThinkingBubble("ogre", "synthesizing…");
      break;
    case "fallback:done": {
      clearThinkingBubble("ogre");
      if (!replay) {
        const snippet = await fetchLootSnippet(step.lootId, 80);
        if (snippet) dispatchBubble($("c-ogre"), snippet);
      }
      setTicker("ogre synthesized result", true);
      break;
    }
    case "scribe:start":
      setState("c-pigeon","active");
      hopGoblin($("c-pigeon"));
      setTicker("pigeon-scribe writing artifact 📜", true);
      dispatchBubble($("c-pigeon"), "📜 scribing this rite...");
      break;
    case "scribe:done":
      setState("c-pigeon","idle");
      queuePigeonPeckSoon(350);
      setTicker("artifact " + step.artifactId + " stashed", true);
      dispatchBubble($("c-pigeon"), "📜 " + step.artifactId);
      break;
    case "scribe:error":
      setState("c-pigeon", "fail");
      setTicker("scribe failed: " + step.message, true);
      dispatchBubble($("c-pigeon"), "⚠ " + step.message.slice(0, 60), "fail");
      break;
    case "budget:exceeded":
      setTicker("budget exceeded · " + step.phase + " · used=" + step.used + "/" + step.cap);
      break;
    case "rite:done":
      setTicker("rite complete · outcome=" + step.outcome);
      goHomeAllGoblins(1200);
      break;
  }
}

renderGoblinSlots(3);

/* Attach to an existing run if ?run=<id> is in the URL (e.g. when arriving
 * from the /runs page after a refresh). Otherwise restore the last result
 * panel as before. */
async function attachToRunFromUrl() {
  const params = new URLSearchParams(window.location.search);
  let runId = params.get("run");
  if (!runId) {
    const remembered = readRememberedRun();
    if (remembered && remembered.runId) {
      runId = remembered.runId;
      history.replaceState(null, "", "/?run=" + encodeURIComponent(runId));
    } else {
      showSidecarMode();
      return;
    }
  }
  try {
    const r = await fetch("/api/runs/" + runId + "?full=1");
    if (!r.ok) {
      setTicker("run " + runId + " not found");
      clearRememberedRun(runId);
      showSidecarMode();
      return;
    }
    const record = await r.json();
    lastTask = record.task;
    const isPlan = runModeFromRecord(record) === "plan";
    // Determine pack size: explicit on rite records, or read from a pack:start event.
    let packSize = record.packSize;
    if (!packSize || packSize < 1) {
      const ps = (record.events || []).find((e) =>
        e.kind === "step" && e.data && e.data.kind === "pack:start",
      );
      if (ps && ps.data && typeof ps.data.size === "number") packSize = ps.data.size;
    }
    resetRunStage(isPlan, packSize);
    showTankMode();

    const status = runStatus(record);
    const label = record.done ? status : "watching live";
    setSurfaceMode(isPlan ? "plan · " + label : "rite · " + label);
    setTicker((isPlan ? "plan " : "rite ") + runId + " · " + label, true);
    setLaunchButtonsDisabled(!record.done);
    if (canResumeRecord(record)) {
      showResumePanel(record);
    } else {
      hideResumePanel();
      if (record.done) clearRememberedRun(runId);
    }
    openStream(runId, isPlan, { attach: true, terminal: !!record.done });
  } catch (e) {
    setTicker("attach failed: " + (e.message || e));
    showSidecarMode();
  }
}
attachToRunFromUrl();

/* Periodic light stats refresh in case of background activity */
setInterval(() => { if (!activeStream) refreshStats(); }, 30000);
</script>
</body>
</html>`;
}
