# Extensions Overview

Goblintown has extension surfaces, plural. They are separate because each one
extends a different part of the system.

| Surface | Extends | Persistence | Primary files |
| --- | --- | --- | --- |
| Reward plugins | Winner scoring | `.goblintown/reward.mjs` | `src/reward-plugin.ts` |
| Provider routes | Model/backend per creature slot | `.goblintown/warren.json`, `.goblintown/provider-secrets.json` | `src/providers.ts` |
| Repo skills | Future development workflows | `.agents/skills/<name>/SKILL.md` | `.agents/skills/` |

## Built-in Verifier Tools

Built-in tools live in `src/tools.ts`.

| Tool | Notes |
| --- | --- |
| `json.parse` | Parses JSON and returns validity/error detail. |
| `regex.match` | Tests a regex with a small runtime cap. |
| `http.head` | Disabled unless `GOBLINTOWN_TOOLS_HTTP=1`. |
| `web.fetch` | Fetches public HTTP(S) page text; blocks localhost and private-network hosts. |

## Reward Plugins

Drop `.goblintown/reward.mjs` into a Warren:

```js
export default function (loot, verdict) {
  return verdict.passed ? 0.8 + (1 - loot.drift.driftRate) * 0.2 : verdict.score * 0.5;
}
```

The result is clamped to `[0, 1]`. This is local and project-specific. Do not
publish secrets or network side effects in reward plugins unless you want future
you to ask what past you was trying to prove.

## Provider Routes

Routes let each creature slot use a different backend:

```bash
goblintown route set goblin --preset ollama --model gemma3:27b
goblintown route set troll --preset openrouter --model openai/gpt-4o-mini
goblintown route set ogre --preset openai --model gpt-5
```

Plain OpenAI-compatible endpoints usually need only a provider config. Real SDK
packages should be added with a repo skill. See [skills.md](skills.md).
