# FLYTOWN evaluation report

created: 2026-09-12T01:46:40.967Z  ·  seeds: 1  ·  fixtures: 10  ·  **LIVE** — real Goblintown pipeline against the provider in /Users/angusdurrie/flytown/.flytown/live-warren (pack ≤ 2, ≤ 700 output tokens/call, ≤ 60000 tokens/run; learnable planners trained in the mock world first)

> tokens spent: 2,570,445  ·  wall time: 69.3 min  ·  3 runs skipped by the total-token cap. Completion here means Goblintown's own troll-gated pipeline produced a winner for every node; halts are judged against each fixture's expected termination. No external judge yet — final claims are recorded per run in report.json for human review.

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| llm | 10 | 100% | 100% | 100% | 122539 | 4.29 | 0.00 | 4.29 | 0.00 | 0 / 0.000 | 30% |
| rules | 10 | 90% | 88% | 100% | 60180 | 2.10 | 0.00 | 2.10 | 0.40 | 7 / 0.588 | 0% |
| larva+learning+plastic | 10 | 80% | 100% | 100% | 26280 | 1.10 | 0.00 | 1.10 | 0.30 | 1 / 0.011 | 0% |
| larva+shuffled+learning+plastic | 10 | 80% | 100% | 100% | 84807 | 3.00 | 0.00 | 3.00 | 1.30 | 1 / 0.034 | 0% |

> **Constant-policy warning:** llm, larva+learning+plastic, larva+shuffled+learning+plastic made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.

## Training curves (epochs=8, train seeds 1001 — disjoint from evaluation seeds)

- larva+learning+plastic: e1 80% → e2 60% → e3 70% → e4 70% → e5 80% → e6 80% → e7 80% → e8 80%
- larva+shuffled+learning+plastic: e1 70% → e2 80% → e3 70% → e4 70% → e5 80% → e6 80% → e7 80% → e8 70%

## larva+learning+plastic vs larva+shuffled+learning+plastic (paired, n=10)

- termination-accuracy difference: 0.0 pts, permutation p = 1.000
- token difference: -58527, permutation p = 0.002
- primary-action JS divergence: 1.000 bits  ·  identical decisions: 0%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | request_artifact_investigation | request_human_approval | run_tests | run_tool | spawn_subrite | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|
| llm | 0% | 0% | 0% | 0% | 100% | 0% | 0% |
| rules | 30% | 10% | 10% | 10% | 20% | 10% | 10% |
| larva+learning+plastic | 0% | 0% | 0% | 0% | 100% | 0% | 0% |
| larva+shuffled+learning+plastic | 100% | 0% | 0% | 0% | 0% | 0% | 0% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| llm | 100% | 100% | 100% | 100% | 100% | 100% | 100% | – | – | – |
| rules | 100% | 100% | 100% | 100% | 100% | 0% | 100% | 100% | 100% | 100% |
| larva+learning+plastic | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0% | 0% |
| larva+shuffled+learning+plastic | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0% | 0% |

