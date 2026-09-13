# Storage Layout

FLYTOWN stores a terrarium's local state under `.flytown/` in the project
root. `flytown init` creates it; commands find it by walking up from the
current directory to the nearest `.flytown/terrarium.json`.

```text
.flytown/
  terrarium.json
  provider-secrets.json
  reward.mjs
  compost/
    morsels/<id>.json
    forays/<id>.json
    flights/<id>.json
    artifacts/<id>.json
  runs/<runId>.json
  traces/<runId>.json
  eval/<timestamp>/report.json
  eval/<timestamp>/report.md
  weights/
```

## Files

| Path | Purpose |
| --- | --- |
| `terrarium.json` | Project manifest: name, provider config and per-slot routes, and the `flytown` planner settings (`planner`, `connectome`, `fallbackToLlm`, `learning`, `seed`). Never contains API keys. |
| `provider-secrets.json` | Local provider keys written by `flytown secret set` or `POST /api/provider`. Gitignored. |
| `reward.mjs` | Optional local reward plugin that replaces Sugar. |
| `compost/` | The Compost: the file-backed record store. |
| `compost/morsels/` | Morsels: one record per model invocation, content-addressed. |
| `compost/forays/` | Foray records: a swarm plus guard review. |
| `compost/flights/` | Flight records: the full pipeline. |
| `compost/artifacts/` | Artifacts written in Scribe mode, plus imported context. |
| `runs/` | State of runs started over HTTP; lets a restarted server replay history and resume interrupted runs. |
| `traces/` | Planner decision traces (signals → activity → action → plan), read with `flytown fly trace`. |
| `eval/` | Evaluation harness reports written by `flytown fly eval`. |
| `weights/` | Learned planner state: adapter and plastic-synapse weights per connectome, the learned router, and the `rules+memory` stored associations (`memory-<connectome>[-<variant>-s<seed>].json`). Delete a file to reset it. |

Connectome artifacts are not terrarium state. They live in the repository's
`connectome/<id>/` directory (or `FLYTOWN_CONNECTOME_DIR`) and are built by
`connectome-etl/`.

The global terrarium lives at `~/.flytown`; set `FLYTOWN_HOME` to move it.

The evaluation repositories are fetched to `~/.flytown/fixtures/<name>-<commit>/`
(or `$FLYTOWN_FIXTURES_DIR`) by `flytown fly fixtures fetch`. They are shallow
checkouts of pinned public commits: leave them unedited, or the harness treats
them as unavailable.

## Cleanup Rule

If you are comparing repos or deleting duplicate checkouts, do not ignore
`.flytown/`. It is gitignored runtime state, but it can contain real progress:
run history, decision traces, evaluation reports and learned weights.
