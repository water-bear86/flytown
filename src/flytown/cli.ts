/**
 * `fly` CLI — plain-text, non-graphical access to everything FLYTOWN does.
 *
 *   fly plan "<task>" [--planner spec] [--dry-run] [--max-nodes N] [--seed N] [--no-fallback]
 *   fly eval [--planners a,b,c] [--seeds N] [--fixtures id,id] [--out dir] [--max-replan N] [--traces]
 *   fly trace <runId>            fly traces
 *   fly replay <runId>           re-run a stored decision deterministically and diff
 *   fly connectome [id]          fly regions [id]
 *   fly planners
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTerrarium } from "../terrarium.js";
import { loadRewardPlugin } from "../reward-plugin.js";
import { executePlan } from "../plan-executor.js";
import type { Artifact } from "../types.js";
import { DEFAULT_PLANNER, KNOWN_PLANNER_SPECS, resolvePlannerBackend } from "./registry.js";
import { listTraces, readTrace, renderTraceText, writeTrace, type DecisionTrace } from "./trace.js";
import { defaultConnectomeRoot, listConnectomes, loadConnectome, degreeStats, groupIndex } from "./connectome/artifact.js";
import { runHarness } from "./eval/harness.js";
import { FIXTURES, FIXTURE_REPOS, FIXTURE_SUITE, fixtureAvailability } from "./eval/fixtures.js";

export async function runFlyCli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const args = argv.slice(1);
  switch (cmd) {
    case "plan": return cmdPlan(args);
    case "eval": return cmdEval(args);
    case "trace": return cmdTrace(args);
    case "traces": return cmdTraces();
    case "replay": return cmdReplay(args);
    case "connectome": return cmdConnectome(args);
    case "regions": return cmdRegions(args);
    case "groups": return cmdGroups(args);
    case "sensitivity": return cmdSensitivity(args);
    case "effects": return cmdEffects(args);
    case "hash": return cmdHash(args);
    case "fixtures": return cmdFixtures(args);
    case "planners": {
      process.stdout.write(KNOWN_PLANNER_SPECS.join("\n") + "\n  (flags combine with '+', e.g. fly:shuffled+norecurrence, fly:ablate=MB_CA,MB_ML)\n");
      return;
    }
    default:
      process.stderr.write(`usage: fly <plan|eval|trace|traces|replay|connectome|regions|groups|sensitivity|effects|hash|fixtures|planners> ...\n`);
      process.exitCode = 1;
  }
}

async function cmdFixtures(args: string[]): Promise<void> {
  const f = flags(args);
  const { fetchFixtureRepos, fixtureRepoPath, fixtureRepoState, fixturesRoot } = await import("./eval/fixture-repos.js");
  const repos = Object.values(FIXTURE_REPOS);
  const sub = positional(args)[0];
  if (sub === "fetch") {
    const results = await fetchFixtureRepos(repos, { force: f.force === "true", log: (line) => process.stdout.write(line + "\n") });
    for (const r of results) process.stdout.write(`${r.repo.name.padEnd(10)} ${r.action.padEnd(12)} ${r.after.padEnd(14)} ${r.path}\n`);
    if (results.some((r) => r.after !== "ready")) process.exitCode = 1;
    return;
  }
  if (sub && sub !== "status") {
    process.stderr.write(`usage: fly fixtures [status]  |  fly fixtures fetch [--force]\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`suite ${FIXTURE_SUITE}: ${FIXTURES.length} tasks · repositories under ${fixturesRoot()}\n`);
  for (const repo of repos) {
    const state = await fixtureRepoState(repo);
    const tasks = FIXTURES.filter((x) => x.pinned?.name === repo.name).length;
    process.stdout.write(`${repo.name.padEnd(10)} ${repo.commit.slice(0, 12)}  ${state.padEnd(14)} ${String(tasks).padStart(2)} tasks  ${repo.url}\n`);
    if (state !== "ready") process.stdout.write(`${"".padEnd(10)} ${fixtureRepoPath(repo)}\n`);
  }
  if (!(await Promise.all(repos.map((r) => fixtureRepoState(r)))).every((s) => s === "ready")) process.stdout.write(`\nRun \`flytown fly fixtures fetch\` to download the pinned commits.\n`);
}

async function cmdGroups(args: string[]): Promise<void> {
  const id = positional(args)[0] ?? (await listConnectomes())[0];
  if (!id) { process.stderr.write(`no connectome artifacts available\n`); process.exitCode = 1; return; }
  const g = await loadConnectome(id);
  const groups = groupIndex(g);
  const prefix = flags(args).prefix;
  const rows = [...groups.entries()].filter(([k]) => !k.startsWith("node:") && (!prefix || k.startsWith(prefix))).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  process.stdout.write(`${g.id}: ${rows.length} groups over ${g.n} nodes${prefix ? ` (prefix ${prefix})` : ""}\n`);
  for (const [k, idx] of rows) process.stdout.write(`  ${k.padEnd(40)} ${String(idx.length).padStart(6)}\n`);
  if (g.plasticity?.plasticEdges) {
    const spec = g.plasticity.plasticEdges;
    process.stdout.write(`plastic site: ${spec.preGroup} → ${spec.postGroup}${spec.channel ? ` (channel ${spec.channel})` : ""} [${spec.tag}]\n  rule: ${spec.rule}\n`);
    const d = g.plasticity.dopaminergic;
    if (d) process.stdout.write(`dopaminergic: appetitive=${d.appetitive.length} aversive=${d.aversive.length} unknown=${d.unknown?.length ?? 0} [${d.tag}] ${d.source ?? ""}\n`);
  }
}

/**
 * Where does task information go? Mean pairwise Jensen–Shannon divergence
 * (bits) across the fixture suite at each stage of a fly planner:
 * raw features → encoder input → final activity → action scores.
 */
