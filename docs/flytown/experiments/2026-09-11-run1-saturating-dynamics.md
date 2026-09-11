# FLYTOWN evaluation report

created: 2026-09-11T21:04:32.288Z  ·  seeds: 1,2,3  ·  fixtures: 20  ·  mock worker world (not live models)

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | errors |
|---|---|---|---|---|---|---|---|---|---|---|
| rules | 60 | 82% | 76% | 50% | 17003 | 2.62 | 0.47 | 3.27 | 0.52 | 0% |
| random | 60 | 47% | 58% | 17% | 27293 | 3.87 | 0.58 | 5.10 | 2.47 | 0% |
| learned | 60 | 70% | 93% | 100% | 47493 | 6.43 | 0.63 | 8.17 | 4.63 | 0% |
| fly | 60 | 63% | 84% | 67% | 29323 | 4.62 | 0.85 | 5.55 | 2.47 | 0% |
| fly:shuffled | 60 | 10% | 0% | 0% | 0 | 0.00 | 0.00 | 0.00 | 0.00 | 0% |
| fly:random_degree | 60 | 68% | 91% | 83% | 37210 | 6.22 | 0.68 | 8.42 | 4.12 | 0% |
| fly:norecurrence | 60 | 67% | 69% | 33% | 19803 | 3.23 | 0.35 | 3.78 | 1.25 | 0% |
| fly:signless | 60 | 70% | 93% | 100% | 41830 | 6.32 | 0.67 | 8.33 | 4.30 | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED | 60 | 67% | 89% | 83% | 35170 | 5.85 | 0.77 | 7.65 | 3.55 | 0% |
| fly:ablate=EB+FB+PB+NO | 60 | 63% | 84% | 67% | 29323 | 4.62 | 0.85 | 5.55 | 2.47 | 0% |

## fly vs fly:shuffled (paired, n=60)

- termination-accuracy difference: 53.3 pts, permutation p = 0.000
- token difference: 29323, permutation p = 0.000
- primary-action JS divergence: 1.000 bits  ·  identical decisions: 0%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | increase_pack_size | invoke_reviewer | merge_results | request_artifact_investigation | request_human_approval | retry_new_approach | run_tests | run_tool | search_memory | spawn_subrite | surface_uncertainty | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 0% | 0% | 0% | 25% | 10% | 0% | 10% | 10% | 0% | 20% | 5% | 10% | 10% |
| random | 7% | 10% | 8% | 5% | 3% | 7% | 7% | 7% | 10% | 7% | 12% | 8% | 10% |
| learned | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% |
| fly | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:shuffled | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 100% |
| fly:random_degree | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% |
| fly:norecurrence | 0% | 0% | 0% | 50% | 5% | 0% | 0% | 0% | 25% | 0% | 0% | 10% | 10% |
| fly:signless | 0% | 0% | 0% | 10% | 0% | 0% | 0% | 0% | 0% | 90% | 0% | 0% | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED | 0% | 0% | 0% | 95% | 0% | 5% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:ablate=EB+FB+PB+NO | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| rules | 83% | 83% | 83% | 50% | 67% | 50% | 100% | 100% | 100% | 100% |
| random | 67% | 83% | 50% | 17% | 50% | 50% | 50% | 83% | 0% | 17% |
| learned | 100% | 83% | 100% | 100% | 67% | 50% | 100% | 100% | 0% | 0% |
| fly | 100% | 100% | 100% | 67% | 50% | 33% | 100% | 83% | 0% | 0% |
| fly:shuffled | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 100% |
| fly:random_degree | 100% | 83% | 100% | 83% | 67% | 50% | 100% | 100% | 0% | 0% |
| fly:norecurrence | 50% | 100% | 83% | 33% | 50% | 83% | 100% | 67% | 100% | 0% |
| fly:signless | 100% | 83% | 100% | 100% | 67% | 50% | 100% | 100% | 0% | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED | 100% | 83% | 100% | 83% | 50% | 50% | 100% | 100% | 0% | 0% |
| fly:ablate=EB+FB+PB+NO | 100% | 100% | 100% | 67% | 50% | 33% | 100% | 83% | 0% | 0% |

