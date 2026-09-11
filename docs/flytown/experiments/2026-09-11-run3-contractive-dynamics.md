# FLYTOWN evaluation report

created: 2026-09-11T21:07:11.101Z  ·  seeds: 1,2,3  ·  fixtures: 20  ·  mock worker world (not live models)

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 60 | 82% | 76% | 50% | 17003 | 2.62 | 0.47 | 3.27 | 0.52 | 8 / 0.570 | 0% |
| random | 60 | 47% | 58% | 17% | 27293 | 3.87 | 0.58 | 5.10 | 2.47 | 12 / 0.153 | 0% |
| fly | 60 | 52% | 56% | 17% | 16720 | 2.65 | 0.45 | 3.05 | 1.18 | 3 / 0.048 | 0% |
| fly:shuffled | 60 | 38% | 38% | 0% | 16343 | 2.38 | 0.52 | 2.85 | 1.15 | 4 / 0.126 | 0% |
| fly:random_degree | 60 | 47% | 49% | 17% | 18653 | 3.00 | 0.40 | 3.75 | 1.52 | 7 / 0.067 | 0% |
| fly:norecurrence | 60 | 65% | 73% | 33% | 22857 | 3.72 | 0.47 | 4.42 | 1.58 | 3 / 0.118 | 0% |
| fly:signless | 60 | 57% | 62% | 17% | 22573 | 3.45 | 0.43 | 4.17 | 1.83 | 5 / 0.056 | 0% |
| fly:noself | 60 | 63% | 71% | 17% | 24707 | 3.98 | 0.52 | 4.80 | 2.22 | 3 / 0.055 | 0% |
| fly:gain=0.6 | 60 | 52% | 49% | 17% | 15280 | 2.35 | 0.40 | 2.75 | 0.98 | 5 / 0.103 | 0% |
| fly:insteps=3+gain=1.5 | 60 | 63% | 84% | 67% | 29323 | 4.62 | 0.85 | 5.55 | 2.47 | 1 / 0.000 | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED | 60 | 48% | 44% | 33% | 17180 | 2.73 | 0.43 | 3.45 | 1.28 | 4 / 0.079 | 0% |
| fly:ablate=EB+FB+PB+NO | 60 | 57% | 56% | 17% | 16210 | 2.50 | 0.40 | 2.90 | 0.98 | 4 / 0.055 | 0% |

> **Constant-policy warning:** fly:insteps=3+gain=1.5 made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.

## fly vs fly:shuffled (paired, n=60)

- termination-accuracy difference: 13.3 pts, permutation p = 0.060
- token difference: 377, permutation p = 0.701
- primary-action JS divergence: 0.712 bits  ·  identical decisions: 0%

**Not distinguishable** at p<0.05 on termination accuracy or tokens. Under this harness the real wiring is not shown to matter versus fly:shuffled. Report this as the result; do not dress it up.

## Primary action distribution

| planner | increase_pack_size | invoke_reviewer | merge_results | request_artifact_investigation | request_human_approval | retry_new_approach | run_tests | run_tool | search_memory | spawn_subrite | surface_uncertainty | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 0% | 0% | 0% | 25% | 10% | 0% | 10% | 10% | 0% | 20% | 5% | 10% | 10% |
| random | 7% | 10% | 8% | 5% | 3% | 7% | 7% | 7% | 10% | 7% | 12% | 8% | 10% |
| fly | 0% | 0% | 0% | 10% | 0% | 0% | 0% | 0% | 80% | 0% | 0% | 10% | 0% |
| fly:shuffled | 0% | 0% | 0% | 45% | 0% | 0% | 0% | 20% | 0% | 0% | 25% | 10% | 0% |
| fly:random_degree | 0% | 0% | 0% | 15% | 10% | 25% | 0% | 20% | 10% | 0% | 15% | 5% | 0% |
| fly:norecurrence | 0% | 0% | 0% | 55% | 0% | 0% | 0% | 0% | 35% | 0% | 0% | 10% | 0% |
| fly:signless | 0% | 0% | 0% | 50% | 0% | 0% | 0% | 20% | 10% | 0% | 15% | 5% | 0% |
| fly:noself | 0% | 0% | 0% | 75% | 0% | 0% | 0% | 0% | 20% | 0% | 0% | 5% | 0% |
| fly:gain=0.6 | 0% | 0% | 0% | 45% | 5% | 0% | 0% | 15% | 25% | 0% | 0% | 10% | 0% |
| fly:insteps=3+gain=1.5 | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED | 0% | 0% | 0% | 65% | 5% | 0% | 0% | 20% | 0% | 0% | 0% | 10% | 0% |
| fly:ablate=EB+FB+PB+NO | 0% | 0% | 0% | 5% | 5% | 0% | 0% | 0% | 80% | 0% | 0% | 10% | 0% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| rules | 83% | 83% | 83% | 50% | 67% | 50% | 100% | 100% | 100% | 100% |
| random | 67% | 83% | 50% | 17% | 50% | 50% | 50% | 83% | 0% | 17% |
| fly | 67% | 83% | 83% | 17% | 33% | 17% | 67% | 50% | 100% | 0% |
| fly:shuffled | 67% | 83% | 17% | 0% | 17% | 0% | 17% | 83% | 100% | 0% |
| fly:random_degree | 83% | 67% | 50% | 17% | 33% | 50% | 50% | 67% | 50% | 0% |
| fly:norecurrence | 83% | 100% | 83% | 33% | 50% | 33% | 100% | 67% | 100% | 0% |
| fly:signless | 67% | 83% | 67% | 17% | 50% | 50% | 67% | 67% | 100% | 0% |
| fly:noself | 83% | 83% | 83% | 17% | 50% | 50% | 100% | 67% | 100% | 0% |
| fly:gain=0.6 | 67% | 83% | 83% | 17% | 33% | 67% | 17% | 50% | 100% | 0% |
| fly:insteps=3+gain=1.5 | 100% | 100% | 100% | 67% | 50% | 33% | 100% | 83% | 0% | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED | 67% | 67% | 33% | 33% | 17% | 50% | 33% | 83% | 100% | 0% |
| fly:ablate=EB+FB+PB+NO | 67% | 83% | 83% | 17% | 33% | 67% | 67% | 50% | 100% | 0% |

