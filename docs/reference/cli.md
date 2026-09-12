# CLI Reference

The CLI is the plain-text door into everything FLYTOWN does. It is useful for
automation, local development, and checking what the web control surface is
doing underneath. The binary is `flytown` (`dist/cli.js` after
`npm run build`); `flytown --help` prints the full usage text.

Most commands need a terrarium: they use the nearest `.flytown/terrarium.json`
above the current directory.

## Basics

```bash
flytown init                              # create .flytown/terrarium.json here
flytown serve --port 7777                 # web control surface + HTTP API (default port 7777)
flytown secret set DEEPSEEK_API_KEY       # store a provider key; input hidden (or read from stdin)
flytown secret list                       # names only, never values
flytown secret clear DEEPSEEK_API_KEY
```

## Slash Shortcuts

```bash
flytown /ask "Write the shortest useful answer"     # one forager
flytown /swarm "Plan and implement the feature"     # plan + flights, with memory, markdown output
flytown /history                                    # recent persisted runs
flytown /context ingest "./old-conversations"
flytown /context search "rollback paths"
```

## One Insect

```bash
flytown ask scout --task "Summarize package.json" --personality stoic
flytown ask wasp --task "Attack this regex: /^\\d+$/"
```

Castes: `forager`, `wasp`, `scout`, `guard`, `soldier`, `messenger`.
Personalities: `nerdy`, `cynical`, `chipper`, `stoic`, `feral`, `frenzied`.

## Context

```bash
flytown scout --task "What does the build system do?" \
  --scan "package.json" --scan "tsconfig.json" --scan "src/**/*.ts"
flytown scout --task "..." --scan "src/**/*.ts" --preview    # list the files it would read

flytown context ingest ./notes --limit 40
flytown context search "rollback paths"
flytown context scan chats --source codex --limit 20
flytown context import chats --source chatgpt --path ./conversations.json --all
flytown context vectorize --missing-only
```

## Foray And Flight

```bash
flytown foray "Write a SQL join: users to last 5 orders" --swarm 3

flytown flight "Refactor src/foray.ts to share the guard-review helper" \
  --swarm 3 --scan "src/foray.ts" --scan "src/guard-review.ts" \
  --debate --guard-tools --remember \
  --budget 80000 --max-output 4096 --format markdown

flytown flight "..." --no-specialist
flytown flight "..." --specialist-cap 2
flytown flight "..." --cite <flightId>
```

Every flight flag is described in [Swarm mode](../modes/swarm-mode.md#flight).

## Planning

```bash
flytown plan "Design and implement a small REST API for a todo list" \
  --planner rules --max-nodes 6 --max-replan 2 --format json
```

Other `plan` flags: `--budget <tokens>`, `--max-output <tokens>`,
`--cite <flightId>` (repeatable), `--remember`.

## Connectome Planner Research (`fly`)

```bash
flytown fly planners                          # known planner specs
flytown fly connectome [id]                   # list artifacts, or one manifest with its assumptions
flytown fly regions [id] [--limit N]          # nodes with synapse counts and provenance
flytown fly groups <connectomeId> [--prefix P]
flytown fly plan "<task>" --planner <spec> [--dry-run] [--max-nodes N] [--seed N] [--no-fallback]
flytown fly trace <runId> [--json]
flytown fly traces
flytown fly replay <runId>                    # deterministic replay, diffed against the stored plan
flytown fly sensitivity --planners "fly,fly:shuffled"
flytown fly eval --planners "rules,random,fly,fly:shuffled" --seeds 3 \
  [--epochs N] [--compare a,b] [--fixtures id,id] [--traces] [--out dir]
```

`fly eval` runs the deterministic mock worker world by default and writes its
report under `.flytown/eval/`. `fly eval --live` (or `--terrarium <path>` to
use another terrarium's provider) runs the real pipeline, gated on a provider
smoke test and bounded by `--swarm` (maximum swarm size, default 2),
`--budget` (tokens per run), `--max-output` (tokens per call) and
`--max-total-tokens`. `--guard-tools` lets the guard use verifier tools,
`--no-judge` turns off the LLM judge, and `--live-learning` feeds live reward
back into learnable planners. The full flag list is in `src/flytown/cli.ts`.

## Memory And Graphs

```bash
flytown ancestry <flightId>
flytown fold --threshold 30
flytown reroll <flightId>
flytown compare <flightA> <flightB>
flytown export <flightId> --out my-flight.md
flytown export-trace <runId> --out trace.json
flytown drift
flytown compost --caste forager --since 2026-09-01 --limit 20
flytown compost --flight <flightId>
flytown audit <flightId>
flytown graph <flightId|morselId>
flytown reset --runs --yes
```

`flytown reset` clears state under `.flytown/`: by default (`--all`) the
Compost and the run log, or just `--compost`, `--artifacts` or `--runs`. It
keeps `terrarium.json` and `reward.mjs`, and asks for confirmation unless
`--yes` is passed.

## Providers

```bash
flytown route
flytown route set forager --preset ollama --model gemma3:27b
flytown route set soldier --preset openai --model gpt-5
flytown route clear forager
flytown route clear --all
```

Slots: `forager`, `wasp`, `scout`, `guard`, `soldier`, `messenger`, `scribe`,
`embedding`. See [Provider routing](providers.md).

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI provider key. |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL override. |
| `OPENROUTER_API_KEY` | OpenRouter key. |
| `GROQ_API_KEY` | Groq key. |
| `TOGETHER_API_KEY` | Together AI key. |
| `MISTRAL_API_KEY` | Mistral key. |
| `DEEPSEEK_API_KEY` | DeepSeek key. |
| `ANTHROPIC_API_KEY` | Anthropic key. |
| `GEMINI_API_KEY` | Gemini key. |
| `FLYTOWN_MODEL_FORAGER` | Forager model override. |
| `FLYTOWN_MODEL_WASP` | Wasp model override. |
| `FLYTOWN_MODEL_SCOUT` | Scout model override. |
| `FLYTOWN_MODEL_GUARD` | Guard model override. |
| `FLYTOWN_MODEL_SOLDIER` | Soldier model override. |
| `FLYTOWN_MODEL_MESSENGER` | Messenger model override. |
| `FLYTOWN_MODEL_SCRIBE` | Scribe-mode (Artifact distillation) model override. |
| `FLYTOWN_EMBEDDING_MODEL` | Artifact embedding model. |
| `FLYTOWN_TOOLS_HTTP` | Set `1` to enable the `http.head` verifier tool. |
| `FLYTOWN_MAX_CONCURRENCY` | In-flight model call cap (default 5). |
| `FLYTOWN_CONNECTOME_DIR` | Load connectome artifacts from this directory instead of `connectome/`. |
| `FLYTOWN_HOME` | Location of the global terrarium (default `~/.flytown`). |
| `FLYTOWN_NO_BANNER` | Set `1` to suppress the banner that `flytown ask` prints. |