async function cmdSensitivity(args: string[]): Promise<void> {
  const f = flags(args);
  const specs = (f.planners ?? f.planner ?? "fly,fly:shuffled").split(",").map((s) => s.trim()).filter(Boolean);
  const root = await rootOrCwd();
  const { jsDivergence } = await import("./eval/harness.js");
  const { scanRepo } = await import("./signals.js");
  const repoCache = new Map<string, import("./signals.js").RepoSignals>();
  for (const fx of FIXTURES) if (!repoCache.has(fx.repo)) repoCache.set(fx.repo, await scanRepo(fx.repo));
  const norm = (rec: Record<string, number>) => { const s = Object.values(rec).reduce((a, b) => a + b, 0); return s > 0 ? Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v / s])) : rec; };
  const pair = (rows: Record<string, number>[]) => { let s = 0, n = 0; for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) { s += jsDivergence(rows[i], rows[j]); n++; } return n ? s / n : 0; };
  process.stdout.write(`stage-wise task sensitivity over ${FIXTURES.length} fixtures (mean pairwise JS divergence, bits; 0 = every task identical)\n`);
  process.stdout.write(`planner`.padEnd(44) + `features   input   final   scores  distinct-primary\n`);
  for (const spec of specs) {
    const backend = resolvePlannerBackend(spec, { root, seed: f.seed ? Number(f.seed) : 1, fallback: false });
    const feats: Record<string, number>[] = [], inputs: Record<string, number>[] = [], finals: Record<string, number>[] = [], scores: Record<string, number>[] = [];
    const primaries = new Set<string>();
    for (const fx of FIXTURES) {
      const res = await backend.plan({ task: fx.task, cwd: fx.repo, repo: repoCache.get(fx.repo), extraSignals: fx.extra, runId: `sens-${fx.id}`, parentArtifacts: Array.from({ length: fx.priorArtifacts ?? 0 }, (_, i) => ({ id: `p${i}`, flightId: "r", task: fx.task, outcome: "winner" as const, claims: [], evidence: [], openQuestions: [], nextSteps: [], parentArtifactIds: [], keywords: [], timestamp: 0 })) });
      const t = res.trace!;
      feats.push(norm(t.features ?? {}));
      scores.push(t.actionScores);
      primaries.add(t.decision.primary);
      if (t.brain) { inputs.push(norm(t.brain.input)); finals.push(norm(t.brain.steps.at(-1)?.activity ?? {})); }
    }
    const fmt = (v: number) => v.toFixed(3).padStart(7);
    process.stdout.write(`${spec.padEnd(44)}${fmt(pair(feats))} ${fmt(pair(inputs))} ${fmt(pair(finals))} ${fmt(pair(scores))}   ${primaries.size}\n`);
  }
}

