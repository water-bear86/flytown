# FLYTOWN experiment log

> **Names:** on 2026-09-12 FLYTOWN replaced every inherited Goblintown term (goblin, troll, rite, hoard, warren, …) with the swarm vocabulary in [`docs/flytown/VOCABULARY.md`](../VOCABULARY.md). Sections that record work done before the rename keep the names that were true at the time; all current-behaviour descriptions use the new ones. **Every entry in this log except the action-effect audit — each dated section, and the Milestone 3 protocol with its larva runs, all written on 2026-09-11 and 2026-09-12 — is a pre-rename record:** those runs used the Goblintown worker prompts, and their write-ups keep the names of that time (`spawn_subrite`, rites, troll, ogre, `warren.json`, …). Today the same things are `spawn_flight`, flights, guard, soldier and `terrarium.json`.

The Milestone 2 and Milestone 3 runs below use the deterministic **mock worker world** (`src/flytown/eval/mock-flight.ts`), not live models. The mock is a toy: it tests whether a planner's decisions are *consequential and comparable*, not whether they are good in the real world. The entries marked LIVE ran the real pipeline against real models; the mushroom-body memory entry makes no model calls at all.

Connectome: `fafb-v783-projectome-1` — FlyWire FAFB materialization 783 collapsed to 79 neuropil-level nodes (78 regions + `UNASGD`), 3,509 edges, 54.5M synapses, built by `connectome-etl/build.py` from the Zenodo archival release (MD5-verified). See `connectome/fafb-v783-projectome-1/manifest.json` for every preprocessing assumption and its provenance tag.

Fixtures: every entry below used task suite **v1**: 20 tasks over four repositories on the author's machine, two of them private, ten categories. Seeds: 1–3 evaluation, 1001–1003 training. Every planner sees identical fixtures, seeds, budgets and the same action→Plan compiler.

> **Suite change, 2026-09-12.** v1 could not be reproduced anywhere else. From now on evaluations use suite **`public-v2`** (`src/flytown/eval/fixtures.ts`): 20 tasks over two public repositories pinned to exact commits, `Runechain/blockmmo@e2450b77e2b3` and `water-bear86/flytown@7557dd0bc13a`, fetched with `flytown fly fixtures fetch`. v2 keeps the ten categories, two tasks each, and the same mock-world difficulty settings, but ten tasks moved to new repositories and several were reworded so their premises hold in the pinned code; renamed ids mark the changed tasks. v1 and v2 results are not directly comparable, and no v2 result exists yet. The v1 fixture definitions remain in git history for anyone re-running v1 on its original machine.

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

## Milestone 3 protocol — larval brain, pre-registered (written before the artifact existed)

Substrate: `l1-larva-winding2023-1` — the complete first-instar larval brain (Winding et al. 2023; 3,016 neurons, ~548k synapses, four synapse-type channels), simulated whole at single-neuron resolution. No region collapse anywhere.

What is biology here, and what is not:

| component | tag |
|---|---|
| neuron identities, all edges, synapse-type split (a-d, a-a, d-d, d-a) | MEASURED |
| which edges are KC→MBON (the plastic site), which neurons are DANs, which MBON compartments each DAN innervates | MEASURED (from the graph + annotation tables) |
| DAN valence (appetitive pPAM vs aversive DL1 clusters) | INFERRED_FROM_LITERATURE (Saumweber 2018, Eschbach 2020 — optogenetic substitution, not connectomics) |
| the plasticity rule: co-active KC + dopaminergic drive to a compartment → depression of that KC→MBON synapse, Δw = −a·e_KC·R_DAN | INFERRED_FROM_LITERATURE (Eschbach 2020; Jürgensen 2024) |
| signs: KCs cholinergic (+), APL GABAergic (−), DANs modulatory (0), a few MBONs; everyone else +1 magnitude-only | INFERRED_FROM_LITERATURE for the listed classes; ENGINEERING_CHOICE default — **no neurotransmitter dataset exists for the larva** |
| reward delivery: reward ≥ 0.5 → appetitive DAN set with strength 2(r−0.5), else aversive; one-hop DAN→MBON drive; eligibility = KC activity at decision time; slow recovery toward 1; floor 0.05 | ENGINEERING_CHOICE |
| encoder (task → olfactory / gustatory / nociceptive / visual / mechanosensory neurons) and readout (descending, SEZ, ring-gland, MBON, LHN, CN classes → actions) | METAPHOR (literal for "odour" and "sugar/bitter", still a mapping we chose) |
| propagation dynamics | ENGINEERING_CHOICE (same contractive engine as the projectome) |

Planners to compare, all with identical fixtures/seeds/compiler:

- `rules`, `random`, `learned` (trained) — non-biological baselines
- `fly:connectome=l1-larva-winding2023-1` — untrained, no plasticity
- `…+plastic` — synaptic plasticity only (adapters fixed): **the key condition** — does DAN-gated depression at the real KC→MBON synapses make routing reward-sensitive and task-dependent?
- `…+learning` — adapter learning only (our REINFORCE readout)
- `…+learning+plastic` — both
- `…:shuffled+plastic`, `…:random_degree+plastic` — null models with the *same* plasticity machinery operating on scrambled labels / rewired edges
- `…:ablate=flag:KC+plastic`, `…:ablate=flag:MBIN+plastic` — lesion the plastic site / the dopaminergic neurons
- `…:signless+plastic`, `…:norecurrence+plastic`

Primary pre-registered comparisons (paired permutation, n = fixtures × seeds):

1. `plastic` vs `shuffled+plastic` on termination accuracy — the falsification test for the larval wiring.
2. `plastic` vs untrained — does plasticity help at all?
3. `plastic` vs `ablate=flag:MBIN+plastic` — does the effect run through the dopaminergic neurons (it must, or the "biology" is decorative)?
4. Task sensitivity (distinct primaries / mean pairwise JS bits) for every fly variant — a constant policy is disqualifying regardless of accuracy.

