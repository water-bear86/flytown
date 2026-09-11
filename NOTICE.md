# NOTICE

FLYTOWN's baseline is a stripped derivative of **Goblintown**
(https://github.com/0xbl33p/goblintown), MIT licensed, copyright 0XBL33P.
It is used here with explicit permission from the maintainer. This is a
curated fork of the source tree, not a history-preserving one — FLYTOWN's
git history starts fresh from this baseline commit.

FLYTOWN itself is a connectome-derived AI-orchestration research project.
This repository is only the "fork and strip" baseline step: Goblintown's
multi-agent orchestration core, kept intact, with the following bolt-on
subsystems removed before any FLYTOWN-specific code is added.

## Subsystems removed

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
  `country` commands and the server's friend-request/DM/"Goblin-Country"
  routes and UI) — warren-to-warren message delivery, discoverable
  "countries," and friend/mail features. Out of scope for a single-node
  research baseline.
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

Everything else — the Rite pipeline (Raccoon → Goblin pack → Troll review →
Ogre fallback → Scribe), the Planner DAG, the Hoard artifact store, reward
plugins, provider routing, the Tank UI, and the Electron desktop shell — is
unchanged from upstream Goblintown at this stage.
