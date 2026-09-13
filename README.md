# FLYTOWN

A real, public, static wiring diagram of a fruit-fly brain — the adult
FlyWire FAFB v783 connectome collapsed to brain regions, or the whole
first-instar larval brain (Winding et al. 2023) at single-neuron resolution —
is the fixed topology of a small dynamical system. A task becomes a sensory
pattern; activity propagates; a readout scores thirteen orchestration
actions. The top-scoring actions go to the same compiler every planner uses,
which turns them into a `Plan` that FLYTOWN's swarm of model-backed workers
executes. The compiler acts on only some of those actions, and each decision
trace shows which ones changed the plan. It is **not** a mind, not a simulation of a living animal, and every
quantity is tagged `MEASURED`, `INFERRED_FROM_LITERATURE`,
`ENGINEERING_CHOICE` or `METAPHOR`. The evaluation harness compares every fly
planner against shuffled and rewired copies of the same graph — and so far
reports honest nulls, in the mock worker world and live. Design:
[PROPOSAL.md](./PROPOSAL.md). Results:
[docs/flytown/experiments](./docs/flytown/experiments/README.md).

```bash
npm install
npm run build                                      # compiles to dist/; the flytown binary is dist/cli.js
node dist/cli.js init --provider deepseek --model deepseek-v4-flash   # a terrarium here; asks for your key, input hidden
node dist/cli.js serve                             # then open http://localhost:7777/
node dist/cli.js fly plan "…" --planner fly:connectome=l1-larva-winding2023-1+plastic --dry-run   # no API calls
node dist/cli.js fly fixtures fetch                # the evaluation repositories, at their pinned commits
node dist/cli.js fly eval --planners rules,random,fly,fly:shuffled --seeds 3      # mock worker world, no API calls
node dist/cli.js fly eval --live --planners rules --fixtures q-engine-layout --seeds 1   # one small live run
```

Deciding costs nothing; executing a plan or a live evaluation calls your model
provider. `init --provider` accepts any preset in
[providers](./docs/reference/providers.md) (OpenAI is the default), and
`flytown provider set <preset>` switches later. `deepseek-v4-flash` for every
role is the configuration the recorded live runs used.

Run `npm link` once to put `flytown` on your PATH; the examples below use it.

## The swarm

Work is done by model-backed workers called **insects**. An insect's role is
its **caste**, and there are six:

| Caste | Job |
| --- | --- |
| **Forager** | Cheap, high-temperature worker. Many run in parallel as a **swarm**, each with a different personality, and each brings back a candidate answer. An optional debate round lets foragers revise once after seeing each other's drafts. |
| **Wasp** | Adversary. Its sting pass attacks each candidate to find what is wrong with it. |
| **Scout** | Gathers only the context a task needs, and loads relevant prior Artifacts when memory is enabled. |
| **Guard** | Default-reject reviewer. Inspects every candidate and returns a JSON verdict, optionally after calling verifier tools (`json.parse`, `regex.match`, `http.head`). |
| **Soldier** | Heavyweight, expensive, deep-reasoning escalation, used only when foragers and specialists have failed. |
| **Messenger** | Carries and compresses artifacts; in Scribe mode it distils a finished flight into a typed Artifact. |

When every candidate fails review, the failures are clustered by dominant
failure mode and one to three **specialist foragers** each repair the best
failed seed before the soldier is called.

A **flight** is the full pipeline for one task; a plan is a DAG of flights:

```text
planner      Plan: a DAG of flights, or a halt (blocked / needs approval / already done)
             replans after a node fails, max depth 2

each flight
  scout        task-relevant facts + relevant prior Artifacts
  swarm        N foragers draft candidates in parallel, varied personalities
  debate       optional: foragers see peers' drafts and revise once
  wasps        sting pass: attack each candidate
  guard        default-reject review, optional verifier tools
  specialists  only if every candidate failed: 1-3 focused repairs, reviewed again
  soldier      last-resort escalation
  messenger    Scribe mode: distils the finished flight into a typed Artifact
```

Every step writes a Morsel to the Compost with parent links to its inputs, so
a flight can be reconstructed from the Compost alone. Details:
[docs/architecture/pipeline.md](./docs/architecture/pipeline.md).

## Key concepts

- **Flight** — the full pipeline for one task: scout → swarm → wasps → guard → specialists → soldier → scribe.
- **Foray** — lightweight: a swarm plus guard review, no full pipeline.
- **Morsel** — one model invocation, content-addressed and stored with its prompt, output, model, usage, drift and parent links.
- **Compost** — the file-backed record store under `.flytown/compost/`.
- **Terrarium** — a project root and its manifest, `.flytown/terrarium.json`, found by walking up from the current directory.
- **Sugar** — the reward signal that picks each run's winner: the guard's score plus a pass bonus, clamped to 0..1. A terrarium can replace it with a reward plugin (`.flytown/reward.mjs`).
- **Drift** — how often an output mentions the caste names, per output word. Measured and reported on every morsel as the instrument that catches the themed worker prompts leaking into outputs; it is not subtracted from Sugar.
- **Artifact** — a typed JSON summary of a finished flight (claims, evidence, open questions, next steps, parent-artifact links), written by the messenger in Scribe mode. Future flights can cite one or auto-load relevant ones.
- **Plan** — a DAG of flights emitted by the planner, executed topologically and replanned on node failure.

## Planners: connectome-derived planning

Who decides the `Plan` is pluggable. Every planner backend consumes the same
task signals and emits the same `Plan`:

