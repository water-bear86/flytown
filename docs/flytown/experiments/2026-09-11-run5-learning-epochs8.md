# FLYTOWN evaluation report

created: 2026-09-11T21:11:17.147Z  ·  seeds: 1,2,3  ·  fixtures: 20  ·  mock worker world (not live models)

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 60 | 82% | 76% | 50% | 17003 | 2.62 | 0.47 | 3.27 | 0.52 | 8 / 0.570 | 0% |
| random | 60 | 47% | 58% | 17% | 27293 | 3.87 | 0.58 | 5.10 | 2.47 | 12 / 0.153 | 0% |
| learned | 60 | 63% | 84% | 33% | 12433 | 1.77 | 0.70 | 1.77 | 0.43 | 4 / 0.192 | 0% |
| fly | 60 | 52% | 56% | 17% | 16720 | 2.65 | 0.45 | 3.05 | 1.18 | 3 / 0.048 | 0% |
| fly:learning | 60 | 67% | 89% | 83% | 35500 | 4.77 | 0.78 | 5.62 | 2.75 | 1 / 0.018 | 0% |
| fly:shuffled+learning | 60 | 65% | 80% | 83% | 31090 | 4.67 | 0.80 | 5.48 | 2.32 | 2 / 0.038 | 0% |
| fly:random_degree+learning | 60 | 52% | 56% | 0% | 23963 | 3.57 | 0.37 | 4.45 | 2.18 | 5 / 0.025 | 0% |
| fly:norecurrence+learning | 60 | 67% | 76% | 50% | 25997 | 4.25 | 0.52 | 5.17 | 2.13 | 2 / 0.041 | 0% |
| fly:signless+learning | 60 | 57% | 76% | 67% | 31357 | 4.93 | 1.00 | 6.00 | 2.57 | 1 / 0.018 | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED+learning | 60 | 70% | 93% | 100% | 34090 | 5.52 | 0.78 | 7.13 | 3.27 | 2 / 0.020 | 0% |

> **Constant-policy warning:** fly:learning, fly:signless+learning made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.

## Training curves (epochs=8, train seeds 1001,1002,1003 — disjoint from evaluation seeds)

- learned: e1 53% → e2 67% → e3 67% → e4 68% → e5 72% → e6 70% → e7 70% → e8 70%
- fly:learning: e1 62% → e2 55% → e3 68% → e4 55% → e5 48% → e6 53% → e7 52% → e8 57%
- fly:shuffled+learning: e1 70% → e2 62% → e3 60% → e4 68% → e5 67% → e6 67% → e7 70% → e8 67%
- fly:random_degree+learning: e1 60% → e2 63% → e3 65% → e4 70% → e5 68% → e6 63% → e7 67% → e8 67%
- fly:norecurrence+learning: e1 65% → e2 62% → e3 67% → e4 63% → e5 62% → e6 60% → e7 58% → e8 63%
- fly:signless+learning: e1 70% → e2 62% → e3 63% → e4 58% → e5 63% → e6 60% → e7 62% → e8 60%
- fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED+learning: e1 55% → e2 58% → e3 58% → e4 68% → e5 65% → e6 62% → e7 65% → e8 65%

## fly:learning vs fly:shuffled+learning (paired, n=60)

- termination-accuracy difference: 1.7 pts, permutation p = 1.000
- token difference: 4410, permutation p = 0.008
- primary-action JS divergence: 1.000 bits  ·  identical decisions: 0%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | increase_pack_size | invoke_reviewer | merge_results | request_artifact_investigation | request_human_approval | retry_new_approach | run_tests | run_tool | search_memory | spawn_subrite | surface_uncertainty | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 0% | 0% | 0% | 25% | 10% | 0% | 10% | 10% | 0% | 20% | 5% | 10% | 10% |
| random | 7% | 10% | 8% | 5% | 3% | 7% | 7% | 7% | 10% | 7% | 12% | 8% | 10% |
| learned | 5% | 0% | 5% | 0% | 0% | 5% | 0% | 0% | 0% | 85% | 0% | 0% | 0% |
| fly | 0% | 0% | 0% | 10% | 0% | 0% | 0% | 0% | 80% | 0% | 0% | 10% | 0% |
| fly:learning | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:shuffled+learning | 0% | 0% | 0% | 95% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 5% | 0% |
| fly:random_degree+learning | 0% | 0% | 15% | 50% | 0% | 0% | 0% | 0% | 5% | 20% | 0% | 10% | 0% |
| fly:norecurrence+learning | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 90% | 0% | 0% | 10% | 0% |
| fly:signless+learning | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED+learning | 0% | 0% | 0% | 70% | 0% | 0% | 0% | 0% | 30% | 0% | 0% | 0% | 0% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| rules | 83% | 83% | 83% | 50% | 67% | 50% | 100% | 100% | 100% | 100% |
| random | 67% | 83% | 50% | 17% | 50% | 50% | 50% | 83% | 0% | 17% |
| learned | 100% | 100% | 67% | 33% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly | 67% | 83% | 83% | 17% | 33% | 17% | 67% | 50% | 100% | 0% |
| fly:learning | 100% | 100% | 100% | 83% | 50% | 33% | 100% | 100% | 0% | 0% |
| fly:shuffled+learning | 100% | 83% | 83% | 83% | 33% | 17% | 100% | 100% | 50% | 0% |
| fly:random_degree+learning | 83% | 67% | 67% | 0% | 33% | 33% | 67% | 67% | 100% | 0% |
| fly:norecurrence+learning | 83% | 100% | 67% | 50% | 50% | 50% | 100% | 67% | 100% | 0% |
| fly:signless+learning | 100% | 83% | 83% | 67% | 33% | 17% | 100% | 83% | 0% | 0% |
| fly:ablate=MB_CA+MB_ML+MB_VL+MB_PED+learning | 100% | 100% | 67% | 100% | 83% | 50% | 100% | 100% | 0% | 0% |

