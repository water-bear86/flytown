# connectome-etl — FlyWire FAFB v783 → FLYTOWN runtime artifacts

Offline, reproducible Python ETL that turns the public FlyWire adult *Drosophila*
brain connectome (FAFB, materialization **783**) into small, versioned,
checksummed artifacts under `../connectome/` for the TypeScript runtime to load.
No TypeScript lives here; this directory only produces data.

| Artifact | Directory | Level | Tracked in git |
| --- | --- | --- | --- |
| `fafb-v783-projectome-1` | `connectome/fafb-v783-projectome-1/` | neuropil (region) graph, 79 nodes | yes (all three files) |
| `fafb-v783-neuron-1` | `connectome/fafb-v783-neuron-1/` | neuron graph, ~139k nodes | `manifest.json`, `graph.header.json` only — `graph.bin` and `neurons.parquet` are gitignored and rebuilt locally |

## How to run

```sh
cd connectome-etl
python3 -m venv .venv                       # Python >= 3.11 (built with 3.14.6)
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python build.py --download      # ~1.1 GB into connectome-etl/raw/ (gitignored)
./.venv/bin/python build.py --projectome    # -> ../connectome/fafb-v783-projectome-1/
./.venv/bin/python build.py --neuron        # -> ../connectome/fafb-v783-neuron-1/
# or everything in one go:
./.venv/bin/python build.py --all
```

* `--download` is idempotent: files already present with the right size **and**
  MD5 are skipped; partial downloads resume with HTTP `Range`. It writes
  `raw/zenodo_record.json` (the Zenodo API response) and
  `raw/download_manifest.json` (bytes, MD5, SHA-256 per file).
* `--projectome` / `--neuron` need `raw/download_manifest.json` and refuse to run
  if a raw file is missing or has changed size.
* `--raw-dir` / `--out-dir` override the default locations.
* Peak memory is roughly 6 GB (the connections table has 16.8 M rows and is
  processed with NumPy/pyarrow, not row-by-row pandas). A full run takes a few
  minutes plus download time; per-step timings are recorded in each manifest
  under `build.timingsSec`.

## Inputs (all open, no login)

