# connectome-etl — FlyWire FAFB v783 → FLYTOWN runtime artifacts

Offline, reproducible Python ETL that turns the public FlyWire adult *Drosophila*
brain connectome (FAFB, materialization **783**) into small, versioned,
checksummed artifacts under `../connectome/` for the TypeScript runtime to load.
No TypeScript lives here; this directory only produces data.

| Artifact | Directory | Level | Tracked in git |
| --- | --- | --- | --- |
| `fafb-v783-projectome-1` | `connectome/fafb-v783-projectome-1/` | neuropil (region) graph, 79 nodes | yes (all three files) |
| `fafb-v783-neuron-1` | `connectome/fafb-v783-neuron-1/` | neuron graph, ~139k nodes | `manifest.json`, `graph.header.json` only — `graph.bin` and `neurons.parquet` are gitignored and rebuilt locally |
| `l1-larva-winding2023-1` | `connectome/l1-larva-winding2023-1/` | neuron graph of the L1 **larval** brain, 2,952 nodes, four synapse-type channels (`build_larva.py`, see the Larva section) | yes (all four files, 3.3 MB) |
| `malecns-v1.0-projectome-1` | `connectome/malecns-v1.0-projectome-1/` | brain-only region graph of the adult **male** (MaleCNS v1.0), 73 nodes, built like the female one (`build_male.py`, see the Male section) | yes, plus `adapters-rerouted.json` |
| `malecns-v1.0-mb-1` | `connectome/malecns-v1.0-mb-1/` | neuron graph of the adult male olfactory and mushroom-body circuit, 7,828 nodes | `manifest.json`, `nodes.json` only — `graph.json` (~33 MB) is gitignored and rebuilt locally |

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

## Larva — Winding et al. 2023 L1 larval brain → `l1-larva-winding2023-1`

`build_larva.py` builds a second, much smaller **neuron-level** artifact from the
whole first-instar (L1) *Drosophila* larval brain connectome of Winding et al.
2023 (Science 379:eadd9330, "The connectome of an insect brain"). It imports the
hashing / download / timer helpers from `build.py` but is otherwise independent
(different sources; the FlyWire downloads are not needed). Where the adult
artifact splits every edge by predicted **neurotransmitter**, this one splits it
by **synapse type** (axo-dendritic, axo-axonic, dendro-dendritic, dendro-axonic):
there is no transmitter data for the larva at all. All four output files are
small (3.3 MB together) and are meant to be tracked in git.

### How to run

```sh
cd connectome-etl
./.venv/bin/python build_larva.py --download   # ~11 MB into raw/larva/ (gitignored)
./.venv/bin/python build_larva.py --build      # -> ../connectome/l1-larva-winding2023-1/
./.venv/bin/python build_larva.py --all        # both
```

* `--download` is idempotent: every GitHub file is verified against its **git
  blob SHA-1** from the contents API at the pinned commit, the Zenodo archive
  against the record's **MD5**; a mismatch deletes the file and stops the build
  (nothing is ever built from unverified data). It makes five unauthenticated
  GitHub API calls (rate limit 60/h) and one Zenodo call; if the GitHub API is
  unreachable the check is recorded as `unverified`, never silently passed. It
  writes `raw/larva/download_manifest.json` (URL, bytes, MD5, SHA-256, blob
  SHA-1, commit, per-member hashes of the Data S1 zip, licence fields).
* `--build` takes ~3 s and well under 1 GB of RAM; `--raw-dir` / `--out-dir`
  override the locations as for `build.py`.

### Inputs (all open, no login)

