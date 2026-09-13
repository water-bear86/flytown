#!/usr/bin/env node
try {
  process.loadEnvFile?.();
} catch {
  // no .env file — that's fine
}

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auditFlight } from "./audit.js";
import { printBanner } from "./banners.js";
import { compareFlights } from "./compare.js";
import {
  chatRecordPreview,
  importChatRecords,
  scanChatImports,
  type ChatImportSource,
  vectorizeStoredArtifacts,
} from "./chat-import.js";
import { ingestContextPath } from "./context-ingest.js";
import { makeInsect } from "./castes.js";
import { measureDrift } from "./drift.js";
import { exportFlightMarkdown } from "./export.js";
import { renderMorselAncestry, renderFlightGraph } from "./graph.js";
import { callInsectStream } from "./openai-client.js";
import { dispatchForay } from "./foray.js";
import { reroll } from "./reroll.js";
import { performFlight, type FlightStep } from "./flight.js";
import { loadRewardPlugin } from "./reward-plugin.js";
import { ensureRunDir, loadAllRuns, loadRun } from "./run-store.js";
import { previewScan, scout } from "./scout.js";
import { serve } from "./server.js";
import { commandToCliArgs, parseSlashCommand } from "./slash-commands.js";
import { exportRunAsMasTrace } from "./trace-export.js";
import { MODEL_SLOTS, PROVIDER_PRESETS, normalizeProviderConfig } from "./providers.js";
import {
  CASTES,
  type Artifact,
  type Caste,
  type Morsel,
  type Personality,
  type ModelSlot,
  type ProviderConfig,
} from "./types.js";
import { initTerrarium, loadTerrarium, saveTerrariumManifest, type Terrarium } from "./terrarium.js";
import { normalizeOutputFormat } from "./formatting.js";
import { buildCliHelp } from "./cli-help.js";
import { builtinTools } from "./tools.js";

const HELP = buildCliHelp(CASTES);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  if (cmd.startsWith("/")) {
    return cmdSlash(argv);
  }

  switch (cmd) {
    case "init":
      return cmdInit(argv.slice(1));
    case "provider":
      return cmdProvider(argv.slice(1));
    case "ask":
      return cmdAsk(argv.slice(1));
    case "scout":
      return cmdScout(argv.slice(1));
    case "foray":
      return cmdForay(argv.slice(1));
    case "flight":
      return cmdFlight(argv.slice(1));
    case "reroll":
      return cmdReroll(argv.slice(1));
    case "export":
      return cmdExport(argv.slice(1));
    case "compare":
      return cmdCompare(argv.slice(1));
    case "audit":
      return cmdAudit(argv.slice(1));
    case "graph":
      return cmdGraph(argv.slice(1));
    case "drift":
      return cmdDrift();
    case "compost":
      return cmdCompost(argv.slice(1));
    case "route":
      return cmdRoute(argv.slice(1));
    case "serve":
      return cmdServe(argv.slice(1));
    case "ancestry":
      return cmdAncestry(argv.slice(1));
    case "export-trace":
      return cmdExportTrace(argv.slice(1));
    case "plan":
      return cmdPlan(argv.slice(1));
    case "fly": {
      const { runFlyCli } = await import("./flytown/cli.js");
      return runFlyCli(argv.slice(1));
    }
    case "secret":
      return cmdSecret(argv.slice(1));
    case "context":
      return cmdContext(argv.slice(1));
    case "fold":
      return cmdFold(argv.slice(1));
    case "reset":
      return cmdReset(argv.slice(1));
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function cmdSlash(args: string[]): Promise<void> {
  const parsed = parseSlashCommand(shellArgsToSlashLine(args));
  if (parsed.kind === "help") {
    process.stdout.write(
      `FLYTOWN slash commands:\n\n` +
        `  /ask <task>       Single mode: one forager, one answer.\n` +
        `  /run <task>       Use the selected/default mode.\n` +
        `  /swarm <task>     Swarm mode: planner DAG and multi-agent flights.\n` +
        `  /history          Recent persisted runs.\n` +
        `  /context ingest <path>    Import old conversations/projects as artifacts.\n` +
        `  /context search <query>   Search imported context and prior artifacts.\n` +
        `  /help             Show this help.\n`,
    );
    return;
  }
  if (parsed.kind === "history") {
    const runDir = await ensureRunDir(process.cwd());
    const runs = (await loadAllRuns(runDir)).sort((a, b) => b.startedAt - a.startedAt);
    if (runs.length === 0) {
      process.stdout.write("No FLYTOWN runs yet.\n");
      return;
    }
    for (const r of runs.slice(0, 20)) {
      process.stdout.write(
        `${r.runId}  ${r.mode ?? "flight"}  ${r.status ?? (r.done ? "done" : "running")}  ${truncate(r.task, 90)}\n`,
      );
    }
    return;
  }
  if (parsed.kind === "context") {
    return cmdContext(parsed.args);
  }
  if (!parsed.task) {
    process.stderr.write(`usage: flytown /ask "<task>" or flytown /swarm "<task>"\n`);
    process.exitCode = 1;
    return;
  }
  const mapped = commandToCliArgs(parsed);
  const target = mapped[0];
  if (target === "ask") return cmdAsk(mapped.slice(1));
  if (target === "plan") return cmdPlan(mapped.slice(1));
  process.stderr.write(`Unsupported slash command: /${parsed.kind}\n`);
  process.exitCode = 1;
}

async function cmdContext(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const positionals = positionalArgs(args);
  const action = positionals[0];
  const limit = clampCliLimit(flags.limit, 10, 1, 100);

  if (action === "scan" && positionals[1] === "chats") {
    return cmdContextScanChats(args);
  }

  if (action === "import" && positionals[1] === "chats") {
    return cmdContextImportChats(args);
  }

  if (action === "vectorize") {
    return cmdContextVectorize(args);
  }

  if (action === "ingest") {
    const inputPath = positionals[1];
    if (!inputPath) {
      process.stderr.write(`usage: flytown context ingest <path> [--limit N]\n`);
      process.exitCode = 1;
      return;
    }
    const w = await loadTerrarium(process.cwd());
    const result = await ingestContextPath({
      root: w.root,
      compost: w.compost,
      inputPath,
      limit: clampCliLimit(flags.limit, 80, 1, 500),
    });
    process.stdout.write(`Ingested ${result.artifacts.length} context artifact(s).\n`);
    for (const artifact of result.artifacts.slice(0, 20)) {
      const ref = artifact.evidence[0]?.ref ?? artifact.id;
      process.stdout.write(`  ${artifact.id}  ${ref}\n`);
    }
    if (result.artifacts.length > 20) {
      process.stdout.write(`  ... ${result.artifacts.length - 20} more\n`);
    }
    if (result.skipped.length > 0) {
      process.stdout.write(`Skipped ${result.skipped.length} file(s).\n`);
    }
    return;
  }

  if (action === "search") {
    const query = positionals.slice(1).join(" ").trim();
    if (!query) {
      process.stderr.write(`usage: flytown context search "<query>" [--limit N]\n`);
      process.exitCode = 1;
      return;
    }
    const w = await loadTerrarium(process.cwd());
    const all = await w.compost.allArtifacts();
    const { findRelevantArtifactsEmbedded } = await import("./embeddings.js");
    const matches = await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: query,
      limit,
      compost: w.compost,
    });
    if (matches.length === 0) {
      process.stdout.write("No matching context artifacts found.\n");
      return;
    }
    for (const artifact of matches) {
      const ref = artifact.evidence.find((e) => e.kind === "file")?.ref ?? artifact.flightId;
      const claim = artifact.claims[0]?.text ?? artifact.task;
      process.stdout.write(`${artifact.id}  ${ref}\n  ${truncate(claim, 140)}\n`);
    }
    return;
  }

  process.stderr.write(
    `usage: flytown context ingest <path> [--limit N]\n` +
      `   or: flytown context search "<query>" [--limit N]\n` +
      `   or: flytown context scan chats [--source codex|chatgpt|folder]\n` +
      `   or: flytown context import chats [--all|--ids <id,...>]\n` +
      `   or: flytown context vectorize [--missing-only]\n`,
  );
  process.exitCode = 1;
}