Zenodo record [10676866](https://zenodo.org/records/10676866), *FlyWire
Whole-brain Connectome Connectivity Data*, version 783.0, license **CC-BY-4.0**,
DOI 10.5281/zenodo.10676866. Zenodo publishes **MD5** checksums (not SHA-256);
`build.py` verifies MD5 against the record and additionally records SHA-256.

| File | Bytes | MD5 (Zenodo) | Used for |
| --- | ---: | --- | --- |
| `proofread_connections_783.feather` | 852,022,274 | `f48f972d262323a102aed49af1396b8a` | edges: one row per (pre, post, neuropil) |
| `per_neuron_neuropil_count_post_783.feather` | 233,843,050 | `bb5999f10920ade803d9f37097a43a56` | input region per neuron |
| `per_neuron_neuropil_count_pre_783.feather` | 16,853,770 | `90fcdb42c1ba05ed92820840fa1e6ba0` | output region / fallback |
| `proofread_root_ids_783.npy` | 1,114,168 | `e0e6c19732fd8c7a4e39a2d170105421` | neuron universe |

`flywire_synapses_783.feather` (9.5 GB, per-synapse) is deliberately **not**
downloaded; everything needed is in the summaries above.

Actual columns found (do not trust docs, trust the files):

* connections: `pre_pt_root_id:int64, post_pt_root_id:int64, neuropil:string,
  syn_count:int64, gaba_avg, ach_avg, glut_avg, oct_avg, ser_avg, da_avg:double`
  — **there is no `nt_type` column**; see assumptions.
* post/pre counts: `post_pt_root_id | pre_pt_root_id:int64, neuropil:string, count:int64`
  — these tables cover *all* segments, not only proofread neurons.
* root ids: `uint64[139255]`.

Cell-type annotations: `supplemental_files/Supplemental_file1_neuron_annotations.tsv`
from GitHub [`flyconnectome/flywire_annotations`](https://github.com/flyconnectome/flywire_annotations),
pinned to commit `8587524c1748ce5ef2080822a2fc890fc03bf597` (= tag `v3.1.0`).
`build.py` verifies the file's git blob SHA-1 against the GitHub contents API for
that commit. Columns used: `root_id, flow, super_class, cell_class,
cell_sub_class, cell_type, hemibrain_type, ito_lee_hemilineage (→ hemilineage),
hartenstein_hemilineage, side, nerve, top_nt, top_nt_conf, known_nt,
known_nt_source`. `root_id` in this file is already a v783 id. Note that v3.x
of the table has been extended beyond Schlegel et al. 2024 by Berg et al. 2025
(MaleCNS cross-validation); tag `v2.1.0` is the version reported in the 2024
papers if you ever want that instead (change `ANN_TAG`/`ANN_COMMIT`).

**License of the annotation table:** the repository has **no LICENSE file and
no license statement** (GitHub API `license: null` at that commit); its README
only asks for citations (Berg 2025, Schlegel 2024, Matsliah 2024, Dorkenwald
2024). The original Supplemental File 1 was published with the open-access
(CC-BY-4.0) Schlegel et al. 2024 Nature paper. This is recorded verbatim in
`source.annotations.license` of both manifests — do not upgrade it to a real
license without checking with the authors.

Citations (DOIs resolved through Crossref on the build date):
Dorkenwald et al. 2024 Nature 10.1038/s41586-024-07558-y; Lin et al. 2024 Nature
10.1038/s41586-024-07968-y; Schlegel et al. 2024 Nature 10.1038/s41586-024-07686-5;
Eckstein et al. 2024 Cell 10.1016/j.cell.2024.03.016; plus Berg et al. 2025
(bioRxiv 10.1101/2025.10.09.680999) and Matsliah et al. 2024 (Nature
10.1038/s41586-024-07981-1) because the v3.1.0 annotation table asks for them.

## Outputs

### `fafb-v783-projectome-1/` (region-level projectome)

* `nodes.json` — array sorted by `id`; `index` = array position.
  `{"id","index","provenance":"MEASURED","neuronCount","inSynapses","outSynapses","outNt":{class:int}}`
* `graph.json` — `{"format":"coo","n","src":[...],"dst":[...],"weight":[...],"nt":{class:[...]}}`;
  parallel arrays, edges sorted by `(src, dst)`, indices refer to `nodes.json[].index`,
  weights are synapse counts, `nt[class][i]` is the per-transmitter split of
  `weight[i]` (they sum exactly). Self-edges are kept.
* `manifest.json` — provenance (files, hashes, license, citations), every
  preprocessing step and assumption, graph totals, `stats` (top edges, sanity
  checks, transmitter totals), `build` (versions + timings) and SHA-256 of the
  two data files.

### `fafb-v783-neuron-1/` (neuron-level consolidated graph)

* `neurons.parquet` — one row per neuron in the universe, sorted by `root_id`;
  `index` is the row position and the node index used by `graph.bin`. Columns:
  `root_id, index, proofread, input_region, output_region, flow, super_class,
  cell_class, cell_sub_class, cell_type, hemibrain_type, hemilineage,
  hartenstein_hemilineage, side, nerve, top_nt, top_nt_conf, known_nt,
  known_nt_source, annotated`. Annotation labels are kept verbatim (e.g.
  `top_nt` = `acetylcholine`, not `ACH`).
* `graph.bin` — four little-endian typed arrays back to back:
  `src:uint32[E]`, `dst:uint32[E]`, `weight:uint32[E]`, `nt:uint8[E]`
  (byte offsets and lengths are spelled out in `graph.header.json`, together
  with the file's SHA-256 and `ntClasses` for decoding `nt`). Edges are
  `(pre, post)` pairs sorted by `(src, dst)`; `weight` is the synapse count summed
  over neuropils; `nt` is the synapse-count-weighted majority transmitter.
* `graph.header.json`, `manifest.json` — as above.

## Method and every assumption

The manifests carry the same text under `preprocessing.assumptions[]` with a
`category` of `ENGINEERING_CHOICE` or `INFERRED_FROM_LITERATURE`.

1. **Nodes** = the sorted distinct values of the connections table's `neuropil`
   column: 78 neuropils (symmetric ones as `_L`/`_R`) plus `UNASGD`.
2. **`UNASGD` pseudo-region** (engineering choice). Synapses outside every
   neuropil mesh are labelled `UNASGD` in the connections table but `None` (the
   literal string) in the count tables. Both are mapped to the single id
   `UNASGD`, the synapses are kept (nothing measured is dropped), and the node
   is ignored when choosing a neuron's input/output region unless the neuron
   has no synapses anywhere else. Treat it as "outside annotated neuropils",
   not as a brain region.
3. **Neuron universe** = proofread root ids ∪ all pre/post ids in the
   connections table. Count-table rows for other segments are ignored.
4. **`input_region(neuron)`** (engineering choice, `input_region_argmax`) =
   neuropil with the most postsynaptic sites for that neuron. Ties → the
   alphabetically first neuropil id. No post counts in any neuropil → fall back
   to the max presynaptic-count neuropil; only `UNASGD` synapses → `UNASGD`; no
   counts at all → dropped and counted in `droppedNeurons`. A neuron with
   inputs spread over several neuropils is attributed entirely to its top one.
5. **Projectome edge** for each connection row `(pre, post, N, syn_count)`:
   `input_region(pre) → N`, `weight += syn_count`, `nt[nt_type] += syn_count`.
   Read A→B as "neurons that mostly *listen* in A make synapses located in B":
   information flows from where a neuron listens to where it talks. The edge
   destination is the synapse's own neuropil, so `inSynapses(node)` equals the
   number of proofread synapses inside that neuropil. The alternative
   `output_region(pre) → input_region(post)` is noted in the manifest as a
   future variant and is not built.
6. **Weight = synapse count** (engineering choice, `syn_count_as_weight`): a
   structural proxy, **not** a physiological weight (no synapse size, receptor,
   dynamics, gap junctions or neuromodulation).
7. **`nt_type` is derived** (engineering choice, `nt_type_derivation`): the
   published table has per-connection *mean* probabilities for six classes;
   `nt_type` = argmax in the fixed order `ACH, GABA, GLUT, DA, OCT, SER`
   (ties → first in that order; tie and NaN counts are in the manifest). This
   mirrors the Codex convention but is computed here.
8. **`UNKNOWN` class** (engineering choice): 1,732 rows have all six
   probabilities missing; they are kept under a seventh class `UNKNOWN` so the
   per-class split always sums to the weight.
9. **Transmitters are predictions, not measurements** (from literature,
   `nt_prediction_not_measurement`): Eckstein et al. 2024 report 87% accuracy
   per synapse, 94% per neuron, 91% for known cell types. No co-transmission,
   neuropeptides or histamine.
10. **No sign is encoded** (from literature, `nt_sign`): ACH excitatory, GABA
    inhibitory, GLUT predominantly inhibitory in the adult central brain
    (GluCl-α) but not universally, DA/OCT/SER modulatory with receptor-dependent
    sign. Any sign the runtime applies must be labelled as inferred.
11. **Neuron-level consolidation** (engineering choice, `pair_aggregation`):
    neuropil is dropped; `(pre, post)` weight = total synapses, `nt` = class with
    the largest synapse count within the pair (ties → first in `ntClasses`).
    Autapses are kept.

## Reproducibility

Given the pinned inputs (Zenodo file MD5s, annotation commit) the data files
(`nodes.json`, `graph.json`, `graph.bin`) are byte-for-byte deterministic; the
only run-dependent values are `createdAt`, `build.timingsSec` and the Parquet
file's embedded writer metadata. Every output file's SHA-256 is in its
manifest; `graph.header.json` also carries `graph.bin`'s hash so the gitignored
binary can be verified after a local rebuild.

## Build results (first build, 2026-09-11)

Wall time 45 s after the ~1.1 GB download (load connections 3.0 s, regions
1.9 s, projectome 0.9 s, neuron aggregation 3.8 s, neuron write 3.3 s).

**Neuron universe:** 139,255 neurons = the proofread list exactly (every
pre/post id in the connections table is proofread; 616 proofread neurons have
no connection rows). Input region came from post-synapse argmax for 138,384
neurons (299 ties broken alphabetically), from the pre-synapse fallback for
590, `UNASGD` for 1, and 280 neurons have no synapse counts at all
(`droppedNeurons = 280`; they contribute no edges anyway). 8 neurons whose true
post-argmax was `UNASGD` were attributed to their best real neuropil.

**Projectome:** 79 nodes, 3,509 edges (75 self-edges), 54,492,922 synapses,
0 rows dropped. 57.1% of all synapses are intra-neuropil (self-edges); the
optic lobes dominate (ME_R→ME_R 8.1 M, ME_L→ME_L 7.2 M, ME→LO 2.0 M per side).
Largest neuron counts by input region: ME_L 34,417, ME_R 34,056, LO_L 7,289,
LO_R 6,958, GNG 6,137. Transmitter split of synapses: ACH 55.7%, GABA 23.3%,
GLUT 17.8%, DA 1.4%, SER 1.2%, OCT 0.6%, UNKNOWN 0.06%. Top-probability
statistics of the argmax rule: median 0.84, 5th percentile 0.44; only 2 tied
rows.

Sanity checks (all pass): AL_L→LH_L and AL_L→MB_CA_L are AL_L's two largest
non-self outputs (38% / 30% of its extrinsic output; same on the right);
MB_CA→MB_ML / MB_PED / MB_VL are the calyx's top outputs (Kenyon cells listen
in the calyx, talk in the lobes); LA→ME carries >99.9% of lamina output;
ME→LO is each medulla's #1 extrinsic edge (67–74%); LO→LOP is #1/#2 for the
lobula; EB→PB is EB's #1 extrinsic edge.

**Neuron graph:** 15,091,983 (pre, post) edges aggregated from 16,847,997
rows; 0 autapses in the source; 76,411 pairs had a transmitter tie (broken by
class order). `graph.bin` is **196 MB** (13 bytes/edge) — larger than the
"tens of MB" expected because the v783 table keeps every ≥1-synapse pair.
For reference, restricting to weight ≥ 5 would leave 2,700,513 edges (17.9% of
edges, 62.7% of synapses, ~35 MB); weight ≥ 10 → 1,066,822 edges (43.4% of
synapses, ~14 MB). No threshold is applied here; that is a runtime/loader
decision. `neurons.parquet` is 2.9 MB; 139,241 of 139,255 neurons (99.99%)
have an annotation row (super_class: optic 77,537, central 32,383, sensory
16,904, visual_projection 8,038, ascending 1,750, descending 1,303, …).
Cross-check: the synapse-count-weighted majority transmitter per neuron
derived from `graph.bin` agrees with the annotation table's independently
computed `top_nt` for 92.95% of 137,993 neurons.

Things that contradicted the brief: 16.8 M connection rows (not 3.7 M);
no `nt_type` column (derived); the "outside neuropil" label differs between
tables (`UNASGD` vs `None`); 1,732 rows without any transmitter probability;
Zenodo publishes MD5 not SHA-256; the annotation repo has no license
statement; `hemilineage` exists only as `ito_lee_hemilineage` /
`hartenstein_hemilineage`; `top_nt` uses full names (`acetylcholine`), not
the `ACH` codes.