| File | Source, pinned | Bytes | SHA-256 | Role |
| --- | --- | ---: | --- | --- |
| `Supplementary-Data-S1.zip` | GitHub [`brain-networks/larval-drosophila-connectome`](https://github.com/brain-networks/larval-drosophila-connectome) @ `15e065f5c29f08c96ccd64ea8fe0f51510629009` (blob `e7eff2cd…`) — a mirror of Science Data S1 | 1,107,380 | `8c1f4380…a72a4c` | connectivity (primary) + cell types |
| `data/processed-elife/unmatched_full_nodes.csv` | GitHub [`neurodata/bilateral-connectome`](https://github.com/neurodata/bilateral-connectome) @ `4482b9022f27d361011c9c7442e32ca51d607d08` = tag `elife-v5` (blob `181d62eb…`) | 2,638,863 | `d430f9bc…dccadb` | names, hemisphere, pairs, lineage, class1/class2, flags |
| `data/processed-elife/unmatched_full_edgelist.csv` | same commit (blob `1975f187…`) | 2,351,007 | `92468519…129266` | cross-check only |
| `neurodata/bilateral-connectome-elife-v5.zip` | Zenodo [10.5281/zenodo.7733481](https://doi.org/10.5281/zenodo.7733481) (MD5 `9809ae7e…`, licence id `other-open`) | 4,802,330 | `1697f84a…c5fe7c` | DOI-backed archive of the same commit; its two CSVs are asserted byte-identical to the GitHub copies |

Actual contents found (do not trust the brief, trust the files):

* The Data S1 zip does **not** contain `science.add9330_data_s2/s3/s4.csv`. It
  contains `aa_`, `ad_`, `da_`, `dd_` and `all-all_connectivity_matrix.csv`
  (dense 2,952 × 2,952 CSVs, header row and index column = CATMAID skeleton ids,
  **row = presynaptic, column = postsynaptic**, integer counts written as floats
  like `9.0`), `annotations.csv` (`left_id, right_id, celltype,
  additional_annotations, level_7_cluster`; 1,373 pair rows → 2,610 ids),
  `inputs.csv` (`axon_input, dendrite_input`) and `outputs.csv` (`axon_output,
  dendrite_output`) for 2,956 ids, plus `celltype_axonio_ratio.csv` and
  `celltype_dendriteioratio.csv` (not used).
* The five matrices list the same 2,952 ids in **different row orders**, so
  they must be aligned by id before anything is added. After alignment the sum
  of the four channels equals the all-all matrix exactly (asserted).
* `unmatched_full_nodes.csv` has 3,013 rows × 106 columns. Used: `name,
  hemisphere, pair, pair_id, lineage, class1, class2, simple_group` and the
  boolean flags `KCs, MBONs, MBINs, dVNCs, dSEZs, RGNs`. There is **no `DN`
  column**; descending neurons are `dVNCs` / `dSEZs`. `celltype_discrete` holds
  LaTeX-formatted labels (`DN$^{\mathrm{VNC}}$`), so the plain `simple_group`
  column is used for the fallback cell type instead.
* `unmatched_full_edgelist.csv` is headerless `source,target,weight` with
  111,243 rows over 3,013 ids.
* The mushroom-body neuron names (DAN-i1, MBON-g1, …) live in Data S1
  `additional_annotations`; the neurodata `name` column has the CATMAID names
  (`MBE1c left`), and `class2` carries `DAN` / `OAN` for the MBINs.

### Outputs (`connectome/l1-larva-winding2023-1/`)

* `nodes.json` — array sorted by **ascending numeric skeleton id** (`id` is
  emitted as a string), `index` = array position, one entry per neuron of the
  matrices (2,952). Fields: `id, index, provenance ("MEASURED"), name,
  hemisphere (L|R|?), pairId, pairedWith, lineage, class1, class2, cellType,
  annotation, cluster, groups, inSynapses, outSynapses`. `groups` is what the
  runtime keys on: `class:<class1 token>` (one per `;`-separated token; falls
  back to `class:<cellType>` when class1 is `unk`, else `class:unk`),
  `class2:<class2>`, `type:<paper cell type>`, `hemisphere:L|R`, `flag:KC`,
  `flag:MBON`, `flag:MBIN`, `flag:DN`, `out:DN-VNC`, `out:DN-SEZ`, `out:RGN`,
  `sens:<modality>`.
* `graph.json` — `{"format":"coo","n":2952,"src":[…],"dst":[…],"weight":[…],
  "channels":{"ad":[…],"aa":[…],"dd":[…],"da":[…]}}`; one entry per (pre, post)
  pair with ≥ 1 synapse in any channel, sorted by `(src, dst)`, `weight` =
  sum of the four channels (asserted per edge), autapses kept.
* `plasticity.json` — curated, every block tagged: `plasticEdges` (KC → MBON
  `ad` edges under `class2:DAN` modulation, with the Eschbach 2020 / Jürgensen
  2024 rule), `dopaminergic` (appetitive / aversive / unknown DAN ids plus a
  per-name evidence table), `octopaminergic`, `otherModulatory`,
  `mushroomBodyOutputNeurons`, `signs` (`byGroup`, `byNode`, `default`,
  `unverified`).
* `manifest.json` — same shape as the FAFB manifests: `source` (files, hashes,
  commits, DOI, licences verbatim, citations), `preprocessing` (steps, input
  schemas, neuron-universe reconciliation, annotation coverage, tagged
  assumptions), `graph` (`channels: ["ad","aa","dd","da"]`, per-channel
  totals), `groups` (every distinct group string with its count),
  `plasticitySummary`, `stats` (sanity checks, reproduction of the paper's own
  text statistics, edge-list cross-check, top edges), `build`, `checksums`
  (`sha256:` of `nodes.json`, `graph.json`, `plasticity.json`).

### Method and every assumption

The manifest carries the same list under `preprocessing.assumptions[]`.

1. **Weight = synapse count** (`syn_count_as_weight`, engineering choice):
   manually annotated chemical contacts summed over the four channels; a
   structural proxy, no sizes / receptors / gap junctions / neuromodulation.
2. **Channels are synapse types** (`channels_are_synapse_types`, measured):
   `ad / aa / dd / da` as published in Data S1; the axon/dendrite split of each
   skeleton is the authors'.
3. **No neurotransmitter data** (`no_neurotransmitter_data`, engineering
   choice): the artifact has no `nt` field; the only transmitter knowledge is
   the literature table in `plasticity.json`; everything else is magnitude-only
   (sign +1 by convention).
4. **No sign encoded** (`sign_not_encoded`, from literature): KCs presumed
   cholinergic (inferred from the adult by Eichler 2017), APL GABAergic, DANs /
   OANs modulatory, MBON-g1/g2/h1/h2 and MBON-m1 GABAergic, MBON-i1/j1/k1
   glutamatergic (probably inhibitory); any sign the runtime applies must be
   labelled as inferred.
5. **Data S1 is the connectivity source** (`primary_source_is_data_s1`): the
   Pedigo edge list is a cross-check only (see results for the exact
   reconciliation).
6. **Rows are presynaptic** (`row_is_presynaptic`, measured, verified three
   ways: the edge list's `source,target,weight` reproduces `matrix[row=source]
   [col=target]` for all 110,298 shared edges; column sums never exceed
   `inputs.csv`, row sums never exceed `outputs.csv`; sensory neurons have
   almost no column synapses).
7. **Two annotation tables merged** (`node_annotation_merge`): Data S1 supplies
   `cellType`, `annotation`, `cluster`; neurodata supplies `name, hemisphere,
   pair/pair_id, lineage, class1/class2`, flags. For 32 paired neurons Data S1's
   `left_id/right_id` placement contradicts both the CATMAID names
   (`PDM-DN_right`, `contra-vine left`, …) and neurodata's `hemisphere`; the
   neurodata value is used. Labels are verbatim except for stripped whitespace
   (`'MBNB A '` → `MBNB A`).
8. **`class:` fallback** (`class_group_fallback`): 1,129 neurons have class1
   `unk`; 810 of them get `class:<paper cell type>` (e.g. `class:pre-DN-VNC`)
   so that every neuron carries its most specific label; 323 stay `class:unk`
   (321 whose paper category is `Other`, 2 with no annotation anywhere).
9. **`flag:DN` = dVNCs ∨ dSEZs** (`flag_dn_definition`); the flags are
   inclusive (a `dSEZ;CN` neuron is flagged), hence `out:DN-SEZ` = 184 while the
   paper's exclusive `DN-SEZ` cell type has 164 members. `out:` uses the paper's
   spellings `DN-VNC / DN-SEZ / RGN`.
10. **`sens:` modality** (`sens_modality_source`): Data S1
    `additional_annotations` for `sensory` neurons (whole label) and for
    `ascending` neurons carrying `mechano-Ch / proprio / noci / mechano-II/III`;
    lower-cased, `/` and spaces → `-`. Second-order PNs get **no** `sens:`
    group (their modality string stays verbatim in `annotation`). neurodata
    `class2` (ORN, AN, MN, vtd, photoRh5/6, thermo) is exposed as `class2:`.
11. **Plasticity curation** (`plasticity_curation`, from literature): valences
    and transmitters were taken only from statements found in the full texts
    (Europe PMC / PMC) of the cited papers; anything not found is `unknown`.
    Valences come from optogenetic substitution experiments, not the connectome.
12. **Autapses kept** (`autapses_kept`): 537 diagonal pairs / 783 synapses
    (mostly a-a between KC branches).
13. **`type:Other`** and **`cellType` fallback** (engineering choice): the 346
    neurons absent from Data S1 `annotations.csv` get the paper's category via
    `simple_group` (`unk` → `Other`, the paper's own "Other" bin); 4 neurons are
    missing from the neurodata table, 2 of them (`3813487`, `17068730`) have no
    annotation anywhere (`name: null`, `hemisphere: "?"`, `class:unk`).

### Licence caveat

* **Article:** CC BY 4.0. The PMC full text (PMC7614541) carries two statements
  verbatim — "exclusive licensee American Association for the Advancement of
  Science. No claim to original US government works.
  https://www.sciencemag.org/about/science-licenses-journal-article-reuse" and
  "This work is licensed under a CC BY 4.0 International license." Europe PMC
  metadata: `isOpenAccess=Y, license='cc by'`.
* **Data S1 file: NOT CONFIRMED; cite Winding et al. 2023.** The zip carries no
  licence; the GitHub mirror has no LICENSE (API `license: null`) and its README
  only says "Connectome data from Winding et al (2023) Science. These data were
  originally made available as part of the previously mentioned manuscript.";
  science.org answers automated requests with HTTP 403, so whether CC BY extends
  to the supplement was not confirmable. Recorded verbatim in
  `source.license` / `source.dataS1Mirror`.
* **neurodata annotation table:** **MIT** at the pinned commit `4482b902`
  (tag `elife-v5`, the Zenodo-archived version, Zenodo licence id
  `other-open`); the repository HEAD (`0ff9bbe0`, 2024-04-05, "Update LICENSE")
  switched to the **PolyForm Noncommercial License 1.0.0** (GitHub API `key:
  other, spdx: NOASSERTION`). The two CSVs are byte-identical between the MIT
  commit and HEAD; the build pins the MIT/Zenodo commit and records both
  verbatim in `source.annotations.neurodata.license`.
* Citations (all DOIs resolved through Crossref on the build date; the Zenodo
  DOI through Zenodo/DataCite): Winding 2023 10.1126/science.add9330; Eichler
  2017 10.1038/nature23455; Eschbach 2020 10.1038/s41593-020-0607-9; Saumweber
  2018 10.1038/s41467-018-03130-1; Pedigo 2023 10.7554/eLife.83739; Saalfeld
  2009 (CATMAID) 10.1093/bioinformatics/btp266; Jürgensen 2024
  10.1016/j.isci.2023.108640.

### Build results (first build, 2026-09-11)

Wall time 21 s including the 11 MB download; the build itself is 3 s.

**Graph:** 2,952 neurons, **110,677 edges**, 352,611 synapses, **537 autapses**
(783 synapses). Per channel: a-d 234,958 synapses (**66.6 %**, 63,545 edges),
a-a 90,800 (**25.8 %**, 40,636), d-d 20,415 (**5.8 %**, 9,019), d-a 6,438
(**1.8 %**, 3,722) — the paper's text gives exactly 66.6 / 25.8 / 5.8 / 1.8 %.
Weight quantiles 50/90/99/99.9 % = 2 / 7 / 21 / 48, max 121 (42a ORN → 42a PN).
43 neurons have no output and 58 no input within the matrices (57 of the 58 are
sensory neurons, whose inputs lie outside the brain).

**Reproduction of the paper's own statistics** (paper value in brackets):
weak edges (1–2 synapses) a-d 59.5 % [60], a-a 75.0 % [75], d-d 79.4 % [79],
**d-a 86.1 % [91]**, all 65.3 % [66]; synapse share in ≥ 5-synapse edges a-d
63.2 % [61], all 56.6 % [55]; share in weak edges a-d 21.0 % [22], all 26.2 %
[28]; pairs connected in only one channel 94.6 % [95]; d-a edges that reverse an
a-d edge 64.1 % [63]. Only the d-a weak-edge fraction is noticeably off.

**Edge-list cross-check (Pedigo et al. 2023):** 111,243 rows, 3,013 ids,
537 autapses, 353,859 synapses. 110,298 edges have both ends among the 2,952
matrix neurons and **all 110,298 weights are identical** to the channel sums.
The remaining 945 edge-list edges (2,160 synapses) involve 65 neurons that are
not in the matrices (50 SEZ motor neurons flagged `motor`/`accessory_neurons`,
9 immature "KC … young" cells, 10 `partially_differentiated`, …); 4 matrix
neurons (`3813487, 8644484, 14531828, 17068730`) are absent from the edge list
and contribute the 379 matrix edges it lacks. So the "111,243 edges incl. 536
autapses" of the brief describes the 3,013-node Pedigo graph, not Data S1.

**Neuron universe:** 2,952 matrix neurons; 2,948 have a neurodata row, 2,606 a
Data S1 annotation row (the other 346 are the paper's "Other" bin, 343, one
pre-DN-VNC, and the 2 unannotated cells). The paper's text counts 3,016
neurons and ~548,000 synaptic sites; the matrices hold synapses *between* the
2,952 neurons only (`inputs.csv` sums to 429,503 postsynaptic sites, of which
352,611 = 82 % have a partner inside the matrices). Pairs: 2,804 reciprocal
contralateral pairs from neurodata, 138 unpaired.

**Distinct `groups` (97) with counts:**

* `class:` (33) — sens 430, pre-DN-VNC 430, unk 323, LHN 255, CN 204, dSEZ 182,
  dVNC 182, KC 144, PN-somato 138, pre-DN-SEZ 99, PN 86, CX 77, FFN 74, RGN 56,
  MBON 48, uPN 42, ascending 40, FB2N 34, MBIN 28, mPN 28, FBN 26, LN 17,
  LON 17, bLN 10, pLN 10, tPN 10, vPN 10, FAN 8, dUnk 8, A00c 6, cLN 4, APL 2,
  keystone 2.
* `class2:` (25) — AN 174, MN 153, ORN 42, 1claw 36, 3claw 34, 4claw 33, vtd 26,
  photoRh6 19, 2claw 19, app 16, multi 16, 5claw 15, DAN 14, IPC 14, av 12,
  olfac 12, photoRh5 10, ITP 8, neith 8, 6claw 7, CA-LP 6, Trio 6, thermo 6,
  Duet 4, OAN 4.
* `type:` (18) — pre-DN-VNC 477, sensory 430, Other 343, PN 206, LHN 202,
  DN-VNC 182, DN-SEZ 164, PN-somato 152, KC 144, LN 110, MB-FBN 108,
  pre-DN-SEZ 102, CN 100, RGN 54, MB-FFN 54, MBON 48, ascending 46, MBIN 28.
* `hemisphere:` — L 1,471, R 1,479 (2 unknown).
* `flag:` — DN 366, KC 144, MBON 48, MBIN 28.
* `out:` — DN-SEZ 184, DN-VNC 182, RGN 56.
* `sens:` (12) — gustatory-external 131, gustatory-pharyngeal 107, gut 85,
  olfactory 42, visual 29, respiratory 26, thermo-cold 6, thermo-warm 4 (the 430
  sensory neurons), plus mechano-ch 12, noci 12, proprio 8, mechano-ii-iii 2
  (ascending neurons).

**Mushroom-body neurons identified by name** (Data S1 `additional_annotations`;
each name = one left/right pair): 7 DAN names / 14 ids — DAN-c1, -d1, -f1, -g1,
-i1, -j1, -k1 — exactly the neurodata `class2 == DAN` set; OAN-e1, OAN-g1
(4 ids, = `class2 == OAN`); MBIN-b1, -b2, -e1, -e2, -l1 (10 ids, transmitter
unknown per Eichler 2017); 24 MBON names / 48 ids (MBON-a1 … -q1; two pairs
are annotated "MBON-h1; MBON-h2"); 144 KCs (`flag:KC`, claw classes 1–6 in
`class2:`); APL = `MBE12 left/right`. **DAN-h1 does not exist in L1**: Eichler
2017 list seven DANs without it, so the pPAM reward cluster here is i1/j1/k1.
Valence lists: appetitive = DAN-i1 (2 ids; Saumweber 2018 sufficiency);
aversive = DAN-d1, -f1, -g1 (6 ids; Eschbach 2020); unknown = DAN-c1 (activation
gives neither memory), DAN-j1 (no driver, untested), DAN-k1 (alone not
rewarding). `signs.byNode` covers 22 cells: MBON-g1/g2/h1/h2 GABA, MBON-i1/j1/k1
glutamate (probable −1), MBON-m1 GABA, FBN-7 and FB2N-19 acetylcholine, FBN-23
GABA. MBON-e1 "cholinergic" could **not** be verified in any accessible text and
is left unknown (recorded under `signs.unverified`).

**Sanity checks (all pass):** uPN → KC is 3,665 a-d vs 2 a-a synapses and is
the #1 a-d input class to KCs (uPN 3,665, APL 681, PN 393, mPN 344, LHN 255);
over all channels KCs' top inputs are KC→KC a-a (14,854) and MBIN→KC a-a
(4,709) before uPNs. KC → MBON a-d edges exist for **48/48 MBONs** (median 306
KC a-d synapses per MBON). DAN → KC is **100 % a-a** (3,708 synapses), MBIN → KC
100 % a-a, KC → MBIN 99.6 % a-a; DAN → MBON 98 % a-d; APL → KC 98.6 % a-d,
KC → APL 61 % a-d / 38 % d-a; KC → KC 92 % a-a / 8 % d-d; sensory neurons
emit 30,127 synapses and receive 3,784 (all a-a / d-a, none a-d). Top edges are
ORN → uPN a-d pairs (42a: 121/119, 83a: 111/100, 67b: 105/104, 33a: 104/100,
13a: 101) and the d-d `broad T3 → broad T2` LN pair (108).

**File sizes:** `nodes.json` 1,057,168 B, `graph.json` 2,142,688 B,
`plasticity.json` 17,980 B, `manifest.json` 49 KB; raw downloads 11 MB.

**Things that contradicted the brief:** the zip has no `data_s2/s3/s4` files
(they are `annotations.csv`, `inputs.csv`, `outputs.csv` plus two ratio
tables); the matrices are not in a common row order; the edge count is 110,677
/ 537 autapses (the 111,243 / 536 figure is the Pedigo 3,013-node graph);
there is no `DN` flag column (`dVNCs` / `dSEZs`); DAN-h1 is absent from L1 and
DAN-k1 alone is not rewarding, so the appetitive list is DAN-i1 only; MBON-e1's
transmitter is not verifiable from text; the neurodata licence is MIT at the
archived commit but noncommercial at HEAD; the d-a weak-edge fraction is 86 %
against the paper's 91 %.

## Male — Janelia FlyEM MaleCNS v1.0 → `malecns-v1.0-projectome-1`, `malecns-v1.0-mb-1`

`build_male.py` builds two artifacts from the MaleCNS v1.0 flat-connectome release (CC BY 4.0). Every choice was pre-registered in `docs/flytown/experiments/README.md` before the first build.

### How to run

```bash
./fetch_male.sh                           # ~3 GB from Janelia's public bucket into raw/malecns/, each file checked against the bucket's MD5
.venv/bin/python build_male.py --all      # both artifacts, about 15 seconds
node ../scripts/male-rerouted-adapters.mjs   # after `npm run build`: the rerouted adapter table
```

`fetch_male.sh` downloads these files from `https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome/`:

| File | Size | Bucket MD5 (base64) |
| --- | --- | --- |
| `syn-partners-male-cns-v1.0-minconf-0.5-traced-only.feather` | 2.97 GB | `9bwcXONKAbaJVkFLUw7dqA==` |
| `body-annotations-male-cns-v1.0-minconf-0.5.feather` | 14.5 MB | `UKdxh3DFciDxYLpPQxq4ng==` |
| `body-neurotransmitters-male-cns-v1.0.feather` | 43.3 MB | `PYQrEv5cSe763lKNfdJKHw==` |

### Method

- **Region graph.** Male ROIs are mapped onto FlyWire neuropil names, and nerve-cord ROIs are dropped. Each neuron's input region is the brain neuropil holding most of its postsynaptic sites. An edge counts synapses located in a region, made by neurons whose input region is the source. This is the female build's method, restricted to the brain.
- **Missing regions.** The male release has no separate AMMC, gall or ocellar ganglion, and its IB is unsided. The manifest records the full ROI mapping, the ambiguous-ROI decisions and where the missing territories went.
- **Mushroom-body circuit.** Traced olfactory receptor neurons, projection neurons, Kenyon cells, APL, MBONs and dopaminergic neurons, with every synapse among them.
- **Transmitters.** Per neuron: the consensus prediction, else the neuron's own prediction, else its cell type's, else `UNKNOWN`. Histamine is its own class.

