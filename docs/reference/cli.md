# CLI Reference

The CLI is the boring door into the strange house. It is useful for automation,
local development, and checking what the browser UI is doing underneath.

## Basics

```bash
goblintown init
goblintown serve --port 7777
goblintown cloud
```

## Goblin Mode Slash Commands

```bash
goblintown /ask "Write the shortest useful answer"
goblintown /town "Plan and implement the feature"
goblintown /tank "Debug this with the visual Tank"
goblintown /context ingest "./old-conversations"
goblintown /context search "desktop app tank"
goblintown /history
```

## Single Creatures

```bash
goblintown summon raccoon --task "Summarize package.json" --personality stoic
goblintown summon gremlin --task "Attack this regex: /^\\d+$/"
```

## Context

```bash
goblintown scavenge --task "What does the build system do?" \
  --scan "package.json" --scan "tsconfig.json" --scan "src/**/*.ts"

goblintown context ingest ./notes --limit 40
goblintown context search "rollback paths"
goblintown context scan chats --source codex --limit 20
goblintown context import chats --source chatgpt --path ./conversations.json --all
goblintown context vectorize --missing-only
```

## Pack And Rite

```bash
goblintown quest "Write a SQL join: users to last 5 orders" --pack 3

goblintown rite "Refactor src/quest.ts to share the troll-review helper" \
  --pack 3 --scan "src/quest.ts" --scan "src/troll-review.ts" \
  --debate --troll-tools --remember \
  --budget 80000 --max-output 4096 --format markdown

goblintown rite "..." --no-specialist
goblintown rite "..." --specialist-cap 2
```

## Planning

```bash
goblintown plan "Design and implement a small REST API for a todo list" \
  --max-nodes 6 --max-replan 2 --format json
```

## Memory And Graphs

```bash
goblintown ancestry <riteId>
goblintown fold --threshold 30
goblintown reroll <riteId>
goblintown compare <riteA> <riteB>
goblintown export <riteId> --out my-rite.md
goblintown export-trace <runId> --out trace.json
goblintown drift
goblintown hoard --kind goblin --since 2026-04-30 --limit 20
goblintown audit <riteId>
goblintown graph <riteId|lootId>
```

## Providers

```bash
goblintown route
goblintown route set goblin --preset ollama --model gemma3:27b
goblintown route set ogre --preset openai --model gpt-5
goblintown route clear goblin
```

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Optional OpenAI provider key for local/provider execution. |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL override. |
| `OPENROUTER_API_KEY` | OpenRouter key. |
| `GROQ_API_KEY` | Groq key. |
| `TOGETHER_API_KEY` | Together AI key. |
| `MISTRAL_API_KEY` | Mistral key. |
| `DEEPSEEK_API_KEY` | DeepSeek key. |
| `ANTHROPIC_API_KEY` | Anthropic key. |
| `GEMINI_API_KEY` | Gemini key. |
| `GOBLINTOWN_MODEL_GOBLIN` | Goblin model override. |
| `GOBLINTOWN_MODEL_OGRE` | Ogre model override. |
| `GOBLINTOWN_MODEL_TROLL` | Troll model override. |
| `GOBLINTOWN_MODEL_SCRIBE` | Pigeon-Scribe model override. |
| `GOBLINTOWN_EMBEDDING_MODEL` | Artifact embedding model. |
| `GOBLINTOWN_TOOLS_HTTP` | Set `1` to enable `http.head`. |
| `GOBLINTOWN_MAX_CONCURRENCY` | In-flight model call cap. |
