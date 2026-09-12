# FLYTOWN vocabulary

The single source of truth for names. FLYTOWN began as a fork of Goblintown
(MIT, © 0XBL33P — see NOTICE.md); on 2026-09-12 every inherited goblin term was
replaced with the swarm vocabulary below, as a clean break with no
compatibility layer.

Rule: **what a thing does must stay obvious from its name and its doc comment.**
The theme is the product's identity, not a disguise for behaviour.

## Castes (the six worker roles)

A worker is an **Insect**; its role is its **Caste**.

| Goblintown | FLYTOWN | Job | Code |
|---|---|---|---|
| Creature / CreatureKind / CREATURE_KINDS | **Insect / Caste / CASTES** | a model-backed worker and its role | `castes.ts`, `makeInsect()` |
| Goblin | **Forager** | cheap, high-temperature worker; many run in parallel and each brings back a candidate answer | `forager`, `makeForager()` |
| Specialist Goblin | **Specialist Forager** | focused recovery worker for one identified failure mode | `makeSpecialistForager()` |
| Gremlin | **Wasp** | adversary; attacks each candidate to find what is wrong with it (named for the parasitoid wasps that prey on *Drosophila* larvae) | `wasp`, `makeWasp()` |
| Raccoon | **Scout** | gathers only the context a task needs, and loads relevant prior artifacts | `scout`, `makeScout()` |
| Troll | **Guard** | default-reject reviewer that inspects every candidate and returns a verdict (named for the guard caste that inspects arrivals and turns intruders away) | `guard`, `makeGuard()`, `GuardVerdict`, `guard-review.ts` |
| Ogre | **Soldier** | heavyweight, expensive, deep-reasoning escalation, used only when foragers and specialists have failed | `soldier`, `makeSoldier()` |
| Pigeon | **Messenger** | carries and compresses artifacts; in Scribe mode distils a finished flight into a typed Artifact | `messenger`, `makeMessenger()`; `makeScribe()` unchanged |

## Units of work and storage

| Goblintown | FLYTOWN | Meaning | Code |
|---|---|---|---|
| Pack / packSize | **Swarm / swarmSize** | the parallel foragers on one task | `swarmSize` |
| Rite | **Flight** | the full pipeline: scout → swarm → wasps → guard → specialists → soldier → scribe | `Flight`, `performFlight()`, `flightId`, `FlightStep`, `flight.ts` |
| sub-rite (PlanNode kind `"sub_rite"`) | **flight** (kind `"flight"`) | one node of a plan | |
| action `spawn_subrite` | action **`spawn_flight`** | orchestration action | |
| Quest | **Foray** | lightweight: a swarm plus guard review, no full pipeline | `Foray`, `dispatchForay()`, `foray.ts` |
| Loot | **Morsel** | one model invocation, content-addressed | `Morsel`, `morselId`, `winnerMorselId` |
| Hoard | **Compost** | the file-backed record store | `Compost`, `compost.ts`, `.flytown/compost/` |
| Warren | **Terrarium** | a project root and its manifest | `Terrarium`, `terrarium.ts`, `initTerrarium()`, `loadTerrarium()`, `.flytown/terrarium.json` |
| Shinies | **Sugar** | the reward signal | `sugar()` |
| scavenge | **scout** | context gathering | `scout.ts` |
| chaos pass | **sting pass** | the wasp's adversarial pass | `stingPass()`, `sting.ts` |
| Ogre fallback (outcome `"ogre_fallback"`) | **soldier escalation** (`"soldier_fallback"`) | | |
| personality `goblin_mode` | **`frenzied`** | | |
| Tank | *(removed)* | | |

Unchanged because they were never goblin terms: Plan, PlanNode, planner, Artifact,
Scribe, Specialist, drift, personality, reroll, fold, trace.

## Outside the code

| Goblintown | FLYTOWN |
|---|---|
| `.goblintown/` | `.flytown/` |
| `warren.json` | `terrarium.json` |
| `GOBLINTOWN_*` env vars | `FLYTOWN_*` |
| `goblintown` binary | `flytown` (only) |
| `goblintown summon` | `flytown ask` |
| `goblintown rite` / `quest` / `scavenge` / `hoard` | `flytown flight` / `foray` / `scout` / `compost` |
| slash `/town` | `/swarm` (`/tank` removed) |
| global warren `~/.codex/goblintown` | global terrarium `~/.flytown` (override `FLYTOWN_HOME`) |

## Deliberate behaviour changes that came with the rename

- **Worker prompts** now describe the FLYTOWN swarm and each caste's job instead of the Goblintown protocol. Every live result recorded before 2026-09-12 used the old goblin prompts.
- **Sugar no longer subtracts a drift penalty.** Shinies penalised outputs for mentioning creature names — the joke at the heart of Goblintown. The new caste names are ordinary English words ("add a *guard* clause", "*scout* the codebase"), so the same penalty would punish correct answers. Drift is still *measured and reported* against the caste names, because it is the instrument that detects the themed prompts leaking into outputs.
- The roster test that pinned the castes to OpenAI's banned-creature list is replaced by a test that pins the FLYTOWN roster.
