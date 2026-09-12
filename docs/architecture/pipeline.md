# The Flight Pipeline

A **flight** is FLYTOWN's full multi-agent path. It is a sequence of small,
named responsibilities rather than one large "agent" that does whatever the
prompt implies this week. Each responsibility belongs to a **caste**; a
model-backed worker is an **insect**.

## Flow

```text
Planner
  emits a Plan: a DAG of flights
  or halts: blocked, needs approval, already done
  replans after node failure

Scout
  scans requested files and prior Artifacts
  returns only task-relevant facts

Swarm
  N foragers draft candidate answers in parallel
  varies prompts and personalities

Debate, optional
  lets foragers inspect peer drafts
  asks for one revision round

Wasp
  sting pass: attacks each candidate
  produces failure pressure

Guard
  reviews every candidate
  can call verifier tools
  default posture is rejection

Specialists
  spawn only when the whole swarm fails
  each repairs one clustered failure mode

Soldier
  heavyweight escalation
  called only when cheaper recovery fails

Messenger, in Scribe mode
  distils the finished flight into a typed Artifact
```

## Core Terms

| Term | Meaning |
| --- | --- |
| Morsel | One model invocation, content-addressed, stored with prompt, output, model, usage, drift, and parent links. |
| Foray | Lightweight run: a swarm plus guard review, no full pipeline. |
| Flight | Full pipeline: scout, swarm, optional debate, wasps, guard, specialists, soldier, scribe. |
| Artifact | Typed memory summary of a finished flight: claims, evidence, open questions, next steps, keywords, parent links. |
| Compost | Local file-backed record store under `.flytown/compost/`. |
| Terrarium | A project root with `.flytown/` state and its `terrarium.json` manifest. |
| Sugar | The reward that picks the winning candidate. |
| Plan | DAG of flights emitted by the planner. |
| FailureCluster | A dominant failure mode found across failed forager candidates and wasp attacks. |
| Trace | Exported run record compatible with the LLM-MAS orchestration trace schema. |

## Planner

The planner turns a task into a `Plan`. Which backend decides is configurable:
`rules` by default, the conventional `llm` planner, the `random` and `learned`
baselines, or a connectome-driven `fly` planner (see the README's planner
table). A backend can also halt instead of emitting nodes — blocked, needs
approval, or already done — so "don't run this" is a first-class answer.

Each node is a flight with a narrow task, optional inputs, a swarm size, and a
suggested personality. The executor walks the DAG topologically. Dependent
nodes receive Artifacts from their parents.

On node failure, the planner can be invoked again with failure context and the
partial plan. Replanning is capped (default 2) so a failing plan cannot loop
forever.

Relevant files:

- `src/planner.ts`
- `src/plan-executor.ts`
- `src/flytown/registry.ts`

## Scout

The scout gathers context. It scans requested globs and produces a compact
facts block rather than dumping entire files into every prompt. When memory is
enabled, prior Artifacts are rendered as context before the swarm drafts.

Relevant files:

- `src/scout.ts`
- `src/context-ingest.ts`
- `src/artifact.ts`

## Swarm

The swarm drafts answers in parallel. Each forager receives a prompt variant,
and the swarm can vary personality across `nerdy`, `cynical`, `chipper`,
`stoic`, `feral`, and `frenzied`.

The swarm is not consensus. It is variance. The guard decides whether any
candidate survives.

Relevant files:

- `src/flight.ts`
- `src/foray.ts`
- `src/swarm-prompt.ts`
- `src/castes.ts`

## Debate

Debate is opt-in with `--debate`. After the first draft, each forager can see
peer outputs and revise once before wasp and guard review. This is not a chat
room. It is a single structured revision pass.

Relevant file:

- `src/debate.ts`

## Wasp

The wasp attacks each candidate in a sting pass. Its job is to reveal failure
modes, not to produce the final answer. Its critiques are later used to
cluster failures for specialist recovery.

Relevant file:

- `src/sting.ts`

## Guard

The guard reviews candidate answers and emits a structured verdict for each
one: pass or fail, a 0–1 score, and a critique. It can run pure LLM review, or
when `--guard-tools` is enabled it can call verifier tools before scoring.

Built-in tools include:

- `json.parse`
- `regex.match`
- `http.head`, gated by `FLYTOWN_TOOLS_HTTP=1`
- `web.fetch` for public URL context in chat

Relevant files:

- `src/guard-review.ts`
- `src/tools.ts`

## Specialists

If every candidate fails guard review, the flight clusters the dominant
failure modes and spawns one to three specialist foragers. Each specialist
receives one focused repair target and the best failed seed.

Specialists are still foragers: same caste, narrower prompt.

Relevant file:

- `src/specialist.ts`

## Soldier

The soldier is the expensive escalation. It runs only when the swarm and the
specialist layer cannot produce an acceptable answer; a flight that ends there
records the outcome `soldier_fallback`. The soldier is not the default because
defaulting to the heavyweight model destroys the point of orchestration.

Relevant file:

- `src/fallback.ts`

## Messenger and Scribe Mode

The messenger carries and compresses artifacts. In Scribe mode it writes the
durable memory object. A finished flight can be reconstructed from its
morsels, but the Artifact is what future flights can actually use: claims,
evidence, open questions, next steps, keywords, and parent links.

Relevant files:

- `src/artifact.ts`
- `src/compost.ts`

## Sugar and Drift

Each candidate morsel is scored with Sugar — the guard's score plus a 0.1 pass
bonus, clamped to 0..1 — and the highest-scoring candidate wins. A terrarium
can replace Sugar with a reward plugin (see
[Extensions](../extensions/overview.md#reward-plugins)).

Drift is the rate at which an output mentions the caste names. It is measured
on every morsel and reported by `flytown drift` and `flytown audit`, because
it is the instrument that detects the themed worker prompts leaking into
outputs. It is not subtracted from Sugar: the caste names are ordinary English
words, and a penalty would punish correct answers.

Relevant files:

- `src/reward.ts`
- `src/drift.ts`

## Observability

Useful commands:

```bash
flytown audit <flightId>
flytown graph <flightId|morselId>
flytown export <flightId> --out flight.md
flytown export-trace <runId> --out trace.json
flytown drift
flytown fly trace <runId>
```

Run state is persisted under `.flytown/runs/<runId>.json`, so the server can
replay history after a restart and mark interrupted work honestly. Every
planner backend except `llm` also writes its decision trace to
`.flytown/traces/<runId>.json`.
