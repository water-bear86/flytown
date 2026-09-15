# FLYTOWN evaluation report

created: 2026-09-15T00:00:22.609Z  ·  seeds: 1,2,3  ·  fixtures: 20  ·  mock worker world (not live models)

> suite: public-v2 · blockmmo@e2450b77e2b3 · flytown@7557dd0bc13a

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean flights | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fly:connectome=malecns-v1.0-projectome-1+adapters=adapters-rerouted.json | 60 | 50% | 53% | 33% | 18643 | 2.93 | 0.38 | 3.50 | 1.52 | 4 / 0.063 | 0% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled+adapters=adapters-rerouted.json | 60 | 45% | 47% | 33% | 17323 | 2.65 | 0.43 | 3.05 | 1.28 | 6 / 0.087 | 0% |
| fly:connectome=malecns-v1.0-projectome-1+random_degree+adapters=adapters-rerouted.json | 60 | 55% | 53% | 33% | 17167 | 2.68 | 0.35 | 3.20 | 1.20 | 5 / 0.056 | 0% |

## fly:connectome=malecns-v1.0-projectome-1+adapters=adapters-rerouted.json vs fly:connectome=malecns-v1.0-projectome-1+shuffled+adapters=adapters-rerouted.json (paired, n=60)

- termination-accuracy difference: 5.0 pts, permutation p = 0.461
- token difference: 1320, permutation p = 0.000
- primary-action JS divergence: 0.377 bits  ·  identical decisions: 5%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | merge_results | request_artifact_investigation | request_human_approval | run_tool | search_memory | surface_uncertainty | terminate_blocked |
|---|---|---|---|---|---|---|---|
| fly:connectome=malecns-v1.0-projectome-1+adapters=adapters-rerouted.json | 0% | 55% | 0% | 20% | 15% | 0% | 10% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled+adapters=adapters-rerouted.json | 35% | 10% | 0% | 20% | 10% | 15% | 10% |
| fly:connectome=malecns-v1.0-projectome-1+random_degree+adapters=adapters-rerouted.json | 0% | 5% | 5% | 20% | 60% | 0% | 10% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| fly:connectome=malecns-v1.0-projectome-1+adapters=adapters-rerouted.json | 67% | 67% | 33% | 33% | 50% | 17% | 83% | 50% | 100% | 0% |
| fly:connectome=malecns-v1.0-projectome-1+shuffled+adapters=adapters-rerouted.json | 50% | 67% | 50% | 33% | 33% | 17% | 67% | 33% | 100% | 0% |
| fly:connectome=malecns-v1.0-projectome-1+random_degree+adapters=adapters-rerouted.json | 67% | 67% | 50% | 33% | 50% | 67% | 67% | 50% | 100% | 0% |

