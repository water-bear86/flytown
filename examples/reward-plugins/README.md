# Reward plugin examples

FLYTOWN scores each candidate morsel with the built-in `sugar` reward
(`clamp01(guardScore + 0.1 if the guard passed it)`). A Terrarium can replace it
by adding a local plugin at:

```txt
.flytown/reward.mjs
```

The plugin's default export receives `(morsel, verdict)` — the candidate Morsel
and the Guard's verdict — and returns a number. The returned score is clamped
between `0` and `1`.

This folder contains small example reward plugins that can be copied into a Terrarium.

## low-drift-sugar.mjs

A conservative scoring profile that rewards passed Guard verdicts while giving
a small bonus to low-drift outputs (outputs that rarely mention the caste
names). Unlike the built-in `sugar`, it opts back into letting drift affect the
score.

```bash
mkdir -p .flytown
cp examples/reward-plugins/low-drift-sugar.mjs .flytown/reward.mjs
```
