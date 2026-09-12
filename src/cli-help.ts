export function buildCliHelp(castes: readonly string[]): string {
  return `FLYTOWN — a connectome-derived planner routing a swarm of model-backed workers.

Usage:
  flytown init
      Initialize a Terrarium (.flytown/terrarium.json) in the current directory.

  flytown /ask "<task>"
      Single mode: one forager, one answer.
  flytown /swarm "<task>"
      Swarm mode: planner DAG with multi-agent flights.
  flytown /history
      Show recent persisted runs.
  flytown /context ingest <path> [--limit <N>]
      Import older conversations or project notes as referenceable artifacts.
  flytown /context search "<query>" [--limit <N>]
      Search imported context and prior run artifacts.

  flytown ask <caste> --task "..." [--personality <p>] [--format freeform|markdown|json]
      Run a single insect once. Output goes to stdout; the morsel is stashed.
      Castes: ${castes.join(" ")}

  flytown scout --task "..." --scan "<glob>" [--scan "<glob>"]... [--preview]
      Run a Scout over matched files and stash the distilled facts.

  flytown foray "<task>" [--swarm <N>] [--personality <p>] [--format freeform|markdown|json]
      Forager swarm with Guard arbitration. Default swarm=3. Lightweight.

  flytown flight "<task>" [--swarm <N>] [--scan <glob>]... [--personality <p>] [--no-fallback]
                          [--budget <tokens>] [--max-output <tokens>]
                          [--cite <flightId>]... [--remember]
                          [--no-specialist] [--specialist-cap <N>] [--debate]
                          [--guard-tools] [--format freeform|markdown|json]
      Full pipeline: Scout → Forager swarm → [Debate round] → Wasp sting pass →
                     Guard review → [Specialist recovery on failure] →
                     Soldier escalation → Scribe.
      --cite <flightId>:  load that flight's Artifact as prior context.
      --remember:         auto-load up to 3 most-relevant prior Artifacts.
      --no-specialist:    skip the specialist recovery layer (go straight to the Soldier).
      --specialist-cap N: max specialist foragers to spawn (default 3).
      --debate:           run an inter-agent debate round after the swarm proposes.
      --guard-tools:      enable verifier tool-use during guard review (json/regex/http.head).

  flytown ancestry <flightId>
      Print the artifact lineage for a flight (parents → this → children).

  flytown plan "<task>" [--planner <spec>] [--max-nodes <N>] [--max-replan <N>] [--budget <tokens>]
                        [--cite <flightId>]... [--remember] [--format freeform|markdown|json]
      Use the planner to decompose the task into a DAG of flights and
      execute them in order. Each flight produces its own artifact;
      dependent flights consume them. On a node failure the planner is
      re-invoked (recursive replan, max depth 2 by default).

  flytown fly <plan|eval|trace|traces|replay|connectome|regions|groups|sensitivity|planners> ...
      Planner research tooling: connectome-derived and baseline planners,
      decision traces, deterministic replay, and the evaluation harness.

  flytown context ingest <path> [--limit <N>]
      Import local text files from an old conversation or project folder into
      the Compost as file-backed Artifacts. Generated folders are skipped.
  flytown context search "<query>" [--limit <N>]
      Search all stored Artifacts, including imported context, by relevance.
  flytown context scan chats [--source codex|chatgpt|folder] [--path <path>] [--query <q>] [--since <date>] [--limit <N>] [--json]
      Scan previous chats without importing. Defaults to local Codex sessions.
  flytown context import chats [--source codex|chatgpt|folder] [--path <path>] [--all|--ids <id,...>] [--query <q>] [--since <date>] [--limit <N>] [--no-vectorize] [--summarize]
      Import selected previous chats as Compost Artifacts. Default is local parse
      plus pre-vectorized embeddings when an embedding provider is configured.
      AI summaries are opt-in through --summarize.
  flytown context vectorize [--missing-only] [--limit <N>]
      Precompute embeddings for stored Artifacts using the embedding route.

  flytown export-trace <runId> [--out <path.json>]
      Export a run as an LLM-MAS Orchestration Trace (academic schema —
      xxzcc/awesome-llm-mas-rl).

  flytown fold [--threshold <N>] [--min-overlap <K>] [--max-cluster <S>] [--min-age-days <D>]
      Fold related older artifacts into higher-level summary artifacts
      (Messenger-Scribe). Defaults: threshold=30, overlap=2, max=6, age=7d.

  flytown reset [--all|--compost|--artifacts|--runs] [--yes]
      Reset the terrarium. Default scope (--all) clears the entire compost
      (morsels, forays, flights, artifacts, inbox, outbox) and the SSE run
      log; preserves terrarium.json and reward.mjs. Asks for "RESET"
      confirmation unless --yes is passed.
      Narrower scopes:
        --compost    everything in .flytown/compost/
        --artifacts  only .flytown/compost/artifacts/
        --runs       only .flytown/runs/

  flytown reroll <flightId> [--no-fallback] [--budget <tokens>]
      Re-run an existing flight with identical task / swarm / personality / scan.

  flytown export <flightId> [--out <path.md>]
      Render a Flight as a self-contained markdown document.

  flytown compare <flightA> <flightB>
      Side-by-side comparison of two flights.

  flytown audit <flightId>
      Walk a Flight's causal graph; report tokens, drift, longest chain, warnings.

  flytown graph <flightId|morselId>
      Render the causal graph as ASCII (flight-shaped if it's a flight id,
      ancestry chain if it's a morsel id).

  flytown drift
      Aggregate caste-name drift report across all stashed morsels.

  flytown compost [--caste <c>] [--since <iso|ms>] [--limit <N>] [--flight <id>] [--foray <id>]
      List the contents of the Compost, optionally filtered.

  flytown route
      List per-caste provider routes.
  flytown route set <slot> --preset <id> [--model <name>] [--base-url <url>] [--api-key-env <ENV>] [--format freeform|markdown|json]
      Route a specific slot (forager/soldier/guard/.../embedding) to a provider.
  flytown route clear <slot>|--all
      Remove route overrides.

  flytown secret set|clear <ENV_NAME>   |   flytown secret list
      Store a provider API key for this Terrarium (.flytown/provider-secrets.json, mode 0600).

  flytown serve [--port <N>] [--host <addr>]
      Start the FLYTOWN web control surface. Default port=7777, host=127.0.0.1.
      Serves the planner/trace/connectome/eval UI plus the orchestration HTTP API.
      The server can spend your API budget and read files, so it only accepts
      requests from this machine. --host exposes it on a network: don't, unless
      that network is yours alone.

Environment:
  OPENAI_API_KEY              required (except for init / drift / compost / audit / graph / export / compare / ancestry)
  OPENAI_BASE_URL             optional; e.g. https://openrouter.ai/api/v1
  Provider-specific keys      OPENROUTER_API_KEY, GROQ_API_KEY, TOGETHER_API_KEY, MISTRAL_API_KEY,
                              DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY
  FLYTOWN_MODEL_FORAGER       default: gpt-5-mini
  FLYTOWN_MODEL_SOLDIER       default: gpt-5
  FLYTOWN_MODEL_GUARD         default: gpt-5-mini
  FLYTOWN_MODEL_SCRIBE        default: gpt-5-mini  (Messenger-as-Scribe artifact distillation)
  FLYTOWN_EMBEDDING_MODEL     default: text-embedding-3-small  (artifact retrieval)
  FLYTOWN_TOOLS_HTTP          set to 1 to enable http.head verifier tool (default disabled)
  FLYTOWN_MAX_CONCURRENCY     default: 5 (in-flight API calls)
  FLYTOWN_HOME                global fallback terrarium root (default: ~/.flytown)
  FLYTOWN_NO_BANNER           set to 1 to suppress the banner printed by \`ask\`
  (also: FLYTOWN_MODEL_WASP, FLYTOWN_MODEL_SCOUT, FLYTOWN_MODEL_MESSENGER)
`;
}
