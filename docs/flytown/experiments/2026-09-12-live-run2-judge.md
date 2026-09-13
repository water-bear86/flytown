# FLYTOWN evaluation report

created: 2026-09-12T02:49:50.635Z  ·  seeds: 1,2  ·  fixtures: 10  ·  **LIVE** — real Goblintown pipeline against the provider in ~/flytown/.flytown/live-warren (pack ≤ 2, ≤ 700 output tokens/call, ≤ 60000 tokens/run; learnable planners trained in the mock world first)

> tokens spent: 5,240,117  ·  wall time: 140.6 min  ·  2 runs skipped by the total-token cap. Completion here means Goblintown's own troll-gated pipeline produced a winner for every node; halts are judged against each fixture's expected termination. No external judge yet — final claims are recorded per run in report.json for human review.

| planner | runs | quality (judge) | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| llm | 20 | 0.39 (n=18) | 78% | 100% | 100% | 121076 | 4.22 | 0.00 | 4.22 | 0.94 | 0 / 0.000 | 10% |
| rules | 20 | 0.69 (n=20) | 100% | 100% | 100% | 57930 | 2.10 | 0.00 | 2.10 | 0.40 | 7 / 0.586 | 0% |
| learned | 20 | 0.59 (n=20) | 70% | 100% | 100% | 43664 | 1.80 | 0.00 | 1.80 | 0.70 | 2 / 0.295 | 0% |
| larva+learning+plastic | 20 | 0.44 (n=20) | 70% | 100% | 100% | 25689 | 1.00 | 0.00 | 1.00 | 0.30 | 1 / 0.054 | 0% |
| larva+shuffled+learning+plastic | 20 | 0.58 (n=20) | 70% | 100% | 100% | 25754 | 1.00 | 0.00 | 1.00 | 0.30 | 1 / 0.048 | 0% |

> quality = LLM-judge rubric score in [0,1] per fixture (halts scored 1/0 by the fixture's expected termination; failed plans 0). The judge is a model call with a fixed prompt shared across planners — record, don't trust blindly; rationales are in report.json.

> **Constant-policy warning:** llm, larva+learning+plastic, larva+shuffled+learning+plastic made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.

## Training curves (epochs=8, train seeds 1001,1002 — disjoint from evaluation seeds)

- larva+learning+plastic: e1 65% → e2 60% → e3 65% → e4 65% → e5 65% → e6 65% → e7 65% → e8 65%
- larva+shuffled+learning+plastic: e1 45% → e2 55% → e3 65% → e4 55% → e5 65% → e6 65% → e7 60% → e8 60%
- learned: e1 50% → e2 70% → e3 65% → e4 65% → e5 55% → e6 60% → e7 60% → e8 60%

## larva+learning+plastic vs larva+shuffled+learning+plastic (paired, n=20)

- termination-accuracy difference: 0.0 pts, permutation p = 1.000
- token difference: -65, permutation p = 0.964
- judge-quality difference: -0.140 (n=20), permutation p = 0.199
- primary-action JS divergence: 0.000 bits  ·  identical decisions: 100%

**Not distinguishable** at p<0.05 on termination accuracy or tokens. Under this harness the real wiring is not shown to matter versus larva+shuffled+learning+plastic. Report this as the result; do not dress it up.

## Primary action distribution

| planner | increase_pack_size | request_artifact_investigation | request_human_approval | run_tests | run_tool | spawn_subrite | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|---|
| llm | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% |
| rules | 0% | 30% | 10% | 10% | 10% | 20% | 10% | 10% |
| learned | 70% | 0% | 0% | 30% | 0% | 0% | 0% | 0% |
| larva+learning+plastic | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% |
| larva+shuffled+learning+plastic | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| llm | 100% | 100% | 100% | 100% | 100% | 0% | 100% | 100% | 0% | – |
| rules | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% |
| learned | 100% | 100% | 100% | 100% | 100% | 0% | 100% | 100% | 0% | 0% |
| larva+learning+plastic | 100% | 100% | 100% | 100% | 100% | 0% | 100% | 100% | 0% | 0% |
| larva+shuffled+learning+plastic | 100% | 100% | 100% | 100% | 100% | 0% | 100% | 100% | 0% | 0% |

