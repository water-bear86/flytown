# HTTP API

The browser UI uses the same local HTTP surface exposed by `goblintown serve`.
Most endpoints are local-first and write to `.goblintown/`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Sidecar shell: rite controls, local imports, provider settings, hidden compatibility chat plumbing. |
| GET | `/tank` | Full Tank/live run UI; accepts `?run=<runId>`. |
| GET | `/rite/new` | Plain HTML Rite form fallback. |
| GET | `/rite/:id` | Rite detail with artifact lineage. |
| GET | `/quest/:id` | Quest detail. |
| GET | `/loot/:id` | Single Loot detail. |
| GET | `/drift` | Aggregate drift report. |
| GET | `/runs` | HTML run list. |
| POST | `/api/rite` | Start a Rite and return `{ runId }`. |
| POST | `/api/goblin/single` | Run one Goblin chat turn and stash Loot. |
| POST | `/api/plan` | Start a planner-driven DAG run and return `{ runId }`. |
| POST | `/api/context/ingest` | Import local text files as file-backed Artifacts. |
| POST | `/api/context/search` | Search Artifacts and imported context. |
| POST | `/api/context/chats/scan` | Scan Codex sessions or ChatGPT exports. |
| POST | `/api/context/chats/import` | Import previous chats as root/chunk Artifacts. |
| POST | `/api/context/vectorize` | Precompute embeddings for stored Artifacts. |
| GET | `/api/rite/:runId/stream` | SSE stream of RiteStep and plan events. |
| GET | `/api/runs` | JSON run list. |
| GET | `/api/runs/:runId` | JSON run record. |
| GET | `/api/loot/:id` | JSON Loot. |
| GET | `/api/artifact/:id` | JSON Artifact. |
| GET | `/api/rite/:id/artifact` | Artifact for a Rite. |
| GET | `/api/artifacts?limit=N` | Recent Artifacts. |
| GET | `/api/warren/stats` | `{ loot, rites, drift }`. |
| GET | `/api/trace/:runId` | LLM-MAS orchestration trace. |
| GET | `/api/providers`, `/api/provider` | Provider presets and active config. |
| POST | `/api/provider` | Update provider config and saved local key. |

## Streaming Notes

`/api/rite/:runId/stream` emits history first, then `replay-end`, then live
events. Browser clients should handle both replayed and live events. If a server
restart interrupts a run, the persisted run record marks that state instead of
pretending the run completed.
