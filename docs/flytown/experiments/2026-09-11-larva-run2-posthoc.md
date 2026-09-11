# FLYTOWN evaluation report

created: 2026-09-11T23:15:45.057Z  ·  seeds: 1,2,3  ·  fixtures: 20  ·  mock worker world (not live models)

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 60 | 82% | 76% | 50% | 17003 | 2.62 | 0.47 | 3.27 | 0.52 | 8 / 0.570 | 0% |
| learned | 60 | 63% | 84% | 33% | 12433 | 1.77 | 0.70 | 1.77 | 0.43 | 4 / 0.192 | 0% |
| fly:connectome=l1-larva-winding2023-1 | 60 | 67% | 89% | 83% | 31167 | 4.83 | 0.82 | 5.83 | 2.82 | 2 / 0.013 | 0% |
| fly:connectome=l1-larva-winding2023-1+plastic | 60 | 72% | 96% | 83% | 34267 | 5.40 | 0.85 | 6.82 | 3.37 | 2 / 0.014 | 0% |
| fly:connectome=l1-larva-winding2023-1+learning | 60 | 57% | 76% | 17% | 24593 | 4.10 | 1.03 | 6.10 | 1.60 | 1 / 0.059 | 0% |
| fly:connectome=l1-larva-winding2023-1+learning+plastic | 60 | 68% | 91% | 50% | 16640 | 1.67 | 0.53 | 1.73 | 0.37 | 2 / 0.101 | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+plastic | 60 | 72% | 96% | 83% | 15313 | 1.52 | 0.52 | 1.52 | 0.37 | 1 / 0.002 | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+learning+plastic | 60 | 60% | 80% | 17% | 22777 | 3.77 | 0.98 | 5.62 | 1.42 | 2 / 0.055 | 0% |
| fly:connectome=l1-larva-winding2023-1+random_degree+learning+plastic | 60 | 68% | 91% | 83% | 36407 | 5.57 | 0.80 | 7.20 | 3.28 | 1 / 0.000 | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+learning+plastic | 60 | 57% | 76% | 17% | 24120 | 4.02 | 1.02 | 6.05 | 1.65 | 1 / 0.000 | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+learning+plastic | 60 | 62% | 76% | 67% | 27683 | 4.37 | 0.82 | 5.15 | 1.68 | 2 / 0.119 | 0% |
| fly:connectome=l1-larva-winding2023-1+nosparse+learning+plastic | 60 | 78% | 91% | 50% | 13347 | 1.28 | 0.48 | 1.28 | 0.12 | 2 / 0.325 | 0% |

> **Constant-policy warning:** fly:connectome=l1-larva-winding2023-1+learning, fly:connectome=l1-larva-winding2023-1+shuffled+plastic, fly:connectome=l1-larva-winding2023-1+random_degree+learning+plastic, fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+learning+plastic made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.

## Training curves (epochs=8, train seeds 1001,1002,1003 — disjoint from evaluation seeds)

- learned: e1 53% → e2 67% → e3 67% → e4 68% → e5 72% → e6 70% → e7 70% → e8 70%
- fly:connectome=l1-larva-winding2023-1+plastic: e1 52% → e2 50% → e3 50% → e4 50% → e5 50% → e6 50% → e7 50% → e8 50%
- fly:connectome=l1-larva-winding2023-1+learning: e1 55% → e2 60% → e3 72% → e4 67% → e5 68% → e6 63% → e7 62% → e8 62%
- fly:connectome=l1-larva-winding2023-1+learning+plastic: e1 57% → e2 67% → e3 70% → e4 70% → e5 70% → e6 70% → e7 70% → e8 70%
- fly:connectome=l1-larva-winding2023-1+shuffled+plastic: e1 58% → e2 58% → e3 58% → e4 58% → e5 58% → e6 58% → e7 58% → e8 58%
- fly:connectome=l1-larva-winding2023-1+shuffled+learning+plastic: e1 58% → e2 57% → e3 58% → e4 58% → e5 58% → e6 58% → e7 58% → e8 58%
- fly:connectome=l1-larva-winding2023-1+random_degree+learning+plastic: e1 65% → e2 50% → e3 62% → e4 67% → e5 68% → e6 67% → e7 70% → e8 68%
- fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+learning+plastic: e1 65% → e2 52% → e3 55% → e4 55% → e5 55% → e6 55% → e7 55% → e8 55%
- fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+learning+plastic: e1 57% → e2 60% → e3 67% → e4 58% → e5 68% → e6 75% → e7 73% → e8 80%
- fly:connectome=l1-larva-winding2023-1+nosparse+learning+plastic: e1 68% → e2 65% → e3 72% → e4 75% → e5 73% → e6 75% → e7 78% → e8 80%

## fly:connectome=l1-larva-winding2023-1+plastic vs fly:connectome=l1-larva-winding2023-1+shuffled+plastic (paired, n=60)

- termination-accuracy difference: 0.0 pts, permutation p = 1.000
- token difference: 18953, permutation p = 0.000
- primary-action JS divergence: 0.180 bits  ·  identical decisions: 0%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | increase_pack_size | merge_results | request_artifact_investigation | request_human_approval | retry_new_approach | run_tests | run_tool | search_memory | spawn_subrite | surface_uncertainty | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 0% | 0% | 25% | 10% | 0% | 10% | 10% | 0% | 20% | 5% | 10% | 10% |
| learned | 5% | 5% | 0% | 0% | 5% | 0% | 0% | 0% | 85% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1 | 0% | 0% | 0% | 0% | 25% | 0% | 0% | 0% | 75% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+plastic | 0% | 0% | 0% | 0% | 32% | 0% | 0% | 0% | 68% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+learning | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+learning+plastic | 95% | 0% | 0% | 0% | 0% | 0% | 5% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+plastic | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+learning+plastic | 0% | 0% | 0% | 0% | 0% | 0% | 70% | 0% | 30% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+random_degree+learning+plastic | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+learning+plastic | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+learning+plastic | 0% | 0% | 90% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 10% | 0% |
| fly:connectome=l1-larva-winding2023-1+nosparse+learning+plastic | 80% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 20% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| rules | 83% | 83% | 83% | 50% | 67% | 50% | 100% | 100% | 100% | 100% |
| learned | 100% | 100% | 67% | 33% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1 | 100% | 100% | 83% | 83% | 67% | 33% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+plastic | 100% | 100% | 83% | 83% | 100% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+learning | 100% | 83% | 50% | 17% | 83% | 33% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+learning+plastic | 100% | 100% | 100% | 50% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+plastic | 100% | 100% | 100% | 83% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+learning+plastic | 100% | 100% | 50% | 17% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+random_degree+learning+plastic | 100% | 100% | 67% | 83% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+learning+plastic | 100% | 100% | 33% | 17% | 83% | 33% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+learning+plastic | 100% | 83% | 83% | 67% | 33% | 17% | 100% | 83% | 50% | 0% |
| fly:connectome=l1-larva-winding2023-1+nosparse+learning+plastic | 100% | 100% | 100% | 50% | 83% | 50% | 100% | 100% | 0% | 100% |