const EFFECT_AUDIT_DEFAULT = "rules,random,fly,fly:shuffled,fly:connectome=l1-larva-winding2023-1+plastic,fly:connectome=l1-larva-winding2023-1+shuffled+plastic";

async function cmdEffects(args: string[]): Promise<void> {
  const f = flags(args);
  const specs = (f.planners ?? f.planner ?? EFFECT_AUDIT_DEFAULT).split(",").map((s) => s.trim()).filter(Boolean);
  const { effectAudit } = await import("./eval/effects-audit.js");
  const rows = await effectAudit(specs, { root: await rootOrCwd(), seed: f.seed ? Number(f.seed) : 1 });
  const n = rows[0]?.fixtures ?? 0;
  process.stdout.write(`action-effect audit over ${n} fixtures (decide only, no workers, no model calls)\n`);
  process.stdout.write(`primary: shaped / default / inert · shaped = changed the plan · default = the plan has it anyway · inert = ignored by the compiler\n\n`);
  process.stdout.write("planner".padEnd(58) + "primary s/d/i  selected  shaped  =default  =rules  halts  top-margin\n");
  for (const r of rows) {
    const pr = `${r.primaryShaped}/${r.primaryDefault}/${r.primaryInert}`;
    process.stdout.write(r.planner.padEnd(58) + pr.padStart(13) + r.selectedPerDecision.toFixed(2).padStart(10) + r.shapedPerDecision.toFixed(2).padStart(8) + String(r.planIsDefault).padStart(10) + (r.planMatchesRules === null ? "-" : String(r.planMatchesRules)).padStart(8) + String(r.halts).padStart(7) + r.meanTopMargin.toFixed(3).padStart(12) + "\n");
  }
  process.stdout.write("\nprimary actions:\n");
  for (const r of rows) process.stdout.write(`  ${r.planner}: ${Object.entries(r.primaries).sort((a, b) => b[1] - a[1]).map(([a, c]) => `${a}×${c}`).join(" ")}\n`);
}

/**
 * The model-free mushroom-body hash test: is the Kenyon-cell code of the real
 * wiring a better task hash than label-shuffled and degree-preserving rewired
 * copies of the same graph? Deterministic; no model calls.
 */
async function cmdHash(args: string[]): Promise<void> {
  const f = flags(args);
  const id = f.connectome ?? "l1-larva-winding2023-1";
  const list = (v: string | undefined, d: number[]) => (v ? v.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x)) : d);
  const odorFractions = list(f.odor, [0.024, 0.05, 0.1, 0.15]);
  const seeds = list(f.seeds, [1, 2, 3]);
  const { hashExperiment, renderHashReport } = await import("./eval/hash-experiment.js");
  const graph = await loadConnectome(id, { root: f["connectome-root"] ?? defaultConnectomeRoot() });
  process.stderr.write(`hash test on ${id}: ${graph.n} neurons, ${graph.src.length} edges, odour sparseness ${odorFractions.join(",")}, null seeds ${seeds.join(",")}\n`);
  const h = await hashExperiment(graph, { seeds, odorFractions, sparseness: f.sparseness ? Number(f.sparseness) : undefined });
  const report = renderHashReport(h, [], id).replace(/\n## 2\. Does a stored association generalise[\s\S]*$/, "\n");
  if (f.out) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(f.out, report + "\n", "utf8");
    process.stdout.write(`report: ${f.out}\n`);
  } else {
    process.stdout.write(report + "\n");
  }
}

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = "true";
  }
  return out;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { if (!args[i].includes("=") && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) i++; continue; }
    out.push(args[i]);
  }
  return out;
}

