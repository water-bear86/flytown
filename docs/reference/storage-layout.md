# Storage Layout

Goblintown stores local Warren state under `.goblintown/`.

```text
.goblintown/
  warren.json
  reward.mjs
  provider-secrets.json
  hoard/
    loot/<id>.json
    quests/<id>.json
    rites/<id>.json
    artifacts/<id>.json
  runs/<runId>.json
```

## Files

| Path | Purpose |
| --- | --- |
| `warren.json` | Local project manifest: provider config. |
| `reward.mjs` | Optional local reward plugin. |
| `provider-secrets.json` | Local provider keys. Gitignored. |
| `hoard/loot/` | Model/tool call records. |
| `hoard/quests/` | Lightweight pack runs. |
| `hoard/rites/` | Full Rite records. |
| `hoard/artifacts/` | Pigeon-Scribe memory Artifacts. |
| `runs/` | SSE-streamed browser run state. |

## Cleanup Rule

If you are comparing repos or deleting duplicate checkouts, do not ignore
`.goblintown/`. It is runtime state, but it can contain real progress.