Decision rule stated in advance: if (1) is not significant at p < 0.05 with the mock world and 3+ seeds, the larval wiring is reported as *not shown to matter* under this harness, exactly as the projectome was. If (1) is significant but (3) is not, the effect is not dopaminergic and the biological framing is withdrawn.

### Larva run 1 — pre-registered result: **null** (`2026-09-11-larva-run1-preregistered.md`)

Artifact `l1-larva-winding2023-1`: 2,952 neurons, 110,677 edges, 2,746 KC→MBON synapses designated plastic, 2 appetitive / 6 aversive DANs. 8 training epochs, 3 evaluation seeds, 20 fixtures.

| comparison | termination acc | p |
|---|---|---|
| (1) `plastic` vs `shuffled+plastic` | 68% vs 68% | **1.000** |
| (2) `plastic` vs untrained | 68% vs 68%, 80% identical decisions | 1.000 |
| (3) `plastic` vs `ablate=flag:MBIN+plastic` (no dopaminergic neurons) | 68% vs 68% | 1.000 |
| `learning+plastic` vs `shuffled+learning+plastic` | 68% vs 67% | 1.000 |
| `learning+plastic` vs `rules` | 68% vs 82% | 0.177 |

(4) Task sensitivity: every larval variant except `norecurrence` and `shuffled+learning+plastic` was a **constant policy** (1 distinct primary action). The plastic-only training curves are flat across all 8 epochs for every variant.

**By the pre-registered rule this is a null result, and the biological framing is withdrawn for this configuration.** The one "significant" number — `learning+plastic` beating `learning` alone (68% vs 57%, p = 0.018) — is a comparison between two constant policies that happened to pick different single actions, and is disqualified by rule (4).

Diagnostics run afterwards (`scratchpad/larva-diag.mjs`), to separate "biology has no effect" from "our pipeline cannot transmit it":

- Plasticity *did* fire: direct DAN→MBON wiring exists (1,089 a-d synapses; appetitive DANs drive 9 MBON compartments, aversive drive 27) and each reward depressed ~821 of the 2,746 plastic synapses, several to the floor. Not a dead pathway.
- **Every Kenyon cell was active on every task (144/144 above 5% of max).** The rectified-tanh rate model has no firing threshold, so the KC code is dense, and dense eligibility means the same synapses are depressed whatever the task — association-specific learning is impossible by construction. Real KC coding is ~5–10% sparse, enforced by high thresholds and APL feedback inhibition (Turner, Bazhenov & Laurent 2008; Lin et al. 2014; the fly-hashing model of Dasgupta, Stevens & Navlakha 2017). Our engine lacked this.
- Even forcing *all* plastic synapses to the floor moved mean MBON activity 0.122 → 0.033 but the top action score only 0.166 → 0.177: the readout normalises against the sensory neurons (which carry the maximum activity), so internal populations sit in a compressed range where MBON changes barely register.

So run 1 falsifies "this pipeline, as pre-registered". It does not yet test the sparse-code hypothesis, because the pipeline never produced a sparse code. Run 2 below adds exactly that ingredient and is labelled post-hoc.

### Larva run 2 — post-hoc (changes made *after* seeing run 1's diagnostics)

Every change is an engineering choice about our adapters/engine, not a change to the connectome, the plastic site, the DAN valences or the rule. Listed so the reader can judge how much the pipeline was tuned:

1. **KC sparse coding** — k-winners-take-all keeps the 10% most active Kenyon cells per step (`engine.ts` `sparseGroups`, default `flag:KC@0.1`), with n/k gain compensation on their outgoing weights so the winners carry the population's drive under L1 normalisation. Literature: KC sparseness ~5–10% (Turner et al. 2008; Lin et al. 2014; Dasgupta et al. 2017). Ablation available as `+nosparse`.
2. **Odour identity encoding** — task keywords *and* the deliverable kind each activate a hashed 15% subset of olfactory receptor neurons (`keywordOdor`); the uniform "intensity" drive to all ORNs was cut from 0.4–0.9 to 0.15. Diagnostic effect: mean pairwise KC-set overlap across fixtures 0.86 → 0.23.
3. **Readout normalisation** — by the maximum over the readout populations, not the whole brain (the sensory neurons carried the maximum and compressed every internal population).
4. **Per-neuron readout weights** (learned, empty at init) inside the readout populations, so learning can address *which* output neurons are active.
5. **MBON valence in the readout** — the artifact ships Eschbach et al. 2020's approach/avoidance MBON annotations (`class2:app` 16, `class2:av` 12, `class2:neith` 8). Avoidance-driving MBONs feed `retry_new_approach` / `surface_uncertainty` / `terminate_blocked`; approach-driving MBONs feed `spawn_subrite` / `increase_pack_size` (tagged INFERRED_FROM_LITERATURE for the valence, METAPHOR for the action mapping). Checked against the measured wiring first: appetitive DANs drive avoidance-MBON compartments almost exclusively (drive-weighted 1.89 av vs 0.01 app) and aversive DANs drive approach-MBON compartments (5.28 app vs 0.05 av) — the connectome reproduces the textbook valence-inversion circuit, so reward depresses avoidance and punishment depresses approach for the rewarded task's KC code.
6. Spec-parser fix (`ablate=flag:KC` was truncated at the second colon).

Untrained sanity after these changes (`fly sensitivity`): real larva 2 distinct primaries, final-activity JS 0.070 bits; shuffled larva 1 primary, 0.055 bits. Same planners, seeds, fixtures, epochs and comparisons as run 1.

#### Run 2 results (`2026-09-11-larva-run2-posthoc.md`)