async function cmdPlan(args: string[]): Promise<void> {
  const task = positional(args)[0];
  const f = flags(args);
  if (!task) { process.stderr.write(`usage: fly plan "<task>" [--planner fly|rules|random|learned|llm] [--dry-run] [--max-nodes N] [--seed N] [--no-fallback]\n`); process.exitCode = 1; return; }
  const w = await loadTerrarium(process.cwd());
  const spec = f.planner ?? w.manifest.flytown?.planner ?? DEFAULT_PLANNER;
  const seed = f.seed ? Number(f.seed) : w.manifest.flytown?.seed;
  const backend = resolvePlannerBackend(spec, {
    root: w.root, seed, connectome: w.manifest.flytown?.connectome, learning: w.manifest.flytown?.learning,
    fallback: f["no-fallback"] ? false : w.manifest.flytown?.fallbackToLlm !== false,
    onFallback: (err) => process.stderr.write(`[fly] planner "${spec}" failed, falling back to llm: ${err instanceof Error ? err.message : String(err)}\n`),
  });
  const runId = `${spec.replace(/[^a-z0-9]+/gi, "_")}-${Date.now().toString(36)}`;
  const res = await backend.plan({ task, cwd: w.root, maxNodes: f["max-nodes"] ? Number(f["max-nodes"]) : 6, runId });
  if (res.trace) {
    await writeTrace(w.root, res.trace);
    process.stdout.write(renderTraceText(res.trace) + "\n");
  } else {
    process.stdout.write(`plan ${res.plan.id} (${res.plan.plannerId}) — ${res.plan.nodes.length} node(s)\n`);
  }
  if (f["dry-run"]) { process.stdout.write(`(dry run — not executed; trace ${runId})\n`); return; }
  const rewardPlugin = await loadRewardPlugin(w.root);
  const result = await executePlan({
    plan: res.plan, cwd: w.root, compost: w.compost, planner: backend, rewardFn: rewardPlugin.fn, parentArtifacts: [] as Artifact[],
    maxReplanDepth: f["max-replan"] ? Number(f["max-replan"]) : 2,
    onPlanEvent: (ev) => process.stdout.write(`  [plan] ${ev.kind}${"nodeId" in ev ? ` ${ev.nodeId}` : ""}${"reason" in ev ? ` ${ev.reason}` : ""}\n`),
  });
  process.stdout.write(`plan ${result.outcome}${result.halt ? ` (${result.halt.kind}: ${result.halt.reason})` : ""}${result.finalArtifact ? ` artifact=${result.finalArtifact.id}` : ""}\n`);
}

async function cmdEval(args: string[]): Promise<void> {
  const f = flags(args);
  const planners = (f.planners ?? "rules,random,fly,fly:shuffled").split(",").map((s) => s.trim()).filter(Boolean);
  const nSeeds = f.seeds ? Number(f.seeds) : 3;
  if (!Number.isInteger(nSeeds) || nSeeds < 1) {
    process.stderr.write(`--seeds takes a count of seeds (e.g. --seeds 3 runs seeds 1..3), got "${f.seeds}"\n`);
    process.exitCode = 1;
    return;
  }
  const seeds = Array.from({ length: nSeeds }, (_, i) => i + 1);
  const ids = f.fixtures ? new Set(f.fixtures.split(",")) : null;
  const fixtures = ids ? FIXTURES.filter((x) => ids.has(x.id)) : FIXTURES;
  let root = f.out;
  if (!root) { try { root = (await loadTerrarium(process.cwd())).root; } catch { root = process.cwd(); } }
  let live: import("./eval/harness.js").LiveOptions | undefined;
  if (f.live === "true" || f.terrarium) {
    const terrariumRoot = f.terrarium ?? (await loadTerrarium(process.cwd())).root;
    live = {
      terrariumRoot,
      swarmSize: f.swarm ? Number(f.swarm) : 2,
      maxOutputTokensPerCall: f["max-output"] ? Number(f["max-output"]) : 400,
      budgetTokensPerRun: f.budget ? Number(f.budget) : 40_000,
      maxTotalTokens: f["max-total-tokens"] ? Number(f["max-total-tokens"]) : 3_000_000,
      scanGlobs: f.globs ? f.globs.split(",") : undefined,
      guardTools: f["guard-tools"] === "true",
      judge: f["no-judge"] !== "true",
      liveLearning: f["live-learning"] === "true",
    };
    process.stdout.write(`LIVE evaluation against provider in ${terrariumRoot} — swarm ≤ ${live.swarmSize}, ≤ ${live.maxOutputTokensPerCall} output tokens/call, ≤ ${live.budgetTokensPerRun} tokens/run, ≤ ${live.maxTotalTokens} tokens total, judge=${live.judge ? "on" : "off"}, live-learning=${live.liveLearning ? "on" : "off"}\n`);
  }
  if (!live) {
    const availability = await fixtureAvailability(fixtures);
    const notReady = fixtures.filter((x) => !availability[x.id]).length;
    if (notReady) process.stderr.write(`note: ${notReady} of ${fixtures.length} fixture repositories are not ready, so those runs use empty repo signals. Run \`flytown fly fixtures fetch\` to reproduce the suite.\n`);
  }
  const report = await runHarness({
    planners, fixtures, seeds, root, maxReplan: f["max-replan"] ? Number(f["max-replan"]) : 2, writeTraces: f.traces === "true",
    allowMissingRepos: f["allow-missing-repos"] === "true",
    compare: f.compare ? (f.compare.split(",") as [string, string]) : undefined,
    epochs: f.epochs ? Number(f.epochs) : 0,
    live,
    parallelPlanners: f.parallel === "true",
    parallelFixtures: f["parallel-fixtures"] ? Number(f["parallel-fixtures"]) : 1,
    onProgress: (m) => { if (f.verbose === "true") process.stdout.write(m + "\n"); },
  });
  process.stdout.write(await readFile(join(report.outDir, "report.md"), "utf8"));
  process.stdout.write(`\nreport: ${report.outDir}\n`);
}

