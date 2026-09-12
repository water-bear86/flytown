# Development

This repo is a TypeScript CLI, a local HTTP server with a browser control
surface, an Electron desktop shell, and an offline Python sidecar that builds
the connectome artifacts.

## Setup

```bash
npm install
npm run build
npm test
```

Run the web control surface:

```bash
npm run serve -- --port 7777
```

Run the CLI straight from source with `tsx`, without building:

```bash
npm run dev -- <command> [args]
```

Run the desktop shell:

```bash
npm run desktop
```

## Packaging

Local desktop packages, written to the gitignored `release/` folder:

```bash
npm run dist:mac
npm run dist:win
npm run dist:linux
npm run dist:desktop
```

Nothing is published: there is no release pipeline and there are no
prebuilt installers.

## Tests

```bash
npm test
```

`npm test` builds first, then runs the suite as pure functions with no model
calls. The list of test files in `package.json` is explicit, not a glob: add
new test files to it.

## Connectome Artifacts

Connectome artifacts under `connectome/` are built offline by the Python ETL
sidecar in `connectome-etl/` (see its [README](../connectome-etl/README.md)). The TypeScript runtime only
reads the finished, checksummed artifacts; set `FLYTOWN_CONNECTOME_DIR` to load
them from somewhere else.

## Useful Source Map

| Area | Files |
| --- | --- |
| CLI routing | `src/cli.ts`, `src/cli-help.ts`, `src/slash-commands.ts` |
| HTTP API and web control surface | `src/server.ts`, `src/flytown/web.ts` |
| Ask mode | `src/chat.ts` |
| Castes | `src/castes.ts` |
| Flight pipeline | `src/flight.ts`, `src/foray.ts`, `src/scout.ts`, `src/sting.ts`, `src/guard-review.ts`, `src/specialist.ts`, `src/debate.ts`, `src/fallback.ts` |
| Planning | `src/planner.ts`, `src/plan-executor.ts`, `src/flytown/planner-backend.ts`, `src/flytown/registry.ts` |
| Connectome planners | `src/flytown/fly-planner.ts`, `src/flytown/connectome/`, `src/flytown/signals.ts`, `src/flytown/actions.ts`, `src/flytown/trace.ts`, `src/flytown/baselines/` |
| Evaluation harness | `src/flytown/eval/`, `src/flytown/cli.ts` |
| Memory | `src/compost.ts`, `src/artifact.ts`, `src/context-ingest.ts`, `src/chat-import.ts`, `src/embeddings.ts` |
| Terrarium and run state | `src/terrarium.ts`, `src/run-store.ts` |
| Reward | `src/reward.ts`, `src/reward-plugin.ts`, `src/drift.ts` |
| Providers | `src/providers.ts`, `src/provider-secrets.ts`, `src/openai-client.ts` |
| Verifier tools | `src/tools.ts` |
| Desktop | `src/desktop.ts`, `build/`, `package.json` |
| Connectome ETL (Python, offline) | `connectome-etl/` |