| planner | termination acc | task-sensitivity |
|---|---|---|
| rules | **82%** | 8 / 0.570 |
| learned (trained) | 63% | 4 / 0.192 |
| larva, untrained | 67% | 2 / 0.013 |
| larva `+plastic` | 72% | 2 / 0.014 |
| larva `+learning` | 57% | 1 / 0.059 (constant) |
| larva `+learning+plastic` | 68% | 2 / 0.101 |
| larva `+shuffled+plastic` | 72% | 1 / 0.002 (constant) |
| larva `+shuffled+learning+plastic` | 60% | 2 / 0.055 |
| larva `+random_degree+learning+plastic` | 68% | 1 / 0.000 (constant) |
| larva `+ablate=flag:MBIN+learning+plastic` (no dopaminergic neurons) | 57% | 1 / 0.000 (constant) |
| larva `+ablate=flag:KC+learning+plastic` | 62% | 2 / 0.119 |
| larva `+nosparse+learning+plastic` | 78% | 2 / 0.325 |

Paired permutation tests (n = 60 each; nine comparisons, so treat p ≈ 0.01–0.06 as suggestive — a Bonferroni threshold would be ≈ 0.006 and **nothing below clears it**):

| comparison | acc | p |
|---|---|---|
| (1) pre-registered primary: `plastic` vs `shuffled+plastic` | 72% vs 72% | **1.000 — null again** |
| (2) `plastic` vs untrained | 72% vs 67% | 0.248 |
| `learning+plastic` vs `shuffled+learning+plastic` | 68% vs 60% | 0.061 |
| (3) `learning+plastic` vs DAN-lesioned `ablate=flag:MBIN+learning+plastic` | 68% vs 57% | 0.017 |
| `learning+plastic` vs `learning` (plasticity removed) | 68% vs 57% | 0.014 |
| `learning+plastic` vs `nosparse+learning+plastic` | 68% vs **78%** | 0.030 (sparsening *hurts*) |
| `learning+plastic` vs `random_degree+learning+plastic` | 68% vs 68% | 1.000 |
| `learning+plastic` vs `learned` baseline | 68% vs 63% | 0.254 |
| `learning+plastic` vs `rules` | 68% vs 82% | 0.177 |

**Reading, in order of confidence:**

1. The pre-registered primary test is null for the second time: with plasticity alone, the real larval wiring is not distinguishable from a label-shuffled copy (p = 1.0). Plastic-only training curves are flat — the KC→MBON rule learns stimulus valence, not action selection, and nothing in this pipeline turns valence into a better plan without the learned readout.
2. Two comparisons point the way the biology predicts — adding the plasticity channel to adapter learning helps (p = 0.014) and lesioning the dopaminergic neurons hurts (p = 0.017) — but neither survives correction for the nine tests run, both involve a constant-policy comparator, and the shuffled-wiring control with the same learning is only borderline worse (p = 0.061). **Suggestive, not evidence.**
3. Contrary to the sparse-coding hypothesis, *removing* KC sparsening gave the best larval variant (78%, and the highest task sensitivity of any fly planner). A plausible reason is specific to this harness: mock-world reward depends on the fixture's *category* (its traps), so a code that generalises across tasks of a kind beats one that treats every keyword set as a distinct odour. That is a statement about the evaluation world as much as about the brain.
4. Every biological variant remains below the hand-written rules baseline (82%), and every fly planner is far less task-sensitive (≤ 0.33 bits, 1–2 distinct primary actions) than rules (0.57 bits, 8).

## 2026-09-12 — first LIVE run (`2026-09-12-live-run1-deepseek.md`)

Real Goblintown pipeline (Raccoon → pack ≤ 2 → Gremlin → Troll → Specialists → Ogre → Scribe) on DeepSeek `deepseek-v4-flash` with thinking disabled (`provider.requestParams: {"thinking":{"type":"disabled"}}` — with thinking on, hidden reasoning ate the whole output budget and every goblin failed troll review; that aborted first attempt is not reported as a result). 10 fixtures (one per category), 1 seed, four planners run concurrently, caps: 700 output tokens/call, 60k tokens/plan, 2.5M tokens total. Learnable planners were trained 8 epochs in the mock world, then evaluated live ("sim-to-real"). 2,570,445 tokens, 69 minutes; the ceiling cut the last three `llm` runs (all three of its non-"complete" fixtures, so its termination behaviour on blocked/stop-early tasks went unmeasured).