| spec | what decides |
| --- | --- |
| `rules` | hand-written rules over task/repo signals — **the default** |
| `llm` | the conventional LLM planner — the fallback whenever a `fly` planner fails |
| `random` | seeded random control |
| `learned` | small logistic router, trainable in the harness |
| `rules+memory` | `rules`, nudged by a mushroom-body memory of how similar tasks went: the larval Kenyon-cell code, with outcomes stored at the KC→MBON synapses by the evaluation harness. `rules+memory:shuffled` is its null. The memory experiment found no retrieval signal on held-out tasks, so expect it to match `rules` until tested with real outcomes |
| `fly` | activation propagated through a real FlyWire connectome artifact, read out to actions |
| `fly:shuffled`, `fly:random_degree`, `fly:norecurrence`, `fly:signless`, `fly:ablate=MB_CA,EB`, `fly:learning` | null models and ablations of the same |
| `fly:connectome=l1-larva-winding2023-1+plastic` | the whole larval brain at single-neuron resolution, with dopamine-gated depression at the real KC→MBON synapses (`+learning` adds adapter learning; `:ablate=flag:MBIN` lesions the dopaminergic neurons) |

`rules` is the default because, on the full live suite, it matched the LLM
planner's quality on completable tasks with 39% fewer tokens and, unlike the
LLM planner, halted when the right answer was to stop
([live run 3](./docs/flytown/experiments/2026-09-12-live-run3-rules-vs-llm.md)).

Set `flytown.planner` in `.flytown/terrarium.json` (or pass `--planner`, or
POST `{ planner }` to `/api/plan`) to pick a backend; the LLM planner stays
the fallback for `fly` planners unless `flytown.fallbackToLlm` is `false`.
Every backend except `llm` writes a decision trace to `.flytown/traces/`.
Connectome artifacts live under `connectome/` and are produced offline by the
Python sidecar in [`connectome-etl/`](./connectome-etl/README.md); the runtime
is TypeScript only and has no Python dependency.

Every biologically-flavoured component is tagged `MEASURED`,
`INFERRED_FROM_LITERATURE`, `ENGINEERING_CHOICE` or `METAPHOR` in code and in
traces. Nothing here is, or claims to be, a mind.

## The web control surface

`flytown serve` (default port 7777) serves FLYTOWN's only UI at `/`: choose a
planner backend, decide (no workers) or decide-and-execute with a live run
stream, watch the decision trace with the regional/population activity map and
its plain-text twin, replay any stored decision deterministically, inspect the
connectome artifacts and their provenance-tagged assumptions, and read every
evaluation report, including the null results. The same server exposes the
[HTTP API](./docs/reference/http-api.md).

## The `fly` research CLI

```bash
flytown fly planners                      # list backends
flytown fly connectome                    # list connectome artifacts (built by connectome-etl/)
flytown fly plan "<task>" --planner fly --dry-run   # decide + write a trace, run nothing
flytown plan "<task>" --planner fly       # decide and execute with the real workers
flytown fly trace <runId>                 # plain-text trace: signals → activity → action → plan
flytown fly replay <runId>                # deterministic replay, diffs against the stored plan
flytown fly groups <connectomeId>         # node groups (regions / cell classes / sensory modalities) the adapters can address
flytown fly sensitivity --planners "fly,fly:shuffled"   # where task information survives: features → input → activity → scores
flytown fly effects                       # what each planner's chosen actions actually change in the plan
flytown fly eval --planners "rules,fly,fly:shuffled" --seeds 3 --epochs 8   # matched trials, mock worker world
```

Evaluation reports are written to `.flytown/eval/`; `fly eval --live` runs the
real pipeline against the configured provider under hard token caps.

## Running the swarm directly

The planner is optional; the same binary runs any part of the pipeline by hand:

```bash
flytown ask forager --task "…"            # one insect, one answer (any caste)
flytown foray "…" --swarm 3               # a swarm plus guard review
flytown flight "…" --swarm 3 --remember   # the full pipeline for one task
flytown plan "…"                          # planner + flights
flytown compost --limit 20                # browse stored records
```

Full command list: [docs/reference/cli.md](./docs/reference/cli.md). Modes:
[ask](./docs/modes/ask.md) and [swarm](./docs/modes/swarm-mode.md).

## Providers

The model client is the `openai` SDK pointed at a base URL, so any
OpenAI-compatible API works. Presets cover OpenAI, OpenRouter, Ollama,
LM Studio, Groq, Together AI, Mistral, DeepSeek, Anthropic, Gemini and custom
endpoints, with per-caste routes — for example cheap local foragers and a
hosted soldier. Keys come from the environment or `flytown secret set` and are
stored in `.flytown/provider-secrets.json`, never in `terrarium.json`. Details:
[docs/reference/providers.md](./docs/reference/providers.md).

## Tests

```bash
npm test
```

The suite builds first, then runs as pure functions with no model calls.

## Documentation

- [PROPOSAL.md](./PROPOSAL.md) — the architecture proposal, milestones and falsification plan
- [docs/flytown/VOCABULARY.md](./docs/flytown/VOCABULARY.md) — every name, command and path
- [docs/flytown/experiments](./docs/flytown/experiments/README.md) — the experiment log, null results included
- [docs/](./docs/README.md) — the manual: pipeline, modes, CLI, HTTP API, providers, storage layout

## Provenance and license

FLYTOWN is derived from [Goblintown](https://github.com/0xbl33p/goblintown)
(MIT licensed, © 0XBL33P), used with the maintainer's permission. The fork
removed the crypto/trading, voice, peer-to-peer social/federation,
third-party distribution and local telemetry subsystems it started with, and
on 2026-09-12 replaced every inherited name, prompt, piece of branding and art
with FLYTOWN's own vocabulary. [NOTICE.md](./NOTICE.md) records exactly what changed.

The code is MIT — see [LICENSE](./LICENSE). The connectome data under
`connectome/` is not: it keeps its original licences and must be cited. See
[NOTICE.md](./NOTICE.md#connectome-data).
