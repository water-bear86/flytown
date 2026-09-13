# FLYTOWN evaluation report

created: 2026-09-12T06:35:39.234Z  ·  seeds: 1,2  ·  fixtures: 20  ·  **LIVE** — real Goblintown pipeline against the provider in ~/flytown/.flytown/live-warren (pack ≤ 2, ≤ 700 output tokens/call, ≤ 60000 tokens/run)

> provider (preflight passed): deepseek · deepseek-v4-flash · key from stored · requestParams {"thinking":{"type":"disabled"}} · smoke reply 5 chars

> tokens spent: 6,883,800  ·  wall time: 179.3 min  ·  0 runs skipped by the total-token cap. Completion here means Goblintown's own troll-gated pipeline produced a winner for every node; halts are judged against each fixture's expected termination. No external judge yet — final claims are recorded per run in report.json for human review.

| planner | runs | quality (judge) | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 40 | 0.55 (n=40) | 95% | 93% | 100% | 66838 | 2.10 | 0.00 | 2.10 | 0.40 | 8 / 0.570 | 0% |
| llm | 40 | 0.41 (n=37) | 81% | 100% | 100% | 109813 | 3.84 | 0.03 | 3.86 | 0.57 | 0 / 0.000 | 8% |

> quality = LLM-judge rubric score in [0,1] per fixture (halts scored 1/0 by the fixture's expected termination; failed plans 0). The judge is a model call with a fixed prompt shared across planners — record, don't trust blindly; rationales are in report.json.

> **Constant-policy warning:** llm made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.

## rules vs llm (paired, n=37)

- termination-accuracy difference: 13.5 pts, permutation p = 0.187
- token difference: -37556, permutation p = 0.000
- judge-quality difference: 0.105 (n=37), permutation p = 0.157
- primary-action JS divergence: 0.610 bits  ·  identical decisions: 11%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | request_artifact_investigation | request_human_approval | run_tests | run_tool | spawn_subrite | surface_uncertainty | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|---|
| rules | 25% | 10% | 10% | 10% | 20% | 5% | 10% | 10% |
| llm | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| rules | 100% | 100% | 100% | 100% | 100% | 50% | 100% | 100% | 100% | 100% |
| llm | 100% | 100% | 100% | 100% | 100% | 50% | 100% | 100% | 0% | 0% |

