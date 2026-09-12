# Extensions Overview

FLYTOWN has extension surfaces, plural. They are separate because each one
extends a different part of the system.

| Surface | Extends | Persistence | Primary files |
| --- | --- | --- | --- |
| Planner backends | Who decides the `Plan` | `flytown.planner` in `.flytown/terrarium.json` | `src/flytown/planner-backend.ts`, `src/flytown/registry.ts` |
| Reward plugins | Winner scoring (replaces Sugar) | `.flytown/reward.mjs` | `src/reward-plugin.ts` |
| Provider routes | Model/backend per caste slot | `.flytown/terrarium.json`, `.flytown/provider-secrets.json` | `src/providers.ts` |
| Repo skills | Future development workflows | `.agents/skills/<name>/SKILL.md` | `.agents/skills/` |

## Built-in Verifier Tools

Built-in tools live in `src/tools.ts`.

| Tool | Notes |
| --- | --- |
| `json.parse` | Parses JSON and returns validity/error detail. |
| `regex.match` | Tests a regex with a small runtime cap. |
| `http.head` | Disabled unless `FLYTOWN_TOOLS_HTTP=1`. |
| `web.fetch` | Fetches public HTTP(S) page text; blocks localhost and private-network hosts. |

## Planner Backends

A planner backend implements `PlannerBackend.plan()` and returns a `Plan`
(optionally with a decision trace). Specs are resolved in
`src/flytown/registry.ts`; `flytown fly planners` lists the known ones. Pick
one per run with `--planner`, or per terrarium with `flytown.planner`. Any new
backend can be compared against the others on identical fixtures, seeds and
budgets with `flytown fly eval`.

## Reward Plugins

Drop `.flytown/reward.mjs` (or `reward.js`) into a terrarium:

```js
export default function (morsel, verdict) {
  return verdict.passed ? 0.8 + (1 - morsel.drift.driftRate) * 0.2 : verdict.score * 0.5;
}
```

The function receives the candidate Morsel and the guard's verdict. The
result is clamped to `[0, 1]`, and anything that is not a number scores 0.
Without a plugin, the built-in Sugar is used. This is local and
project-specific. Do not publish secrets or network side effects in reward
plugins unless you want future you to ask what past you was trying to prove.

## Provider Routes

Routes let each caste slot use a different backend:

```bash
flytown route set forager --preset ollama --model gemma3:27b
flytown route set guard --preset openrouter --model openai/gpt-4o-mini
flytown route set soldier --preset openai --model gpt-5
```

Plain OpenAI-compatible endpoints usually need only a provider config. Real SDK
packages should be added with a repo skill. See [skills.md](skills.md) and
[Provider routing](../reference/providers.md).
