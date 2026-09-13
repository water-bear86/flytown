# NOTICE

FLYTOWN is derived from **Goblintown**
(https://github.com/0xbl33p/goblintown), MIT licensed, copyright 0XBL33P,
and is used with the maintainer's explicit permission. The MIT license text
is in [LICENSE](./LICENSE). This is a curated fork of the source tree, not a
history-preserving one — FLYTOWN's git history starts fresh from its baseline
commit.

FLYTOWN is a connectome-derived AI-orchestration research project. Its
baseline was Goblintown's multi-agent orchestration core, kept intact, with
the following bolt-on subsystems removed before any FLYTOWN-specific code was
added.

## Connectome data

The artifacts under `connectome/` are derived from third-party datasets. They
are not covered by FLYTOWN's MIT licence: each keeps its own licence and needs
its own attribution. Each artifact's `manifest.json` lists the full citations
and every preprocessing step.

- **FlyWire FAFB v783** (`fafb-v783-projectome-1`, `fafb-v783-neuron-1`). The
  adult female *Drosophila melanogaster* whole-brain connectome, materialization
  783, from the FlyWire Consortium's Zenodo data release, licensed CC BY 4.0.
  FLYTOWN collapses it to brain regions or re-encodes the neuron graph. Cite
  Dorkenwald et al. 2024, *Nature*, doi:10.1038/s41586-024-07558-y, and
  Schlegel et al. 2024, *Nature*, doi:10.1038/s41586-024-07686-5.
- **First-instar larval brain** (`l1-larva-winding2023-1`). From Winding et al.
  2023, *Science* 379:eadd9330, doi:10.1126/science.add9330, Supplementary
  Data S1, reprocessed into FLYTOWN's graph format. The article is licensed
  CC BY 4.0. We could not confirm a separate licence for the supplementary data
  file, so it is redistributed here with attribution for non-commercial
  research and education. If you hold rights in these data and object, please
  open an issue.

The FLYTOWN authors drafted these citations. A neuroscience collaborator has
not yet checked them.

## Subsystems removed in the fork (2026-09-11)

- **Crypto / trading tools** (`solana.ts`, `solana-tools.ts`, `thesis.ts`,
  `sentiment.ts`, `sentiment-secrets.ts`, `addons.ts`, and the CLI/API/UI
  surfaces that exposed them) — read-only Solana wallet/token lookups,
  market/project sentiment aggregation, and the generic add-on tool-pack
  registry whose only consumer was the Solana add-on. Unrelated to FLYTOWN's
  research scope.
- **Voice / speech-to-text** (`voice.ts`, `voice-secrets.ts`, and the
  browser mic/realtime-session/text-to-speech integration in the chat UI
  and the Electron desktop app's microphone entitlement) — live voice chat
  and audio transcription, added alongside chat mode upstream. Not needed
  for a local-first orchestration baseline.
- **Peer-to-peer social / federation layer** (`federation.ts`, `country.ts`,
  `country-identity.ts`, `social.ts`, and the CLI's `send`/`inbox`/`outbox`/
  `country` commands and the server's friend-request/DM/country routes and
  UI) — instance-to-instance message delivery, discoverable "countries," and
  friend/mail features. Out of scope for a single-node research baseline.
- **OpenAI Codex CLI / ChatGPT Apps / Vercel hosting distribution**
  (`mcp.ts`, `chatgpt-app.ts`, `chatgpt-host-runner.ts`, `vercel.ts`,
  `install.ts`, `plugin-install.ts`, `skill-install.ts`, and their CLI
  subcommands, docs, and package scripts) — the MCP server, ChatGPT Apps
  SDK host, Vercel serverless wrapper, and Codex plugin/skill installers
  used to distribute Goblintown through third-party agent surfaces. FLYTOWN
  will define its own integration surface later, if any.
- **Local telemetry** (`telemetry.ts`) — a local-only crash-report module
  present in the source branch this baseline was cut from (not part of
  upstream Goblintown); removed for a minimal fork with no local
  data-collection code of any kind.

Everything else in the orchestration core — the multi-agent pipeline, the
planner DAG, the artifact store, reward plugins, provider routing, the browser
UI and the Electron desktop shell — was unchanged from upstream Goblintown at
that stage.

## Renamed and replaced (2026-09-12)

On 2026-09-12 FLYTOWN replaced all Goblintown naming, worker prompts,
branding and art with its own vocabulary, as a clean break with no
compatibility layer — see
[docs/flytown/VOCABULARY.md](./docs/flytown/VOCABULARY.md). At the same time:

- the Goblintown Firebase cloud configuration was removed;
- the drift penalty was removed from the reward (Sugar). Drift is still
  measured and reported.

The dated experiment reports in `docs/flytown/experiments/` that predate the
rename are left as written: those runs used the Goblintown prompts and names.
