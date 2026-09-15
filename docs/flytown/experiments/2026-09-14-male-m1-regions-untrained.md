# FLYTOWN evaluation report

created: 2026-09-14T23:59:52.707Z  ·  seeds: 1,2,3  ·  fixtures: 20  ·  mock worker world (not live models)

> suite: public-v2 · blockmmo@e2450b77e2b3 · flytown@7557dd0bc13a

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean flights | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 60 | 85% | 80% | 83% | 17653 | 2.73 | 0.38 | 3.32 | 0.55 | 8 / 0.565 | 0% |
| random | 60 | 52% | 67% | 67% | 30020 | 4.15 | 0.58 | 5.27 | 2.57 | 10 / 0.170 | 0% |
| fly | 60 | 50% | 47% | 0% | 15947 | 2.52 | 0.43 | 2.95 | 1.08 | 4 / 0.046 | 0% |
| fly:shuffled | 60 | 48% | 51% | 33% | 17563 | 2.57 | 0.40 | 2.95 | 1.23 | 4 / 0.104 | 0% |
| fly:random_degree | 60 | 48% | 51% | 33% | 19297 | 3.10 | 0.37 | 3.90 | 1.65 | 7 / 0.058 | 0% |
| fly:connectome=malecns-v1.0-projectome-1 | 60 | 50% | 53% | 33% | 18643 | 2.93 | 0.38 | 3.50 | 1.52 | 4 / 0.058 | 0% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled | 60 | 45% | 47% | 33% | 16873 | 2.57 | 0.43 | 2.95 | 1.25 | 6 / 0.088 | 0% |
| fly:connectome=malecns-v1.0-projectome-1+random_degree | 60 | 57% | 56% | 33% | 17367 | 2.70 | 0.35 | 3.20 | 1.17 | 5 / 0.055 | 0% |

## fly:connectome=malecns-v1.0-projectome-1 vs fly:connectome=malecns-v1.0-projectome-1+shuffled (paired, n=60)

- termination-accuracy difference: 5.0 pts, permutation p = 0.504
- token difference: 1770, permutation p = 0.000
- primary-action JS divergence: 0.377 bits  ·  identical decisions: 5%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | increase_swarm_size | invoke_reviewer | merge_results | request_artifact_investigation | request_human_approval | retry_new_approach | run_tests | run_tool | search_memory | spawn_flight | surface_uncertainty | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 0% | 0% | 0% | 25% | 10% | 0% | 10% | 10% | 0% | 20% | 5% | 10% | 10% |
| random | 7% | 13% | 7% | 7% | 3% | 10% | 10% | 7% | 10% | 5% | 12% | 5% | 5% |
| fly | 0% | 0% | 0% | 10% | 5% | 0% | 0% | 0% | 75% | 0% | 0% | 10% | 0% |
| fly:shuffled | 0% | 0% | 0% | 45% | 0% | 0% | 0% | 20% | 0% | 0% | 25% | 10% | 0% |
| fly:random_degree | 0% | 0% | 0% | 10% | 10% | 30% | 0% | 20% | 20% | 0% | 5% | 5% | 0% |
| fly:connectome=malecns-v1.0-projectome-1 | 0% | 0% | 0% | 55% | 0% | 0% | 0% | 20% | 15% | 0% | 0% | 10% | 0% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled | 0% | 0% | 35% | 10% | 0% | 0% | 0% | 20% | 10% | 0% | 15% | 10% | 0% |
| fly:connectome=malecns-v1.0-projectome-1+random_degree | 0% | 0% | 0% | 5% | 5% | 0% | 0% | 20% | 60% | 0% | 0% | 10% | 0% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| rules | 100% | 83% | 67% | 83% | 67% | 50% | 100% | 100% | 100% | 100% |
| random | 100% | 67% | 33% | 67% | 33% | 17% | 83% | 100% | 0% | 17% |
| fly | 50% | 67% | 67% | 0% | 33% | 67% | 83% | 33% | 100% | 0% |
| fly:shuffled | 67% | 67% | 33% | 33% | 17% | 17% | 67% | 83% | 100% | 0% |
| fly:random_degree | 67% | 50% | 33% | 33% | 33% | 67% | 83% | 67% | 50% | 0% |
| fly:connectome=malecns-v1.0-projectome-1 | 67% | 67% | 33% | 33% | 50% | 17% | 83% | 50% | 100% | 0% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled | 50% | 67% | 50% | 33% | 33% | 17% | 67% | 33% | 100% | 0% |
| fly:connectome=malecns-v1.0-projectome-1+random_degree | 67% | 67% | 67% | 33% | 50% | 67% | 67% | 50% | 100% | 0% |

