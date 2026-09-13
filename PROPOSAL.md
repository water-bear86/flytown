# FLYTOWN — Architecture Proposal (v0.1, draft for approval)

> **Names:** on 2026-09-12 FLYTOWN replaced every inherited Goblintown term (goblin, troll, rite, hoard, warren, …) with the swarm vocabulary in [`docs/flytown/VOCABULARY.md`](./docs/flytown/VOCABULARY.md). Sections that record work done before the rename keep the names that were true at the time; all current-behaviour descriptions use the new ones. Pre-rename records are marked where they begin: the author context and revision log below, the Goblintown audit (Sections 4–5), the dated live-result notes in Section 20, the fork-and-strip record in Section 21, the open questions in Section 27, and the closing note.

**Working title:** FLYTOWN
**Pitch:** FLYTOWN is a real animal connectome dreaming through a swarm of AI agents.
**Status:** Proposal only. No implementation code has been written. Nothing here is approved.
**Author context (pre-rename record):** Produced after (a) a full source-level audit of the local Goblintown repository at `~/goblintown/backrooms-0.7-telemetry` (v0.7.0-beta.1, MIT), and (b) primary-source research into the current (September 2026) state of the FlyWire connectome dataset, its successors, licensing, and access mechanisms.

**Revision log (pre-rename record):**
- **v0.1** — initial draft, all 27 sections, pending review.
- **v0.2 (this revision)** — folds in your answers to the first round of open questions: (1) project is non-commercial, open-source, research/education — resolves the CC-BY-NC licensing concern outright (Section 10, 24); (2) FLYTOWN gets its own repo at `~/flytown/` (confirmed, already created, empty); (3) confirmed intent to strip Goblintown back to its core orchestration pipeline, now backed by verified git history from the real upstream repo, `github.com/0xbl33p/goblintown` (public, MIT, 40 stars, confirmed consent to do this work) rather than guesswork (Section 21); (4) no preference on baseline build order; (5) evaluation task suite will draw from real repos on this machine; (6) biological-circuit citations will be drafted by Claude, validated after the fact by a neuroscience collaborator (async, not a pre-ship gate) (Section 6/27); (7) full neuron-level fidelity (Option C) is explicitly the long-term destination, not a contingent stretch goal — see the cost comparison added to Section 19, which shows this costs little beyond engineering time at the scale this project actually runs at (a personal machine, non-commercial, no cloud-scale infra).

---

## 1. Concise interpretation of the product

