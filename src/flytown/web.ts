/**
 * FLYTOWN web control surface — served by the same Express app as the Tank.
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
import type { Warren } from "../warren.js";
import { KNOWN_PLANNER_SPECS, resolvePlannerBackend } from "./registry.js";
import { listTraces, readTrace, renderTraceText, writeTrace } from "./trace.js";
import { defaultConnectomeRoot, degreeStats, groupIndex, listConnectomes, loadConnectome } from "./connectome/artifact.js";
import { diffPlans, replayTrace } from "./cli.js";

export function registerFlyRoutes(app: Express, warren: Warren): void {
  const root = warren.root;

  app.get("/fly", (_req, res) => {
    res.type("html").send(flyPageHtml(warren.manifest.name));
  });

  app.get("/api/fly/planners", async (_req, res) => {
    res.json({ planners: KNOWN_PLANNER_SPECS, connectomes: await listConnectomes(), default: warren.manifest.flytown?.planner ?? "llm" });
  });

  app.post("/api/fly/plan", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { task?: unknown; planner?: unknown; maxNodes?: unknown };
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (!task) { res.status(400).json({ error: "task is required" }); return; }
    const spec = typeof body.planner === "string" && body.planner.trim() ? body.planner.trim() : (warren.manifest.flytown?.planner ?? "fly");
    try {
      const backend = resolvePlannerBackend(spec, { root, seed: warren.manifest.flytown?.seed, connectome: warren.manifest.flytown?.connectome, learning: warren.manifest.flytown?.learning, fallback: false });
      const runId = `${spec.replace(/[^a-z0-9]+/gi, "_")}-${Date.now().toString(36)}`;
      const out = await backend.plan({ task, cwd: root, maxNodes: typeof body.maxNodes === "number" ? body.maxNodes : 6, runId });
      if (out.trace) await writeTrace(root, out.trace);
      res.json({ plan: out.plan, trace: out.trace ?? null, text: out.trace ? renderTraceText(out.trace) : null, usage: out.usage ?? null });
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
      out.push({ id: r.id, plannerId: t.plannerId, createdAt: t.createdAt, primary: t.decision.primary, task: t.signals.task.slice(0, 140), halt: t.plan.halt?.kind ?? null, nodes: t.plan.nodes.length, connectome: t.brain?.connectomeId ?? null, variant: t.brain?.variant ?? null, outcome: t.outcome?.planOutcome ?? null });
    }
    res.json(out);
  });

  app.get("/api/fly/trace/:id", async (req, res) => {
    const t = await readTrace(root, req.params.id);
    if (!t) { res.status(404).json({ error: "no such trace" }); return; }
    res.json({ trace: t, text: renderTraceText(t) });
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

export function flyPageHtml(warrenName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLYTOWN · ${escapeHtml(warrenName)}</title>
<style>
  :root { color-scheme: dark; --bg:#07090d; --panel:#0e1219; --panel2:#131a24; --line:#1f2a38; --ink:#dfe7f1; --muted:#8a98ab; --acc:#7cf3c9; --warn:#f6c177; --bad:#ff7b8a; --mono: ui-monospace, SFMono-Regular, Menlo, monospace; }
  * { box-sizing: border-box; }
  body { margin:0; background: radial-gradient(1200px 700px at 30% -10%, #10202a 0%, var(--bg) 55%); color:var(--ink); font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
  header { display:flex; align-items:baseline; gap:16px; padding:14px 20px; border-bottom:1px solid var(--line); background:rgba(7,9,13,.8); position:sticky; top:0; backdrop-filter: blur(6px); }
  header h1 { margin:0; font-size:18px; letter-spacing:.08em; }
  header .sub { color:var(--muted); font-size:12px; }
  header a { color:var(--muted); margin-left:auto; text-decoration:none; }
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
  .tag.MEASURED { color:var(--acc); border-color:var(--acc); } .tag.INFERRED_FROM_LITERATURE { color:var(--warn); border-color:var(--warn); } .tag.METAPHOR { color:var(--bad); border-color:var(--bad); }
  .brain { width:100%; height:auto; background:radial-gradient(circle at 50% 45%, #0f1c25 0%, #080c11 70%); border:1px solid var(--line); border-radius:10px; }
  .brain text { font: 9px var(--mono); fill:#9fb3c8; }
  .muted { color:var(--muted); } .ok { color:var(--acc); } .bad { color:var(--bad); }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .log { font: 12px/1.5 var(--mono); max-height:260px; overflow:auto; }
  .log div { border-bottom:1px dashed var(--line); padding:2px 0; }
</style>
</head>
<body>
<header><h1>FLYTOWN</h1><span class="sub">a real animal connectome routing a synthetic swarm · warren: ${escapeHtml(warrenName)}</span><a href="/">← Tank</a></header>
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
        <span class="muted" id="run-status"></span>
      </div>
      <h2 style="margin-top:16px">Execution log</h2>
      <div class="log" id="exec-log"><div class="muted">No run yet.</div></div>
    </div>
    <div class="card">
      <h2>Decision trace</h2>
      <div id="trace-view"><p class="muted">Run a decision to see what stimulated the network, which nodes activated, and what orchestration action followed.</p></div>
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
    <p>A published, static wiring diagram of a fruit-fly brain (FlyWire FAFB v783 collapsed to brain regions, or the whole first-instar larval brain from Winding et al. 2023) is used as the fixed topology of a small dynamical system. A task becomes a sensory pattern; activity propagates; a readout maps the resulting pattern to one of thirteen orchestration actions; that action becomes a Goblintown plan and the existing worker pipeline executes it unchanged.</p>
    <h2>What it is not</h2>
    <p>Not a mind, not a simulation of a living animal, not conscious. The connectome is anatomy: it carries no firing thresholds, receptor kinetics, learning history or internal state. Every quantity here is tagged <span class="tag MEASURED">MEASURED</span> (from the data), <span class="tag INFERRED_FROM_LITERATURE">INFERRED_FROM_LITERATURE</span>, <span class="tag ENGINEERING_CHOICE">ENGINEERING_CHOICE</span> or <span class="tag METAPHOR">METAPHOR</span> so you can see which is which.</p>
    <h2>Where the evidence stands</h2>
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
function traceHtml(t, text) {
  let h = "";
  h += '<div class="row"><b>' + esc(t.plannerId) + '</b><span class="tag">' + esc(t.runId) + '</span></div>';
  h += '<p><b>Decision:</b> ' + esc(t.decision.primary) + (t.decision.included.length ? ' + ' + esc(t.decision.included.join(", ")) : "") + ' · pack ' + t.decision.packSize + ' · ' + esc(t.decision.personality) + '</p>';
  const scores = Object.entries(t.actionScores).sort((a, b) => b[1] - a[1]);
  h += '<table><tr><th>action</th><th style="width:55%">score</th></tr>' + scores.slice(0, 8).map(([a, v]) => '<tr><td>' + esc(a) + '</td><td><div class="bar"><i style="width:' + (v * 100).toFixed(1) + '%"></i></div><span class="muted">' + v.toFixed(3) + '</span></td></tr>').join("") + '</table>';
  if (t.brain) {
    h += '<div id="brain-holder">' + brainSvg(t.brain, t.brain.steps.length - 1) + '</div>';
    h += '<label>Time step <span id="step-label">' + (t.brain.steps.length - 1) + '</span></label><input type="range" id="step" min="0" max="' + (t.brain.steps.length - 1) + '" value="' + (t.brain.steps.length - 1) + '">';
    const contrib = t.brain.readoutContributions[t.decision.primary] || [];
    h += '<p class="muted">' + esc(t.decision.primary) + ' ← ' + contrib.slice(0, 5).map(([g, c]) => esc(g) + ' (' + c.toFixed(2) + ')').join(', ') + '</p>';
    if (t.brain.plastic) h += '<p class="muted">plastic synapses: ' + t.brain.plastic.edges + ' · depressed ' + t.brain.plastic.depressedEdges + ' · mean×' + t.brain.plastic.meanMultiplier.toFixed(3) + '</p>';
  }
  h += '<p><b>Plan:</b> ' + (t.plan.halt ? 'HALT ' + esc(t.plan.halt.kind) + ' — ' + esc(t.plan.halt.reason) : esc(t.plan.nodes.map((n) => n.id + '[' + (n.hints && n.hints.action || n.kind) + ',pack=' + n.packSize + ']').join(' → '))) + '</p>';
  h += '<details><summary class="muted">Provenance tags</summary><p>' + Object.entries(t.provenance).map(([k, v]) => esc(k) + ' <span class="tag ' + esc(v) + '">' + esc(v) + '</span>').join('<br>') + '</p></details>';
  h += '<h2 style="margin-top:12px">Plain text</h2><pre>' + esc(text) + '</pre>';
  return h;
}
function wireStep(container, t) {
  const s = container.querySelector("#step");
  if (!s) return;
  s.addEventListener("input", () => { container.querySelector("#brain-holder").innerHTML = brainSvg(t.brain, Number(s.value)); container.querySelector("#step-label").textContent = s.value; });
}

// ---------- run tab ----------
let lastTrace = null;
$("btn-dry").addEventListener("click", async () => {
  $("run-status").textContent = "deciding…";
  try {
    const r = await api("/api/fly/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: $("task").value, planner: $("planner").value, maxNodes: Number($("maxNodes").value) }) });
    $("run-status").textContent = r.trace ? "decided (trace " + r.trace.runId + ")" : "decided (no trace: " + $("planner").value + ")";
    if (r.trace) { lastTrace = r.trace; $("trace-view").innerHTML = traceHtml(r.trace, r.text); wireStep($("trace-view"), r.trace); }
    else $("trace-view").innerHTML = '<pre>' + esc(JSON.stringify(r.plan, null, 2)) + '</pre>';
  } catch (e) { $("run-status").textContent = "error: " + e.message; }
});
$("btn-exec").addEventListener("click", async () => {
  const log = $("exec-log"); log.innerHTML = "";
  const line = (s, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = s; log.prepend(d); };
  $("run-status").textContent = "starting…";
  try {
    const r = await api("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: $("task").value, planner: $("planner").value, maxNodes: Number($("maxNodes").value) }) });
    $("run-status").textContent = "run " + r.runId;
    const es = new EventSource("/api/rite/" + r.runId + "/stream");
    for (const kind of ["plan:planning", "plan:trace", "plan:built", "plan:halt", "plan:node:start", "plan:node:done", "plan:node:failed", "plan:replan", "plan:fallback", "plan:done", "done", "error"]) {
      es.addEventListener(kind, async (ev) => {
        let data = {}; try { data = JSON.parse(ev.data); } catch {}
        line(kind + " " + JSON.stringify(data).slice(0, 220), kind === "error" || kind === "plan:node:failed" ? "bad" : kind === "plan:done" || kind === "done" ? "ok" : "");
        if (kind === "plan:trace" && data.runId) {
          try { const t = await api("/api/fly/trace/" + encodeURIComponent(data.runId)); lastTrace = t.trace; $("trace-view").innerHTML = traceHtml(t.trace, t.text); wireStep($("trace-view"), t.trace); } catch {}
        }
        if (kind === "done" || kind === "error") es.close();
      });
    }
    es.addEventListener("step", (ev) => { let d = {}; try { d = JSON.parse(ev.data); } catch {} line("  [" + (d.nodeId || "?") + "] " + (d.step && d.step.kind || "")); });
  } catch (e) { $("run-status").textContent = "error: " + e.message; }
});

// ---------- traces tab ----------
async function loadTraces() {
  try {
    const rows = await api("/api/fly/traces");
    if (!rows.length) { $("trace-list").innerHTML = '<p class="muted">No traces yet. Run a decision.</p>'; return; }
    $("trace-list").innerHTML = '<table><tr><th>planner</th><th>decision</th><th>task</th><th>plan</th></tr>' + rows.map((r) => '<tr class="click" data-id="' + esc(r.id) + '"><td>' + esc(r.plannerId) + '</td><td>' + esc(r.primary) + '</td><td class="muted">' + esc(r.task) + '</td><td>' + (r.halt ? 'halt:' + esc(r.halt) : r.nodes + ' nodes') + '</td></tr>').join("") + '</table>';
    $("trace-list").querySelectorAll("tr.click").forEach((tr) => tr.addEventListener("click", async () => {
      const t = await api("/api/fly/trace/" + encodeURIComponent(tr.dataset.id));
      $("trace-detail").innerHTML = '<div class="row"><button class="ghost" id="btn-replay">Replay deterministically</button><span class="muted" id="replay-status"></span></div>' + traceHtml(t.trace, t.text);
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
    if (!rows.length) { $("eval-list").innerHTML = '<p class="muted">No reports under this warren. Run <code>fly eval</code>.</p>'; return; }
    $("eval-list").innerHTML = '<table><tr><th>when</th><th>mode</th><th>planners</th><th>runs</th></tr>' + rows.map((r) => '<tr class="click" data-name="' + esc(r.name) + '"><td class="muted">' + esc(r.createdAt.slice(0, 16).replace("T", " ")) + '</td><td>' + (r.live ? '<b>live</b>' : 'mock') + (r.epochs ? ' +train' : '') + '</td><td class="muted">' + esc(r.planners.join(", ")) + '</td><td>' + r.runs + '</td></tr>').join("") + '</table>';
    $("eval-list").querySelectorAll("tr.click").forEach((tr) => tr.addEventListener("click", async () => {
      const r = await api("/api/fly/eval/" + encodeURIComponent(tr.dataset.name));
      const s = r.report.summaries;
      const judged = s.some((x) => x.meanQuality !== undefined);
      let h = '<table><tr><th>planner</th>' + (judged ? '<th>quality</th>' : '') + '<th>termination</th><th>tokens</th><th>rites</th><th>sensitivity</th></tr>' + s.map((x) => '<tr><td>' + esc(x.planner) + '</td>' + (judged ? '<td>' + (x.meanQuality !== undefined ? x.meanQuality.toFixed(2) : '–') + '</td>' : '') + '<td>' + (x.terminationAccuracy * 100).toFixed(0) + '%</td><td>' + x.meanTokens.toFixed(0) + '</td><td>' + x.meanRites.toFixed(2) + '</td><td>' + x.sensitivity.distinctPrimaries + ' / ' + x.sensitivity.meanPairwiseJs.toFixed(3) + '</td></tr>').join("") + '</table>';
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