async function cmdContextScanChats(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const result = await scanChatImports({
    source: normalizeChatSource(flags.source),
    path: flags.path,
    query: flags.query,
    since: flags.since,
    limit: clampCliLimit(flags.limit, 50, 1, 500),
  });
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify({
      records: result.records.map(chatRecordPreview),
      skipped: result.skipped,
    }, null, 2) + "\n");
    return;
  }
  process.stdout.write(`Found ${result.records.length} previous chat(s).\n`);
  for (const record of result.records) {
    process.stdout.write(
      `${record.id}  ${record.source}  ${record.updatedAt ?? record.createdAt ?? "unknown"}  ${truncate(record.title, 90)}\n`,
    );
  }
  if (result.skipped.length > 0) {
    process.stdout.write(`Skipped ${result.skipped.length} path(s).\n`);
  }
}

async function cmdContextImportChats(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const ids = splitCsv(flags.ids);
  const importAll = flags.all === "true";
  if (!importAll && ids.length === 0) {
    process.stderr.write(
      `usage: flytown context import chats --all [--source codex|chatgpt|folder] [--path <path>]\n` +
        `   or: flytown context import chats --ids <id,...> [--source codex|chatgpt|folder]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const w = await loadTerrarium(process.cwd());
  const scan = await scanChatImports({
    source: normalizeChatSource(flags.source),
    path: flags.path,
    query: flags.query,
    since: flags.since,
    limit: clampCliLimit(flags.limit, 50, 1, 500),
  });
  const result = await importChatRecords({
    compost: w.compost,
    records: scan.records,
    ids: importAll ? undefined : ids,
    vectorize: flags["no-vectorize"] !== "true",
    summarize: flags.summarize === "true",
  });
  process.stdout.write(
    `Imported ${result.records.length} chat(s), ${result.artifacts.length} artifact(s), vectorized ${result.vectorized} artifact(s).\n`,
  );
  for (const record of result.records.slice(0, 20)) {
    process.stdout.write(`  ${record.id}  ${record.source}  ${truncate(record.title, 90)}\n`);
  }
  if (result.skipped.length > 0) {
    process.stdout.write(`Vectorization skipped/failed for ${result.skipped.length} artifact(s).\n`);
  }
}

async function cmdContextVectorize(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const w = await loadTerrarium(process.cwd());
  const result = await vectorizeStoredArtifacts({
    compost: w.compost,
    missingOnly: flags["missing-only"] === "true",
    limit: flags.limit ? clampCliLimit(flags.limit, 100, 1, 500) : undefined,
  });
  process.stdout.write(
    `Scanned ${result.scanned} artifact(s), vectorized ${result.vectorized} artifact(s).\n`,
  );
  if (result.failed.length > 0) {
    process.stdout.write(`Failed ${result.failed.length} artifact(s).\n`);
  }
}

async function cmdInit(args: string[] = []): Promise<void> {
  const flags = parseFlags(args);
  const { isProviderPresetId } = await import("./provider-setup.js");
  if (flags.provider !== undefined && !isProviderPresetId(flags.provider)) {
    process.stderr.write(`--provider must be one of: ${Object.keys(PROVIDER_PRESETS).join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  const w = await initTerrarium(process.cwd());
  process.stdout.write(`Terrarium "${w.manifest.name}" initialized at ${w.root}.\n`);
  if (flags.provider) await setupProvider(w, flags.provider, flags);
  else process.stdout.write(`Provider: OpenAI (the default). To use another, run: flytown provider set <${Object.keys(PROVIDER_PRESETS).join("|")}>\n`);
}

async function cmdProvider(args: string[]): Promise<void> {
  const sub = args[0];
  const w = await loadTerrarium(process.cwd());
  const { describeProvider, isProviderPresetId } = await import("./provider-setup.js");
  const { readProviderSecretsForRootSync } = await import("./provider-secrets.js");
  if (!sub || sub === "show") {
    const config = normalizeProviderConfig(w.manifest.provider);
    const { lines } = describeProvider(config, process.env, readProviderSecretsForRootSync(w.root));
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  const preset = args[1];
  if (sub !== "set" || !isProviderPresetId(preset)) {
    process.stderr.write(
      `usage: flytown provider [show]\n` +
        `       flytown provider set <${Object.keys(PROVIDER_PRESETS).join("|")}> [--model <name>] [--soldier-model <name>] [--base-url <url>] [--api-key-env <ENV>] [--keep-routes] [--no-key-prompt]\n`,
    );
    process.exitCode = 1;
    return;
  }
  await setupProvider(w, preset, parseFlags(args.slice(2)));
}

/**
 * Switch every model slot to one preset, save, describe the result, and, in
 * an interactive terminal, offer to store a missing API key (input hidden).
 */
async function setupProvider(w: Terrarium, preset: string, flags: Record<string, string>): Promise<void> {
  const { applyProviderPreset, describeProvider, isProviderPresetId } = await import("./provider-setup.js");
  const { readProviderSecretsForRootSync, setProviderSecretForRoot } = await import("./provider-secrets.js");
  if (!isProviderPresetId(preset)) throw new Error(`unknown provider preset: ${preset}`);
  let config: ProviderConfig;
  try {
    config = applyProviderPreset(normalizeProviderConfig(w.manifest.provider), preset, {
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags["soldier-model"] ? { soldierModel: flags["soldier-model"] } : {}),
      ...(flags["base-url"] ? { baseURL: flags["base-url"] } : {}),
      ...(flags["api-key-env"] ? { apiKeyEnv: flags["api-key-env"] } : {}),
      keepRoutes: flags["keep-routes"] === "true",
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    return;
  }
  w.manifest.provider = config;
  await saveTerrariumManifest(w);
  let described = describeProvider(config, process.env, readProviderSecretsForRootSync(w.root));
  process.stdout.write(described.lines.join("\n") + "\n");
  if (!described.missingApiKey) return;
  if (!process.stdin.isTTY || flags["no-key-prompt"] === "true") {
    process.stdout.write(`\nNext: flytown secret set ${described.missingApiKey}\n`);
    return;
  }
  const value = (await readSecretFromTerminal(`\nPaste your ${described.missingApiKey} (input hidden, Enter to skip): `)).trim();
  if (!value) {
    process.stdout.write(`Skipped. Store it later with: flytown secret set ${described.missingApiKey}\n`);
    return;
  }
  await setProviderSecretForRoot(w.root, described.missingApiKey, value);
  described = describeProvider(config, process.env, readProviderSecretsForRootSync(w.root));
  process.stdout.write(`stored ${described.missingApiKey ?? "the key"} for ${w.root} (file mode 0600)\n`);
}

async function cmdAsk(args: string[]): Promise<void> {
  const caste = args[0] as Caste | undefined;
  if (!caste || !CASTES.includes(caste)) {
    process.stderr.write(
      `usage: flytown ask <${CASTES.join("|")}> --task "..." [--personality <p>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args.slice(1));
  const task = flags.task;
  if (!task) {
    process.stderr.write(`--task is required\n`);
    process.exitCode = 1;
    return;
  }
  const personality = flags.personality as Personality | undefined;
  const outputFormat = normalizeOutputFormat(flags.format);
  const insect = makeInsect(caste, personality);

  printBanner(caste);

  const { text, usage } = await callInsectStream(insect, task, (chunk) => {
    process.stdout.write(chunk);
  }, {
    outputFormat,
  });
  process.stdout.write("\n");

  try {
    const w = await loadTerrarium(process.cwd());
    const drift = measureDrift(text);
    const morsel: Morsel = {
      id: "",
      caste,
      personality: insect.personality,
      model: insect.model,
      prompt: task,
      output: text,
      timestamp: Date.now(),
      drift,
      usage,
    };
    await w.compost.stash(morsel);
    process.stdout.write(
      `\n— drift —\n` +
        `  caste-name words: ${drift.totalCasteWords} / ${drift.outputWordCount}` +
        `  rate=${drift.driftRate.toFixed(4)}\n` +
        `  ${formatMentions(drift.casteMentions)}\n` +
        `  morsel: ${morsel.id}  tokens: ${usage.totalTokens}\n`,
    );
  } catch {
    // No Terrarium — print the drift report anyway, just don't stash.
    const drift = measureDrift(text);
    process.stdout.write(
      `\n— drift —\n` +
        `  caste-name words: ${drift.totalCasteWords} / ${drift.outputWordCount}` +
        `  rate=${drift.driftRate.toFixed(4)}\n` +
        `  ${formatMentions(drift.casteMentions)}\n` +
        `  (no Terrarium — morsel not stashed; tokens=${usage.totalTokens})\n`,
    );
  }
}

async function cmdScout(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const scanGlobs = collectFlag(args, "scan");
  const task = flags.task;
  if (!task || scanGlobs.length === 0) {
    process.stderr.write(
      `usage: flytown scout --task "..." --scan "<glob>" [--scan "<glob>"]...\n`,
    );
    process.exitCode = 1;
    return;
  }
  const w = await loadTerrarium(process.cwd());
  if (flags.preview === "true") {
    const paths = await previewScan(w.root, scanGlobs);
    process.stdout.write(
      `Would scan ${paths.length} file(s):\n${paths.map((p) => "  " + p).join("\n")}\n`,
    );
    return;
  }
  const result = await scout({
    task,
    scanGlobs,
    cwd: w.root,
    compost: w.compost,
    personality: flags.personality as Personality | undefined,
  });
  process.stdout.write(
    `Scout read ${result.files.length} file(s). Morsel: ${result.morsel.id}\n\n` +
      `${result.facts}\n`,
  );
}

async function cmdForay(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const task = positional[0];
  if (!task) {
    process.stderr.write(
      `usage: flytown foray "<task>" [--swarm <N>] [--personality <p>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const swarmSize = flags.swarm ? Number(flags.swarm) : 3;
  const personality = flags.personality as Personality | undefined;

  const w = await loadTerrarium(process.cwd());
  const outputFormat = normalizeOutputFormat(
    flags.format ?? w.manifest.provider?.outputFormat,
  );

  process.stdout.write(
    `Dispatching ${swarmSize} forager(s) on foray "${truncate(task, 60)}"...\n`,
  );
  const t0 = Date.now();
  const result = await dispatchForay({
    task,
    swarmSize,
    compost: w.compost,
    personality,
    outputFormat,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  process.stdout.write(
    `\nForay ${result.foray.id} finished in ${dt}s.\n\n`,
  );
  for (const l of result.morsels) {
    const v = result.foray.guardVerdicts[l.id];
    const tag = l.id === result.winner.id ? "  <-- WINNER" : "";
    process.stdout.write(
      `  ${l.id}  sugar=${(l.reward ?? 0).toFixed(3)}  ` +
        `guard=${v.score.toFixed(2)} ${v.passed ? "PASS" : "FAIL"}  ` +
        `drift=${l.drift.driftRate.toFixed(4)}${tag}\n`,
    );
    process.stdout.write(`     critique: ${truncate(v.critique, 120)}\n`);
  }
  process.stdout.write(`\n— winning morsel —\n\n${result.winner.output}\n`);
}

async function cmdFlight(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const task = positional[0];
  if (!task) {
    process.stderr.write(
      `usage: flytown flight "<task>" [--swarm <N>] [--scan <glob>]... [--personality <p>] [--no-fallback] [--budget <tokens>] [--max-output <tokens>] [--cite <flightId>]... [--remember]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const scanGlobs = collectFlag(args, "scan");
  const cites = collectFlag(args, "cite");
  const remember = flags.remember === "true";
  const swarmSize = flags.swarm ? Number(flags.swarm) : 3;
  const personality = flags.personality as Personality | undefined;
  const noFallback = flags["no-fallback"] === "true";
  const noSpecialist = flags["no-specialist"] === "true";
  const specialistCap = flags["specialist-cap"]
    ? Number(flags["specialist-cap"])
    : undefined;
  const debate = flags.debate === "true";
  const guardTools = flags["guard-tools"] === "true";
  const budgetTokens = flags.budget ? Number(flags.budget) : undefined;
  const maxOutputTokensPerCall = flags["max-output"]
    ? Number(flags["max-output"])
    : undefined;

  const w = await loadTerrarium(process.cwd());
  const outputFormat = normalizeOutputFormat(
    flags.format ?? w.manifest.provider?.outputFormat,
  );
  const rewardPlugin = await loadRewardPlugin(w.root);
  if (rewardPlugin.source !== "builtin") {
    process.stdout.write(`(reward plugin: ${rewardPlugin.source})\n`);
  }

  // Memory context: load any --cite'd or --remember'd artifacts.
  const parentArtifacts: Artifact[] = [];
  for (const flightId of cites) {
    const a = await w.compost.getArtifactByFlightId(flightId);
    if (a) parentArtifacts.push(a);
    else process.stderr.write(`(warning: no artifact found for flight ${flightId})\n`);
  }
  if (remember) {
    const all = await w.compost.allArtifacts();
    const { findRelevantArtifactsEmbedded } = await import("./embeddings.js");
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: task,
      limit: 3,
      compost: w.compost,
    })).filter((a) => !parentArtifacts.some((p) => p.id === a.id));
    parentArtifacts.push(...auto);
  }
  if (parentArtifacts.length > 0) {
    process.stdout.write(
      `(loaded ${parentArtifacts.length} prior artifact(s): ${parentArtifacts.map((a) => a.id).join(", ")})\n`,
    );
  }

  process.stdout.write(
    `Beginning flight (swarm=${swarmSize}, scan=${scanGlobs.length} glob(s)` +
      `${budgetTokens ? `, budget=${budgetTokens}` : ""})...\n`,
  );

  const t0 = Date.now();
  const result = await performFlight({
    task,
    swarmSize,
    scanGlobs,
    cwd: w.root,
    compost: w.compost,
    personality,
    rewardFn: rewardPlugin.fn,
    noFallback,
    noSpecialist,
    specialistCap,
    debate,
    guardTools,
    tools: guardTools ? builtinTools : undefined,
    budgetTokens,
    maxOutputTokensPerCall,
    outputFormat,
    parentArtifacts,
    onStep: (s) => process.stdout.write(formatFlightStep(s) + "\n"),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  process.stdout.write(`\nFlight ${result.flight.id} finished in ${dt}s — ${result.flight.outcome}.\n\n`);

  for (const gid of result.flight.foragerMorselIds) {
    const v = result.flight.guardVerdicts[gid];
    const tag = gid === result.flight.winnerMorselId ? "  <-- WINNER" : "";
    const tline =
      v
        ? `guard=${v.score.toFixed(2)} ${v.passed ? "PASS" : "FAIL"}`
        : "guard=—";
    process.stdout.write(`  forager ${gid}  ${tline}${tag}\n`);
    if (v?.critique) {
      process.stdout.write(`    critique: ${truncate(v.critique, 120)}\n`);
    }
  }
  if (result.flight.soldierMorselId) {
    process.stdout.write(`  soldier ${result.flight.soldierMorselId}  (fallback)\n`);
  }

  process.stdout.write(`\n— winning morsel —\n\n${result.winnerMorsel.output}\n`);
}

function formatFlightStep(s: FlightStep): string {
  switch (s.kind) {
    case "scout:start":
      return `  scout reading (${s.globs.length} glob(s))...`;
    case "scout:done":
      return `  scout stashed ${s.morselId} (${s.fileCount} file(s))`;
    case "artifacts:loaded":
      return `  scout loaded ${s.count} prior artifact(s): ${s.artifactIds.join(", ")}`;
    case "swarm:start":
      return `  dispatching swarm of ${s.size}...`;
    case "swarm:forager":
      return `    forager ${s.index + 1}${s.personality ? ` [${s.personality}]` : ""} → ${s.morselId}`;
    case "debate:start":
      return `  debate round ${s.round} (size ${s.size})...`;
    case "debate:forager":
      return `    debate forager ${s.index + 1} → ${s.morselId}`;
    case "debate:done":
      return `  debate round ${s.round} done`;
    case "sting:start":
      return `  wasps running sting pass...`;
    case "sting:done":
      return `    wasp → ${s.waspId} (on forager ${s.foragerId})`;
    case "review:start":
      return `  guard reviewing...`;
    case "tool:calls":
      return `    guard invoking tools: ${s.calls.map((c) => c.name).join(", ")}`;
    case "tool:results":
      return `    tool results: ${s.results.map((r) => `${r.name}=${r.ok ? "ok" : "err"}`).join(", ")}`;
    case "review:verdict":
      return `    guard: ${s.verdict.passed ? "PASS" : "FAIL"} score=${s.verdict.score.toFixed(2)} (${s.verdict.morselId})`;
    case "specialist:cluster:start":
      return `  swarm failed; clustering failure modes...`;
    case "specialist:cluster:done":
      return `  identified ${s.clusters.length} cluster(s): ${s.clusters.map((c) => `${c.name}[${c.severity}]`).join(", ")}`;
    case "specialist:cluster:empty":
      return `  specialist recovery skipped: ${s.reason}`;
    case "specialist:cluster:error":
      return `  specialist recovery failed: ${truncate(s.message, 120)}`;
    case "specialist:spawn":
      return `    specialist #${s.index + 1} → focus: "${truncate(s.focus, 80)}"`;
    case "specialist:done":
      return `    specialist #${s.index + 1} delivered ${s.morselId}`;
    case "specialist:verdict":
      return `    specialist #${s.index + 1} guard: ${s.verdict.passed ? "PASS" : "FAIL"} score=${s.verdict.score.toFixed(2)}`;
    case "fallback:start":
      return `  specialists insufficient; escalating to the soldier...`;
    case "fallback:done":
      return `  soldier delivered ${s.morselId}`;
    case "scribe:start":
      return `  messenger-scribe writing artifact...`;
    case "scribe:done":
      return `  artifact ${s.artifactId} stashed`;
    case "scribe:error":
      return `  ⚠ scribe failed: ${s.message}`;
    case "thinking":
      return `    [${s.slot}] thinking… ${s.text.length} chars`;
    case "budget:exceeded":
      return `  ⚠ budget exceeded at ${s.phase}: used ${s.used} / cap ${s.cap}`;
    case "flight:done":
      return `  flight outcome: ${s.outcome}`;
  }
}

async function cmdReroll(args: string[]): Promise<void> {
  const flightId = args.find((a) => !a.startsWith("--"));
  if (!flightId) {
    process.stderr.write(
      `usage: flytown reroll <flightId> [--no-fallback] [--budget <tokens>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const w = await loadTerrarium(process.cwd());
  const rewardPlugin = await loadRewardPlugin(w.root);
  const original = await w.compost.getFlight(flightId);
  if (!original) {
    process.stderr.write(`Flight ${flightId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Rerolling flight ${flightId}\n` +
      `  task: "${truncate(original.task, 80)}"\n` +
      `  swarm=${original.swarmSize}  personality=${original.personality}\n`,
  );
  const t0 = Date.now();
  const result = await reroll({
    flightId,
    cwd: w.root,
    compost: w.compost,
    rewardFn: rewardPlugin.fn,
    noFallback: flags["no-fallback"] === "true",
    budgetTokens: flags.budget ? Number(flags.budget) : undefined,
    onStep: (s) => process.stdout.write(formatFlightStep(s) + "\n"),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(
    `\nNew flight ${result.flight.id} (${result.flight.outcome}) in ${dt}s.\n` +
      `Compare: flytown compare ${flightId} ${result.flight.id}\n`,
  );
}

async function cmdExport(args: string[]): Promise<void> {
  const flightId = args.find((a) => !a.startsWith("--"));
  if (!flightId) {
    process.stderr.write(
      `usage: flytown export <flightId> [--out <path.md>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const w = await loadTerrarium(process.cwd());
  const md = await exportFlightMarkdown(w.compost, flightId);
  if (!md) {
    process.stderr.write(`Flight ${flightId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  if (flags.out) {
    await writeFile(flags.out, md, "utf8");
    process.stdout.write(`Wrote ${md.length} bytes to ${flags.out}\n`);
  } else {
    process.stdout.write(md);
    if (!md.endsWith("\n")) process.stdout.write("\n");
  }
}

async function cmdCompare(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [a, b] = positional;
  if (!a || !b) {
    process.stderr.write(`usage: flytown compare <flightA> <flightB>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadTerrarium(process.cwd());
  const report = await compareFlights(w.compost, a, b);
  if (!report) {
    process.stderr.write(`One or both flights not found (${a}, ${b}).\n`);
    process.exitCode = 1;
    return;
  }
  const fmt = (label: string, x: typeof report.a) =>
    `${label} ${x.flight.id}\n` +
    `  outcome:        ${x.flight.outcome}\n` +
    `  swarm:          ${x.flight.swarmSize}\n` +
    `  personality:    ${x.flight.personality}\n` +
    `  total morsels:  ${x.totalMorsels}\n` +
    `  total tokens:   ${x.totalTokens}\n` +
    `  avg drift rate: ${x.avgDriftRate.toFixed(4)}\n` +
    `  pass rate:      ${(x.passRate * 100).toFixed(0)}%\n`;
  process.stdout.write(
    fmt("A:", report.a) + "\n" + fmt("B:", report.b) + "\n",
  );
  process.stdout.write(
    `task identical: ${report.taskMatches ? "yes" : "no"}\n\n`,
  );
  if (report.a.winner) {
    process.stdout.write(
      `--- winner of A (${report.a.winner.id}) ---\n${report.a.winner.output}\n\n`,
    );
  }
  if (report.b.winner) {
    process.stdout.write(
      `--- winner of B (${report.b.winner.id}) ---\n${report.b.winner.output}\n`,
    );
  }
}

async function cmdAudit(args: string[]): Promise<void> {
  const flightId = args[0];
  if (!flightId) {
    process.stderr.write(`usage: flytown audit <flightId>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadTerrarium(process.cwd());
  const report = await auditFlight(w.compost, flightId);
  if (!report) {
    process.stderr.write(`Flight ${flightId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  const r = report.flight;
  process.stdout.write(
    `Audit of flight ${r.id}\n` +
      `  outcome:        ${r.outcome}\n` +
      `  task:           "${truncate(r.task, 80)}"\n` +
      `  total morsels:  ${report.totalMorsels}\n` +
      `  tokens:         total=${report.totalTokens} prompt=${report.promptTokens} completion=${report.completionTokens}\n` +
      `  longest chain:  depth=${report.longestChain.length}  ${report.longestChain.morselIds.join(" → ")}\n` +
      `  highest drift:  ${
        report.highestDrift
          ? `${report.highestDrift.caste} ${report.highestDrift.morselId} rate=${report.highestDrift.rate.toFixed(4)}`
          : "(none)"
      }\n\n`,
  );
  process.stdout.write(`By caste:\n`);
  for (const [caste, stats] of Object.entries(report.byCaste)) {
    if (stats.count === 0) continue;
    process.stdout.write(
      `  ${caste.padEnd(9)} n=${stats.count}  tokens=${stats.totalTokens}  ` +
        `avg drift=${stats.avgDriftRate.toFixed(4)}  avg sugar=${stats.avgRewardOrZero.toFixed(3)}\n`,
    );
  }
  if (report.warnings.length > 0) {
    process.stdout.write(`\nWarnings:\n`);
    for (const w of report.warnings) process.stdout.write(`  ⚠ ${w}\n`);
  }
  if (report.artifact) {
    process.stdout.write(`\nArtifact memory:\n`);
    process.stdout.write(`  id:             ${report.artifact.id}\n`);
    process.stdout.write(`  parents:        ${report.artifact.parentArtifactIds.length}\n`);
    process.stdout.write(`  children:       ${report.artifactChildren?.length ?? 0}\n`);
    process.stdout.write(`  claims:         ${report.artifact.claims.length}\n`);
    process.stdout.write(`  open questions: ${report.artifact.openQuestions.length}\n`);
    process.stdout.write(`  next steps:     ${report.artifact.nextSteps.length}\n`);
  } else {
    process.stdout.write(`\nArtifact memory: none (scribe failed or skipped)\n`);
  }
  if ((r.specialistMorselIds?.length ?? 0) > 0) {
    process.stdout.write(`\nSpecialist recovery: ${r.specialistMorselIds!.length} specialist(s)\n`);
    for (const sid of r.specialistMorselIds!) {
      const v = r.specialistVerdicts?.[sid];
      process.stdout.write(`  ${sid}  ${v ? `${v.passed ? "PASS" : "FAIL"} score=${v.score.toFixed(2)}` : "(no verdict)"}\n`);
    }
  }
}

async function cmdGraph(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    process.stderr.write(`usage: flytown graph <flightId|morselId>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadTerrarium(process.cwd());
  const flightRendered = await renderFlightGraph(w.compost, id);
  if (flightRendered) {
    process.stdout.write(flightRendered + "\n");
    return;
  }
  const morselRendered = await renderMorselAncestry(w.compost, id);
  if (morselRendered) {
    process.stdout.write(morselRendered + "\n");
    return;
  }
  process.stderr.write(`No flight or morsel found with id ${id}.\n`);
  process.exitCode = 1;
}

async function cmdDrift(): Promise<void> {
  const w = await loadTerrarium(process.cwd());
  const all = await w.compost.allMorsels();
  if (all.length === 0) {
    process.stdout.write(`Compost is empty.\n`);
    return;
  }
  process.stdout.write(`Compost contains ${all.length} morsel(s).\n\n`);

  const byCaste = new Map<Caste, number[]>();
  for (const k of CASTES) byCaste.set(k, []);
  for (const l of all) byCaste.get(l.caste)?.push(l.drift.driftRate);

  process.stdout.write(
    `Drift rate by caste (caste-name mentions / total words):\n`,
  );
  for (const k of CASTES) {
    const rates = byCaste.get(k) ?? [];
    if (rates.length === 0) {
      process.stdout.write(`  ${k.padEnd(9)} (n=0)\n`);
      continue;
    }
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    process.stdout.write(
      `  ${k.padEnd(9)} avg=${avg.toFixed(4)}  n=${rates.length}\n`,
    );
  }
  process.stdout.write(
    `\nNote: drift is reported, not penalised by sugar. High drift can mean the themed\n` +
      `worker prompts are leaking into outputs, or just ordinary use of words such as\n` +
      `"guard" and "scout". Read the morsels before changing prompts.\n`,
  );
}

async function cmdCompost(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const w = await loadTerrarium(process.cwd());
  const limit = flags.limit ? Math.max(1, Number(flags.limit)) : Infinity;
  const since = flags.since ? parseTimestamp(flags.since) : null;
  const caste = flags.caste as Caste | undefined;
  const filterFlight = flags.flight;
  const filterForay = flags.foray;

  if (caste && !CASTES.includes(caste)) {
    process.stderr.write(`unknown --caste: ${caste}\n`);
    process.exitCode = 1;
    return;
  }

  let morsels = await w.compost.allMorsels();
  if (caste) morsels = morsels.filter((l) => l.caste === caste);
  if (since !== null) morsels = morsels.filter((l) => l.timestamp >= since);
  if (filterFlight) morsels = morsels.filter((l) => l.flightId === filterFlight);
  if (filterForay) morsels = morsels.filter((l) => l.forayId === filterForay);
  morsels.sort((a, b) => b.timestamp - a.timestamp);
  if (Number.isFinite(limit)) morsels = morsels.slice(0, limit);

  let flights = await w.compost.allFlights();
  if (since !== null) flights = flights.filter((r) => r.startedAt >= since);
  flights.sort((a, b) => b.startedAt - a.startedAt);

  let forays = await w.compost.allForays();
  if (since !== null) forays = forays.filter((q) => q.startedAt >= since);
  forays.sort((a, b) => b.startedAt - a.startedAt);

  process.stdout.write(
    `Compost at ${w.root}\n` +
      `  morsels: ${morsels.length}${caste ? ` (caste=${caste})` : ""}` +
      `${since !== null ? ` (since=${new Date(since).toISOString()})` : ""}\n` +
      `  forays:  ${forays.length}\n` +
      `  flights: ${flights.length}\n\n`,
  );

  if (caste || filterFlight || filterForay || since !== null) {
    for (const l of morsels) {
      const tokens = l.usage ? `tokens=${l.usage.totalTokens} ` : "";
      process.stdout.write(
        `  ${l.caste.padEnd(9)} ${l.id}  ${tokens}drift=${l.drift.driftRate.toFixed(4)}` +
          ` ${new Date(l.timestamp).toISOString()}\n`,
      );
    }
    return;
  }

  for (const r of flights) {
    process.stdout.write(
      `  flight ${r.id}  ${r.outcome.padEnd(16)}  swarm=${r.swarmSize}\n` +
        `    "${truncate(r.task, 80)}"\n`,
    );
  }
  for (const q of forays) {
    process.stdout.write(
      `  foray  ${q.id}  swarm=${q.swarmSize}  winner=${q.winnerMorselId ?? "—"}\n` +
        `    "${truncate(q.task, 80)}"\n`,
    );
  }
}

function parseTimestamp(raw: string): number {
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && raw.trim().length > 0) {
    // 10-digit values are seconds; longer values are milliseconds
    if (raw.length <= 10) return asNum * 1000;
    return asNum;
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Could not parse --since value: ${raw}`);
}

async function cmdRoute(args: string[]): Promise<void> {
  const sub = args[0];
  const w = await loadTerrarium(process.cwd());
  const routes = w.manifest.provider?.routes ?? {};
  if (!sub || sub === "ls" || sub === "list") {
    process.stdout.write(`Per-caste routes:\n`);
    for (const slot of MODEL_SLOTS) {
      const route = routes[slot];
      if (!route) {
        process.stdout.write(`  ${slot.padEnd(9)} (default provider)\n`);
        continue;
      }
      const bits = [
        `preset=${route.preset}`,
        route.model ? `model=${route.model}` : "",
        route.baseURL ? `base=${route.baseURL}` : "",
        route.apiKeyEnv ? `key=${route.apiKeyEnv}` : "",
        route.outputFormat ? `format=${route.outputFormat}` : "",
      ].filter(Boolean);
      process.stdout.write(`  ${slot.padEnd(9)} ${bits.join(" ")}\n`);
    }
    return;
  }
  if (sub === "clear") {
    const flags = parseFlags(args.slice(1));
    const slotRaw = args.slice(1).find((a) => !a.startsWith("--"));
    if (flags.all === "true") {
      w.manifest.provider = {
        ...(w.manifest.provider ?? { preset: "openai" }),
        routes: {},
      };
      await saveTerrariumManifest(w);
      process.stdout.write(`Cleared all route overrides.\n`);
      return;
    }
    if (!slotRaw || !isModelSlot(slotRaw)) {
      process.stderr.write(
        `usage: flytown route clear <${MODEL_SLOTS.join("|")}> | --all\n`,
      );
      process.exitCode = 1;
      return;
    }
    const next = { ...(w.manifest.provider?.routes ?? {}) };
    delete next[slotRaw];
    w.manifest.provider = {
      ...(w.manifest.provider ?? { preset: "openai" }),
      routes: next,
    };
    await saveTerrariumManifest(w);
    process.stdout.write(`Cleared route for ${slotRaw}.\n`);
    return;
  }
  if (sub === "set") {
    const rest = args.slice(1);
    const slotRaw = rest.find((a) => !a.startsWith("--"));
    const flags = parseFlags(rest);
    if (!slotRaw || !isModelSlot(slotRaw)) {
      process.stderr.write(
        `usage: flytown route set <${MODEL_SLOTS.join("|")}> --preset <${Object.keys(PROVIDER_PRESETS).join("|")}> [--model <name>] [--base-url <url>] [--api-key-env <ENV>] [--format freeform|markdown|json]\n`,
      );
      process.exitCode = 1;
      return;
    }
    const preset = flags.preset;
    if (!preset || !(preset in PROVIDER_PRESETS)) {
      process.stderr.write(
        `--preset is required and must be one of: ${Object.keys(PROVIDER_PRESETS).join(", ")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const route = {
      preset: preset as keyof typeof PROVIDER_PRESETS,
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags["base-url"] ? { baseURL: flags["base-url"] } : {}),
      ...(flags["api-key-env"] ? { apiKeyEnv: flags["api-key-env"] } : {}),
      ...(flags.format
        ? { outputFormat: normalizeOutputFormat(flags.format) }
        : {}),
    };
    w.manifest.provider = {
      ...(w.manifest.provider ?? { preset: "openai" }),
      routes: {
        ...(w.manifest.provider?.routes ?? {}),
        [slotRaw]: route,
      },
    };
    await saveTerrariumManifest(w);
    process.stdout.write(`Route set for ${slotRaw}: preset=${preset}\n`);
    return;
  }
  process.stderr.write(
    `usage: flytown route [list|set|clear]\n` +
      `  set:   flytown route set <slot> --preset <id> [--model <name>] [--base-url <url>] [--api-key-env <ENV>] [--format freeform|markdown|json]\n` +
      `  clear: flytown route clear <slot>|--all\n`,
  );
  process.exitCode = 1;
}

async function cmdServe(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const port = flags.port ? Number(flags.port) : 7777;
  await serve({ cwd: process.cwd(), port, ...(flags.host ? { host: flags.host } : {}) });
}

async function cmdPlan(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const task = positional[0];
  if (!task) {
    process.stderr.write(`usage: flytown plan "<task>" [--max-nodes N] [--max-replan N] [--budget tokens] [--cite <flightId>]... [--remember]\n`);
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const cites = collectFlag(args, "cite");
  const remember = flags.remember === "true";
  const maxNodes = flags["max-nodes"] ? Number(flags["max-nodes"]) : 6;
  const maxReplan = flags["max-replan"] ? Number(flags["max-replan"]) : 2;
  const budgetTokens = flags.budget ? Number(flags.budget) : undefined;
  const maxOutputTokensPerCall = flags["max-output"] ? Number(flags["max-output"]) : undefined;

  const w = await loadTerrarium(process.cwd());
  const outputFormat = normalizeOutputFormat(
    flags.format ?? w.manifest.provider?.outputFormat,
  );
  const rewardPlugin = await loadRewardPlugin(w.root);

  const parents: Artifact[] = [];
  for (const r of cites) {
    const a = await w.compost.getArtifactByFlightId(r);
    if (a) parents.push(a);
  }
  if (remember) {
    const all = await w.compost.allArtifacts();
    const { findRelevantArtifactsEmbedded } = await import("./embeddings.js");
    const auto = (await findRelevantArtifactsEmbedded({
      artifacts: all,
      queryText: task,
      limit: 3,
      compost: w.compost,
    })).filter(
      (a) => !parents.some((p) => p.id === a.id),
    );
    parents.push(...auto);
  }
  if (parents.length > 0) {
    process.stdout.write(`(loaded ${parents.length} prior artifact(s))\n`);
  }

  const { DEFAULT_PLANNER, resolvePlannerBackend } = await import("./flytown/registry.js");
  const plannerSpec = flags.planner ?? w.manifest.flytown?.planner ?? DEFAULT_PLANNER;
  process.stdout.write(`Planning task (planner=${plannerSpec})...\n`);
  const planner = resolvePlannerBackend(plannerSpec, {
    root: w.root, seed: w.manifest.flytown?.seed, connectome: w.manifest.flytown?.connectome, learning: w.manifest.flytown?.learning,
    fallback: w.manifest.flytown?.fallbackToLlm !== false,
    onFallback: (err) => process.stderr.write(`[fly] planner "${plannerSpec}" failed, falling back to llm: ${err instanceof Error ? err.message : String(err)}\n`),
  });
  const planned = await planner.plan({
    task,
    cwd: w.root,
    parentArtifacts: parents,
    maxNodes,
    maxOutputTokens: maxOutputTokensPerCall,
    budgetTokens,
  });
  const { plan } = planned;
  if (planned.trace) {
    const { writeTrace } = await import("./flytown/trace.js");
    await writeTrace(w.root, planned.trace);
  }
  if (plan.halt) {
    process.stdout.write(`Plan ${plan.id}: halted (${plan.halt.kind}) — ${plan.halt.reason}\n`);
    return;
  }
  process.stdout.write(`Plan ${plan.id}: ${plan.nodes.length} node(s)\n`);
  for (const n of plan.nodes) {
    const inputs = n.inputs.length > 0 ? ` ← [${n.inputs.join(",")}]` : "";
    process.stdout.write(`  ${n.id} (${n.kind}, swarm=${n.swarmSize ?? 3}, ${n.personality ?? "?"}): ${truncate(n.task, 80)}${inputs}\n`);
  }
  process.stdout.write(`Executing...\n\n`);

  const { executePlan } = await import("./plan-executor.js");
  const t0 = Date.now();
  const result = await executePlan({
    plan,
    cwd: w.root,
    compost: w.compost,
    rewardFn: rewardPlugin.fn,
    budgetTokens,
    maxOutputTokensPerCall,
    outputFormat,
    parentArtifacts: parents,
    maxReplanDepth: maxReplan,
    planner,
    onPlanEvent: (ev) => {
      if (ev.kind === "plan:node:start") process.stdout.write(`  ▸ node ${ev.nodeId} starting\n`);
      else if (ev.kind === "plan:node:done") process.stdout.write(`  ✓ node ${ev.nodeId} done — flight=${ev.flightId} outcome=${ev.outcome}${ev.artifactId ? ` artifact=${ev.artifactId}` : ""}\n`);
      else if (ev.kind === "plan:node:failed") process.stdout.write(`  ✗ node ${ev.nodeId} failed: ${ev.reason}\n`);
      else if (ev.kind === "plan:replan") process.stdout.write(`  ↻ replanning (depth ${ev.depth}): ${ev.reason}\n`);
      else if (ev.kind === "plan:done") process.stdout.write(`  ${ev.outcome === "success" ? "✓" : "✗"} plan ${ev.outcome}\n`);
    },
    onStep: (nodeId, step) => process.stdout.write(`    [${nodeId}] ${formatFlightStep(step)}\n`),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\nPlan finished in ${dt}s — ${result.outcome}\n`);
  if (result.finalArtifact) {
    process.stdout.write(`Final artifact: ${result.finalArtifact.id}\n`);
  }
}

/**
 * flytown secret set <ENV_NAME>    — store a provider API key for this Terrarium
 *                                     (prompted with echo off on a TTY, or read from stdin)
 * flytown secret clear <ENV_NAME>  — remove it
 * flytown secret list              — names only, never values
 * Keys live in .flytown/provider-secrets.json (mode 0600) and are picked up
 * automatically by the provider resolver for this Terrarium.
 */
async function cmdSecret(args: string[]): Promise<void> {
  const [sub, name] = args;
  const w = await loadTerrarium(process.cwd());
  const { setProviderSecretForRoot, clearProviderSecretForRoot, readProviderSecretsForRootSync } = await import("./provider-secrets.js");
  if (sub === "list") {
    const names = Object.keys(readProviderSecretsForRootSync(w.root));
    process.stdout.write(names.length ? names.join("\n") + "\n" : `(no stored secrets for ${w.root})\n`);
    return;
  }
  if ((sub !== "set" && sub !== "clear") || !name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) {
    process.stderr.write(`usage: flytown secret set|clear <ENV_NAME>   |   flytown secret list\n`);
    process.exitCode = 1;
    return;
  }
  if (sub === "clear") {
    await clearProviderSecretForRoot(w.root, name);
    process.stdout.write(`cleared ${name} for ${w.root}\n`);
    return;
  }
  const value = (await readSecretFromTerminal(`Paste ${name} (input hidden): `)).trim();
  if (!value) { process.stderr.write(`no value read; nothing stored\n`); process.exitCode = 1; return; }
  await setProviderSecretForRoot(w.root, name, value);
  process.stdout.write(`stored ${name} for ${w.root} (${value.length} chars, file mode 0600)\n`);
}

async function readSecretFromTerminal(prompt: string): Promise<string> {
  const { stdin } = process;
  if (!stdin.isTTY) {
    return new Promise((resolve) => { let buf = ""; stdin.setEncoding("utf8"); stdin.on("data", (d) => { buf += d; }); stdin.on("end", () => resolve(buf)); });
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let buf = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stdout.write("\n"); resolve(buf); return; }
        if (c === "") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (c === "" || c === "\b") { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function cmdExportTrace(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const idArg = positional[0];
  if (!idArg) {
    process.stderr.write(
      `usage: flytown export-trace <runId|flightId> [--out <path.json>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const w = await loadTerrarium(process.cwd());
  const runDir = await ensureRunDir(w.root);
  let run = await loadRun(runDir, idArg);
  if (!run) {
    // Allow lookup by flightId.
    const all = await loadAllRuns(runDir);
    run = all.find((r) => r.finalFlightId === idArg) ?? null;
  }
  if (!run) {
    process.stderr.write(`No run or flight found for "${idArg}".\n`);
    process.exitCode = 1;
    return;
  }
  const trace = exportRunAsMasTrace(run, w.manifest.name);
  const json = JSON.stringify(trace, null, 2);
  if (flags.out) {
    await writeFile(flags.out, json, "utf8");
    process.stdout.write(`Wrote ${flags.out} (${trace.events.length} events, ${trace.edges.length} edges).\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

async function cmdReset(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const yes = flags.yes === "true" || flags.y === "true";
  const onlyArtifacts = flags.artifacts === "true";
  const onlyRuns = flags.runs === "true";
  const onlyCompost = flags.compost === "true";
  // Default = --all: compost + runs.
  const all = flags.all === "true" || (!onlyArtifacts && !onlyRuns && !onlyCompost);

  const w = await loadTerrarium(process.cwd());
  const root = w.root;
  const targets: { label: string; path: string }[] = [];
  if (all || onlyCompost) {
    targets.push(
      { label: "morsels",   path: w.compost.morselDir },
      { label: "forays",    path: w.compost.forayDir },
      { label: "flights",   path: w.compost.flightDir },
      { label: "artifacts", path: w.compost.artifactDir },
      { label: "inbox",     path: w.compost.inboxDir },
      { label: "outbox",    path: w.compost.outboxDir },
    );
  }
  if (onlyArtifacts) {
    targets.push({ label: "artifacts", path: w.compost.artifactDir });
  }
  if (all || onlyRuns) {
    targets.push({ label: "runs", path: join(root, ".flytown", "runs") });
  }

  // Show what will be deleted.
  process.stdout.write(`Reset target(s) under ${root}/.flytown/:\n`);
  let totalFiles = 0;
  for (const t of targets) {
    const n = await countFiles(t.path);
    totalFiles += n;
    process.stdout.write(`  ${t.label.padEnd(10)}  ${n} file(s)  (${t.path})\n`);
  }
  if (totalFiles === 0) {
    process.stdout.write(`Nothing to delete.\n`);
    return;
  }

  if (!yes) {
    process.stdout.write(`\nThis will delete ${totalFiles} file(s). terrarium.json and reward.mjs are preserved.\n`);
    process.stdout.write(`Type "RESET" to confirm: `);
    const answer = await readStdinLine();
    if (answer.trim() !== "RESET") {
      process.stdout.write(`Aborted.\n`);
      return;
    }
  }

  for (const t of targets) {
    try {
      await rm(t.path, { recursive: true, force: true });
      await mkdir(t.path, { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  warning: failed to reset ${t.label}: ${msg}\n`);
    }
  }
  process.stdout.write(`Terrarium reset (${totalFiles} file(s) cleared).\n`);
}

async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer | string): void => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl));
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

async function cmdFold(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const threshold = flags.threshold ? Number(flags.threshold) : 30;
  const minOverlap = flags["min-overlap"] ? Number(flags["min-overlap"]) : 2;
  const maxCluster = flags["max-cluster"] ? Number(flags["max-cluster"]) : 6;
  const minAgeDays = flags["min-age-days"] ? Number(flags["min-age-days"]) : 7;

  const w = await loadTerrarium(process.cwd());
  const { foldArtifacts } = await import("./fold.js");
  const { created, foldedInputCount } = await foldArtifacts({
    compost: w.compost,
    threshold,
    minOverlap,
    maxClusterSize: maxCluster,
    minAgeDays,
    onProgress: (m) => process.stdout.write(`  ${m}\n`),
  });
  process.stdout.write(`Folded ${foldedInputCount} input artifact(s) into ${created.length} summary artifact(s).\n`);
  for (const a of created) {
    process.stdout.write(`  ${a.id}  parents=${a.parentArtifactIds.length}  task="${truncate(a.task, 80)}"\n`);
  }
}

async function cmdAncestry(args: string[]): Promise<void> {
  const flightId = args.find((a) => !a.startsWith("--"));
  if (!flightId) {
    process.stderr.write(`usage: flytown ancestry <flightId>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadTerrarium(process.cwd());
  const all = await w.compost.allArtifacts();
  const root = all.find((a) => a.flightId === flightId || a.id === flightId);
  if (!root) {
    process.stderr.write(`No artifact found for flight/id "${flightId}".\n`);
    process.exitCode = 1;
    return;
  }

  // Walk parents
  const byId = new Map(all.map((a) => [a.id, a] as const));
  const parents: typeof all = [];
  const seen = new Set<string>();
  const queue = [...root.parentArtifactIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const a = byId.get(id);
    if (!a) continue;
    parents.push(a);
    queue.push(...a.parentArtifactIds);
  }

  // Walk children (any artifact citing root in its parents)
  const children = all.filter((a) => a.parentArtifactIds.includes(root.id));

  const fmt = (a: typeof root): string =>
    `  ${a.id}  flight=${a.flightId}  outcome=${a.outcome}  task="${truncate(a.task, 70)}"`;

  process.stdout.write(`Ancestry for artifact ${root.id} (flight ${root.flightId}):\n\n`);
  if (parents.length > 0) {
    process.stdout.write(`Parents (${parents.length}):\n`);
    for (const p of parents) process.stdout.write(fmt(p) + "\n");
  } else {
    process.stdout.write(`Parents: (none — root flight)\n`);
  }
  process.stdout.write(`\nThis:\n${fmt(root)}\n`);
  if (children.length > 0) {
    process.stdout.write(`\nChildren (${children.length}):\n`);
    for (const c of children) process.stdout.write(fmt(c) + "\n");
  } else {
    process.stdout.write(`\nChildren: (none yet)\n`);
  }

  if (root.claims.length > 0) {
    process.stdout.write(`\nClaims:\n`);
    for (const c of root.claims) {
      process.stdout.write(`  - (${c.confidence}) ${c.text}\n`);
    }
  }
  if (root.openQuestions.length > 0) {
    process.stdout.write(`\nOpen questions:\n`);
    for (const q of root.openQuestions) process.stdout.write(`  - ${q}\n`);
  }
  if (root.nextSteps.length > 0) {
    process.stdout.write(`\nSuggested next steps:\n`);
    for (const n of root.nextSteps) process.stdout.write(`  - ${n}\n`);
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function normalizeChatSource(raw: string | undefined): ChatImportSource | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "codex" || value === "chatgpt" || value === "folder") return value;
  throw new Error("--source must be codex, chatgpt, or folder");
}

function splitCsv(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function shellArgsToSlashLine(args: string[]): string {
  return args.map((arg, index) => (index === 0 ? arg : quoteSlashArg(arg))).join(" ");
}

function quoteSlashArg(arg: string): string {
  return /^[^\s"'\\]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function clampCliLimit(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function collectFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--")) {
      out.push(args[i + 1]);
      i++;
    }
  }
  return out;
}

function isModelSlot(value: string): value is ModelSlot {
  return MODEL_SLOTS.includes(value as ModelSlot);
}

function formatMentions(m: Record<Caste, number>): string {
  return CASTES.map((k) => `${k}:${m[k]}`).join(" ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

main().catch((err) => {
  process.stderr.write(`\nFLYTOWN error: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
