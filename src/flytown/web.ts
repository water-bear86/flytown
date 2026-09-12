/**
 * FLYTOWN web control surface — the app's only UI, served at `/` and `/fly`.
 *
 *   GET  /fly                         the page (vanilla HTML/JS, no build step)
 *   GET  /api/fly/planners            planner specs + connectome ids
 *   POST /api/fly/plan                plan only (dry run): { task, planner, maxNodes } → { trace, plan, text }
 *   GET  /api/fly/traces              trace ids, newest first
 *   GET  /api/fly/trace/:id           full DecisionTrace (+ text rendering)
 *   POST /api/fly/replay/:id          re-run the stored decision, diff
 *   GET  /api/fly/connectomes         artifact ids
 *   GET  /api/fly/connectome/:id      manifest summary, groups, plasticity, top edges
 *   GET  /api/fly/evals               evaluation reports under <root>/.flytown/eval
 *   GET  /api/fly/eval/:name          report.json (+ markdown)
 *
 * Executing a plan uses the existing POST /api/plan (with `planner`) and the
 * existing run stream, so nothing about worker execution changes here. The
 * plain-text trace is always rendered next to the visual; the visual is
 * slider-driven (no autonomous animation) so reduced-motion users lose
 * nothing.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import type { Terrarium } from "../terrarium.js";
import { DEFAULT_PLANNER, KNOWN_PLANNER_SPECS, resolvePlannerBackend } from "./registry.js";
import { listTraces, readTrace, renderTraceText, writeTrace, type DecisionTrace } from "./trace.js";
import { actionEffects } from "./actions.js";
import { defaultConnectomeRoot, degreeStats, groupIndex, listConnectomes, loadConnectome } from "./connectome/artifact.js";
import { diffPlans, replayTrace } from "./cli.js";

const effectsOf = (t: DecisionTrace) => actionEffects(t.decision, t.signals, t.plan);

export function registerFlyRoutes(app: Express, terrarium: Terrarium): void {
  const root = terrarium.root;

  app.get("/fly", (_req, res) => {
    res.type("html").send(flyPageHtml(terrarium.manifest.name));
  });

  app.get("/api/fly/planners", async (_req, res) => {
    res.json({ planners: KNOWN_PLANNER_SPECS, connectomes: await listConnectomes(), default: terrarium.manifest.flytown?.planner ?? DEFAULT_PLANNER });
  });

  app.post("/api/fly/plan", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { task?: unknown; planner?: unknown; maxNodes?: unknown };
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!task) { res.status(400).json({ error: "task is required" }); return; }
    const spec = typeof body.planner === "string" && body.planner.trim() ? body.planner.trim() : (terrarium.manifest.flytown?.planner ?? DEFAULT_PLANNER);
    try {
      const backend = resolvePlannerBackend(spec, { root, seed: terrarium.manifest.flytown?.seed, connectome: terrarium.manifest.flytown?.connectome, learning: terrarium.manifest.flytown?.learning, fallback: false });
      const runId = `${spec.replace(/[^a-z0-9]+/gi, "_")}-${Date.now().toString(36)}`;
      const out = await backend.plan({ task, cwd: root, maxNodes: typeof body.maxNodes === "number" ? body.maxNodes : 6, runId });
      if (out.trace) await writeTrace(root, out.trace);
      res.json({ plan: out.plan, trace: out.trace ?? null, text: out.trace ? renderTraceText(out.trace) : null, effects: out.trace ? effectsOf(out.trace) : null, usage: out.usage ?? null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/fly/traces", async (_req, res) => {
    const ids = await listTraces(root);
    const rows = [];
    for (const id of ids) {
      try {
        const s = await stat(join(root, ".flytown", "traces", `${id}.json`));
        rows.push({ id, mtime: s.mtimeMs });
      } catch { rows.push({ id, mtime: 0 }); }
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    const out = [];
    for (const r of rows.slice(0, 200)) {
      const t = await readTrace(root, r.id);
      if (!t) continue;
      const primaryEffect = effectsOf(t)[0];
      out.push({ id: r.id, plannerId: t.plannerId, createdAt: t.createdAt, primary: t.decision.primary, primaryEffect: primaryEffect?.effect ?? null, primaryWhy: primaryEffect?.why ?? null, task: t.signals.task.slice(0, 140), halt: t.plan.halt?.kind ?? null, nodes: t.plan.nodes.length, connectome: t.brain?.connectomeId ?? null, variant: t.brain?.variant ?? null, outcome: t.outcome?.planOutcome ?? null });
    }
    res.json(out);
  });

  app.get("/api/fly/trace/:id", async (req, res) => {
    const t = await readTrace(root, req.params.id);
    if (!t) { res.status(404).json({ error: "no such trace" }); return; }
    res.json({ trace: t, text: renderTraceText(t), effects: effectsOf(t) });
  });

  app.post("/api/fly/replay/:id", async (req, res) => {
    const t = await readTrace(root, req.params.id);
    if (!t) { res.status(404).json({ error: "no such trace" }); return; }
    try {
      const out = await replayTrace(root, t);
      const diff = diffPlans(t, out.plan, out.trace);
      res.json({ identical: diff.length === 0, diff, text: out.trace ? renderTraceText(out.trace) : null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/fly/connectomes", async (_req, res) => {
    res.json({ root: defaultConnectomeRoot(), ids: await listConnectomes() });
  });

  app.get("/api/fly/connectome/:id", async (req, res) => {
    try {
      const g = await loadConnectome(req.params.id);
      const groups = groupIndex(g);
      const d = degreeStats(g);
      const groupRows = [...groups.entries()].filter(([k]) => !k.startsWith("node:")).map(([k, idx]) => ({ key: k, size: idx.length })).sort((a, b) => b.size - a.size || a.key.localeCompare(b.key));
      const top = Array.from(g.src, (s, e) => ({ src: g.nodes[s].id, dst: g.nodes[g.dst[e]].id, w: g.weight[e] })).sort((x, y) => y.w - x.w).slice(0, 25);
      const nodes = g.n <= 200 ? g.nodes.map((n) => ({ id: n.id, name: n.name ?? null, groups: n.groups ?? [], inStrength: Math.round(d.inStrength[n.index]), outStrength: Math.round(d.outStrength[n.index]), neuronCount: n.neuronCount ?? null })) : undefined;
      res.json({
        id: g.id, level: g.manifest.level, n: g.n, edges: g.src.length, createdAt: g.manifest.createdAt,
        source: g.manifest.source, assumptions: g.manifest.preprocessing.assumptions ?? [], channels: Object.keys(g.channels), ntClasses: Object.keys(g.nt),
        plasticity: g.plasticity ? { plasticEdges: g.plasticity.plasticEdges ?? null, dopaminergic: g.plasticity.dopaminergic ? { appetitive: g.plasticity.dopaminergic.appetitive.length, aversive: g.plasticity.dopaminergic.aversive.length, unknown: g.plasticity.dopaminergic.unknown?.length ?? 0, source: g.plasticity.dopaminergic.source ?? null, tag: g.plasticity.dopaminergic.tag } : null, signs: g.plasticity.signs ? { byGroup: Object.keys(g.plasticity.signs.byGroup ?? {}).length, byNode: Object.keys(g.plasticity.signs.byNode ?? {}).length, default: g.plasticity.signs.default ?? null, tag: g.plasticity.signs.tag } : null } : null,
        groups: groupRows.slice(0, 120), topEdges: top, nodes,
      });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/fly/evals", async (_req, res) => {
    const dir = join(root, ".flytown", "eval");
    let names: string[] = [];
    try { names = (await readdir(dir)).sort().reverse(); } catch { /* none */ }
    const out = [];
    for (const name of names.slice(0, 50)) {
      try {
        const r = JSON.parse(await readFile(join(dir, name, "report.json"), "utf8")) as { createdAt: string; options: { planners: string[]; seeds?: number[]; live?: unknown; epochs?: number; fixtures?: unknown[] }; runs: unknown[] };
        out.push({ name, createdAt: r.createdAt, planners: r.options.planners, seeds: r.options.seeds ?? [], live: !!r.options.live, epochs: r.options.epochs ?? 0, fixtures: r.options.fixtures?.length ?? 0, runs: r.runs.length });
      } catch { /* skip partial */ }
    }
    res.json(out);
  });

  app.get("/api/fly/eval/:name", async (req, res) => {
    const name = req.params.name.replace(/[^a-zA-Z0-9._-]/g, "");
    try {
      const dir = join(root, ".flytown", "eval", name);
      const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8"));
      let markdown = "";
      try { markdown = await readFile(join(dir, "report.md"), "utf8"); } catch { /* optional */ }
      res.json({ report, markdown });
    } catch {
      res.status(404).json({ error: "no such report" });
    }
  });
}