async function cmdTrace(args: string[]): Promise<void> {
  const id = positional(args)[0];
  if (!id) { process.stderr.write(`usage: fly trace <runId> [--json]\n`); process.exitCode = 1; return; }
  const root = await rootOrCwd();
  const t = await readTrace(root, id);
  if (!t) { process.stderr.write(`no trace ${id} under ${root}/.flytown/traces\n`); process.exitCode = 1; return; }
  process.stdout.write(flags(args).json ? JSON.stringify(t, null, 2) + "\n" : renderTraceText(t) + "\n");
}

async function cmdTraces(): Promise<void> {
  const root = await rootOrCwd();
  const ids = await listTraces(root);
  process.stdout.write(ids.length ? ids.join("\n") + "\n" : `(no traces under ${root}/.flytown/traces)\n`);
}

async function cmdReplay(args: string[]): Promise<void> {
  const id = positional(args)[0];
  if (!id) { process.stderr.write(`usage: fly replay <runId>\n`); process.exitCode = 1; return; }
  const root = await rootOrCwd();
  const t = await readTrace(root, id);
  if (!t) { process.stderr.write(`no trace ${id}\n`); process.exitCode = 1; return; }
  const { plan, trace } = await replayTrace(root, t);
  const diff = diffPlans(t, plan, trace);
  process.stdout.write(diff.length === 0 ? `replay of ${id} is identical (${t.plannerId}, seed ${t.seed})\n` : `replay of ${id} DIFFERS:\n${diff.map((d) => `  - ${d}`).join("\n")}\n`);
}

export async function replayTrace(root: string, t: DecisionTrace) {
  const backend = resolvePlannerBackend(t.plannerId.split("(")[0], { root, seed: t.brain?.engine.variantSeed as number | undefined, connectome: t.brain?.connectomeId, fallback: false });
  const parentArtifacts: Artifact[] = t.request.priorArtifactIds.map((pid) => ({ id: pid, flightId: pid, task: t.request.task, outcome: "winner", claims: [], evidence: [], openQuestions: [], nextSteps: [], parentArtifactIds: [], keywords: [], timestamp: 0 }));
  const res = await backend.plan({
    task: t.request.task, cwd: t.request.cwd, maxNodes: t.request.maxNodes, replanDepth: t.request.replanDepth, budgetTokens: t.request.budgetTokens,
    extraSignals: t.request.extraSignals, parentArtifacts, repo: t.signals.repo, runId: t.runId,
    failureContext: t.request.failureContext ? { ...t.request.failureContext, partialPlan: t.plan } : undefined,
  });
  return res;
}

