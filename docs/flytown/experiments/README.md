# FLYTOWN experiment log

All runs below use the deterministic **mock worker world** (`src/flytown/eval/mock-rite.ts`), not live models. The mock is a toy: it tests whether a planner's decisions are *consequential and comparable*, not whether they are good in the real world. Live evaluation is a separate, later step.

Connectome: `fafb-v783-projectome-1` — FlyWire FAFB materialization 783 collapsed to 79 neuropil-level nodes (78 regions + `UNASGD`), 3,509 edges, 54.5M synapses, built by `connectome-etl/build.py` from the Zenodo archival release (MD5-verified). See `connectome/fafb-v783-projectome-1/manifest.json` for every preprocessing assumption and its provenance tag.

Fixtures: 20 tasks over four real local repositories, ten categories (`src/flytown/eval/fixtures.ts`). Seeds: 1–3 evaluation, 1001–1003 training. Every planner sees identical fixtures, seeds, budgets and the same action→Plan compiler.

## 2026-09-11 — first matched runs (Milestone 2 prototype)

### Run 1 — saturating dynamics (`run1-saturating-dynamics.md`)

Engine defaults at the time: transient input (3 of 12 steps), gain 1.5 on an in-L1-normalised matrix.

**Every fly variant was a constant policy.** `fly` chose `retry_new_approach` for 100% of fixtures, `fly:random_degree` chose `spawn_subrite` 100%, `fly:shuffled` halted 100%. Activity either saturated every reachable node (gain ≫ 1, real/rewired graphs) or died once the transient input stopped (shuffled labels moved the input off the high-recurrence regions). Accuracy numbers in that run are artefacts of a fixed policy meeting the fixture mix and are **uninformative**. The harness now prints a constant-policy warning and a task-sensitivity column so this cannot hide again.

### Run 3 — contractive dynamics, no learning (`run3-contractive-dynamics.md`)

Fix (ENGINEERING_CHOICE, documented in `engine.ts`): sustained input, gain 0.9 → contraction → unique graded fixed point; readout sees the max-normalised activity pattern; quiescence bonus removed.

| planner | termination acc | task-sensitivity (distinct primaries / JS bits) |
|---|---|---|
| rules | 82% | 8 / 0.570 |
| random | 47% | 12 / 0.153 |
| fly | 52% | 3 / 0.048 |
| fly:shuffled | 38% | 4 / 0.126 |
| fly:random_degree | 47% | 7 / 0.067 |
| fly:norecurrence | 65% | 3 / 0.118 |
| fly:noself | 63% | 3 / 0.055 |

- **fly vs fly:shuffled: 13.3 pts, permutation p = 0.060 — not distinguishable at p < 0.05.**
- The rules baseline beats every fly variant.
- Decisions *are* anatomically interpretable: real wiring → `search_memory` 80% (AL → MB calyx pathway dominates); ablating the mushroom body → `request_artifact_investigation` 65% (AL → lateral horn takes over); ablating the central complex barely changes anything. The AL→calyx vs AL→lateral-horn split is real anatomy and the readout reflects it. Interesting, but it is a property of the *graph's attractor*, not of task-dependent routing.

### Run 5 — with training (`run5-learning-epochs8.md`)

8 training epochs on disjoint seeds, REINFORCE-style readout update (`adapters.applyReward`) with softmax exploration during training only; evaluation greedy. The small learned router (baseline #3) trains the same way.

| planner | termination acc | task-sensitivity |
|---|---|---|
| rules | 82% | 8 / 0.570 |
| learned (trained) | 63% | 4 / 0.192 |
| fly:learning | 67% | **1 / 0.018 — constant policy** |
| fly:shuffled+learning | 65% | 2 / 0.038 |
| fly:random_degree+learning | 52% | 5 / 0.025 |
| fly:ablate=MB+learning | 70% | 2 / 0.020 |

- **fly:learning vs fly:shuffled+learning: 1.7 pts, permutation p = 1.0 — not distinguishable.**
- Learning drives the fly planner *toward* a constant policy rather than away from it.

(An earlier learning run with a taken-action-only update and no exploration made every learner worse over epochs; that was a bug in our rule, not a finding, and is not reported as one.)

### Why: the projectome washes the task out

Mean pairwise Jensen–Shannon divergence across the 20 fixtures at each stage of the fly pipeline (bits; 0 = every task looks identical):

| stage | real graph | shuffled labels |
|---|---|---|
| raw feature vector | 1.816 | 1.816 |
| encoder input (what enters the graph) | 0.270 | 0.270 |
| fixed-point activity (what leaves the graph) | **0.032** | 0.119 |
| action scores | 0.048 | 0.126 |

The real region-level graph reduces task information ~8× more than a label-shuffled copy of itself. Its strongest structures — optic-lobe self-recurrence (ME→ME alone is 15M synapses), AL→MB/LH, the GNG hub — form an attractor that every input relaxes into. This is exactly the Option-A limitation the proposal flagged ("loses sparse neuron-level computation; risks becoming a themed state machine"), now measured.

### Verdict for Milestone 2

The falsification test from the proposal (Section 25) was run. **Under this harness, the real region-level topology contributes nothing measurable over a shuffled graph**, with or without adapter learning. This is reported as the result.

What it does *not* say: it does not test neuron-level sparse coding (Kenyon cells), which is where the biology actually implements task-specific, high-dimensional representations, and which a 79-node projectome cannot express by construction. It also uses hand-set metaphorical adapters and a toy worker world.

### Next (Milestone 3 direction)

1. **Move the sensory/associative stage to neuron level** (`fafb-v783-neuron-1`, already built: 139,255 neurons, 15.1M edges): project task features onto antennal-lobe projection neurons → Kenyon cells (sparse, ~5% active) → MBONs, with the projectome only for everything downstream. This is the biological substrate for task-specific codes; the region-level result predicts it is necessary.
2. Read out earlier transients (`insteps`, `steps` flags) rather than only the fixed point, and let the encoder gain compete with recurrence — cheap checks of whether the attractor can be kept from dominating at region level.
3. Keep every null model and the task-sensitivity statistic in the loop; a fly planner that is not task-sensitive is not a router, whatever its accuracy.

Reproduce: `flytown fly eval --planners "rules,random,fly,fly:shuffled" --seeds 3` and `--epochs 8 --planners "learned,fly:learning,fly:shuffled+learning" --compare "fly:learning,fly:shuffled+learning"`.
