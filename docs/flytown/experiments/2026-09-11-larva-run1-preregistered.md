# FLYTOWN evaluation report

created: 2026-09-11T23:07:44.024Z  ·  seeds: 1,2,3  ·  fixtures: 20  ·  mock worker world (not live models)

| planner | runs | termination acc | completion (of completable) | recovery (misleading) | mean tokens | mean rites | mean replans | mean nodes | unnecessary | task-sensitivity (distinct / JS bits) | errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 60 | 82% | 76% | 50% | 17003 | 2.62 | 0.47 | 3.27 | 0.52 | 8 / 0.570 | 0% |
| random | 60 | 47% | 58% | 17% | 27293 | 3.87 | 0.58 | 5.10 | 2.47 | 12 / 0.153 | 0% |
| learned | 60 | 63% | 84% | 33% | 12433 | 1.77 | 0.70 | 1.77 | 0.43 | 4 / 0.192 | 0% |
| fly:connectome=l1-larva-winding2023-1 | 60 | 68% | 91% | 83% | 37127 | 6.15 | 0.80 | 8.35 | 3.98 | 1 / 0.006 | 0% |
| fly:connectome=l1-larva-winding2023-1+plastic | 60 | 68% | 91% | 83% | 37127 | 6.15 | 0.80 | 8.35 | 3.98 | 1 / 0.006 | 0% |
| fly:connectome=l1-larva-winding2023-1+learning | 60 | 57% | 76% | 17% | 24120 | 4.02 | 1.02 | 6.05 | 1.65 | 1 / 0.027 | 0% |
| fly:connectome=l1-larva-winding2023-1+learning+plastic | 60 | 68% | 91% | 50% | 15600 | 1.50 | 0.50 | 1.50 | 0.33 | 1 / 0.000 | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+plastic | 60 | 68% | 91% | 100% | 29770 | 4.13 | 0.73 | 4.82 | 3.00 | 1 / 0.001 | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+learning+plastic | 60 | 67% | 89% | 83% | 34193 | 5.50 | 0.88 | 7.32 | 3.20 | 2 / 0.014 | 0% |
| fly:connectome=l1-larva-winding2023-1+random_degree+plastic | 60 | 67% | 89% | 100% | 26733 | 3.85 | 0.68 | 4.82 | 2.28 | 1 / 0.000 | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+plastic | 60 | 68% | 91% | 83% | 37127 | 6.15 | 0.80 | 8.35 | 3.98 | 1 / 0.006 | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+plastic | 60 | 72% | 96% | 83% | 36393 | 6.02 | 0.82 | 8.28 | 3.90 | 1 / 0.005 | 0% |
| fly:connectome=l1-larva-winding2023-1+signless+plastic | 60 | 68% | 91% | 83% | 37127 | 6.15 | 0.80 | 8.35 | 3.98 | 1 / 0.005 | 0% |
| fly:connectome=l1-larva-winding2023-1+norecurrence+plastic | 60 | 67% | 89% | 67% | 33407 | 5.32 | 0.97 | 6.72 | 2.90 | 2 / 0.023 | 0% |

> **Constant-policy warning:** fly:connectome=l1-larva-winding2023-1, fly:connectome=l1-larva-winding2023-1+plastic, fly:connectome=l1-larva-winding2023-1+learning, fly:connectome=l1-larva-winding2023-1+learning+plastic, fly:connectome=l1-larva-winding2023-1+shuffled+plastic, fly:connectome=l1-larva-winding2023-1+random_degree+plastic, fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+plastic, fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+plastic, fly:connectome=l1-larva-winding2023-1+signless+plastic made the same primary decision for every fixture. Their accuracy numbers reflect how a fixed policy interacts with the fixture mix, not task-dependent routing — treat them as uninformative until task sensitivity is > 0.

## Training curves (epochs=8, train seeds 1001,1002,1003 — disjoint from evaluation seeds)

