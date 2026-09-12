# HTTP API

`flytown serve` exposes the local HTTP surface that the web control surface
uses. Endpoints are local-first and write to the terrarium's `.flytown/`.

## Control Surface And Planner Research

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | The web control surface (also served at `/fly`). |
| GET | `/api/fly/planners` | Planner specs, connectome ids, and the terrarium's default planner. |
| POST | `/api/fly/plan` | Decide only, run nothing: `{ task, planner, maxNodes }` → `{ trace, plan, text }`. |
| GET | `/api/fly/traces` | Decision trace ids, newest first. |
| GET | `/api/fly/trace/:id` | One decision trace plus its plain-text rendering. |
| POST | `/api/fly/replay/:id` | Re-run a stored decision deterministically and diff it. |
| GET | `/api/fly/connectomes` | Connectome artifact ids. |
| GET | `/api/fly/connectome/:id` | Manifest summary, node groups, plasticity, top edges. |
| GET | `/api/fly/evals` | Evaluation reports under `.flytown/eval/`. |
| GET | `/api/fly/eval/:name` | One evaluation report (JSON plus markdown). |

## Runs

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/plan` | Start a planned run and return `{ runId }`. Body: `task`, optional `planner`, `maxNodes`, `maxReplan`, `budgetTokens`, `cite` (flight ids), `remember`, `outputFormat`. |
| POST | `/api/flight` | Start a flight and return `{ runId }`. Body: `task`, optional `swarmSize`, `scanGlobs`, `personality`, `debate`, `guardTools`, `noSpecialist`, `specialistCap`, `noFallback`, `budgetTokens`, `maxOutputTokens`, `cite`, `remember`, `outputFormat`. |
| POST | `/api/ask` | One forager answers `{ task }` (optional `remember`, `outputFormat`, `maxOutputTokens`) and returns `{ output, morselId, usage, parentArtifactIds }`. |
| POST | `/api/chat` | One chat turn over `{ messages }` (optional `personality`, `maxOutputTokens`, and `modelSlot`: `forager` or `soldier`). |
| GET | `/api/flight/:runId/stream` | SSE stream of flight steps and plan events for a run started by `/api/flight` or `/api/plan`. |
| GET | `/api/runs` | JSON run list. |
| GET | `/api/runs/:runId` | JSON run summary; `?full=1` includes the events. |
| POST | `/api/runs/:runId/resume` | Resume an interrupted run from its last checkpoint. |
| GET | `/api/trace/:runId` | LLM-MAS orchestration trace for a run (a final `flightId` also works). |

## Records And Memory

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/morsel/:id` | JSON Morsel. |
| GET | `/api/artifact/:id` | JSON Artifact. |
| GET | `/api/flight/:id/artifact` | The Artifact written for a flight. |
| GET | `/api/artifacts?limit=N` | Recent Artifacts. |
| GET | `/api/terrarium/stats` | Morsel and flight counts and mean drift for this terrarium. |
| POST | `/api/context/ingest` | Import local text files as file-backed Artifacts. |
| POST | `/api/context/search` | Search Artifacts and imported context. |
| POST | `/api/context/chats/scan` | Scan Codex sessions or ChatGPT exports. |
| POST | `/api/context/chats/import` | Import previous chats as root/chunk Artifacts. |
| POST | `/api/context/vectorize` | Precompute embeddings for stored Artifacts. |

## Providers

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/providers` | Provider presets and model slots. |
| GET | `/api/provider` | Active provider config. |
| POST | `/api/provider` | Update provider config and the saved local key. |

## Record Shapes

- A **Morsel** is one model invocation: `id`, `caste`, `personality`,
  `model`, `prompt`, `output`, `drift`, `usage`, the `flightId` or `forayId`
  it belongs to, and `parentMorselIds`.
- A **guard verdict** (`GuardVerdict`) is
  `{ morselId, passed, score, critique }`.
- A **Flight** record carries its `task`, `swarmSize`, `personality` and
  `scanGlobs`; the morsel ids of each step (`contextMorselId`,
  `foragerMorselIds`, `stingMorselIds`, `specialistMorselIds`,
  `soldierMorselId`); `guardVerdicts` and `specialistVerdicts` keyed by
  morsel id; `winnerMorselId`; and an `outcome` of `winner`,
  `specialist_recovery`, `soldier_fallback` or `all_failed`.
- A **Foray** record carries `swarmSize`, `morselIds`, `guardVerdicts` and
  `winnerMorselId`.
- A **Plan** node carries `kind` (`flight` or `synthesize`), `swarmSize`,
  `personality`, `status`, and once run, its `flightId` and `artifactId`.

## Streaming Notes

`/api/flight/:runId/stream` emits history first, then `replay-end`, then live
events. Clients should handle both replayed and live events. If a server
restart interrupts a run, the persisted run record marks that state instead of
pretending the run completed.
