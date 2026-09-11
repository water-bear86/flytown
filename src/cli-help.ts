export function buildCliHelp(creatureKinds: readonly string[]): string {
  return `Goblintown — agent management protocol.

Usage:
  goblintown init
      Initialize a Warren in the current directory.

  goblintown /ask "<task>"
      Goblin Mode: Single Goblin, one worker, one answer.
  goblintown /town "<task>"
      Goblin Mode: Goblintown planner DAG with multi-agent execution.
  goblintown /tank "<task>"
      Goblintown planner DAG intended for the compact live Tank.
  goblintown /history
      Show recent persisted runs.
  goblintown /context ingest <path> [--limit <N>]
      Import older conversations or project notes as referenceable artifacts.
  goblintown /context search "<query>" [--limit <N>]
      Search imported context and prior run artifacts.

  goblintown summon <kind> --task "..." [--personality <p>]
      Run a single creature once. Output goes to stdout; loot is stashed.
      Kinds: ${creatureKinds.join(" ")}

  goblintown scavenge --task "..." --scan "<glob>" [--scan "<glob>"]...
      Run a Raccoon over matched files and stash the distilled facts.

  goblintown quest "<task>" [--pack <N>] [--personality <p>] [--format freeform|markdown|json]
      Goblin pack with Troll arbitration. Default pack=3. Lightweight.

  goblintown rite "<task>" [--pack <N>] [--scan <glob>]... [--personality <p>] [--no-fallback]
                          [--budget <tokens>] [--max-output <tokens>]
                          [--cite <riteId>]... [--remember]
                          [--no-specialist] [--specialist-cap <N>] [--debate]
                          [--format freeform|markdown|json]
      Full ceremony: Raccoon → Goblin pack → [Debate round] → Gremlin chaos →
                    Troll review → [Specialist re-rite on failure] →
                    Ogre fallback → Scribe.
      --cite <riteId>:    load that rite's Artifact as prior context.
      --remember:         auto-load up to 3 most-relevant prior Artifacts.
      --no-specialist:    skip the specialist recovery layer (go straight to Ogre).
      --specialist-cap N: max specialist goblins to spawn (default 3).
      --debate:           run an inter-agent debate round after the pack proposes.
      --troll-tools:      enable verifier tool-use during troll review (json/regex/http.head).

  goblintown ancestry <riteId>
      Print the artifact lineage for a rite (parents → this → children).

  goblintown plan "<task>" [--max-nodes <N>] [--max-replan <N>] [--budget <tokens>]
                          [--cite <riteId>]... [--remember] [--format freeform|markdown|json]
      Use the Planner to decompose the task into a DAG of sub-rites and
      execute them in order. Each sub-rite produces its own artifact;
      dependent sub-rites consume them. On a node failure the planner is
      re-invoked (recursive replan, max depth 2 by default).

  goblintown context ingest <path> [--limit <N>]
      Import local text files from an old conversation or project folder into
      the Hoard as file-backed Artifacts. Generated folders are skipped.
  goblintown context search "<query>" [--limit <N>]
      Search all stored Artifacts, including imported context, by relevance.
  goblintown context scan chats [--source codex|chatgpt|folder] [--path <path>] [--query <q>] [--since <date>] [--limit <N>] [--json]
      Scan previous chats without importing. Defaults to local Codex sessions.
  goblintown context import chats [--source codex|chatgpt|folder] [--path <path>] [--all|--ids <id,...>] [--query <q>] [--since <date>] [--limit <N>] [--no-vectorize] [--summarize]
      Import selected previous chats as Hoard Artifacts. Default is local parse
      plus pre-vectorized embeddings when an embedding provider is configured.
      AI summaries are opt-in through --summarize.
  goblintown context vectorize [--missing-only] [--limit <N>]
      Precompute embeddings for stored Artifacts using the embedding route.

  goblintown export-trace <runId> [--out <path.json>]
      Export a run as an LLM-MAS Orchestration Trace (academic schema —
      xxzcc/awesome-llm-mas-rl).

  goblintown fold [--threshold <N>] [--min-overlap <K>] [--max-cluster <S>] [--min-age-days <D>]
      Fold related older artifacts into higher-level summary artifacts
      (Pigeon-Scribe). Defaults: threshold=30, overlap=2, max=6, age=7d.

  goblintown reset [--all|--hoard|--artifacts|--runs] [--yes]
      Reset the town. Default scope (--all) clears the entire hoard
      (loot, quests, rites, artifacts, inbox, outbox) and the SSE run
      log; preserves warren.json and reward.mjs. Asks for "RESET"
      confirmation unless --yes is passed.
      Narrower scopes:
        --hoard      everything in .goblintown/hoard/
        --artifacts  only .goblintown/hoard/artifacts/
        --runs       only .goblintown/runs/

  goblintown reroll <riteId> [--no-fallback] [--budget <tokens>]
      Re-run an existing rite with identical task / pack / personality / scan.

  goblintown export <riteId> [--out <path.md>]
      Render a Rite as a self-contained markdown document.

  goblintown compare <riteA> <riteB>
      Side-by-side comparison of two rites.

  goblintown audit <riteId>
      Walk a Rite's causal graph; report tokens, drift, longest chain, warnings.

  goblintown graph <riteId|lootId>
      Render the causal graph as ASCII (rite-shaped if it's a rite id,
      ancestry chain if it's a loot id).

  goblintown drift
      Aggregate personality-drift report across all stashed loot.

  goblintown hoard [--kind <k>] [--since <iso|ms>] [--limit <N>] [--rite <id>] [--quest <id>]
      List the contents of the Hoard, optionally filtered.

  goblintown route
      List per-creature provider routes.
  goblintown route set <slot> --preset <id> [--model <name>] [--base-url <url>] [--api-key-env <ENV>] [--format freeform|markdown|json]
      Route a specific slot (goblin/ogre/troll/.../embedding) to a provider.
  goblintown route clear <slot>|--all
      Remove route overrides.

  goblintown cloud
      Show the bundled Goblintown Cloud project, first-run Local Only vs Goblintown Cloud choice,
      Settings -> Account controls, and optional Firebase env overrides.

  goblintown serve [--port <N>] [--chat]
      Start the Goblin Mode GUI. Default port=7777.
      By default runs in AI-autopilot mode: the Tank diorama with config menus, no chat surface.
      Use --chat to restore the legacy chat UI.
      Settings also contains API Provider and Reset -> Asteroid Mode.
      Bundled sprite sheets and the Goblintown wordmark are loaded from site/assets.

Environment:
  OPENAI_API_KEY              required (except for init / drift / hoard / inbox / outbox / audit / graph / export / compare / ancestry)
  OPENAI_BASE_URL             optional; e.g. https://openrouter.ai/api/v1
  Provider-specific keys      OPENROUTER_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY, MISTRAL_API_KEY,
                              DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY
  FIREBASE_API_KEY            optional override for forks; normal users use bundled Goblintown Cloud config
  FIREBASE_AUTH_DOMAIN        optional override
  FIREBASE_PROJECT_ID         optional override
  FIREBASE_APP_ID             optional override
  FIREBASE_STORAGE_BUCKET     optional override
  FIREBASE_MESSAGING_SENDER_ID optional override
  FIREBASE_MEASUREMENT_ID     optional override
  GOBLINTOWN_MODEL_GOBLIN     default: gpt-5-mini
  GOBLINTOWN_MODEL_OGRE       default: gpt-5
  GOBLINTOWN_MODEL_TROLL      default: gpt-5-mini
  GOBLINTOWN_MODEL_SCRIBE     default: gpt-5-mini  (Pigeon-as-Scribe artifact distillation)
  GOBLINTOWN_EMBEDDING_MODEL  default: text-embedding-3-small  (artifact retrieval)
  GOBLINTOWN_TOOLS_HTTP       set to 1 to enable http.head verifier tool (default disabled)
  GOBLINTOWN_MAX_CONCURRENCY  default: 5 (in-flight API calls)
  (also: GREMLIN, RACCOON, PIGEON)

"OpenAI tried to put the goblins back in the box. We built the box for them."
`;
}
