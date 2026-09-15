# FLYTOWN evaluation report

created: 2026-09-15T00:00:21.964Z  ·  seeds: 1,2,3  ·  fixtures: 20  ·  mock worker world (not live models)

> suite: public-v2 · blockmmo@e2450b77e2b3 · flytown@7557dd0bc13a

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean flights | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fly:learning | 60 | 62% | 82% | 83% | 29890 | 4.70 | 0.88 | 5.65 | 2.40 | 1 / 0.032 | 0% |
| fly:shuffled+learning | 60 | 63% | 71% | 83% | 21863 | 2.97 | 0.53 | 3.65 | 1.13 | 3 / 0.049 | 0% |
| fly:connectome=malecns-v1.0-projectome-1+learning | 60 | 77% | 89% | 100% | 20123 | 2.42 | 0.43 | 2.63 | 0.48 | 2 / 0.025 | 0% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled+learning | 60 | 65% | 80% | 83% | 27343 | 4.32 | 0.77 | 5.05 | 1.95 | 2 / 0.062 | 0% |

> **Constant-policy warning:** fly:learning made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.

## Training curves (epochs=8, train seeds 1001,1002,1003 — disjoint from evaluation seeds)

- fly:learning: e1 78% → e2 70% → e3 63% → e4 68% → e5 65% → e6 65% → e7 70% → e8 67%
- fly:shuffled+learning: e1 77% → e2 67% → e3 62% → e4 67% → e5 63% → e6 62% → e7 58% → e8 68%
- fly:connectome=malecns-v1.0-projectome-1+learning: e1 60% → e2 67% → e3 53% → e4 67% → e5 68% → e6 62% → e7 58% → e8 77%
- fly:connectome=malecns-v1.0-projectome-1+shuffled+learning: e1 70% → e2 68% → e3 62% → e4 60% → e5 62% → e6 60% → e7 63% → e8 60%

## fly:connectome=malecns-v1.0-projectome-1+learning vs fly:connectome=malecns-v1.0-projectome-1+shuffled+learning (paired, n=60)

- termination-accuracy difference: 11.7 pts, permutation p = 0.016
- token difference: -7220, permutation p = 0.000
- primary-action JS divergence: 0.950 bits  ·  identical decisions: 0%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | increase_swarm_size | run_tests | search_memory | surface_uncertainty | terminate_blocked |
|---|---|---|---|---|---|
| fly:learning | 0% | 0% | 100% | 0% | 0% |
| fly:shuffled+learning | 0% | 85% | 0% | 10% | 5% |
| fly:connectome=malecns-v1.0-projectome-1+learning | 95% | 0% | 0% | 0% | 5% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled+learning | 0% | 0% | 95% | 0% | 5% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| fly:learning | 100% | 100% | 67% | 83% | 33% | 50% | 100% | 83% | 0% | 0% |
| fly:shuffled+learning | 83% | 100% | 50% | 83% | 17% | 50% | 67% | 83% | 100% | 0% |
| fly:connectome=malecns-v1.0-projectome-1+learning | 100% | 100% | 67% | 100% | 50% | 50% | 100% | 100% | 100% | 0% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled+learning | 100% | 100% | 67% | 83% | 33% | 50% | 100% | 67% | 50% | 0% |