export function diffPlans(orig: DecisionTrace, plan: import("../types.js").Plan, trace?: DecisionTrace): string[] {
  const out: string[] = [];
  if (trace && trace.decision.primary !== orig.decision.primary) out.push(`primary ${orig.decision.primary} → ${trace.decision.primary}`);
  if (trace && trace.decision.included.join() !== orig.decision.included.join()) out.push(`included [${orig.decision.included}] → [${trace.decision.included}]`);
  const shape = (p: import("../types.js").Plan) => p.halt ? `halt:${p.halt.kind}` : p.nodes.map((n) => `${n.id}[${n.hints?.action ?? n.kind},${n.swarmSize},${n.personality}]`).join(">");
  if (shape(orig.plan) !== shape(plan)) out.push(`plan ${shape(orig.plan)} → ${shape(plan)}`);
  if (trace?.brain && orig.brain) {
    const a = orig.brain.steps.at(-1)?.activity ?? {}, b = trace.brain.steps.at(-1)?.activity ?? {};
    let maxDelta = 0;
    for (const k of Object.keys(a)) maxDelta = Math.max(maxDelta, Math.abs((a[k] ?? 0) - (b[k] ?? 0)));
    if (maxDelta > 1e-6) out.push(`brain activity differs (max |Δ| = ${maxDelta.toExponential(2)})`);
  }
  return out;
}

async function cmdConnectome(args: string[]): Promise<void> {
  const id = positional(args)[0];
  const root = defaultConnectomeRoot();
  if (!id) {
    const ids = await listConnectomes(root);
    process.stdout.write(ids.length ? `connectome artifacts under ${root}:\n${ids.map((i) => `  ${i}`).join("\n")}\n` : `no connectome artifacts under ${root} — run connectome-etl/build.py\n`);
    return;
  }
  const g = await loadConnectome(id, { root });
  const m = g.manifest;
  process.stdout.write(`${g.id}  level=${m.level}  nodes=${g.n}  edges=${g.src.length}  created=${m.createdAt}\n`);
  process.stdout.write(`source: ${JSON.stringify(m.source.dataset)} materialization=${m.source.materialization ?? "?"} license=${m.source.license ?? "?"}\n`);
  for (const c of m.source.citations ?? []) process.stdout.write(`  cite: ${c}\n`);
  process.stdout.write(`assumptions:\n`);
  for (const a of m.preprocessing.assumptions ?? []) process.stdout.write(`  [${a.category}] ${a.id}: ${a.text}\n`);
  const top = Array.from(g.src, (s, e) => ({ s, d: g.dst[e], w: g.weight[e] })).sort((x, y) => y.w - x.w).slice(0, 15);
  process.stdout.write(`top edges by synapse count:\n`);
  for (const e of top) process.stdout.write(`  ${g.nodes[e.s].id} → ${g.nodes[e.d].id}  ${e.w}\n`);
}

async function cmdRegions(args: string[]): Promise<void> {
  const id = positional(args)[0] ?? (await listConnectomes())[0];
  if (!id) { process.stderr.write(`no connectome artifacts available\n`); process.exitCode = 1; return; }
  const g = await loadConnectome(id);
  const d = degreeStats(g);
  const limit = flags(args).limit ? Number(flags(args).limit) : (g.n > 200 ? 60 : g.n);
  process.stdout.write(`node       neurons  in_syn  out_syn  in_deg  out_deg  provenance  groups\n`);
  const rows = g.n > 200 ? [...g.nodes].sort((a, b) => (d.inStrength[b.index] + d.outStrength[b.index]) - (d.inStrength[a.index] + d.outStrength[a.index])).slice(0, limit) : g.nodes.slice(0, limit);
  for (const n of rows) process.stdout.write(`${n.id.padEnd(10)} ${String(n.neuronCount ?? "").padStart(7)} ${String(Math.round(d.inStrength[n.index])).padStart(8)} ${String(Math.round(d.outStrength[n.index])).padStart(8)} ${String(d.inDegree[n.index]).padStart(6)} ${String(d.outDegree[n.index]).padStart(7)}  ${n.provenance.padEnd(10)}  ${(n.groups ?? []).filter((x) => !x.startsWith("node:")).join(" ")}\n`);
  if (rows.length < g.n) process.stdout.write(`(${rows.length} of ${g.n} nodes shown, by total synapses; use --limit N or \`fly groups\`)\n`);
}

async function rootOrCwd(): Promise<string> {
  try { return (await loadTerrarium(process.cwd())).root; } catch { return process.cwd(); }
}