FLYTOWN takes a **static, public, real fruit-fly connectome** (a wiring diagram — which neurons synapse onto which, roughly how many synapses, and a statistical guess at each neuron's neurotransmitter) and uses it as the **fixed topology of a small dynamical system**. A task's structured signals are injected into that system as "sensory" input; activation propagates through the biological graph for a bounded number of discrete steps; a readout layer maps the resulting activity pattern to a small, fixed vocabulary of **orchestration actions** (spawn a worker, retry, escalate, stop, ...). Those actions become a `Plan` — the orchestrator's own DAG-of-flights data type — which the existing, untouched execution engine (`performFlight`, workers, tools, artifacts, recovery) carries out exactly as it does for any other planner. Results flow back as reward that updates only a small number of explicitly-designated trainable parameters (never the biological topology itself).

FLYTOWN's substance is not its insect nouns. It is a new control-plane component — a `PlannerBackend` — whose *decision substrate* is derived from real anatomical data rather than an LLM call. Everything downstream of "what should happen next" stays the existing orchestration pipeline.

## 2. What is genuinely novel

- **Using a real, published, versioned connectome as production control-plane topology**, not as a visual theme or a random-graph generator with biological branding. The prior art we found (Jin/Zhu/Zhang/Sui, Feb 2026, arXiv 2602.17997) uses the FlyWire connectome as an RL controller for *body locomotion* — the same "connectome-as-fixed-graph-for-control" idea, but for a robot, not for an AI-agent orchestrator. We are not aware of a prior system that routes *software agents* through connectome-derived dynamics.
- **A falsifiability harness built into the architecture from day one** — every biologically-derived component ships with a same-shaped ablation (shuffled graph, random-degree graph, region-deleted graph, recurrence-off, learning-off) as a first-class experiment, not an afterthought.
- **A hard, auditable boundary between "structure we measured," "parameters we inferred from literature," "engineering choices we made," and "product-language metaphor"** (Section 3), maintained in the trace format itself, not just in prose documentation.
- **Reuse, not replacement, of a working multi-agent system.** The source audit (Sections 4–5) found a genuinely clean, narrow seam (Section 5 / 9) — this is a real integration, not a rewrite-from-scratch dressed up as one.

## 3. What is scientifically real versus metaphorical

| Layer | Status | Detail |
|---|---|---|
| Neuron identities, synapse-level connectivity, ~78 neuropil regions | **Real, measured** | FlyWire FAFB v783: 139,255 neurons, EM-reconstructed synaptic connectivity. This is anatomy, not a model of anatomy. |
| Neurotransmitter identity per neuron | **Real prediction, not measurement** | Eckstein et al. 2024 (*Cell*) classifier, ~94% per-neuron accuracy, with explicit author caveats about systematic misidentification in some populations. We will treat this as a probabilistic sign hint, not ground truth. |
| Cell types (~8,400), hemilineages, superclasses | **Real, curated, actively maintained** | `flyconnectome/flywire_annotations` v3.1.0, cross-referenced against 2026 male-CNS work. |
| Synapse count as connection "strength" | **Engineering assumption, not physiology** | The network-statistics Nature paper (Lin, Yang et al. 2024) explicitly states its analysis ignores connection sign and neuron/synapse biophysics. We inherit that limitation and document it everywhere the count is used as a weight. |
| Region-level or neuron-level "dynamics" (decay, propagation, thresholds) | **Not measured — engineering choice** | The connectome captures *structure*, not per-neuron physiological time constants, firing thresholds, or receptor kinetics. Any dynamical model layered on top (Section 11) is ours, explicitly labeled as such, and swappable. |
| Mushroom-body-as-associative-memory, central-complex-as-action-selection, antennal-lobe-as-classifier mappings | **Metaphorical hypothesis, informed by real neuroscience literature, not derived from the connectome data itself** | These are product/engineering framings borrowed from decades of *Drosophila* behavioral neuroscience (which studied a different individual fly, under different conditions, with different tools). They motivate *where* we attach input/output adapters, not a claim that the connectome "computes" these functions today. |
| "The system is dreaming / has a mind / is conscious" | **False. Never claimed.** | A connectome is a wiring diagram. We do not know its dynamics, its learning history, or whether it corresponds to any particular animal's subjective experience — because there is no subject. This must appear verbatim or near-verbatim in the product's own UI copy, not just this document. |

Every FLYTOWN component we build will be tagged in its own code comments and in the brain-trace schema (Section 17) with one of these four categories: `MEASURED`, `INFERRED_FROM_LITERATURE`, `ENGINEERING_CHOICE`, `METAPHOR`.

## 4. Summary of the existing Goblintown architecture

*Pre-rename record: Goblintown as audited before the fork, in its own terms.*

(Full source-cited detail available on request; this is the load-bearing summary.)

Goblintown (`~/goblintown/backrooms-0.7-telemetry`, npm package `goblintown`, MIT, copyright 0XBL33P, v0.7.0-beta.1) is a **local-first Node/TypeScript app** (Express server + optional Electron shell) that turns a task into either:

- **Single Goblin** — one non-orchestrated LLM call (`chat.ts`), or
- **Quest** — a Goblin pack + Troll arbitration (lightweight), or
- **Rite** — the full pipeline: **Raccoon** (context scavenging + prior-artifact retrieval) → **Goblin pack** (N parallel workers, varied personality, optional debate round) → **Gremlin** (per-goblin adversarial chaos pass) → **Troll** (reviewer, default-reject JSON verdict, optional verifier tool calls) → on all-fail: cluster failures (1 LLM call) → **Specialist goblins** (1–3 focused recovery workers) + re-judge → **Ogre** (heavyweight last-resort fallback) → **Pigeon-as-Scribe** (distills the winning output into a typed `Artifact`: claims, evidence, open questions, next steps, parent-artifact links).
- **Plan** mode wraps multiple Rites into a DAG: `planTask()` (currently just the Troll model with a swapped prompt) emits a `Plan = {nodes: PlanNode[], edges: PlanEdge[]}`; `executePlan()` topologically walks it, calls `performRite()` per node, and **re-invokes the planner on failure** (capped at 2 replans).

Everything is content-addressed and file-backed under `.goblintown/hoard/` (`Loot` = one model call, `Quest`, `Rite`, `Artifact`, plus federation/social records) with no external database. A parallel `RunRecord` system under `.goblintown/runs/` drives SSE-based live streaming and best-effort resume. Reward (**"Shinies"**) is computed per-Loot as `clamp01(trollScore − min(0.5, 4·crossCreatureDrift) + passBonus)` and is used **only to pick a winner within a single rite** — there is currently **no cross-rite learning or history-informed routing anywhere in the codebase.** Model routing is per-role (`ModelSlot`) through a single OpenAI-SDK-compatible client pointed at 11 possible provider presets. Tool calling is hand-rolled (LLM emits JSON, not native function-calling), tool surface is deliberately read-only (JSON/regex parsing, HTTP HEAD, opt-in web fetch with private-IP SSRF guards, opt-in Solana read-only RPC) — **no shell/file-write tool exists** despite one being mentioned in a stale source comment.

Two things worth flagging for scope: the repo also bundles substantial **crypto/trading-research features** (Solana RPC client, "investment thesis" generation, sentiment aggregation) and a **peer-to-peer federation/social layer** (HMAC-signed inter-Warren messaging, friends/DMs) that are unrelated to the orchestration core and out of scope for FLYTOWN unless you say otherwise.

## 5. The cleanest integration seam

*Pre-rename record: the seam analysis of the audited Goblintown code, in its own terms. As built, the seam is `PlannerBackend` in `src/flytown/planner-backend.ts`, and plan nodes are `kind: "flight" | "synthesize"` with `swarmSize` and `flightId`.*

There is **no existing planner interface** to implement — `executePlan()` hardcodes a direct import of `planTask()` (`src/plan-executor.ts:7,173`). But the data it produces and consumes is already clean and LLM-agnostic:

```ts
// src/types.ts (existing, unchanged)
export interface Plan {
  id: string; rootTask: string; nodes: PlanNode[]; edges: PlanEdge[];
  replanDepth: number; createdAt: number;
}
export interface PlanNode {
  id: string; task: string; inputs: string[];
  kind: "sub_rite" | "synthesize";
  packSize?: number; personality?: Personality;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  riteId?: string; artifactId?: string; failureReason?: string;
}
export interface PlanEdge { from: string; to: string; }
```

**Recommendation: extract one small interface, inject it, touch nothing else.**

```ts
// proposed — new, minimal
export interface PlannerBackend {
  plan(opts: {
    task: string;
    parentArtifacts?: Artifact[];
    failureContext?: { failedNodeId: string; reason: string; partialPlan: Plan };
    maxNodes?: number;
  }): Promise<{ plan: Plan }>;
}
```

`plan-executor.ts` takes `opts.planner: PlannerBackend` (default: a thin wrapper around today's `planTask`) instead of importing `planTask` directly. `validatePlan` / `topologicalOrder` / the replan loop / per-node `performRite` execution are already planner-agnostic and need **zero changes**. The existing structural invariants Goblintown already enforces on any `Plan` — acyclic, at most one `synthesize` sink, `maxNodes` cap — become FLYTOWN's safety backstop for free (Section 16).

**Everything else stays completely untouched:** `creatures.ts`, `openai-client.ts`, `providers.ts`, `tools.ts`, `addons.ts`, `rite.ts` (the whole Raccoon→pack→Gremlin→Troll→Specialist→Ogre→Scribe pipeline), `hoard.ts`, `artifact.ts`, `reward.ts`/`reward-plugin.ts`, `warren.ts`, `run-store.ts`. `server.ts`/`cli.ts` need at most one-line changes each (pass the chosen `PlannerBackend` through) if you want runtime selection rather than a build-time swap — and we recommend keeping it build-time/config-selected initially to avoid touching `server.ts`, which is the single largest, most tangled file in the repo (~15k lines, inlined UI included).

**Where a clean seam is *not* possible without deeper refactoring:** `performRite()` is a 380-line monolith with no per-phase abstraction — if FLYTOWN later wants connectome activity to influence something *inside* a rite (e.g., dynamic pack sizing mid-run, tie-breaking between candidate winners) rather than only *between* rites (DAG shape), that requires decomposing `performRite` itself. **Out of scope for v1.** FLYTOWN v1 operates purely at the DAG/planning layer.

**License note:** `goblintown` is already claimed as an npm package name; a FLYTOWN fork/sidecar publishing separately needs its own package name. No copyleft obligations from any bundled dependency (all MIT/ISC/Apache-2.0).

## 6. Three architecture options (fidelity levels)

### Option A — Region-level projectome (~78 neuropils)
**What:** Aggregate the full synapse-level graph into a small weighted directed graph over ~78 anatomically-named brain regions.
**Pros:** Small (tens of KB), fast (sub-millisecond propagation), trivially cacheable/versionable, easy to visualize and to debug by hand, cheapest possible falsification test.
**Cons:** Loses essentially all neuron-level sparse coding; closest of the three to "a themed state machine" if not handled carefully — the burden of proof that it's more than that falls on the evaluation harness (Section 18), not on architectural complexity.

### Option B — Curated functional subcircuits
**What:** Hand-select specific, well-studied circuits (mushroom body / Kenyon cells, central complex, antennal lobe, a set of dopaminergic and descending neurons) at neuron- or cell-type resolution, connected to each other and to the rest of the system only through the region-level projectome for everything not curated.
**Pros:** Materially more biologically meaningful per unit of engineering effort than A; the curated circuits are exactly the ones with the strongest behavioral-neuroscience literature backing the metaphorical mappings in Section 3.
**Cons:** Requires real neuroscience interpretation work and literature review per circuit; risk of cherry-picking; boundaries between curated circuits and the rest of the brain are incomplete by construction (we are choosing what to include).

### Option C — Full neuron-level connectome (~139K neurons, ~54.5M synapses)
**What:** The complete FAFB v783 graph, neuron-level, sparse.
**Pros:** Strongest possible claim to "using the real connectome"; richest recurrent dynamics; best substrate for serious ablation science; visually and conceptually the most compelling.
**Cons:** ~9.5 GB raw synapse table; non-trivial preprocessing pipeline (Section 11); anatomical weights are still not physiological models even at full resolution — moving to C does not, by itself, fix the "synapse count ≠ strength" limitation; harder to debug; slower to iterate on during the phase where we're still validating the *hypothesis*, not the *fidelity*.

## 7. Recommended architecture

**Confirms your instinct, with one addition the source audit revealed.** Start at **Option A**, graduate to **Option B**, treat **Option C** as a Milestone-4 stretch goal gated on A/B actually beating baselines. The addition: because the orchestrator's integration seam sits at the **DAG/planning layer** (Section 5), not inside individual worker calls, the orchestration decisions FLYTOWN needs to make ("how many flights," "what kind of node," "retry or escalate or stop") are inherently **coarse-grained**. A region-level graph is not just the cheapest starting point — it is *architecturally well-matched* to the actual decision resolution the planner seam requires. Neuron-level resolution (Option C) buys the most scientific credibility but is not needed to make the first falsifiable test meaningful, and premature neuron-level complexity risks obscuring whether the *routing decisions* are doing anything different at all.

**Structural recommendation for where preprocessing happens:** a **Python ETL sidecar, run offline/occasionally, producing versioned, checksummed runtime artifacts** consumed by a **TypeScript runtime module inside the orchestrator, with no Python dependency at request time.** This follows your own engineering principles directly: the FlyWire ecosystem (`caveclient`, `navis`, `fafbseg-py` — Section 10) is Python-only and not worth reimplementing in TS; but the *runtime* operation (loading a small versioned sparse graph and propagating activation for a few hundred milliseconds per request) has no dependency on that ecosystem once the artifact exists, so it does not need to drag a mandatory Python service into FLYTOWN's deployment story. This also directly satisfies "define a stable artifact format so runtime operation does not depend on the preprocessing environment."

## 8. Component diagram

```
OFFLINE / PREPROCESSING (Python sidecar, run rarely, not part of the deployed app)
┌────────────────────────────────────────────────────────────────────────┐
│  FlyWire Zenodo archive (FAFB v783, CC-BY-4.0)                          │
│  + flywire_annotations v3.1.0 (cell types, NT predictions)              │
│         │  caveclient / navis / fafbseg-py / pandas / scipy             │
│         ▼                                                               │
│  connectome-etl/  (checksum source, record every preprocessing choice)  │
│    - region aggregation (Option A)                                      │
│    - curated-circuit extraction (Option B, Milestone 3)                 │
│    - NT-sign resolution, degree-distribution stats for baselines        │
│         │                                                                │
│         ▼                                                               │
│  runtime artifacts/  (versioned, checksummed, small)                    │
│    connectome/<version>/manifest.json                                  │
│    connectome/<version>/graph.json   (sparse edges, signed weights)    │
│    connectome/<version>/regions.json (names, provenance, MEASURED/etc) │
└────────────────────────────────────────────────────────────────────────┘
                              │  artifact copied/synced, no live Python dep
                              ▼
RUNTIME (TypeScript, inside the orchestrator, no Python at request time)
┌────────────────────────────────────────────────────────────────────────┐
│  Sensory Encoder        task text, repo signals, test results, etc.    │
│  (ENGINEERING_CHOICE)   → sparse "odor" input vector over glomerulus-  │
│                            like input nodes                            │
│         │                                                                │
│         ▼                                                               │
│  Connectome Engine       loads versioned graph.json (cached, sparse),  │
│  (MEASURED topology,     deterministic seed, bounded discrete-time     │
│   ENGINEERING_CHOICE     propagation (Section 11)                      │
│   dynamics)                                                             │
│         │                                                                │
│         ▼                                                               │
│  Readout Layer           aggregate regional/circuit activity →         │
│  (trainable, small)      distribution over fixed orchestration actions │
│         │                                                                │
│         ▼                                                               │
│  PlannerBackend adapter  maps action distribution → Plan{nodes,edges}  │
│  (new, ~1 file)          validated by the existing validatePlan()      │
│         │                                                                │
│         ▼                                                               │
│  ═══ existing, UNCHANGED orchestration pipeline ═══                    │
│  executePlan → performFlight → Scout/swarm/Wasp/Guard/Specialist/      │
│  Soldier/Scribe → Compost/Artifact/RunRecord/SSE                       │
│         │                                                                │
│         ▼                                                               │
│  Reward ingestion         Sugar + test/tool/cost/latency outcomes      │
│         │                                                                │
│         ▼                                                               │
│  Learned adapters          reward-modulated update, ONLY: input         │
│  (versioned, resettable)   projection, readout weights, optionally a    │
│                             small explicitly-designated plastic-edge set│
│         │                                                                │
│         └──────────────────► feeds next Connectome Engine invocation   │
│                                                                          │
│  Brain Trace exporter      per-run: input odor, per-region activity,   │
│                             action taken, Plan produced, reward         │
│                             received — alongside existing RunRecord     │
└────────────────────────────────────────────────────────────────────────┘
```

## 9. End-to-end data flow

1. User submits a task (via the existing CLI/HTTP entry points, unchanged).
2. **Sensory encoding** (new): task text, repo structure, test failures, prior-attempt outcomes, uncertainty signals, etc. are mapped to a sparse activation vector over a fixed set of input nodes (`ENGINEERING_CHOICE`, analogous to antennal-lobe glomeruli — Section 12).
3. **Propagation** (new): the input vector is injected into the connectome-derived graph; activation propagates for a bounded number of discrete timesteps under fixed topology + signed weights + a simple leaky decay rule (`ENGINEERING_CHOICE` dynamics on top of `MEASURED` structure — Section 11).
4. **Readout** (new, trainable): aggregate per-region (or per-curated-circuit) terminal activity is mapped by a small trained head to a distribution over a fixed orchestration-action vocabulary (spawn flight, allocate a larger swarm, request specific artifact, invoke reviewer, retry, escalate, stop-success, stop-blocked, ...).
5. **Plan construction** (new, thin): the action distribution is turned into a `Plan{nodes, edges}` using the existing `Plan` types; validated with the existing `validatePlan`/`topologicalOrder` before anything runs.
6. **Execution** (existing, unchanged): `executePlan` → `performFlight` per node → the existing worker pipeline, tools, budget/concurrency limits, Compost persistence, SSE streaming.
7. **Outcome capture** (existing + new): the existing Sugar/guard-score/test-pass signals, plus cost/latency/retry counts, become the reward signal for step 8.
8. **Learning** (new, off by default): reward updates only the trainable input/readout parameters from step 2/4 (and optionally a small explicitly-designated plastic-edge set inside a curated mushroom-body-like circuit in Milestone 3 — biologically, this is *where* real fly associative plasticity actually lives, so it is the one place "engineering choice" and "real biology" meaningfully overlap).
9. **Brain trace + run trace both written**, cross-linked by run id, for full replay and side-by-side comparison against the conventional planner.

## 10. Connectome dataset and exact version

**Recommended dataset: FlyWire FAFB v783** (Female Adult Fly Brain, materialization/snapshot version 783), the same version underlying both cited Nature papers and still the current public brain-only dataset as of September 2026.

- 139,255 neurons, ~54.5M raw synapses, Codex-reported 3,732,460 consolidated neuron-pair edges, >8,400 annotated cell types, ~78 neuropil regions.
- Archival bulk files (Zenodo, DOI record 10676866): `flywire_synapses_783.feather` (9.5 GB, full synapse table with 3D coordinates + per-synapse NT-class probabilities), `proofread_connections_783.feather` (852 MB, proofread neuron-neuron edges), `per_neuron_neuropil_count_{pre,post}_783.feather`, `proofread_root_ids_783.npy`.
- Cell-type/hierarchy annotations: `flyconnectome/flywire_annotations` GitHub repo, v3.1.0, actively maintained through 2026 (cross-referenced against the new male-CNS paper).
- Access: no general bulk REST/GraphQL API exists; programmatic access is via `caveclient` (CAVE account + bearer token) and `fafbseg-py`/`navis` on top of it, or direct Zenodo file download for the frozen v783 snapshot (recommended for reproducibility — the archival snapshot doesn't drift as proofreading continues).
- **Root IDs are not permanent** (proofreading edits mint new root IDs) — we will pin every derived artifact to materialization version 783 explicitly and prefer the frozen Zenodo snapshot over live Codex queries for anything that needs to stay reproducible.

**✅ Licensing — resolved, not a blocker.** You've confirmed FLYTOWN is non-commercial, open-source, and research/education-oriented. The archival Zenodo connectivity/synapse data is CC-BY-4.0; the live Codex platform's cell-type/NT annotation layer is CC-BY-NC-4.0 (commercial use prohibited). **Both are fully compliant with a non-commercial open-source research project — no exception request needed.** The only ongoing obligation is attribution (Section 24): cite the papers per FlyWire's guidelines, credit Codex's DOI, and preserve per-annotation-edit authorship metadata if individual annotations are surfaced in the product. If FLYTOWN's licensing posture ever changes (e.g. someone wants to commercialize it later), this section needs revisiting — flagging that dependency explicitly so it isn't forgotten.

**Successor datasets, noted for awareness, not recommended for v1:** BANC v888 (female brain + nerve cord), MCNS v1.0 (male whole-CNS, Berg/Beckett/Costa/Schlegel et al. 2026, license listed as CC-BY without the NC restriction — worth a second look if the FAFB licensing question resolves unfavorably, though it changes which specimen/sex we're using and would need its own literature-mapping pass).

## 11. Simulation model and why

**Recommended: discrete-time, rate-based activation propagation with per-node leaky decay over a fixed sparse weighted graph — not spiking, not a dense matrix, not (yet) trainable dynamics.**

Formally, for region/node activity vector `a_t` (dimension = number of regions, ~78 for Option A):

```
a_{t+1} = clip( (1 − λ) · a_t + λ · σ( W · a_t + input_t ) , 0, a_max )
```

- `W` — fixed, sparse, signed adjacency derived from connectome structure (`MEASURED` topology; sign from NT predictions, `INFERRED_FROM_LITERATURE`; magnitude from synapse counts, explicitly documented as a proxy, `ENGINEERING_CHOICE`).
- `λ` — leak rate, `ENGINEERING_CHOICE`, exposed as a parameter, default fixed (not learned) in v1.
- `σ` — a bounded nonlinearity (e.g. tanh or clipped ReLU), `ENGINEERING_CHOICE`.
- `input_t` — nonzero only during the first few steps (the injected "odor").
- Propagation runs for a small fixed `T` (e.g. 8–20 steps), bounding both latency and memory deterministically.

**Why this over the alternatives you asked us to compare:**

| Approach | Verdict for v1 |
|---|---|
| Weighted graph diffusion | Close cousin of what we chose; slightly too passive (no nonlinearity/thresholding) to express anything resembling action-selection competition. |
| **Discrete-time rate-based propagation (chosen)** | Simplest model that still has recurrence, nonlinearity, and a natural place for inhibition/excitation to matter — the minimum viable substrate for the actual hypothesis. Cheap enough to run at Option-C scale later without new infrastructure. |
| Leaky integrate-and-fire / event-driven spiking | Biologically richer, but we have no validated per-neuron time constants, thresholds, or refractory parameters for this connectome — every such parameter would be an unsupported invented number dressed as biology. Deferred until/unless Milestone 3+ evaluation shows the coarser model is action-selection-limited in a way spiking would plausibly fix. |
| Reservoir computing | Tempting (fixed random-like recurrent reservoir + trained readout is structurally very close to what we're proposing) but frames the connectome as "just a big random reservoir," which undercuts the falsifiability goal — we specifically need to compare against a *literal* random/shuffled reservoir as a baseline (Section 18), so the production model shouldn't already *be* generic reservoir computing philosophically. |
| Connectome-constrained learned dynamics | The natural v2+ direction (Section 13) — deferred because it reintroduces exactly the "is this just a themed neural net" risk the falsifiability harness exists to catch, and we want a dumb, fixed-topology baseline result *first*. |
| Hybrid (fixed topology, trainable weights/time-constants/readouts) | This is effectively what we chose, scoped conservatively: topology fixed, `λ`/`σ` fixed in v1, only the readout and input encoder trainable. Time constants become trainable in Milestone 3 if warranted. |

**Engineering constraints satisfied:** sparse representation throughout (never a dense 139,255×139,255 matrix — even at full Option-C scale, ~3.7M consolidated edges is a small sparse structure); deterministic given a seed + connectome version + learned-weights version; CPU-only, sub-second per request at Option-A/B scale; fails safe (NaN/Inf/out-of-range activity anywhere → fall back to the conventional planner and surface the failure, never silently proceed with garbage state).

## 12. Input encoding and action readout design

**Input ("odor") encoding — `ENGINEERING_CHOICE`, explicitly a "sensory prosthesis," not claimed to be biologically derived:**

A structured feature vector (semantic task embedding, deliverable type, repo language/framework, test-failure count, error signatures, security sensitivity flag, time/cost pressure, confidence/uncertainty estimate, number of conflicting hypotheses, prior-attempt outcome, tool availability, pending-approval flags) is projected through a small trainable linear/embedding layer onto a *sparse* subset of designated input nodes — deliberately modeled loosely on antennal-lobe sparse coding (a handful of "glomeruli" respond per task), not a dense broadcast to every node. This projection is one of the few trainable parameter sets (Section 13).

**Action readout — fixed vocabulary, `ENGINEERING_CHOICE` for the mapping, trainable weights:**

Terminal (or time-averaged) activity of a small set of designated **readout regions** (in Option A, a handful of the 78 neuropils chosen for plausible correspondence to motor/descending output per the literature; in Option B, actual descending-neuron-like cell types) is mapped by a small trained linear/softmax head to a distribution over:

```
spawn_flight | increase_swarm_size | request_artifact_investigation |
invoke_reviewer | merge_results | run_tool | run_tests | retry_new_approach |
search_memory | surface_uncertainty | request_human_approval |
terminate_success | terminate_blocked
```

Each action, plus the current activity snapshot, deterministically compiles into `PlanNode`/`PlanEdge` entries via a fixed, unit-tested mapping function (not another LLM call) — this keeps the readout inspectable and the trace exactly attributable ("region X's activity of Y caused action Z").

## 13. Learning and reward design

**Off by default.** When enabled:

- **Trainable:** input-encoder projection weights, readout weights, per-action decision thresholds, and — starting Milestone 3 only — a small, explicitly-designated set of "plastic" edges inside the curated mushroom-body-like circuit (Kenyon-cell → MBON-equivalent connections), which is the one place in the real fly brain where dopaminergic reinforcement is understood to act on synaptic weights during associative learning — an unusually well-motivated place for us to also permit plasticity.
- **Fixed, never modified in v1:** the connectome topology itself, all other synaptic weights, decay/nonlinearity parameters.
- **Update rule:** reward-modulated, simple to start — treat action selection as a contextual bandit over connectome-engine state, use a standard bandit update (e.g., a linear/softmax policy gradient step) on the readout weights only; explore local Hebbian-style updates restricted to the designated plastic edges as a Milestone-3 experiment, not a v1 requirement.
- **Reward signal:** reuse the orchestrator's existing outcome data (guard pass/fail, Sugar score, test pass/fail, cost, latency, retry count, human accept/revise/reject) rather than inventing a new one — this also means FLYTOWN's reward is exposed to the exact same reward-hacking surface the worker pipeline already has (Section 16), so hardening one hardens both.
- **All learned state:** versioned, inspectable (plain JSON, diffable), resettable (delete the file, fall back to untrained/zero-init weights), exportable, reproducible given a seed, and **disabled by default whenever a run requests deterministic evaluation** (matching the run store's own `RunRecord`/replay philosophy).
- **Explicitly not claimed:** that a task embedding model "understands" language because it's attached to a fly graph. The embedding is a prosthesis we built; the fly graph never sees natural language.

## 14. Worker-orchestration contracts

No new contract needed — this is the payoff of the integration seam (Section 5). FLYTOWN's `PlannerBackend` implementation produces exactly the `Plan`/`PlanNode`/`PlanEdge` shapes `executePlan`/`performFlight` already consume. Worker activation, context allocation, concurrency (global semaphore, `FLYTOWN_MAX_CONCURRENCY`), tool permissions, retry limits, evidence requirements (guard verdicts), and final synthesis (`synthesize` sink node + Scribe) are **100% the existing orchestration machinery, untouched.** FLYTOWN adds exactly one new decision point upstream of all of that.

One gap the audit surfaced that FLYTOWN should *not* inherit silently: the audited pipeline has **no per-model-call timeout** and a **single global concurrency semaphore** with no per-slot/per-cost-tier distinction. If FLYTOWN's routing starts allocating swarm sizes and worker counts more dynamically than the conventional planner does today, this existing gap becomes more consequential (Section 23) — worth fixing regardless of FLYTOWN, and cheap to fix now.

## 15. Persistence and artifact formats

New, additive, namespaced separately from the Compost so nothing existing is touched:

```
<terrarium>/.flytown/
  connectome/<version>/manifest.json     # source dataset version, checksum, every
                                          # preprocessing decision, license terms
  connectome/<version>/graph.json        # sparse signed edge list (Option A/B/C)
  connectome/<version>/regions.json      # names + MEASURED/INFERRED/ENGINEERING/METAPHOR tags
  learned-weights/<weightsVersion>.json  # versioned, resettable, exportable
  brain-traces/<runId>.json              # full trace, keyed to the orchestrator's runId
```

`brain-traces/<runId>.json` cross-references the existing `RunRecord`/`Flight`/`Plan` ids so a single `runId` reconstructs both "what the fly-derived network did" and "what the swarm did as a result" from two small, independently-readable JSON trees — mirroring the "fully reconstructible from records alone" property the Compost already has (with the same caveat the audit found in the inherited store: no corruption/integrity checking beyond best-effort warnings, which FLYTOWN should not make worse).

*As built:* connectome artifacts live in the repository's `connectome/<id>/` (built by `connectome-etl/`), and a terrarium keeps decision traces in `.flytown/traces/`, learned weights in `.flytown/weights/` and evaluation reports in `.flytown/eval/`, beside its Compost in `.flytown/compost/` — see [docs/reference/storage-layout.md](./docs/reference/storage-layout.md).

## 16. Security and permission boundaries

- The connectome engine **only ever produces a `Plan`** — a pure data structure, not code, not a tool call, not a prompt fed directly to a worker as an instruction. It cannot execute anything.
- Every `Plan` FLYTOWN produces passes through the **existing, unmodified** `validatePlan`/`topologicalOrder` (cycle rejection, single-sink enforcement, `maxNodes` cap) before a single node executes — this is a real, pre-existing safety backstop we inherit for free, not something FLYTOWN has to build.
- Tool permissions, sandboxing (such as it is — Section 4's "no shell/file-write tool" finding), budget enforcement, and concurrency limits are 100% the existing orchestration code path, unchanged.
- `node.task` strings FLYTOWN's planner writes are treated exactly as planner-authored task strings are treated today — they still go through ordinary worker prompting with no elevated trust, so FLYTOWN introduces no new prompt-injection surface beyond what a task string already has.
- Reward signals inherit the worker pipeline's existing reward-hacking exposure (Sugar is not adversarially hardened, and since 2026-09-12 it no longer carries a drift penalty either) — flagged as a shared risk, not a new one, in Section 23.
- Hard caps, independent of any connectome-derived decision: max nodes per plan, max replans (existing default 2), max total budget (existing `Budget`/`enforceOrThrow`), and a **kill switch** — an explicit "fall back to the conventional planner" flip, both as a terrarium-level config default and as a runtime override, satisfied trivially by the `PlannerBackend` injection point itself (swap the implementation, no other change needed).
- The system must never claim sentience/consciousness in any user-facing string, log, or trace — enforced by a copy-review checklist at ship time, not just this document.

## 17. Observability and brain-trace format

Every FLYTOWN decision is traceable end-to-end via `brain-traces/<runId>.json`:

```jsonc
{
  "runId": "...",                         // shared with the RunRecord/Flight/Plan
  "connectomeVersion": "fafb-v783-optionA-1",
  "weightsVersion": "readout-v3" ,        // or "untrained" if learning disabled
  "seed": 12345,
  "input": { "rawSignals": {...}, "odorVector": {"AL_glom_3": 0.8, ...} },
  "propagation": [
    { "t": 0, "regionActivity": {"MB": 0.1, "CX": 0.0, ...} },
    { "t": 1, "regionActivity": {...} }
    // ... bounded T steps
  ],
  "readout": { "actionDistribution": {"spawn_flight": 0.62, "retry": 0.2, ...},
               "actionTaken": "spawn_flight" },
  "planProduced": { "planId": "...", "nodes": [...], "edges": [...] },
  "flightOutcome": { "flightId": "...", "outcome": "winner", "sugar": 0.81 },
  "reward": { "value": 0.81, "appliedTo": ["readoutWeights"], "learningEnabled": true },
  "provenance": { "AL_glom_3": "MEASURED", "readoutMapping_spawn_flight": "ENGINEERING_CHOICE" }
}
```

A plain-text/technical trace view (this JSON, or a rendered table) is **always** available; the biological/artistic visualization (Section "observability" in your brief — dark 3D/2D brain, glowing regions, workers-as-flies) is an optional layer on top, never the only way to see what happened. CLI/API parity with the visual mode is a Milestone-5 requirement, not an afterthought. Deterministic replay = re-run with the same `connectomeVersion` + `weightsVersion` + `seed` + `input`.

*As built:* the trace type is `DecisionTrace` in `src/flytown/trace.ts`, written to `.flytown/traces/<runId>.json`, rendered as plain text by `flytown fly trace` and replayed by `flytown fly replay`.

## 18. Evaluation and ablation methodology

Every FLYTOWN planner variant is run against the **same task suite, same budgets**, and compared against:

1. The existing LLM-based planner (`planTask`, unmodified) — the real baseline that matters commercially.
2. A conventional rules-based router (simple heuristics over the same input signals).
3. A small learned neural router (dense/MLP, no biological topology) trained on the same reward.
4. A random graph with FLYTOWN's actual degree distribution.
5. A shuffled FLYTOWN graph (same edges, permuted node identities).
6. FLYTOWN with major regions ablated (one region zeroed at a time).
7. FLYTOWN with learning disabled (fixed/untrained readout).
8. FLYTOWN with recurrence disabled (single-pass, no feedback loop).

**Task suite** (Milestone 1 deliverable, before any connectome code is written): straightforward repo questions, small bug fixes, ambiguous failures, misleading-initial-hypothesis tasks, multi-file implementation, security-sensitive work, research synthesis, tool/runtime-check tasks, genuinely-blocked tasks, and tasks where early stopping is correct.

**Metrics:** completion rate, correctness, test pass rate, human acceptance, token usage, cost, latency, worker count, unnecessary-action count, recovery-after-failed-approach rate, hypothesis diversity, false-confidence frequency, termination quality, reproducibility, trace interpretability (all per your brief — nothing added or removed).

**Reporting standard:** if FLYTOWN performs indistinguishably from the shuffled-graph baseline (#5) on the primary metrics, **that is the headline result**, reported as such, not buried. A negative result on raw task performance is an acceptable outcome; an unfalsifiable claim is not.

## 19. Performance and cost expectations

- **Option A runtime:** sub-millisecond graph propagation per request (≤78-node sparse graph, ≤~20 timesteps); dominant latency is still the LLM calls inside `performFlight`, which FLYTOWN does not change. FLYTOWN's own overhead should be negligible against existing flight latency.
- **Option A memory/storage:** connectome runtime artifact on the order of tens of KB to low MB; trivial to bundle, version, and diff.
- **Option C (neuron-level, Milestone 4+):** raw synapse table 9.5 GB on disk (Zenodo v783), consolidated edge list (~3.7M edges) plausibly 70–100 MB as a sparse columnar structure — **this specific size estimate is our own order-of-magnitude calculation, not a published benchmark**, and should be validated against a real preprocessing run before being treated as a planning number. In-memory sparse-graph propagation at this scale is still CPU-feasible (tens to low hundreds of ms per request is a reasonable target, to be measured, not assumed).
- **No GPU required** for v1 or v2 (Options A/B); GPU acceleration is a possible later optimization for Option C, never a hard requirement per your engineering principles.
- **Preprocessing cost (one-time/occasional, Python sidecar):** CAVE account/token setup, multi-GB file download and ETL — a few hours of engineering + reasonable compute for the initial pipeline build, re-run only when the connectome version or extraction logic changes (checksummed and cached, not part of the request path).

## 19a. Cost comparison — Option A/B vs. full-fidelity Option C

You asked for concrete cost differences before deciding whether full neuron-level fidelity should be the committed destination rather than a contingent stretch goal. Here it is. **Headline finding: at the scale this project actually runs at — a personal machine, non-commercial, no paying users, no cloud-scale request volume — dollar cost is negligible at every fidelity level.** The real cost that scales with fidelity is engineering and review *time*, not infrastructure spend. Dollar figures below are order-of-magnitude, based on standard 2026 cloud object-storage pricing (~$0.02–0.023/GB-month) — treat as approximate, not quoted rates, since this project won't be pricing-sensitive at these volumes regardless.

| Dimension | Option A (projectome, ~78 regions) | Option B (curated circuits, on top of A) | Option C (full ~139K-neuron graph) |
|---|---|---|---|
| Raw data touched | Full 9.5 GB synapse table read once to compute region aggregates, then discarded/cached as the tiny output | Same 9.5 GB table, once, to extract curated-neuron subgraphs (~tens of MB output) | Same 9.5 GB table, retained or re-derivable from the stable Zenodo mirror on demand |
| One-time ETL engineering time | ~3–5 days (aggregation script + manifest/checksum tooling) | ~2–3 weeks **of which most is literature review and citation-drafting, not code** — this is the human-time cost Section 6/27 already scoped as async-validated, not a blocking gate | ~1–2 weeks *if built after A's tooling exists* (audit found the region-level and neuron-level pipelines share almost all preprocessing scaffolding); ~3–4 weeks if attempted from scratch |
| Runtime artifact size | Tens of KB | Low single-digit MB | ~70–100 MB (our own estimate, consolidated sparse edge list — not a published benchmark, flagged in Section 19) |
| Fits comfortably on this machine? | Trivial, sub-MB working set | Trivial | Yes — a modern 16–32 GB Mac holds the full sparse graph in memory without strain; propagation is expected in the tens-to-low-hundreds-of-ms range per request (to be measured, not assumed) |
| Storage cost if ever hosted (rough) | Effectively $0/mo | Effectively $0/mo | ~$0.002–0.20/mo for the runtime artifact; no need to host the raw 9.5 GB archive yourself at all — re-pull from the stable public Zenodo mirror (v783) whenever the ETL reruns, rather than paying to store a duplicate |
| One-time preprocessing compute | Minutes on a laptop, no GPU | Minutes to low hours on a laptop, no GPU | Tens of minutes to ~1–2 hours on a laptop (pandas/scipy at 9.5 GB scale), no GPU required at any point in this plan |
| Ongoing maintenance (per FlyWire dataset/annotation update) | Low — rerun aggregation, minutes | Medium — each curated circuit needs a re-check against updated annotations | Low–medium — mechanical rerun; larger data means more to spot-check, not more to compute |
| **Dominant cost driver** | Negligible across the board | **Human review time** (literature curation, async neuroscience-collaborator validation) | **Engineering time** for sparse-graph runtime correctness and performance polish — not infrastructure spend |

**Conclusion:** since dollar cost is trivial at every fidelity level and the main cost — engineering weeks — is comparable in order of magnitude to Option A once its tooling exists (Option C reuses most of it), there isn't a real cost tradeoff to weigh against your "more fly, the better" instinct. **Section 20 below reframes Option C as the committed destination, sequenced after A/B for tooling-reuse reasons, not gated on A/B beating baselines first.** The falsifiability harness (Section 18) still runs honestly at every stage regardless of that commitment — "we're building toward full fidelity anyway" and "we report null results honestly" are not in tension; the first is a project-scope decision, the second is a scientific-integrity commitment that applies no matter what scope was chosen.

## 20. Milestone-by-milestone implementation plan

Revised from your draft based on what the audit found — Milestone numbers preserved, content adjusted where the planner seam or FlyWire data landscape changes the shape of the work.

**Milestone 0 — Audit & research (this document + its two source reports).** Done pending your approval. Deliverable: this proposal + the falsifiable hypothesis (Section 25) + the ADR this document effectively is.

**✅ Status (2026-09-11 evening): Milestones 1 and 2 are implemented and the Section-25 falsification test has been run — and, at projectome level, it falsified.** `PlannerBackend` seam extracted (`src/plan-executor.ts`, `src/flytown/`); rules / random / learned baselines, deterministic mock-worker evaluation harness with paired permutation tests, decision-trace format with replay, `fly` CLI; Python ETL sidecar producing checksummed `fafb-v783-projectome-1` (79 nodes, 3,509 edges) and `fafb-v783-neuron-1` (139,255 neurons, 15.1M edges) artifacts from the Zenodo v783 release; fly planner with shuffled / degree-preserving-random / region-ablated / no-recurrence / signless / no-learning variants. 353/353 tests. **Result:** fly vs fly:shuffled not distinguishable (p = 0.06 without learning, p = 1.0 with 8 training epochs); the real region-level graph collapses task information ~8× harder than a shuffled copy (0.03 vs 0.12 bits). Full log: `docs/flytown/experiments/README.md`. Milestone 3 is therefore redirected at neuron-level sparse coding (Kenyon cells), which is the biological substrate the region-level test could not reach.

**Milestone 1 — Orchestration interface & baselines.**
- Extract `PlannerBackend` interface in `plan-executor.ts` (Section 5); wrap existing `planTask` as the default implementation. No behavior change for existing users.
- Build the fixed task suite (Section 18) as deterministic fixtures.
- Record conventional-planner traces on the task suite as the baseline dataset.
- Implement baselines #2 (rules-based) and #3 (small learned router) as additional `PlannerBackend` implementations — cheap, no connectome data needed yet, and they exercise the seam end-to-end before any biology is involved.
- Establish the evaluation harness (metrics + comparison runner) against these three planners first.

**Milestone 2 — Projectome prototype (Option A).**
- Stand up the Python ETL sidecar; produce a versioned, checksummed region-level (~78 neuropil) runtime graph artifact from FAFB v783.
- Build the sensory encoder and fixed action-readout mapping (Sections 12, un-trained initially — fixed random or zero-init readout).
- Implement the propagation model (Section 11) as a small, dependency-light TS module.
- Wire it up as a `PlannerBackend`; run the full task suite; compare against baselines #1–5 (add random-graph and shuffled-graph baselines here).
- **Go/no-go checkpoint:** if FLYTOWN-A is statistically indistinguishable from shuffled/random on every primary metric, say so plainly before proceeding to Milestone 3.

**Substrate decision (2026-09-11, approved):** Milestone 3 moves to the **whole first-instar larval brain** (Winding et al. 2023: 3,016 neurons, ~548k synapses, four synapse-type channels) rather than curated adult subcircuits. Rationale: the projectome result showed region collapse destroys task information; the larva is small enough to simulate whole at single-neuron resolution, and its mushroom body is the best-mapped learning circuit in any connectome — every KC→MBON synapse and the DAN→compartment wiring are measured, and the depression rule and DAN valences are established experimentally (Eichler 2017, Saumweber 2018, Eschbach 2020, Jürgensen 2024). "Designated plastic edges" therefore become MEASURED structure + INFERRED_FROM_LITERATURE rules instead of METAPHOR. Known limits, stated up front: no neurotransmitter dataset exists for the larva (curated partial signs only), single 6-hour-old female, ~25% of synaptic sites orphaned, chemical synapses only, supplementary-data licence not independently confirmed (article CC BY 4.0; cite Winding 2023 + CATMAID). The adult FAFB data remain the Milestone-4 / product substrate. Pre-registered protocol: `docs/flytown/experiments/README.md`.

**✅ Milestone 3 status (2026-09-11, late):** larval artifact built and verified (2,952 neurons, 110,677 edges, 2,746 plastic KC→MBON synapses, 2 appetitive / 6 aversive DANs, MBON valence labels); runtime generalised to neuron-level substrates (node groups, synapse-type channels, curated signs, k-WTA sparse coding, per-neuron learned readout, DAN-gated plasticity). **Pre-registered primary test: null twice** (`plastic` vs `shuffled+plastic`, p = 1.0 in both the pre-registered and the post-hoc configuration). Suggestive but uncorrected signals in the predicted direction (plasticity helps adapter learning p = 0.014; dopaminergic lesion hurts p = 0.017); removing KC sparsening unexpectedly gave the best larval variant (78%); the rules baseline (82%) still beats everything. Full account with every post-hoc change listed: `docs/flytown/experiments/README.md`.

**✅ First live-model evaluation (2026-09-12; pre-rename record):** real Goblintown pipeline on DeepSeek `v4-flash` (thinking disabled via the new `provider.requestParams`), 10 fixtures × 4 planners, 2.57M tokens, 69 min. Real larva vs shuffled larva: termination accuracy 80% vs 80%, **p = 1.0** — the pre-registered null holds live; both transferred constant policies from mock training. `rules` 90%, Goblintown's `llm` planner 100% on what it completed at 2–5× the cost. Goblintown's troll-gated "success" proved non-discriminative live (every plan shape gets rescued by specialists/ogre), so the next requirement is an LLM-judge quality score, more seeds, and live reward. Details: `docs/flytown/experiments/2026-09-12-live-run1-deepseek.md`.

**✅ Shipped (2026-09-12; pre-rename record): `rules` is the default planner.** Full-suite live comparison against Goblintown's own LLM planner (20 fixtures × 2 seeds, 6.88M tokens, n=37 pairs): on completable tasks quality is **indistinguishable** (+0.010, p = 0.89) — correcting an earlier small-sample overstatement — but `rules` uses **39% fewer tokens** (p < 0.0001) and wins **7 of 7** pairs where the right answer is to stop (p = 0.015), because the LLM planner picks `spawn_subrite` for 100% of tasks and has no halt vocabulary. Same answers, meaningfully cheaper, and it knows when to stop. Details: `docs/flytown/experiments/2026-09-12-live-run3-rules-vs-llm.md`.

**✅ Live run 2 with the LLM judge (2026-09-12; pre-rename record):** 5 planners × 10 fixtures × 2 seeds, 5.24M tokens. Real vs shuffled larva: identical decisions on every task, quality 0.44 vs 0.58 (p = 0.20, i.e. worker noise on identical plans). **`rules` 0.69 quality / 100% termination / 58k tokens beat Goblintown's own `llm` planner (0.39 / 78% / 121k) on every axis.** Third consecutive null for the wiring; the constant-policy collapse under learning is the identified obstacle. The web control surface (`/fly`) is built and verified. Details and proposals: `docs/flytown/experiments/README.md`.

**Milestone 3 — Curated circuits (Option B) + restrained learning.**
- Add mushroom-body / central-complex / dopaminergic / descending-neuron curated subcircuits at cell-type resolution where literature support is real (documented per-circuit, with citations, in the `provenance` trace tags).
- **Curation review process (confirmed):** citations are drafted by Claude as part of this work, clearly flagged as our interpretation per Section 3's `MEASURED`/`INFERRED_FROM_LITERATURE`/`ENGINEERING_CHOICE`/`METAPHOR` tagging. A neuroscience collaborator then validates **after the fact, asynchronously** — this is not a pre-ship blocking gate, so Milestone 3 work isn't stalled waiting on a review cycle, but any correction the collaborator surfaces gets folded back into the trace provenance tags and product copy promptly.
- Enable the restrained learning design (Section 13): trainable input/readout weights, optional plastic KC→MBON-equivalent edges.
- Add ablation baselines #6–8 (region-ablated, learning-off, recurrence-off).
- Test recovery-from-misleading-hypothesis and exploration/exploitation behavior specifically — these are the metrics your brief flags as the most interesting possible "win" short of raw completion-rate gains.

**Milestone 4 — Full connectome substrate (Option C), committed destination, not gated.**
- Per your decision (Section 19a): pursued regardless of whether Milestone 2/3 benchmarks show a clear performance win, because the marginal cost over A/B is small (mostly engineering time reusing A's tooling) and full fidelity is a research/art goal in its own right, not purely an instrumentally-justified one.
- Preprocess the full sparse ~139K-neuron graph; benchmark real CPU/memory cost against the Section 19/19a estimates; introduce event-driven/sparse propagation if the benchmark shows it's needed (not preemptively); preserve neuron/synapse provenance throughout; run the full evaluation harness (Section 18) against A/B and all baselines on the same suite.
- **The falsifiability commitment does not weaken here.** If full-fidelity FLYTOWN still performs indistinguishably from shuffled/random baselines, that gets reported exactly as honestly as it would have at Milestone 2 — "we built it anyway because it's the right destination" and "we tell you the truth about whether it helps" are separate commitments, both held simultaneously.

**Milestone 5 — Product experience.**
- Brain visualization (biological, artistic, accessible, reduced-motion-compliant) as a layer over the always-available plain trace (Section 17).
- Run replay, side-by-side comparison mode, ablation mode (user disables a region, reruns the same task), region/cell-type inspection.
- Accessible CLI/API parity, packaged reproducible demo.

## 21. Every file expected to be created, modified, or removed

*Pre-rename record: the fork status, the source-of-truth decision and the strip table describe the Goblintown tree as it was. The list of kept files uses the file names in use since the rename.*

**✅ Status (2026-09-11): the fork-and-strip baseline is done.** `~/flytown/` was built from a fresh `git clone --filter=blob:none` sparse checkout of `0xbl33p/goblintown@main` (not the stale local worktree, which predated the Codex/ChatGPT/Vercel commits and was missing 7 files this section's removal list covers). Result: 48 kept `src/*.ts` files + 38 test files, `npm run build` clean, `npm test` 299/299 passing, single initial commit `bbb628e` on a fresh `git init` (no remote, nothing pushed). Package provisionally renamed `flytown-core` pending final naming (Section 27). Open follow-ups from that pass, not yet resolved:
- `site/index.html`'s marketing copy still describes Solana/Thesis/Sentiment/ChatGPT/Codex features that no longer exist in this fork (cosmetic only, not code/tested — left as-is, needs a copy pass).
- The Firebase Cloud Mode schema (`countries`/`countryJoinRequests` Firestore collections, `profile.countryId`) and its user-facing copy still describe the removed country/federation feature server-side, because `nukeCloudAccountData` (kept, Asteroid Mode) depends on that exact schema to scrub cloud data correctly. Not broken, but describes a feature with no local UI anymore — needs a decision once Cloud Mode itself is revisited. *(Resolved 2026-09-12: the Goblintown Firebase cloud configuration was removed — see [NOTICE.md](./NOTICE.md).)*
- 4 orphaned static pages (`site/admin.html`, `dashboard.html`, `privacy.html`, `terms.html`) were dropped as an inferred extension of the ChatGPT-App removal (their only referrer was `chatgpt-app.ts`) — not explicitly on the original removal list, flagging for awareness.



**Source-of-truth decision needed before this section can be finalized.** The local checkout at `~/goblintown/backrooms-0.7-telemetry` and the real upstream repo at `github.com/0xbl33p/goblintown` (public, MIT, 40 stars, 6 forks — confirmed consented) have **diverged**:

- The **local checkout has one file upstream doesn't**: `src/telemetry.ts` (crash-report infra under `.goblintown/errors/` — this looks like core operational infra, not a user-facing bolt-on, so my instinct is to keep it either way, but flagging since it's not in the canonical repo).
- **Upstream `main` has seven files the local checkout doesn't**: `src/mcp.ts`, `src/chatgpt-app.ts`, `src/chatgpt-host-runner.ts`, `src/vercel.ts`, `src/install.ts`, `src/plugin-install.ts`, `src/skill-install.ts`. I have not audited any of these yet — I don't know if they're more bolt-on surface area (in the spirit of the crypto/social stuff we're stripping) or legitimate extension infrastructure worth keeping. **Recommend a quick audit pass on these seven files before forking**, so the strip decision covers them deliberately rather than by omission. See Section 27 for this as an open item.

**Git-verified strip scope** (confirmed against real upstream commit history, not guesswork):

| Files | Introduced in | Verdict |
|---|---|---|
| `src/solana.ts`, `src/solana-tools.ts`, `src/thesis.ts`, `src/sentiment.ts`, `src/sentiment-secrets.ts`, `src/addons.ts` | commit `215ef32`, "refine sentiment and settings workflows" — landed together as one cohesive crypto/trading-research feature cluster | **Strip.** `addons.ts`'s only current consumer is the Solana tool pack it registers; the `AddonDefinition` extension-point *pattern* (Section 6) is worth remembering if a future non-crypto tool pack is wanted, but the file itself goes. |
| `src/voice.ts`, `src/voice-secrets.ts` | commit `e59e861`, "Add desktop installers and full Tank chat UI" — added alongside Single-Goblin chat mode, not the orchestration core | **Strip.** |
| `src/federation.ts`, `src/country.ts`, `src/country-identity.ts`, `src/social.ts` | present on upstream `main`; exact introducing commit not pinned (likely folded into a merge commit whose file-diff GitHub's API doesn't expose per-file) but confirmed real and upstream, not a local-only experiment | **Strip** — the whole peer-to-peer federation/friends/DM social layer (Hoard's `friends/`, `friend-requests/`, `dm-threads/`, `dm-messages/`, `inbox/`, `outbox/` collections; `server.ts`'s `/api/friends/*`, `/api/dm/*`, `/api/country/*` routes) per your confirmation. |
| `src/telemetry.ts` | local-only, not upstream | **Keep, tentatively** — crash-report infra, not a themed bolt-on feature; flagging for your confirmation rather than assuming. |
| Corresponding test files for every stripped module (`src/__tests__/solana*.test.ts`, `thesis*.test.ts`, `sentiment*.test.ts`, `voice.test.ts`, `federation.test.ts`, `country.test.ts`, `onchain-ui.test.ts`, `addons.test.ts`) and doc pages (`docs/features/cloud-country.md`, `docs/features/research-tools.md` — audit before removing, may contain non-bolt-on content) | — | **Strip alongside their source files**, and remove the now-45-entries-shorter list from `package.json`'s `scripts.test` (Section 4 of the original audit flagged this list as hand-maintained, not a glob — easy to leave stale entries pointing at deleted files if this isn't done carefully). |

**Everything else — the full Morsel/Foray/Flight/Plan/Compost/Artifact/Terrarium orchestration core (file names as renamed on 2026-09-12): `castes.ts`, `flight.ts`, `foray.ts`, `compost.ts`, `terrarium.ts`, `scout.ts`, `sting.ts`, `guard-review.ts`, `specialist.ts`, `planner.ts`/`plan-executor.ts`, `artifact.ts`, `openai-client.ts`, `providers.ts`, `tools.ts`, `budget.ts`, `concurrency.ts`, `reward.ts`/`reward-plugin.ts`, `run-store.ts`, `chat.ts` (minus its voice dependency), `server.ts` (minus the stripped routes), `cli.ts` (minus the stripped subcommands) — stays, matching what the README itself documents as the product.**

**Modified (in the new stripped fork, once created) — Milestone 1:**
- `src/plan-executor.ts` — extract `PlannerBackend` interface, accept it as an injected option, default to wrapped `planTask`. (~20–40 line diff.)
- `src/planner.ts` — no logic change; export a `PlannerBackend`-shaped adapter around existing `planTask`. (~10 line addition.)
- `src/cli.ts` (`cmdPlan`) / `src/server.ts` (`startPlanRun`) — optional, only if runtime (not build-time) planner selection is wanted; otherwise untouched.

**New (in `~/flytown/`, confirmed as its own repo):**
- `connectome-etl/` (Python) — CAVE/fafbseg/navis-based preprocessing scripts, one per extraction stage (region aggregation, curated-circuit extraction in Milestone 3, provenance/checksum manifest writer).
- `src/flytown-planner.ts` (or a small package) — `PlannerBackend` implementation: sensory encoder, connectome engine (graph load + propagation), readout, Plan compiler.
- `src/connectome-engine.ts` — sparse graph propagation core, dependency-light, unit-testable in isolation from the worker pipeline.
- `src/sensory-encoder.ts`, `src/action-readout.ts` — the two trainable-parameter modules.
- `src/brain-trace.ts` — trace writer/reader matching Section 17's schema.
- `src/baselines/` — rules-based router, small learned router, random-graph, shuffled-graph, ablated-graph implementations (all `PlannerBackend`s, for the evaluation harness).
- `eval/` — task-suite fixtures, comparison runner, metrics collection (Section 18).
- `docs/adr/0001-flytown-integration-seam.md` — this proposal, formalized as an ADR once approved.
- No files are removed from either repo.

*As built:* the FLYTOWN runtime lives under `src/flytown/` — `planner-backend.ts` and `registry.ts` (the seam), `fly-planner.ts`, `connectome/` (artifact loader, engine, adapters, plasticity), `signals.ts`, `actions.ts`, `trace.ts`, `memory.ts`, `baselines/`, `eval/` (fixtures, harness, judge, mock worker world), `cli.ts` (the `fly` commands) and `web.ts` (the control surface).

## 22. Dependencies expected to be added

**Python (ETL sidecar only, not shipped with the running product):** `caveclient`, `navis`, `fafbseg`, `pandas`, `pyarrow` (feather/parquet), `numpy`, `scipy` (sparse), `networkx` (baseline degree-distribution/random-graph generation for evaluation).

**TypeScript/Node (runtime, minimal by design):** a sparse-matrix/graph utility if we don't hand-roll one (candidates to evaluate at implementation time, not pre-committed: `graphology` or a small hand-written sparse adjacency-list module — given "keep dependencies minimal," leaning toward hand-rolled given the graph sizes involved at Option A/B). No new LLM/provider dependencies — FLYTOWN reuses the existing `openai-client.ts`/`providers.ts` untouched for anything that still needs a model call (e.g. the sensory encoder's embedding step, if we reuse the existing `embeddings.ts` rather than adding a second embedding pipeline — recommended, to avoid two parallel embedding-model configs).

**No new mandatory runtime service.** No GPU dependency. No new database (flat JSON, matching the Compost's own persistence philosophy).

## 23. Major unknowns, risks, and possible failure modes

- **The headline scientific risk:** FLYTOWN performs statistically indistinguishably from the shuffled-graph baseline. This is a real, live possibility, explicitly designed for in Section 18, and must be reported honestly if it happens.
- **Licensing risk (Section 10, 24):** CC-BY vs. CC-BY-NC conflict between the archival synapse data and the live annotation layer is unresolved and could block commercial shipping entirely until FlyWire/Princeton clarifies or grants an exception.
- **"Themed state machine" risk:** Option A alone, without the evaluation harness actually being run and reported honestly, would be indistinguishable in spirit from "a themed random-number generator" — the harness is not optional scaffolding, it is the thing that makes this project defensible at all.
- **Reward-hacking risk is inherited, not new:** the worker pipeline's Sugar signal has no adversarial hardening (and since 2026-09-12 no drift penalty either); FLYTOWN's reward-modulated learning (Section 13) makes this matter more once anything is actually trainable, so hardening it becomes higher priority once Milestone 3 begins.
- **Inherited pipeline gaps that become more consequential under FLYTOWN:** no per-model-call timeout, single global (not per-slot) concurrency semaphore, no tool-argument schema validation (Section 14/4) — none of these are FLYTOWN's fault, but a more dynamically-routing planner will exercise them harder than the current LLM planner does.
- **Root-ID drift:** any FLYTOWN artifact built from live Codex queries rather than the pinned Zenodo v783 snapshot risks silent desynchronization as community proofreading continues; mitigated by pinning to the archival snapshot (Section 10) but must be enforced in the ETL tooling, not just documented.
- **Neurotransmitter-sign risk:** ~94% per-neuron accuracy with known systematic misidentification in some populations means the excitatory/inhibitory sign layer is the least trustworthy `INFERRED_FROM_LITERATURE` component in the whole system — worth a dedicated ablation (sign-randomized graph) in addition to Section 18's list if early results are sign-sensitive.
- **Scope-creep risk from the upstream codebase:** the crypto/trading and federation/social subsystems the audit surfaced are large, unrelated surface area; explicitly out of scope unless you say otherwise, but easy to accidentally couple to if FLYTOWN development happens inside the same repo rather than the separate `~/flytown/` tree recommended in Section 21.
- **FlyBrainLab is not a viable dependency** (last meaningful commit ~Sept 2025, last PyPI release June 2024) — already reflected in Section 22's dependency list (we go directly to `caveclient`/`navis`/`fafbseg-py`), flagged here as a risk in case anyone on the team assumed otherwise from the original brief's reading list.

## 24. Licensing and attribution considerations

- **Goblintown itself:** MIT, no blocking issue, reuse freely; note the `goblintown` npm name is already claimed, pick a distinct name for anything published.
- **FlyWire connectome data — the one open legal question in this whole proposal:** archival Zenodo synapse/connectivity data (CC-BY-4.0, commercial use technically fine with attribution) vs. live Codex/community annotation layer (CC-BY-NC-4.0, explicitly commercial-use-prohibited per FlyWire's own Terms of Service). **Recommendation: treat the combined dataset as non-commercial-use-only for now; get written clarification from flywire@princeton.edu before any paid/commercial FLYTOWN ships.** This does not block research/internal work.
- **Required attribution regardless of commercial status:** the FlyWire citation guidelines (https://flywire.ai/guidelines) specify the papers to cite; per-annotation-edit authorship metadata must be preserved/credited if we surface individual annotations; Codex itself has a citable DOI.
- **Neurotransmitter classifier (Eckstein et al., *Cell* 2024):** cite separately from the connectome papers when used.
- **Male-CNS / MCNS data (CC-BY, no NC restriction):** noted as a possible fallback path if the FAFB licensing question resolves unfavorably for commercial use, at the cost of switching specimens and re-doing the curated-circuit literature mapping in Milestone 3.

## 25. The smallest experiment that could falsify the idea

Run **Milestone 2 only** (Option A, no learning, no curated circuits) through the **full evaluation harness** against baselines #1 (conventional planner), #4 (random-degree graph), and #5 (shuffled FLYTOWN graph) on the fixed task suite, matched budgets, deterministic seeds. If FLYTOWN-A's orchestration decisions (action distribution, plan shape, termination behavior) are statistically indistinguishable from #5 (shuffled graph) across the primary metrics (Section 18), **the core hypothesis — that this specific biological topology contributes something a same-shaped random graph doesn't — is falsified**, and that should be reported as the headline result rather than proceeding to Milestone 3's added biological fidelity in hopes it fixes a null result at the wrong layer.

## 26. Clear acceptance criteria for the first prototype (end of Milestone 2)

1. `PlannerBackend` interface exists in the orchestrator, default behavior unchanged for existing users, verified by the existing test suite still passing unmodified.
2. FAFB v783 region-level (Option A) runtime artifact is built, versioned, checksummed, and reproducible from a documented, re-runnable ETL script.
3. FLYTOWN-A `PlannerBackend` runs the full fixed task suite end-to-end, producing valid `Plan`s that pass the existing `validatePlan`, with zero crashes/invalid-activity fallbacks required.
4. Baselines #1, #2, #3, #4, #5 all implemented and run on the identical task suite/budgets.
5. Brain-trace JSON produced for every run, cross-linked to the orchestrator's own `RunRecord`, and independently replayable (same seed/version/input → identical trace).
6. Evaluation report published with honest metrics per Section 18 — including explicit reporting of the shuffled-graph comparison regardless of outcome.
7. No claim anywhere in code, docs, or UI copy of consciousness, sentience, or a "captured mind."

## 27. Questions that genuinely require your decision

*Pre-rename record: the questions as posed before the fork. They have since been settled — see the Section 20 and 21 status notes and [NOTICE.md](./NOTICE.md).*

**Resolved this round:** licensing risk tolerance (non-commercial, no blocker), repo placement (`~/flytown/`, own repo), Milestone 1 baseline order (no preference — I'll build the rules-based router first since it's the simpler groundwork, then the small learned router, unless you object), task-suite realism (real repos on this machine), curation review process (draft-then-async-validate), and fidelity ambition (Option C is the committed destination, cost-justified in Section 19a).

**Still open:**

1. **Fork source:** upstream `github.com/0xbl33p/goblintown` `main` branch (the real canonical/consented repo, but has 7 files — `mcp.ts`, `chatgpt-app.ts`, `chatgpt-host-runner.ts`, `vercel.ts`, `install.ts`, `plugin-install.ts`, `skill-install.ts` — I haven't audited yet) vs. this local checkout (`~/goblintown/backrooms-0.7-telemetry`, missing those 7 files but has a local-only `telemetry.ts`)? **My recommendation: fork from upstream `main` as the canonical source, audit the 7 unknown files first (I can do this in a few minutes — want me to?), and port `telemetry.ts` over separately since it looks like reasonable infra to keep regardless.**
2. **`telemetry.ts`:** keep (crash-report infra) or strip alongside the other bolt-ons? My instinct is keep — it's operational infra, not a themed feature — but flagging rather than assuming.
3. **Scope of Goblintown reuse — narrowly confirming the final strip list:** the table in Section 21 is my best git-verified read of "core vs. bolt-on." Anything on that strip list you actually want kept (e.g. federation, if you have plans for multi-Warren collaboration later)?
4. **Kill-switch/fallback default:** should the conventional LLM planner remain the *default* in any shared/demo build indefinitely (FLYTOWN opt-in only), or is there a point where you'd want FLYTOWN to become the default? Given your "this must be the fly in the end" framing, my instinct is FLYTOWN becomes the default once Milestone 2's evaluation harness clears it as at least non-regressive — but this is worth your explicit call, not my assumption.
5. **Green light to actually start:** you asked me to revise the proposal first rather than touch any repo — this revision is that. Once you've read it, do you want me to (a) do the 7-file upstream audit next, (b) go ahead and fork+strip into `~/flytown/` now, or (c) something else first?

---

*Pre-rename record — the original v0.2 closing note:*

*No implementation code exists yet. Nothing above is approved except where explicitly marked "Resolved this round." This document and its two source research passes (Goblintown source audit; FlyWire dataset/licensing research) are available in full if you want the underlying citations or file:line references for any claim above.*