export function flyPageHtml(terrariumName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLYTOWN · ${escapeHtml(terrariumName)}</title>
<style>
  :root { color-scheme: dark; --bg:#07090d; --panel:#0e1219; --panel2:#131a24; --line:#1f2a38; --ink:#dfe7f1; --muted:#8a98ab; --acc:#7cf3c9; --warn:#f6c177; --bad:#ff7b8a; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  /* the hidden attribute must beat the flex/grid display rules below */
  [hidden] { display: none !important; }
  body { margin:0; background: radial-gradient(1200px 700px at 30% -10%, #10202a 0%, var(--bg) 55%); color:var(--ink); font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
  header { display:flex; align-items:baseline; gap:16px; padding:14px 20px; border-bottom:1px solid var(--line); background:rgba(7,9,13,.8); position:sticky; top:0; backdrop-filter: blur(6px); }
  header h1 { margin:0; font-size:18px; letter-spacing:.08em; }
  header .sub { color:var(--muted); font-size:12px; }
  header .meta { color:var(--muted); margin-left:auto; font-size:12px; }
  nav.tabs { display:flex; gap:4px; padding:10px 20px 0; }
  nav.tabs button { background:transparent; border:1px solid var(--line); border-bottom:none; color:var(--muted); padding:8px 14px; border-radius:8px 8px 0 0; cursor:pointer; }
  nav.tabs button.active { color:var(--ink); background:var(--panel); }
  main { padding:16px 20px 40px; }
  section.tab { display:none; } section.tab.active { display:block; }
  .grid { display:grid; grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr); gap:16px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .card h2 { margin:0 0 8px; font-size:13px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); }
  label { display:block; color:var(--muted); font-size:12px; margin:8px 0 4px; }
  input, select, textarea { width:100%; background:var(--panel2); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
  textarea { min-height:90px; resize:vertical; }
  button.primary { background:var(--acc); color:#06231a; border:none; border-radius:6px; padding:9px 14px; font-weight:600; cursor:pointer; margin-top:10px; }
  button.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:7px 12px; cursor:pointer; }
  pre { background:#0a0e14; border:1px solid var(--line); border-radius:8px; padding:10px; overflow:auto; font: 12px/1.5 var(--mono); color:#cfe3d8; white-space:pre-wrap; max-height:420px; }
  table { width:100%; border-collapse:collapse; font-size:12.5px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  tr.click { cursor:pointer; } tr.click:hover { background:var(--panel2); }
  .bar { height:8px; background:#1a2432; border-radius:4px; overflow:hidden; } .bar > i { display:block; height:100%; background:var(--acc); }
  .tag { display:inline-block; font-size:10px; letter-spacing:.06em; padding:2px 6px; border-radius:4px; border:1px solid var(--line); color:var(--muted); margin-left:6px; }
  ul.effects { list-style:none; padding:0; margin:4px 0 10px; } ul.effects li { margin:3px 0; font-size:13px; } ul.effects code { font-family:var(--mono); }
  .eff.shaped { color:var(--acc); } .eff.default { color:var(--ink); } .eff.inert { color:var(--muted); text-decoration:line-through; }
  .tag.MEASURED { color:var(--acc); border-color:var(--acc); } .tag.INFERRED_FROM_LITERATURE { color:var(--warn); border-color:var(--warn); } .tag.METAPHOR { color:var(--bad); border-color:var(--bad); }
  .brain { width:100%; height:auto; background:radial-gradient(circle at 50% 45%, #0f1c25 0%, #080c11 70%); border:1px solid var(--line); border-radius:10px; }
  .brain text { font: 9px var(--mono); fill:#9fb3c8; }
  .muted { color:var(--muted); } .ok { color:var(--acc); } .bad { color:var(--bad); }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .log { font: 12px/1.5 var(--mono); max-height:260px; overflow:auto; }
  .log div { border-bottom:1px dashed var(--line); padding:2px 0; }
  /* working state */
  button[disabled] { opacity:.5; cursor:progress; }
  .spin { display:inline-block; width:11px; height:11px; border:2px solid var(--line); border-top-color:var(--acc); border-radius:50%; animation: spin .8s linear infinite; vertical-align:-1px; margin-right:6px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .working { color:var(--acc); }
  .phases { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
  .phase { font-size:11px; padding:3px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); }
  .phase.now { color:#06231a; background:var(--acc); border-color:var(--acc); font-weight:600; }
  .phase.done { color:var(--acc); border-color:var(--acc); }
  /* live plan DAG */
  .dag { display:flex; align-items:stretch; gap:8px; overflow-x:auto; padding:4px 0 8px; }
  .dagnode { min-width:128px; border:1px solid var(--line); border-radius:8px; padding:8px; background:var(--panel2); position:relative; }
  .dagnode .nid { font: 11px var(--mono); color:var(--muted); }
  .dagnode .nact { font-size:12px; margin-top:2px; }
  .dagnode .nmeta { font-size:10.5px; color:var(--muted); margin-top:4px; }
  .dagnode.running { border-color:var(--acc); box-shadow:0 0 0 1px var(--acc) inset; }
  .dagnode.running::after { content:""; position:absolute; inset:auto 0 0 0; height:2px; background:linear-gradient(90deg, transparent, var(--acc), transparent); background-size:60% 100%; animation: sweep 1.2s linear infinite; }
  @keyframes sweep { from { background-position:-60% 0; } to { background-position:160% 0; } }
  .dagnode.done { border-color:#2c6b55; } .dagnode.done .nid { color:var(--acc); }
  .dagnode.failed { border-color:var(--bad); } .dagnode.failed .nid { color:var(--bad); }
  .arrow { align-self:center; color:var(--muted); }
  .swarm { display:flex; gap:4px; flex-wrap:wrap; min-height:18px; margin-top:6px; }
  .fly { width:7px; height:7px; border-radius:50%; background:var(--warn); opacity:.85; animation: bob 1.4s ease-in-out infinite; }
  @keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
  .fly.rest { background:var(--muted); animation:none; }
  @media (prefers-reduced-motion: reduce) {
    .spin { animation:none; border-top-color:var(--acc); }
    .dagnode.running::after { animation:none; background:var(--acc); }
    .fly { animation:none; }
  }
</style>
</head>
<body>
<header><h1>FLYTOWN</h1><span class="sub">a real animal connectome routing a synthetic swarm</span><span class="meta">terrarium: ${escapeHtml(terrariumName)}</span></header>
<nav class="tabs">
  <button class="active" data-tab="run">Run</button>
  <button data-tab="traces">Traces</button>
  <button data-tab="connectome">Connectome</button>
  <button data-tab="evals">Evaluations</button>
  <button data-tab="about">What this is (and is not)</button>
</nav>
<main>
<section class="tab active" id="tab-run">
  <div class="grid">
    <div class="card">
      <h2>Plan a task</h2>
      <label>Planner backend</label>
      <select id="planner"></select>
      <label>Task</label>
      <textarea id="task" placeholder="What should the swarm do?"></textarea>
      <label>Max nodes</label>
      <input id="maxNodes" type="number" value="6" min="1" max="10">
      <div class="row">
        <button class="primary" id="btn-dry">Decide only (no workers)</button>
        <button class="ghost" id="btn-exec">Decide and execute</button>
        <span id="run-status" class="muted"></span>
      </div>
      <div class="phases" id="phases" hidden>
        <span class="phase" data-phase="decide">decide</span>
        <span class="arrow">→</span>
        <span class="phase" data-phase="plan">plan</span>
        <span class="arrow">→</span>
        <span class="phase" data-phase="workers">workers</span>
        <span class="arrow">→</span>
        <span class="phase" data-phase="done">done</span>
      </div>
      <div id="dag-holder" hidden>
        <h2 style="margin-top:12px">Plan</h2>
        <div class="dag" id="dag"></div>
        <div class="row"><span class="muted" id="dag-meta"></span></div>
      </div>
      <h2 style="margin-top:16px">Execution log</h2>
      <div class="log" id="exec-log"><div class="muted">No run yet.</div></div>
    </div>
    <div class="card">
      <h2>Decision trace</h2>
      <div id="trace-view"><p class="muted">Run a decision to see what stimulated the network, which nodes activated, and what orchestration action followed.</p></div>
      <div id="trace-pending" hidden>
        <p class="working"><span class="spin"></span><span id="pending-label">propagating activity through the connectome…</span></p>
        <div class="bar"><i id="pending-bar" style="width:6%"></i></div>
      </div>
    </div>
  </div>
</section>
<section class="tab" id="tab-traces">
  <div class="grid">
    <div class="card"><h2>Stored traces</h2><div id="trace-list" class="muted">Loading…</div></div>
    <div class="card"><h2>Selected trace</h2><div id="trace-detail"><p class="muted">Pick a trace.</p></div></div>
  </div>
</section>
<section class="tab" id="tab-connectome">
  <div class="grid">
    <div class="card"><h2>Artifacts</h2><div id="cx-list" class="muted">Loading…</div></div>
    <div class="card"><h2>Detail</h2><div id="cx-detail"><p class="muted">Pick an artifact.</p></div></div>
  </div>
</section>
<section class="tab" id="tab-evals">
  <div class="grid">
    <div class="card"><h2>Reports</h2><div id="eval-list" class="muted">Loading…</div></div>
    <div class="card"><h2>Report</h2><div id="eval-detail"><p class="muted">Pick a report.</p></div></div>
  </div>
</section>
<section class="tab" id="tab-about">
  <div class="card">
    <h2>What this is</h2>
    <p>A published, static wiring diagram of a fruit-fly brain (FlyWire FAFB v783 collapsed to brain regions, or the whole first-instar larval brain from Winding et al. 2023) is used as the fixed topology of a small dynamical system. A task becomes a sensory pattern; activity propagates; a readout scores thirteen orchestration actions. The top action, and any scoring at least half as high, go to the same deterministic compiler every planner uses, which builds the FLYTOWN plan the worker pipeline executes. The compiler acts on only some of those actions, and the decision trace marks which ones changed the plan.</p>
    <h2>What it is not</h2>
    <p>Not a mind, not a simulation of a living animal, not conscious. The connectome is anatomy: it carries no firing thresholds, receptor kinetics, learning history or internal state. Every quantity here is tagged <span class="tag MEASURED">MEASURED</span> (from the data), <span class="tag INFERRED_FROM_LITERATURE">INFERRED_FROM_LITERATURE</span>, <span class="tag ENGINEERING_CHOICE">ENGINEERING_CHOICE</span> or <span class="tag METAPHOR">METAPHOR</span> so you can see which is which.</p>
    <h2>Where the evidence stands</h2>
    <p>The default planner is the hand-written rules router: in live runs it matched the LLM planner's answer quality at lower cost, and it is the only planner that reliably stops on blocked or finished tasks. The fly planners are opt-in.</p>
    <p>Matched experiments against shuffled and rewired copies of the same graph have so far <b>not</b> shown the real wiring to matter for routing quality. The Evaluations tab shows every run, including the null results. That is the point of the harness.</p>
  </div>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav.tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("section.tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + b.dataset.tab));
  if (b.dataset.tab === "traces") loadTraces();
  if (b.dataset.tab === "connectome") loadConnectomes();
  if (b.dataset.tab === "evals") loadEvals();
}));

async function api(path, opts) { const r = await fetch(path, opts); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; }

// ---------- planners ----------
(async () => {
  try {
    const p = await api("/api/fly/planners");
    const sel = $("planner");
    const specs = p.planners.filter((s) => !s.includes("<"));
    for (const c of p.connectomes) if (!c.startsWith("fafb-v783-projectome")) { specs.push("fly:connectome=" + c); specs.push("fly:connectome=" + c + "+plastic"); specs.push("fly:connectome=" + c + "+learning+plastic"); specs.push("fly:connectome=" + c + "+shuffled+plastic"); }
    sel.innerHTML = specs.map((s) => '<option value="' + esc(s) + '"' + (s === p.default ? " selected" : "") + ">" + esc(s) + "</option>").join("");
  } catch (e) { $("planner").innerHTML = '<option value="llm">llm</option>'; }
})();

// ---------- brain rendering ----------
function brainSvg(brain, t) {
  const step = brain.steps[Math.min(t, brain.steps.length - 1)] || { activity: {} };
  const keys = Object.keys(step.activity);
  const isGroups = keys.some((k) => k.includes(":"));
  const entries = keys.map((k) => [k, step.activity[k]]).filter(([k]) => !k.startsWith("node:"));
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const shown = isGroups ? entries.filter(([k]) => /^(class:|sens:|out:|flag:|region:)/.test(k)).slice(0, 96) : entries;
  const n = shown.length || 1;
  const W = 640, H = 420, cx = W / 2, cy = H / 2 + 10, R = Math.min(W, H) / 2 - 40;
  const max = Math.max(1e-6, ...shown.map(([, v]) => v));
  const inputs = brain.input || {};
  let out = '<svg class="brain" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Regional activity at step ' + t + '">';
  out += '<text x="12" y="16">' + esc(brain.connectomeId) + ' · ' + esc(brain.variant) + ' · step ' + t + '/' + (brain.steps.length - 1) + ' · ' + shown.length + ' populations</text>';
  shown.forEach(([k, v], i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const ring = isGroups ? (k.startsWith("sens:") ? 0.55 : k.startsWith("out:") ? 1.0 : 0.8) : 0.9;
    const x = cx + Math.cos(a) * R * ring, y = cy + Math.sin(a) * R * ring;
    const rel = v / max, r = 3 + rel * 14;
    const drive = inputs[k] || 0;
    out += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="rgba(124,243,201,' + (0.15 + rel * 0.75).toFixed(2) + ')"' + (drive > 0 ? ' stroke="#f6c177" stroke-width="1.5"' : ' stroke="#1f2a38" stroke-width="0.5"') + '><title>' + esc(k) + ': ' + v.toFixed(3) + (drive ? ' (input ' + drive.toFixed(3) + ')' : '') + '</title></circle>';
    if (rel > 0.35 || drive > 0 || n <= 40) out += '<text x="' + (x + r + 2).toFixed(1) + '" y="' + (y + 3).toFixed(1) + '">' + esc(k.replace(/^region:/, "")) + '</text>';
  });
  out += '<text x="12" y="' + (H - 10) + '">circle size/opacity = activity · amber ring = receives task input · hover for values</text></svg>';
  return out;
}
function traceHtml(t, text, effects) {
  let h = "";
  h += '<div class="row"><b>' + esc(t.plannerId) + '</b><span class="tag">' + esc(t.runId) + '</span></div>';
  h += '<p><b>Decision:</b> ' + esc(t.decision.primary) + (t.decision.included.length ? ' + ' + esc(t.decision.included.join(", ")) : "") + ' · swarm ' + t.decision.swarmSize + ' · ' + esc(t.decision.personality) + '</p>';
  if (effects && effects.length) {
    h += '<ul class="effects">' + effects.map((e) => '<li><code class="eff ' + esc(e.effect) + '">' + esc(e.action) + '</code>' + (e.primary ? '<span class="tag">primary</span>' : '') + ' <span class="muted">' + esc(e.effect) + ': ' + esc(e.why) + '</span></li>').join("") + '</ul>';
    h += '<p class="muted" style="font-size:12px">shaped = changed the plan · default = the plan has this anyway · inert = selected, but the compiler ignored it</p>';
  }
  const scores = Object.entries(t.actionScores).sort((a, b) => b[1] - a[1]);
  h += '<table><tr><th>action</th><th style="width:55%">score</th></tr>' + scores.slice(0, 8).map(([a, v]) => '<tr><td>' + esc(a) + '</td><td><div class="bar"><i style="width:' + (v * 100).toFixed(1) + '%"></i></div><span class="muted">' + v.toFixed(3) + '</span></td></tr>').join("") + '</table>';
  if (t.brain) {
    h += '<div id="brain-holder">' + brainSvg(t.brain, t.brain.steps.length - 1) + '</div>';
    h += '<label>Time step <span id="step-label">' + (t.brain.steps.length - 1) + '</span></label><input type="range" id="step" min="0" max="' + (t.brain.steps.length - 1) + '" value="' + (t.brain.steps.length - 1) + '">';
    const contrib = t.brain.readoutContributions[t.decision.primary] || [];
    h += '<p class="muted">' + esc(t.decision.primary) + ' ← ' + contrib.slice(0, 5).map(([g, c]) => esc(g) + ' (' + c.toFixed(2) + ')').join(', ') + '</p>';
    if (t.brain.plastic) h += '<p class="muted">plastic synapses: ' + t.brain.plastic.edges + ' · depressed ' + t.brain.plastic.depressedEdges + ' · mean×' + t.brain.plastic.meanMultiplier.toFixed(3) + '</p>';
  }
  h += '<p><b>Plan:</b> ' + (t.plan.halt ? 'HALT ' + esc(t.plan.halt.kind) + ' — ' + esc(t.plan.halt.reason) : esc(t.plan.nodes.map((n) => n.id + '[' + (n.hints && n.hints.action || n.kind) + ',swarm=' + n.swarmSize + ']').join(' → '))) + '</p>';
  h += '<details><summary class="muted">Provenance tags</summary><p>' + Object.entries(t.provenance).map(([k, v]) => esc(k) + ' <span class="tag ' + esc(v) + '">' + esc(v) + '</span>').join('<br>') + '</p></details>';
  h += '<h2 style="margin-top:12px">Plain text</h2><pre>' + esc(text) + '</pre>';
  return h;
}
function wireStep(container, t) {
  const s = container.querySelector("#step");
  if (!s) return;
  s.addEventListener("input", () => { container.querySelector("#brain-holder").innerHTML = brainSvg(t.brain, Number(s.value)); container.querySelector("#step-label").textContent = s.value; });
}

// ---------- working state ----------
const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let busy = false, pendingTimer = null, elapsedTimer = null, t0 = 0;
function setBusy(on, label) {
  busy = on;
  $("btn-dry").disabled = on; $("btn-exec").disabled = on;
  $("run-status").className = on ? "working" : "muted";
  $("run-status").innerHTML = on ? '<span class="spin"></span><span id="status-label">' + esc(label || "working…") + '</span>' : esc(label || "");
  if (on) { t0 = Date.now(); clearInterval(elapsedTimer); elapsedTimer = setInterval(() => { const l = $("status-label"); if (l) l.textContent = (label || "working…") + " " + ((Date.now() - t0) / 1000).toFixed(0) + "s"; }, 500); }
  else { clearInterval(elapsedTimer); }
}
function statusLabel(s) { const l = $("status-label"); if (l) l.textContent = s; }
function setPhase(name) {
  $("phases").hidden = false;
  const order = ["decide", "plan", "workers", "done"];
  const i = order.indexOf(name);
  document.querySelectorAll("#phases .phase").forEach((el) => {
    const j = order.indexOf(el.dataset.phase);
    el.classList.toggle("now", j === i);
    el.classList.toggle("done", j < i || (name === "done" && j <= i));
  });
}
function showPending(on, label) {
  $("trace-pending").hidden = !on;
  if (label) $("pending-label").textContent = label;
  clearInterval(pendingTimer);
  if (on) { let w = 6; pendingTimer = setInterval(() => { w = Math.min(94, w + Math.max(0.6, (94 - w) * 0.08)); $("pending-bar").style.width = w.toFixed(1) + "%"; }, REDUCED ? 600 : 200); }
}
// Live plan DAG
let dagState = new Map();
function renderDag(plan) {
  $("dag-holder").hidden = false;
  const d = $("dag");
  if (plan && plan.halt) { d.innerHTML = '<div class="dagnode failed" style="min-width:240px"><div class="nid">HALT · ' + esc(plan.halt.kind) + '</div><div class="nact">' + esc(plan.halt.reason) + '</div></div>'; return; }
  const nodes = (plan && plan.nodes) || [];
  d.innerHTML = nodes.map((n, i) => {
    const st = dagState.get(n.id) || {};
    const cls = st.status ? " " + st.status : "";
    const flies = st.status === "running" ? Number(n.swarmSize || 1) : st.status === "done" ? Number(n.swarmSize || 1) : 0;
    return (i ? '<span class="arrow">→</span>' : "") +
      '<div class="dagnode' + cls + '" id="dagnode-' + esc(n.id) + '"><div class="nid">' + esc(n.id) + (st.status ? " · " + esc(st.status) : "") + '</div>' +
      '<div class="nact">' + esc((n.hints && n.hints.action) || n.kind) + '</div>' +
      '<div class="nmeta">swarm ' + esc(String(n.swarmSize || 1)) + ' · ' + esc(n.personality || "?") + (st.outcome ? '<br>' + esc(st.outcome) : "") + (st.step ? '<br>' + esc(st.step) : "") + '</div>' +
      '<div class="swarm">' + Array.from({ length: flies }, () => '<span class="fly' + (st.status === "done" ? " rest" : "") + '"></span>').join("") + '</div></div>';
  }).join("");
}

// ---------- run tab ----------
let lastTrace = null, currentPlan = null;
$("btn-dry").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true, "deciding");
  setPhase("decide");
  showPending(true, "propagating activity through the connectome…");
  $("dag-holder").hidden = true;
  try {
    const r = await api("/api/fly/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: $("task").value, planner: $("planner").value, maxNodes: Number($("maxNodes").value) }) });
    showPending(false);
    if (r.trace) { lastTrace = r.trace; $("trace-view").innerHTML = traceHtml(r.trace, r.text, r.effects); wireStep($("trace-view"), r.trace); animateSteps($("trace-view"), r.trace); }
    else $("trace-view").innerHTML = '<pre>' + esc(JSON.stringify(r.plan, null, 2)) + '</pre>';
    currentPlan = r.plan; dagState = new Map(); renderDag(r.plan);
    setPhase("plan");
    setBusy(false, r.trace ? "decided · trace " + r.trace.runId : "decided");
  } catch (e) { showPending(false); setBusy(false, "error: " + e.message); }
});
$("btn-exec").addEventListener("click", async () => {
  if (busy) return;
  const log = $("exec-log"); log.innerHTML = "";
  const line = (s, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = s; log.prepend(d); };
  setBusy(true, "starting");
  setPhase("decide");
  showPending(true, "deciding…");
  dagState = new Map(); $("dag-holder").hidden = true;
  try {
    const r = await api("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: $("task").value, planner: $("planner").value, maxNodes: Number($("maxNodes").value) }) });
    statusLabel("run " + r.runId);
    line("run " + r.runId + " started");
    const es = new EventSource("/api/flight/" + r.runId + "/stream");
    const finish = (label, cls) => { showPending(false); setPhase("done"); setBusy(false, label); es.close(); line(label, cls); };
    for (const kind of ["plan:planning", "plan:trace", "plan:built", "plan:halt", "plan:node:start", "plan:node:done", "plan:node:failed", "plan:replan", "plan:fallback", "plan:done", "done", "error"]) {
      es.addEventListener(kind, async (ev) => {
        let data = {}; try { data = JSON.parse(ev.data); } catch {}
        line(kind + " " + JSON.stringify(data).slice(0, 220), kind === "error" || kind === "plan:node:failed" ? "bad" : kind === "plan:done" || kind === "done" ? "ok" : "");
        if (kind === "plan:planning") { setPhase("decide"); showPending(true, "planner deciding…"); statusLabel("deciding"); }
        if (kind === "plan:trace" && data.runId) {
          showPending(false);
          try { const t = await api("/api/fly/trace/" + encodeURIComponent(data.runId)); lastTrace = t.trace; $("trace-view").innerHTML = traceHtml(t.trace, t.text, t.effects); wireStep($("trace-view"), t.trace); animateSteps($("trace-view"), t.trace); } catch {}
        }
        if (kind === "plan:built") { currentPlan = data.plan; renderDag(data.plan); setPhase(data.plan && data.plan.halt ? "done" : "workers"); showPending(false); statusLabel("workers running"); }
        if (kind === "plan:halt") { setPhase("done"); }
        if (kind === "plan:node:start") { dagState.set(data.nodeId, { status: "running" }); renderDag(currentPlan); statusLabel("node " + data.nodeId); }
        if (kind === "plan:node:done") { dagState.set(data.nodeId, { status: "done", outcome: data.outcome }); renderDag(currentPlan); }
        if (kind === "plan:node:failed") { dagState.set(data.nodeId, { status: "failed", outcome: data.reason }); renderDag(currentPlan); }
        if (kind === "plan:replan") { statusLabel("replanning (depth " + data.depth + ")"); }
        if (kind === "plan:done") { $("dag-meta").textContent = "plan " + data.outcome + (data.finalArtifactId ? " · artifact " + data.finalArtifactId : ""); }
        if (kind === "done") finish("finished in " + ((Date.now() - t0) / 1000).toFixed(0) + "s", "ok");
        if (kind === "error") finish("error: " + (data.message || "unknown"), "bad");
      });
    }
    es.addEventListener("step", (ev) => {
      let d = {}; try { d = JSON.parse(ev.data); } catch {}
      const kindName = (d.step && d.step.kind) || "";
      line("  [" + (d.nodeId || "?") + "] " + kindName);
      if (d.nodeId) { const st = dagState.get(d.nodeId) || { status: "running" }; st.step = kindName; dagState.set(d.nodeId, st); renderDag(currentPlan); }
    });
  } catch (e) { showPending(false); setBusy(false, "error: " + e.message); }
});
// Play the propagation forward once on arrival, so the page shows the network working.
function animateSteps(container, t) {
  if (!t.brain || REDUCED || t.brain.steps.length < 3) return;
  const slider = container.querySelector("#step");
  if (!slider) return;
  let i = 0;
  const holder = container.querySelector("#brain-holder");
  const label = container.querySelector("#step-label");
  const id = setInterval(() => {
    if (i >= t.brain.steps.length || !document.body.contains(holder)) { clearInterval(id); return; }
    holder.innerHTML = brainSvg(t.brain, i);
    if (label) label.textContent = String(i);
    slider.value = String(i);
    i++;
  }, 90);
}

// ---------- traces tab ----------
async function loadTraces() {
  try {
    const rows = await api("/api/fly/traces");
    if (!rows.length) { $("trace-list").innerHTML = '<p class="muted">No traces yet. Run a decision.</p>'; return; }
    $("trace-list").innerHTML = '<table><tr><th>planner</th><th>decision</th><th>task</th><th>plan</th></tr>' + rows.map((r) => '<tr class="click" data-id="' + esc(r.id) + '"><td>' + esc(r.plannerId) + '</td><td><span class="eff ' + esc(r.primaryEffect || "") + '" title="' + esc(r.primaryEffect ? r.primaryEffect + ': ' + r.primaryWhy : "") + '">' + esc(r.primary) + '</span></td><td class="muted">' + esc(r.task) + '</td><td>' + (r.halt ? 'halt:' + esc(r.halt) : r.nodes + ' nodes') + '</td></tr>').join("") + '</table>';
    $("trace-list").querySelectorAll("tr.click").forEach((tr) => tr.addEventListener("click", async () => {
      const t = await api("/api/fly/trace/" + encodeURIComponent(tr.dataset.id));
      $("trace-detail").innerHTML = '<div class="row"><button class="ghost" id="btn-replay">Replay deterministically</button><span class="muted" id="replay-status"></span></div>' + traceHtml(t.trace, t.text, t.effects);
      wireStep($("trace-detail"), t.trace);
      $("btn-replay").addEventListener("click", async () => {
        $("replay-status").textContent = "replaying…";
        try { const r = await api("/api/fly/replay/" + encodeURIComponent(tr.dataset.id), { method: "POST" }); $("replay-status").textContent = r.identical ? "identical ✓" : "DIFFERS: " + r.diff.join("; "); $("replay-status").className = r.identical ? "ok" : "bad"; }
        catch (e) { $("replay-status").textContent = "error: " + e.message; }
      });
    }));
  } catch (e) { $("trace-list").innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
}

// ---------- connectome tab ----------
async function loadConnectomes() {
  try {
    const c = await api("/api/fly/connectomes");
    if (!c.ids.length) { $("cx-list").innerHTML = '<p class="muted">No artifacts under ' + esc(c.root) + '. Run connectome-etl.</p>'; return; }
    $("cx-list").innerHTML = '<p class="muted">' + esc(c.root) + '</p>' + c.ids.map((id) => '<p><button class="ghost" data-id="' + esc(id) + '">' + esc(id) + '</button></p>').join("");
    $("cx-list").querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const g = await api("/api/fly/connectome/" + encodeURIComponent(b.dataset.id));
      let h = '<p><b>' + esc(g.id) + '</b> · ' + esc(g.level) + ' · ' + g.n.toLocaleString() + ' nodes · ' + g.edges.toLocaleString() + ' edges' + (g.channels.length ? ' · channels ' + esc(g.channels.join(",")) : "") + (g.ntClasses.length ? ' · NT classes ' + esc(g.ntClasses.join(",")) : "") + '</p>';
      h += '<p class="muted">' + esc(g.source.dataset || "") + (g.source.license ? ' · licence: ' + esc(g.source.license) : "") + '</p>';
      if (g.source.citations) h += '<details><summary class="muted">Citations</summary>' + g.source.citations.map((s) => '<p class="muted">' + esc(s) + '</p>').join("") + '</details>';
      if (g.plasticity && g.plasticity.plasticEdges) h += '<p><b>Plastic site:</b> ' + esc(g.plasticity.plasticEdges.preGroup) + ' → ' + esc(g.plasticity.plasticEdges.postGroup) + ' <span class="tag ' + esc(g.plasticity.plasticEdges.tag) + '">' + esc(g.plasticity.plasticEdges.tag) + '</span><br><span class="muted">' + esc(g.plasticity.plasticEdges.rule) + '</span></p>';
      if (g.plasticity && g.plasticity.dopaminergic) h += '<p>Dopaminergic sets: appetitive ' + g.plasticity.dopaminergic.appetitive + ', aversive ' + g.plasticity.dopaminergic.aversive + ', unknown ' + g.plasticity.dopaminergic.unknown + ' <span class="tag ' + esc(g.plasticity.dopaminergic.tag) + '">' + esc(g.plasticity.dopaminergic.tag) + '</span></p>';
      h += '<h2>Assumptions</h2>' + g.assumptions.map((a) => '<p><span class="tag ' + esc(a.category) + '">' + esc(a.category) + '</span> <b>' + esc(a.id) + '</b><br><span class="muted">' + esc(a.text) + '</span></p>').join("");
      h += '<h2>Largest populations</h2><table><tr><th>group</th><th>nodes</th></tr>' + g.groups.slice(0, 40).map((r) => '<tr><td>' + esc(r.key) + '</td><td>' + r.size + '</td></tr>').join("") + '</table>';
      h += '<h2>Strongest edges (synapses)</h2><table><tr><th>from</th><th>to</th><th>syn</th></tr>' + g.topEdges.map((e) => '<tr><td>' + esc(e.src) + '</td><td>' + esc(e.dst) + '</td><td>' + e.w.toLocaleString() + '</td></tr>').join("") + '</table>';
      $("cx-detail").innerHTML = h;
    }));
  } catch (e) { $("cx-list").innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
}

// ---------- evals tab ----------
async function loadEvals() {
  try {
    const rows = await api("/api/fly/evals");
    if (!rows.length) { $("eval-list").innerHTML = '<p class="muted">No reports under this terrarium. Run <code>fly eval</code>.</p>'; return; }
    $("eval-list").innerHTML = '<table><tr><th>when</th><th>mode</th><th>planners</th><th>runs</th></tr>' + rows.map((r) => '<tr class="click" data-name="' + esc(r.name) + '"><td class="muted">' + esc(r.createdAt.slice(0, 16).replace("T", " ")) + '</td><td>' + (r.live ? '<b>live</b>' : 'mock') + (r.epochs ? ' +train' : '') + '</td><td class="muted">' + esc(r.planners.join(", ")) + '</td><td>' + r.runs + '</td></tr>').join("") + '</table>';
    $("eval-list").querySelectorAll("tr.click").forEach((tr) => tr.addEventListener("click", async () => {
      const r = await api("/api/fly/eval/" + encodeURIComponent(tr.dataset.name));
      const s = r.report.summaries;
      const judged = s.some((x) => x.meanQuality !== undefined);
      let h = '<table><tr><th>planner</th>' + (judged ? '<th>quality</th>' : '') + '<th>termination</th><th>tokens</th><th>flights</th><th>sensitivity</th></tr>' + s.map((x) => '<tr><td>' + esc(x.planner) + '</td>' + (judged ? '<td>' + (x.meanQuality !== undefined ? x.meanQuality.toFixed(2) : '–') + '</td>' : '') + '<td>' + (x.terminationAccuracy * 100).toFixed(0) + '%</td><td>' + x.meanTokens.toFixed(0) + '</td><td>' + Number(x.meanFlights ?? x.meanRites ?? 0).toFixed(2) + '</td><td>' + x.sensitivity.distinctPrimaries + ' / ' + x.sensitivity.meanPairwiseJs.toFixed(3) + '</td></tr>').join("") + '</table>';
      const c = r.report.comparison;
      if (c) h += '<p><b>' + esc(c.a) + '</b> vs <b>' + esc(c.b) + '</b> (n=' + c.pairs + '): termination Δ ' + (c.completionDiff * 100).toFixed(1) + ' pts, p=' + c.completionP.toFixed(3) + (c.qualityP !== undefined ? ' · quality Δ ' + c.qualityDiff.toFixed(3) + ', p=' + c.qualityP.toFixed(3) : '') + ' · tokens Δ ' + c.tokensDiff.toFixed(0) + ', p=' + c.tokensP.toFixed(3) + '</p>';
      h += '<details><summary class="muted">Full markdown report</summary><pre>' + esc(r.markdown) + '</pre></details>';
      const judgedRuns = r.report.runs.filter((x) => x.judgeRationale);
      if (judgedRuns.length) h += '<h2>Judge rationales</h2><table><tr><th>planner</th><th>fixture</th><th>q</th><th>why</th></tr>' + judgedRuns.slice(0, 80).map((x) => '<tr><td>' + esc(x.planner) + '</td><td>' + esc(x.fixtureId) + '</td><td>' + (x.quality !== undefined ? x.quality.toFixed(2) : '–') + '</td><td class="muted">' + esc(x.judgeRationale) + '</td></tr>').join("") + '</table>';
      $("eval-detail").innerHTML = h;
    }));
  } catch (e) { $("eval-list").innerHTML = '<p class="bad">' + esc(e.message) + '</p>'; }
}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
