# Swarm Mode

Swarm mode is the full pipeline: multi-agent work with context, review,
recovery, memory, and resumable run state. It comes in two shapes — a single
flight against one task, or a plan of flights chosen by the planner.

## Entry Points

CLI:

```bash
flytown flight "Audit this migration plan" --swarm 3 --remember --debate --guard-tools
flytown plan "Design the feature and split it into buildable slices" --max-nodes 6
flytown /swarm "Plan and implement the feature"   # shortcut for plan --remember --format markdown
```

HTTP, while `flytown serve` is running:

- `POST /api/flight` — start a flight, returns `{ runId }`
- `POST /api/plan` — start a planned run, returns `{ runId }`
- `GET /api/flight/:runId/stream` — server-sent events for either kind of run

The web control surface at `/` starts planned runs from its Run tab and
streams them live. See the [HTTP API](../reference/http-api.md).

## Flight

A flight runs the pipeline directly against one task. Useful flags:

```text
--swarm <N>              foragers in the swarm (default 3)
--scan <glob>            files for the scout to read (repeatable)
--personality <name>     nerdy | cynical | chipper | stoic | feral | frenzied
--cite <flightId>        load that flight's Artifact as prior context (repeatable)
--remember               auto-load up to 3 relevant prior Artifacts
--debate                 one revision round after foragers see each other's drafts
--guard-tools            let the guard call verifier tools before scoring
--no-specialist          skip specialist recovery and go straight to the soldier
--specialist-cap <N>     maximum specialist foragers (default 3)
--no-fallback            never escalate to the soldier
--budget <tokens>
--max-output <tokens>
--format freeform|markdown|json
```

For a lighter run — a swarm plus guard review, with no scout, wasps,
specialists or soldier — use a foray:

```bash
flytown foray "Write a SQL join: users to last 5 orders" --swarm 3
```

## Plan Mode

Plan mode asks the planner to decompose a task into a DAG of flights. Each
node writes its own Artifact; dependent nodes receive parent Artifacts as
context. The planner backend is `rules` unless `--planner` or `flytown.planner`
in `.flytown/terrarium.json` chooses another, and a plan may halt without
running anything when the task is blocked, needs approval, or is already done.

```bash
flytown plan "Build a small authenticated API with tests" \
  --planner rules \
  --max-nodes 6 \
  --max-replan 2 \
  --remember \
  --format markdown
```

Planner decision traces are written to `.flytown/traces/<runId>.json`; read one
with `flytown fly trace <runId>`.

## Run State

Runs started over HTTP are written to `.flytown/runs/<runId>.json`. The stream
replays history first and then follows live events. After a server restart,
in-flight runs are marked interrupted rather than reported as complete, and
`POST /api/runs/:runId/resume` resumes one from its last checkpoint.

The point is not spectacle. The point is that a run has visible state,
causality, and an answer that can be inspected after the moment passes.