| planner | termination acc | mean tokens / plan | mean rites | task-sensitivity |
|---|---|---|---|---|
| `llm` (Goblintown's own planner) | 100% (7/7 measured, all "complete" tasks) | 122,539 | 4.3 | constant (spawn 100%) |
| `rules` | **90%** | 60,180 | 2.1 | 7 / 0.588 |
| larva `+learning+plastic` (mock-trained) | 80% | **26,280** | 1.1 | constant (spawn 100%) |
| larva `+shuffled+learning+plastic` (mock-trained) | 80% | 84,807 | 3.0 | constant (investigate 100%) |

Paired, n = 10: real larva vs shuffled larva — termination accuracy 0.0 pts, **p = 1.000**; tokens −58,527, p = 0.002.

Reading:

1. **The pre-registered null holds live.** The real larval wiring is not distinguishable from its shuffled copy on termination accuracy. The token difference is real but uninteresting: both planners transferred a *constant policy* from mock training — the real graph learned "one node, spawn", the shuffled graph learned "investigate → main → synthesize" — and a one-node plan is cheaper. That is not routing.
2. **Neither larval planner ever halts.** Both "completed" `blocked-credentials` (a task that should be declared blocked) and `stop-already-done`; Goblintown dutifully produced answers. Only `rules` handled blocked / approval / stop-early correctly (100% on those; its one miss was halting `sec-input-sanitize` for approval, which is defensible).
3. **Goblintown's troll-gated "success" is not a discriminative quality measure live.** Every planner reached success on every completable task, usually via specialist recovery or the ogre fallback — the pipeline's own recovery machinery is strong enough to rescue almost any plan shape. The recorded final claims show the quality variance the harness cannot see: on `q-engine-layout` the real larva's single rite concluded "the repository does not contain a game loop" while the shuffled larva's three-rite plan located the `requestAnimationFrame` loop in `index.html` and entity ticking in `engine/`. Cheaper was worse there; the metric said both succeeded.
4. **The conventional LLM planner is thorough and expensive**: 4–5 nodes per task, 2–5× the tokens of the others, and it has no halt vocabulary at all (it decomposes everything). It is the commercially relevant baseline and it did not lose on anything it was measured on.
5. Sim-to-real transfer of mock-trained adapters carried the mock world's degeneracy into production; live reward never touched the planners in this run.

What this run bought: the full loop — real workers, real repositories, real model cost — runs end to end under hard caps with replayable traces, and the numbers are honest. What it did not buy: any evidence for the biology. Next, in order: (a) an LLM-judge quality score per fixture (the troll gate is not enough), (b) more than one seed and the full fixture set within budget (drop `llm`'s pack size or nodes), (c) live reward feeding the adapters instead of mock-only training — and (d) the standing recommendation stays: do not tune adapters post-hoc against these results.

## 2026-09-12 — LIVE run 3: rules vs Goblintown's LLM planner, full suite (`2026-09-12-live-run3-rules-vs-llm.md`)

The product question, properly powered: all 20 fixtures × 2 seeds, real workers, LLM judge, 6.88M tokens, 179 minutes, preflight passed (`deepseek-v4-flash`, `thinking: disabled`). 3 transient connection errors (8% of `llm` runs) are the only losses.

**A void run preceded this one and is not reported as data.** A running FLYTOWN server had re-saved `warren.json` and dropped the provider's `requestParams`; with DeepSeek's hidden reasoning re-enabled it consumed the whole 700-token output cap, every worker returned empty, the troll rejected everything, and the harness produced a plausible-looking table (`rules 0.29`, `llm 93% errors`) from 400k tokens of garbage. Live runs now gate on a provider smoke test and record the resolved provider in the report.

| planner | quality (judge) | termination | tokens / plan | rites |
|---|---|---|---|---|
| `rules` | 0.55 | 95% | **66,838** | 2.10 |
| `llm` | 0.41 | 81% | 109,813 | 3.84 |

Paired over all 37 usable pairs: quality +0.105 (p = 0.146), termination +13.5 pts (p = 0.182), tokens −37,556 (**p < 0.0001**). Decomposed by what the fixture asks for:

| subgroup | n | termination | quality | tokens |
|---|---|---|---|---|
| tasks that should be **completed** | 30 | −6.7 pts (p = 0.50) | **+0.010 (p = 0.89)** | −28,021 (p = 0.0001) |
| tasks whose right answer is to **stop** | 7 | **+100 pts, 7/7 pairs (p = 0.015)** | +0.514 (p = 0.065) | −78,420 (p = 0.015) |

**This corrects the overstatement in live run 2.** At n = 10 on a 10-fixture subset, `rules` looked much better on quality (0.69 vs 0.39). With the full suite and twice the seeds, quality on completable tasks is **dead even** (+0.010, p = 0.89) — the earlier gap was small-sample noise, exactly what the ≈0.15-at-n=20 noise floor predicted.

What survives is sharper and more useful than the version that didn't:

1. **Cost, robustly.** 39% fewer tokens per plan overall (p < 0.0001) and 28k fewer on completable tasks *at equal quality* — 2.1 rites against 3.84, because the LLM planner decomposes everything into four nodes.
2. **Knowing when to stop.** On the 7 pairs where the correct answer is "blocked", "needs approval" or "already done", `rules` won every single one. The LLM planner chose `spawn_subrite` for 100% of all fixtures — it has no halt vocabulary at all, so it cannot express "don't do this". This was the mechanism identified in run 2, so testing it here is confirmatory rather than fishing; at 7/7 with p = 0.015 it is the strongest single result in the project so far.
3. Quality overall: directional only (+0.105, p = 0.15). Not claimed.

**Acted on:** `rules` is now the default planner (`DEFAULT_PLANNER` in `src/flytown/registry.ts`, with these numbers in the comment). `--planner llm` is one flag away and the LLM planner remains the fallback for every fly variant.

## 2026-09-12 — giving the fly a different job: the mushroom body as a task memory (`2026-09-12-mushroom-body-memory.md`)

Three configurations had put the connectome in the per-task *decision* seat and found the same null. The diagnosis was that the job was wrong, not the graph: action selection needs task-dependent output, and a fixed-point readout of a recurrent graph is nearly task-invariant. Associative memory is the job this circuit demonstrably has, and it comes with a precise, falsifiable claim from the literature — Kenyon-cell sparse codes are a locality-sensitive hash, so an association learned at KC→MBON synapses for one odour generalises to similar odours (Dasgupta, Stevens & Navlakha, *Science* 2017).

Two model-free experiments (80 authored tasks over the same ten categories, no model calls, `src/flytown/memory.ts` + `eval/hash-experiment.ts`), each run on the real larval graph and on label-shuffled and degree-preserving-rewired copies:

1. **Is the KC code a locality-sensitive hash of tasks?** AUC of same-category vs cross-category code similarity; Spearman correlation between code similarity and input-space (keyword) similarity; collision rate.
2. **Does a stored association generalise?** Train on half of each category, test recall's sign on the held-out half.

**Two defects in our own pipeline surfaced first, and both had to be fixed before the test meant anything:**

- **Receptor saturation.** Every task was activating *all 42* larval olfactory receptors identically (measured receptor overlap 1.000), because the planner's encoder sends a uniform "stimulus intensity" term to the whole receptor population. The odour carried no task identity at all, so the first run's numbers were meaningless. The memory path now drives receptors only through the keyword odour code (overlap 0.10–0.48 depending on sparseness), and odour sparseness is swept rather than chosen.
- **Wrong circuit shape.** The fly-hashing claim is about a *feedforward* three-layer circuit; we were reading Kenyon cells at the fixed point of a whole-brain recurrent simulation, where activity from everywhere floods them. `FlyMemory` now walks the measured pathway one hop at a time (sensory → projection neurons → Kenyon cells → k-WTA). This helped the real graph materially (AUC 0.538 → 0.594 at the original odour setting) but did not change the conclusion.

**Result (feedforward, odour sparseness swept 0.024 → 0.15):**

| | real | shuffled | rewired |
|---|---|---|---|
| AUC, same vs cross category | 0.594–0.649 | **0.680–0.740** | 0.567–0.688 |
| Spearman, code vs input similarity | 0.10–0.18 | 0.15–0.19 | 0.09–0.21 |
| collision-free codes | **100% at every setting** | 51–89% | 74–99% |
| held-out sign accuracy | 45–50% | 23–26% | 45–53% |
| p (retrieved sign better than chance) | ≥ 0.63 | — | ≥ 0.25 |

**The locality-sensitive-hash claim does not transfer to this circuit as implemented.** The real larval ORN→PN→KC pathway separates task categories *worse* than a label-shuffled copy of the same graph at every odour setting (real minus shuffled: AUC −0.04 to −0.12), ties the degree-preserving rewire, and its retrieved valence is at chance on held-out tasks. Shuffling in this artifact replaces the real pathway with a random projection through a random subgraph — i.e. the textbook LSH setup — so the honest reading is that a generic random projection is a better task hash here than the measured larval wiring.

The one respect in which the real wiring wins is **selectivity**: it is collision-free at every setting (100% distinct codes) where the shuffled graph collides on 11–49% of tasks. Its codes are more specific and less similarity-preserving — consistent with each larval KC sampling very few projection neurons, which makes winners flip on small input changes. That is a real property of the measured circuit, and it is the opposite of what a good LSH needs.

Also worth recording: retrieved valence shifts are tiny (mean |shift| ≈ 0.01), which is why the `rules+memory` planner's blend had to be calibrated with a gain of ~20 — and why the honest conclusion is that this memory carries very little signal, not that it needs more tuning.

**Where that leaves the fly.** Four falsification attempts across three roles (region-level decision, neuron-level decision with plasticity, associative memory) and no role yet in which the measured wiring beats its own null. The remaining untested ideas are narrower than "use the connectome for X": (a) the collision-freeness result suggests a *deduplication / novelty-detection* role rather than a similarity-retrieval one — "have I seen exactly this before" is what this code is good at; (b) an adult mushroom body has ~2,000 Kenyon cells against the larva's 144, and the hash's discriminative power is expected to scale with that dimensionality — the `fafb-v783-neuron-1` artifact exists but the runtime cannot load its binary graph yet. Both are pre-registerable. Neither is a reason to keep tuning the current one.

## 2026-09-12 — what the decisions change: action-effect audit (`flytown fly effects`)

The first entry written after the rename. Decide only, with no workers and no model calls: untrained planners with no stored weights, the 20 fixtures, seed 1. Reproduce with `flytown fly effects`; the output is identical from any directory.

**Why.** A decision lists every action scoring at least half the top score, but the compiler acts on only some of them: a halt only as the primary action, a retry only after a recorded failure, extra steps only under the node cap. The trace view showed the whole list, which made every planner look more influential than it was. Each selected action is now labelled *shaped* (changed the plan), *default* (the plan has it anyway) or *inert* (ignored by the compiler) in the trace view, the trace text and `/api/fly/plan`. A test checks every label against the plan the compiler actually builds.

| planner | primary: shaped / default / inert | actions selected | actions that shaped | plan = default plan | plan = rules' plan | halts | top-2 score gap |
|---|---|---|---|---|---|---|---|
| `rules` | 14 / 6 / 0 | 2.25 | 1.40 | 2 | — | 6 | 0.266 |
| `random` | 16 / 4 / 0 | 7.10 | 2.40 | 0 | 0 | 9 | 0.011 |
| `fly` (adult projectome) | 18 / 2 / 0 | 3.40 | 1.25 | 0 | 2 | 2 | 0.026 |
| `fly:shuffled` | 20 / 0 / 0 | 2.70 | 1.70 | 0 | 3 | 2 | 0.101 |
| larva `+plastic` | **0 / 15 / 5** | 3.90 | 1.00 | 4 | 1 | 0 | 0.034 |
| larva `+shuffled+plastic` | 0 / 20 / 0 | 2.05 | 0.45 | 14 | 2 | 0 | 0.091 |

The default plan is the one compiled when `spawn_flight` is the only action.

Reading:

1. **The untrained larval brain's primary action never changed a plan.** It chose `spawn_flight` on 15 fixtures, which every running plan has anyway, and `retry_new_approach` on the other 5, which does nothing without a recorded failure. Everything it contributed came from secondary actions: an investigation step on 16 fixtures, a verification step on 2 and debate on 2. It also selected `retry_new_approach` on all 20 fixtures and `terminate_blocked` on 13, and the compiler ignored every one of those.
2. **The real larval wiring changes more plans than its shuffled copy** (the default plan on 4 fixtures against 14). That is a difference, not an advantage: live run 2 found no quality or termination difference between the two, and the random baseline changes plans more than either.
3. **The adult projectome picks `search_memory` on 16 of 20 fixtures**, so it adds the same investigation step almost everywhere.
4. **The connectome planners decide by near-ties.** Their top two actions differ by 0.026–0.101 in normalised score, against 0.266 for `rules`.

**Correction to live run 1 ("replayable traces").** The fly planners' traces from live runs 1 and 2 cannot be replayed. The harness keeps mock-trained adapters and plastic state in memory and never writes them, so `fly replay` rebuilds untrained weights. None of the 60 fly traces from those runs replays identically, and 48 replay to a different decision even after old action names are mapped to new ones. Separately, fly planner ids did not round-trip through the spec parser, so replaying a shuffled, plastic or multi-region-ablated trace rebuilt a different brain; that is fixed. No reported number came from replay.

**Raw data.** The run directories behind live runs 1–3, the aborted first attempt and the void run (composts, per-decision traces, logs) had been written to `/tmp`. They are now preserved under `.flytown/live-warren/.flytown/eval-raw/`, which is local and not in git.

## 2026-09-12 — LIVE run 2 with the LLM judge (`2026-09-12-live-run2-judge.md`)

Same pipeline and provider as live run 1, plus: an LLM judge scoring every final output against a per-fixture rubric (rubrics written before any live output was inspected), online live reward for the learnable planners (after mock pre-training), the trained small learned router as a fifth planner, 2 seeds, `--max-nodes 4`. 100 runs, 5.24M tokens, 141 minutes; the 5M ceiling skipped `llm`'s two `stop-already-done` runs.

| planner | quality (judge, 0–1) | termination acc | tokens / plan | rites | task-sensitivity |
|---|---|---|---|---|---|
| `rules` | **0.69** | **100%** | 57,930 | 2.1 | 7 / 0.586 |
| `learned` (trained) | 0.59 | 70% | 43,664 | 1.8 | 2 / 0.295 |
| larva `+shuffled+learning+plastic` | 0.58 | 70% | 25,754 | 1.0 | constant |
| larva `+learning+plastic` | 0.44 | 70% | **25,689** | 1.0 | constant |
| `llm` (Goblintown's own planner) | 0.39 | 78% (18 measured) | 121,076 | 4.2 | constant |

Paired tests (n = 20 unless noted): real larva vs shuffled larva — quality −0.14, **p = 0.199**; termination 0.0 pts, p = 1.0; tokens −65, p = 0.96; **identical decisions 100%**. Larva vs rules: termination −30 pts, p = 0.031; tokens −32k, p = 0.009. Rules vs llm (n = 18): termination +22 pts, p = 0.126; tokens −57k, p < 0.001.

Reading:

1. **The null holds a third time, now on quality.** The real and shuffled larval brains made *literally the same decision on every task* (both collapsed to a one-node "spawn" policy, before and after 20 online reward updates), so their 0.14 quality gap is pure worker stochasticity on identical plans. That gap is also the most useful calibration number in the report: **quality differences below ~0.15 at n = 20 are noise**, whatever the planner.
2. **Live learning did not rescue task sensitivity.** REINFORCE over 13 actions from a few dozen noisy scalar rewards is far too little signal; the mock-pretrained constant policy survived intact. The learned linear router did marginally better (two actions) for the same reason.
3. **The hand-written rules router beat Goblintown's own LLM planner on every axis** — quality 0.69 vs 0.39, termination 100% vs 78%, cost 58k vs 121k tokens — and it is the only planner with any termination judgment. The judge's rationales show why the LLM planner loses: its 4-node decompositions routinely end in "blocked report, no code" outputs on implementation tasks (small-bug-fix and multi-file quality 0.00), while producing the best answers on the diagnosis-style tasks. That is a product finding about Goblintown, independent of any biology.
4. **Cheapest is not best:** the larva's one-node plans cost a fifth of the LLM planner's and scored higher on quality than it did, but lower than rules and the shuffled copy.

**Verdict for the connectome hypothesis after three live/mock configurations:** no evidence that the real wiring contributes to routing quality, termination or cost beyond what a label-shuffled copy of the same graph contributes; the dominant obstacle is now clear — every fly planner collapses to a constant policy, and neither DAN-gated plasticity nor reward-modulated readout learning, at the data volumes an orchestration loop can supply, breaks that symmetry. Continuing to tune adapters against this suite is not warranted.

**What is warranted (proposals, not decisions):** (a) ship `rules` as Goblintown's default planner — the one demonstrated, replicable improvement; (b) if the biology is kept, move it out of the per-task *decision* seat, where task-invariance is fatal, into roles that tolerate or exploit it — an associative memory over task→outcome (the mushroom body's actual job), or pack composition / exploration diversity — and pre-register a new falsification test for that role; (c) more seeds on the rules-vs-llm comparison before making the product claim loudly.

**Verdict for Milestone 3 as of 2026-09-11:** the larval substrate does not yet show a robust advantage over its own shuffled null model, in either the pre-registered or the post-hoc configuration. What it did show: (a) the pipeline now transmits biology end to end — sparse task-specific KC codes, DAN-gated depression at measured synapses, a valence circuit reproduced from the data — and each piece is ablatable; (b) two ablations behave as the biology predicts, at uncorrected p < 0.02; (c) the mock world is now the limiting factor. Next step is not more adapter tuning (each post-hoc round erodes evidential value) but a **live-model evaluation** on a fixed task suite with the same null models — the only way to learn whether any of this matters for real work.

## 2026-09-14 — the male fly (MaleCNS v1.0), pre-registered (written before any male artifact was built or any male result seen)

**Why now.** Public token projects claim a simulated *male* fly (Janelia FlyEM MaleCNS v1.0) launched and trades a token, and a fork claims the same of a *female* fly (FlyWire FAFB v783). Every adult result in this log already used the female brain: `fafb-v783-projectome-1` is FlyWire's adult female. This entry runs the same falsification tests on the male.

**Substrate.** MaleCNS v1.0 (Janelia FlyEM, Google, Cambridge Connectomics Group; CC-BY 4.0), flat-connectome release, pinned by the bucket's MD5 checksums: `syn-partners-male-cns-v1.0-minconf-0.5-traced-only.feather` (synapse pairs between traced bodies, with the ROI of each postsynaptic site), `body-annotations-male-cns-v1.0-minconf-0.5.feather`, `body-neurotransmitters-male-cns-v1.0.feather`. Built by `connectome-etl/build_male.py`.

**Two artifacts, built to match the female ones as closely as the data allow:**

1. `malecns-v1.0-projectome-1` — brain neuropils only, named and split exactly as FlyWire's (male ROIs mapped onto FlyWire neuropil names; the mapping table ships in the manifest; any ROI with no FlyWire counterpart is listed, not guessed). Same method as the female build: each neuron's input region is the brain neuropil holding most of its postsynaptic sites; an edge A → B counts synapses located in B made by neurons whose input region is A. Nerve-cord synapses are dropped and nerve-cord sites are ignored when assigning input regions, so the male brain is seen the way FAFB sees the female one (a brain without its cord). Known deviations, stated now: input regions come from synapses between traced bodies only (FAFB counted all partners); synapse confidence ≥ 0.5 (FlyWire used its own cleft-score threshold); transmitter per edge is the presynaptic neuron's consensus prediction (FAFB used per-connection means).
2. `malecns-v1.0-mb-1` — the adult olfactory → mushroom-body circuit at single-neuron resolution, both hemispheres: olfactory receptor neurons, projection neurons, Kenyon cells, APL, MBONs and dopaminergic neurons, with the synapses among them. Contingency stated in advance: if fewer than 200 olfactory receptor neurons are traced, the odour code drives projection neurons directly, and that is reported as a deviation.

**Experiment M1 — region-level decisions (mock world, suite `public-v2`, seeds 1–3, training seeds 1001–1003).** Planners: `rules`, `random`; female `fly`, `fly:shuffled`, `fly:random_degree`; male `fly:connectome=malecns-v1.0-projectome-1` with `+shuffled` and `+random_degree`; and, after 8 training epochs, female and male `+learning` and `+shuffled+learning`. Every planner sees identical fixtures, seeds, budgets and compiler.

- Primary comparison: untrained male real vs male shuffled, termination accuracy, paired permutation test (n = 60).
- Decision rule: p ≥ 0.05 → "the male wiring is not shown to matter under this harness". p < 0.05 but the male planner is a constant policy (one distinct primary action) → disqualified. p < 0.05 and task-sensitive → a positive mock result that needs live replication before any claim.
- Secondary, descriptive: male vs female real; the learning comparisons; task sensitivity for every variant.

**Experiment M2 — is the adult Kenyon-cell code a better task hash than a random projection?** The larval test, unchanged in method: 80 authored tasks, feedforward receptor → projection neuron → Kenyon cell with k-winners-take-all, odour sparseness swept over 0.024, 0.05, 0.10 and 0.15; real graph vs label-shuffled and degree-preserving rewired copies, null seeds 1–3.

- Primary metric: AUC of same-category vs cross-category code similarity.
- Decision rule: the real male wiring "beats its null" only if its AUC exceeds **every** null seed's AUC, for **both** null models, at **every** sparseness setting. Anything less is reported as not shown.
- Secondary: Spearman correlation with input similarity, collision-free fraction, and the same numbers for the larva.
- Not run in this entry: the held-out valence-transfer test, because adult MBON valence would need a literature table that the neuroscience collaborator has not yet checked.

**Experiment M3 — action-effect audit** (`flytown fly effects`) for the male real and shuffled projectome planners. Descriptive only.

**Not run:** live-model runs (they cost money and no provider key is stored) and plasticity on the adult circuit.

### Addendum to the male protocol (written after the inputs were downloaded and inspected, before any artifact was built or any planner run)

Inspecting the downloaded tables settled the choices the protocol left open. Each is fixed here before anything is computed from synapses.

- **Region names.** Male brain ROIs map one-to-one onto FlyWire neuropils, except: `CA` → `MB_CA`, `PED` → `MB_PED`, `aL` + `a'L` → `MB_VL`, `bL` + `b'L` + `gL` → `MB_ML`, and `AB` → `FB` (the asymmetrical body is a subunit of the fan-shaped body). `IB` is unsided in the male release and stays one node, `IB`. `CentralBrain-unspecified` and `Optic-unspecified` → `UNASGD`. The male release has **no separate AMMC, gall (GA) or ocellar ganglion (OCG)**, so those FlyWire nodes do not exist in the male projectome. The remaining ROIs are nerve-cord or neck neuropils and are dropped, except `<unspecified>` and `CRN`, whose location is unclear from the name: each counts as brain (→ `UNASGD`) only if most of its synapses come from neurons whose superclass is a brain one (`cb_*`, `ol_*`, `visual_*`), and is dropped otherwise.
- **Transmitters.** Per neuron: consensus prediction; if `unclear`, the neuron's own prediction; if still `unclear`, its cell type's; if still `unclear`, `UNKNOWN`. Histamine gets its own class, `HIST`. The engine gives any class without a sign in its policy a sign of 0, so `HIST` and `UNKNOWN` synapses are silent, as `UNKNOWN` already is for the female.
- **M1b, a robustness variant of M1 (secondary).** The default region adapters send test failures, runtime and compile errors and pressure into `AMMC`, and two signals into `GA`. The male brain lacks both, so under identical adapters it silently loses those inputs. Male real and shuffled lose them equally, so the primary test stays fair, but a male-versus-female difference could come from that alone. M1b re-points only those entries to the male ROI where those territories went. For `AMMC`, that is the ROI holding most presynaptic sites of Johnston's-organ neurons (`JO-*` types). For `GA`, it is the ROI holding most presynaptic sites of gall-innervating neurons (`GLNO`, `LNO*`, `LCNO*` types). Both are computed by the build and recorded in the manifest before any planner runs. M1b runs male real, shuffled and random-degree untrained. If M1 and M1b disagree on the primary comparison, the result is reported as adapter-sensitive, not as a finding.
- **M2 null scope.** The mushroom-body artifact holds only the olfactory and mushroom-body circuit, so label shuffling and rewiring happen within that circuit. The larval null shuffled across the whole larval brain. The adult null is the stricter of the two, and this difference is reported alongside the numbers.

## 2026-09-14 — the male fly: results (M1, M1b, M2, M3)

Everything below ran as pre-registered above. These are also the first results on suite `public-v2`, at its pinned commits.

**The male artifacts.** `malecns-v1.0-projectome-1` has 73 brain regions, 2,988 edges and 99,983,192 synapses between traced neurons. 20,862 traced neurons have synapses only in the nerve cord and are not in it. Same-region synapses are 56% of the total (the female's are 57%). Both ambiguous ROIs counted as brain under the rule, and both are tiny (251 and 62 synapses). `malecns-v1.0-mb-1` has 7,828 neurons: 2,639 olfactory receptor neurons, 334 uniglomerular and 352 other projection neurons, 4,064 Kenyon cells, 2 APL, 97 MBONs and 340 dopaminergic neurons, with 1,171,820 edges and 3.9 million synapses.

**Three procedural notes, recorded before the numbers.**

- **A void first M1 run.** It passed `--seeds 1,2,3`, which the CLI reads as a count, so it ran no seeds. The harness still rendered a zero-run report whose comparison section read like a null result. It is discarded. The harness now refuses an empty evaluation, and the CLI rejects a malformed seed count.
- **A flaw in the pre-registered gall rule.** It used the *presynaptic* sites of gall-innervating neurons. GLNO and LNO neurons receive input in the gall and send output to the noduli, where 99% of their presynaptic sites lie. So the rule re-pointed the gall's adapter entries at the noduli, not at the gall's own territory. M1b ran exactly as written, and this flaw is one more reason M1b is only a robustness check. The AMMC rule behaved as intended: 88% of Johnston's-organ output lies in the male SAD region.
- **A faster feedforward hop.** The memory code's hop now scans only the edges ending in each layer; a full scan would have taken hours on 1.2 million edges. Edge order and sums are unchanged: `flytown fly hash` reproduces all 28 rows of the published larval table exactly.

### M1 — region-level decisions, untrained (`2026-09-14-male-m1-regions-untrained.md`)

n = 60 per planner (20 fixtures × 3 seeds).

| planner | termination acc | task sensitivity (distinct / JS bits) |
|---|---|---|
| rules | 85% | 8 / 0.565 |
| random | 52% | 10 / 0.170 |
| female real (`fly`) | 50% | 4 / 0.046 |
| female shuffled | 48% | 4 / 0.104 |
| female rewired | 48% | 7 / 0.058 |
| male real | 50% | 4 / 0.058 |
| male shuffled | 45% | 6 / 0.088 |
| male rewired | 57% | 5 / 0.055 |

**Primary comparison: male real vs male shuffled, termination +5.0 pts, p = 0.504. By the pre-registered rule, the male wiring is not shown to matter under this harness.** The harness also flags a token difference: the real male brain builds slightly bigger plans, 1,770 more tokens each (p < 0.001). That is a cost difference, not an advantage, and it was not the pre-registered metric.

### M1b — rerouted adapters (`2026-09-14-male-m1b-rerouted-adapters.md`)

Male real 50% vs shuffled 45%, termination +5.0 pts, p = 0.461. M1 and M1b agree, so the result is not adapter-sensitive.

### M1 with 8 training epochs — secondary (`2026-09-14-male-m1-regions-learning.md`)

Male `+learning` scored 77% against 65% for male `+shuffled+learning` (+11.7 pts, p = 0.016). Female `+learning` scored 62% and was a constant policy; female `+shuffled+learning` scored 63%. **This is not evidence that the male wiring matters.**

- The trained male chose `increase_swarm_size` on 19 of 20 fixtures, and its shuffled copy chose `search_memory` on 19 of 20. That compares two near-constant policies that settled on different single actions, which is the pattern larva run 1 disqualified.
- The male's training curve was noisy until a final-epoch jump, from 58% at epoch 7 to 77% at epoch 8.
- It is one of several secondary comparisons. It is reported, not claimed.

### M2 — the adult Kenyon-cell code as a task hash (`2026-09-14-male-m2-mushroom-body-hash.md`)

| odour sparseness | real AUC | shuffled seeds | rewired seeds |
|---|---|---|---|
| 0.024 | 0.656 | 0.610–0.625 | 0.645–0.661 |
| 0.05 | 0.709 | 0.600–0.633 | 0.627–0.688 |
| 0.10 | 0.672 | 0.609–0.642 | 0.654–0.692 |
| 0.15 | 0.665 | 0.613–0.629 | 0.658–0.683 |

**The real male wiring beats every label-shuffled seed at every setting. It does not beat every degree-preserving rewired seed at 0.024, 0.10 and 0.15. By the pre-registered rule, this is not shown.**

What the numbers do show, stated as differences rather than claims:

- **The larval pattern reverses against label shuffling.** In the larva, real wiring scored below every shuffled seed at every setting. In the adult male it scores above every one.
- **Degree structure may explain it.** A rewired copy that keeps each neuron's number of connections does about as well as the real wiring. So the male's edge over label shuffling may come from how many inputs each neuron has, not from which projection neurons reach which Kenyon cells. That fits published work finding this wiring close to random given its degrees (Caron et al. 2013; INFERRED_FROM_LITERATURE, for the neuroscience collaborator to check).
- **The larval collision difference disappears.** Every code was distinct for the real graph and all nulls, so the larva's collision-free advantage vanishes at adult scale.

### M3 — action-effect audit (`2026-09-14-male-m3-effects.md`)

The male real planner's primary action shaped the plan on 5 fixtures, was a default on 15 and was inert on none (5/15/0); its shuffled copy scored 11/9/0. The female real scored 18/2/0 and female shuffled 19/1/0. For all four, the top two action scores differ by only 0.025–0.080, so the fly planners still decide by near-ties.

### Verdict

Across the region-level decision test, its robustness variant and the adult mushroom-body hash test, the male fly's wiring is not shown to beat its null models under the pre-registered rules. That is the same verdict as the female adult brain and the larva.

One lead is specific enough to test: whether degree structure alone explains the adult hash result. A fair test would compare the real wiring against degree-preserving rewires only, with more seeds, pre-registered before it runs.

Reproduce: `connectome-etl/fetch_male.sh`, then `connectome-etl/build_male.py --all`, `node scripts/male-rerouted-adapters.mjs`, `flytown fly fixtures fetch`, then the `fly eval`, `fly effects` and `fly hash` commands recorded at the top of each report.