- learned: e1 53% → e2 67% → e3 67% → e4 68% → e5 72% → e6 70% → e7 70% → e8 70%
- fly:connectome=l1-larva-winding2023-1+plastic: e1 53% → e2 55% → e3 53% → e4 55% → e5 55% → e6 55% → e7 55% → e8 55%
- fly:connectome=l1-larva-winding2023-1+learning: e1 62% → e2 65% → e3 55% → e4 55% → e5 67% → e6 65% → e7 55% → e8 55%
- fly:connectome=l1-larva-winding2023-1+learning+plastic: e1 58% → e2 68% → e3 70% → e4 72% → e5 70% → e6 70% → e7 70% → e8 70%
- fly:connectome=l1-larva-winding2023-1+shuffled+plastic: e1 65% → e2 65% → e3 65% → e4 65% → e5 65% → e6 65% → e7 65% → e8 65%
- fly:connectome=l1-larva-winding2023-1+shuffled+learning+plastic: e1 62% → e2 62% → e3 72% → e4 72% → e5 70% → e6 72% → e7 68% → e8 73%
- fly:connectome=l1-larva-winding2023-1+random_degree+plastic: e1 52% → e2 52% → e3 52% → e4 52% → e5 52% → e6 52% → e7 52% → e8 52%
- fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+plastic: e1 55% → e2 55% → e3 55% → e4 55% → e5 55% → e6 55% → e7 55% → e8 55%
- fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+plastic: e1 60% → e2 60% → e3 60% → e4 60% → e5 60% → e6 60% → e7 60% → e8 60%
- fly:connectome=l1-larva-winding2023-1+signless+plastic: e1 60% → e2 65% → e3 65% → e4 65% → e5 65% → e6 65% → e7 65% → e8 65%
- fly:connectome=l1-larva-winding2023-1+norecurrence+plastic: e1 55% → e2 55% → e3 55% → e4 55% → e5 55% → e6 55% → e7 55% → e8 55%

## fly:connectome=l1-larva-winding2023-1+plastic vs fly:connectome=l1-larva-winding2023-1+shuffled+plastic (paired, n=60)

- termination-accuracy difference: 0.0 pts, permutation p = 1.000
- token difference: 7357, permutation p = 0.026
- primary-action JS divergence: 1.000 bits  ·  identical decisions: 0%

**Distinguishable** on at least one primary metric at p<0.05.

## Primary action distribution

| planner | increase_pack_size | invoke_reviewer | merge_results | request_artifact_investigation | request_human_approval | retry_new_approach | run_tests | run_tool | search_memory | spawn_subrite | surface_uncertainty | terminate_blocked | terminate_success |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rules | 0% | 0% | 0% | 25% | 10% | 0% | 10% | 10% | 0% | 20% | 5% | 10% | 10% |
| random | 7% | 10% | 8% | 5% | 3% | 7% | 7% | 7% | 10% | 7% | 12% | 8% | 10% |
| learned | 5% | 0% | 5% | 0% | 0% | 5% | 0% | 0% | 0% | 85% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1 | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+plastic | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+learning | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+learning+plastic | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+plastic | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+learning+plastic | 0% | 0% | 0% | 40% | 0% | 0% | 0% | 60% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+random_degree+plastic | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 100% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+plastic | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+plastic | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+signless+plastic | 0% | 0% | 0% | 100% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+norecurrence+plastic | 0% | 0% | 0% | 35% | 0% | 0% | 0% | 0% | 0% | 65% | 0% | 0% | 0% |

## By category (termination accuracy)

| planner | repo_question | small_bug_fix | ambiguous_failure | misleading_hypothesis | multi_file_impl | security_sensitive | research_synthesis | needs_runtime_check | genuinely_blocked | stop_early |
|---|---|---|---|---|---|---|---|---|---|---|
| rules | 83% | 83% | 83% | 50% | 67% | 50% | 100% | 100% | 100% | 100% |
| random | 67% | 83% | 50% | 17% | 50% | 50% | 50% | 83% | 0% | 17% |
| learned | 100% | 100% | 67% | 33% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1 | 100% | 83% | 83% | 83% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+plastic | 100% | 83% | 83% | 83% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+learning | 100% | 100% | 33% | 17% | 83% | 33% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+learning+plastic | 100% | 100% | 100% | 50% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+plastic | 100% | 67% | 83% | 100% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+shuffled+learning+plastic | 100% | 100% | 67% | 83% | 83% | 50% | 100% | 83% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+random_degree+plastic | 100% | 100% | 67% | 100% | 67% | 33% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:MBIN+plastic | 100% | 83% | 83% | 83% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+ablate=flag:KC+plastic | 100% | 100% | 83% | 83% | 100% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+signless+plastic | 100% | 83% | 83% | 83% | 83% | 50% | 100% | 100% | 0% | 0% |
| fly:connectome=l1-larva-winding2023-1+norecurrence+plastic | 100% | 100% | 83% | 67% | 83% | 33% | 100% | 100% | 0% | 0% |

