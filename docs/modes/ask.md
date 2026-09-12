# Ask Mode

Ask mode is the fast path: one worker, one answer, one stored Morsel. Use it
when the task is a normal question or when the honest answer is "ask the model
directly."

## Entry Points

CLI:

```bash
flytown /ask "Write the shortest useful answer"             # one forager
flytown ask forager --task "Write the shortest useful answer"
flytown ask scout --task "Summarize package.json" --personality stoic
```

`flytown ask <caste>` runs any single caste once and streams its output;
`/ask` is the shortcut for a forager. Castes: `forager`, `wasp`, `scout`,
`guard`, `soldier`, `messenger`.

HTTP, while `flytown serve` is running:

- `POST /api/ask` — one forager answers `{ task }`. With `remember` (on
  unless set to `false`) up to three relevant prior Artifacts are prepended as
  context. Returns `{ output, morselId, usage, parentArtifactIds }`.
- `POST /api/chat` — one conversational turn over a `messages` transcript.

The web control surface has no chat screen; ask mode is a CLI and HTTP path.

## What A Chat Turn Does

`POST /api/chat`:

- keeps the most recent messages and caps the size of each one;
- fetches public URL context with `web.fetch` when the latest messages contain
  links;
- builds a single-forager prompt;
- calls the forager model slot, or the soldier slot when `modelSlot` asks for
  it;
- stores the answer as a Morsel in the Compost;
- flags when the request looks complex enough to deserve a full flight.

It does not run the planner, the swarm, wasps, the guard, specialists, the
soldier escalation, or Scribe mode. That is the point. One answer should not
wear a fake committee badge.

## Prompt Contract

The single-forager chat prompt tells the model:

- answer the latest user message directly;
- use the transcript only as context;
- cite fetched URL context when present;
- stay practical and complete;
- offer a full FLYTOWN run only when the task warrants it.

Relevant files:

- `src/chat.ts`
- `src/castes.ts`

## When To Escalate

Escalate from ask mode to [swarm mode](swarm-mode.md) when the task needs:

- scanned repository context;
- multiple candidate answers;
- adversarial review;
- verifier tools;
- failure recovery;
- memory Artifacts;
- a planner DAG;
- traceable run history.
