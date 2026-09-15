#!/usr/bin/env python3
"""
FLYTOWN runtime artifacts from Janelia FlyEM MaleCNS v1.0 (flat connectome).

    .venv/bin/python build_male.py --all          # both artifacts
    .venv/bin/python build_male.py --projectome   # connectome/malecns-v1.0-projectome-1/
    .venv/bin/python build_male.py --mb           # connectome/malecns-v1.0-mb-1/

Inputs live in raw/malecns/ and are fetched and MD5-verified by fetch_male.sh:

    syn-partners-male-cns-v1.0-minconf-0.5-traced-only.feather   synapse pairs between traced bodies
    body-annotations-male-cns-v1.0-minconf-0.5.feather           cell types, classes, sides
    body-neurotransmitters-male-cns-v1.0.feather                 transmitter predictions per body

Every choice below was fixed before this script first ran, in the pre-registration
"the male fly (MaleCNS v1.0), pre-registered" and its addendum in
docs/flytown/experiments/README.md. The projectome follows connectome-etl/build.py
(the female FlyWire FAFB build) step for step wherever the male data allow.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import re
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.feather as pf
import pyarrow.ipc as ipc

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build import Timer, build_block, log, now_iso, sha256_file, write_json  # noqa: E402

RAW = HERE / "raw" / "malecns"
OUT_ROOT = HERE.parent / "connectome"
BUCKET = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
FILES = {
    "synPartners": ("syn-partners-male-cns-v1.0-minconf-0.5-traced-only.feather", "9bwcXONKAbaJVkFLUw7dqA=="),
    "annotations": ("body-annotations-male-cns-v1.0-minconf-0.5.feather", "UKdxh3DFciDxYLpPQxq4ng=="),
    "neurotransmitters": ("body-neurotransmitters-male-cns-v1.0.feather", "PYQrEv5cSe763lKNfdJKHw=="),
}
PROJECTOME_ID = "malecns-v1.0-projectome-1"
MB_ID = "malecns-v1.0-mb-1"
UNASSIGNED_ID = "UNASGD"
NT_CLASSES = ["ACH", "GABA", "GLUT", "DA", "OCT", "SER", "HIST", "UNKNOWN"]
NT_NAMES = {"acetylcholine": "ACH", "gaba": "GABA", "glutamate": "GLUT", "dopamine": "DA",
            "octopamine": "OCT", "serotonin": "SER", "histamine": "HIST"}
BRAIN_SUPERCLASS = re.compile(r"^(cb_|ol_|visual_)")
CITATIONS = [
    "Berg S, et al. (2025). Sexual dimorphism in the complete connectome of the Drosophila male central "
    "nervous system. bioRxiv, doi:10.1101/2025.10.09.680999",
    "MaleCNS v1.0 data release, Janelia FlyEM, https://male-cns.janelia.org/download/ (CC-BY 4.0)",
]

# ---- region names (addendum: "Region names") -------------------------------------------- #
SIDED_SAME = {"AL", "AME", "AOTU", "ATL", "AVLP", "BU", "CAN", "CRE", "EPA", "FLA", "GOR", "ICL", "IPS",
              "LA", "LAL", "LH", "LO", "LOP", "ME", "PLP", "PVLP", "SCL", "SIP", "SLP", "SMP", "SPS", "VES", "WED"}
UNSIDED_SAME = {"EB", "FB", "GNG", "IB", "NO", "PB", "PRW", "SAD"}
MB_PARTS = {"CA": "MB_CA", "PED": "MB_PED", "aL": "MB_VL", "a'L": "MB_VL", "bL": "MB_ML", "b'L": "MB_ML", "gL": "MB_ML"}
AMBIGUOUS = ("<unspecified>", "CRN")
FAFB_NODES = ("AL_L AL_R AME_L AME_R AMMC_L AMMC_R AOTU_L AOTU_R ATL_L ATL_R AVLP_L AVLP_R BU_L BU_R CAN_L CAN_R "
              "CRE_L CRE_R EB EPA_L EPA_R FB FLA_L FLA_R GA_L GA_R GNG GOR_L GOR_R IB_L IB_R ICL_L ICL_R IPS_L IPS_R "
              "LAL_L LAL_R LA_L LA_R LH_L LH_R LOP_L LOP_R LO_L LO_R MB_CA_L MB_CA_R MB_ML_L MB_ML_R MB_PED_L "
              "MB_PED_R MB_VL_L MB_VL_R ME_L ME_R NO OCG PB PLP_L PLP_R PRW PVLP_L PVLP_R SAD SCL_L SCL_R SIP_L "
              "SIP_R SLP_L SLP_R SMP_L SMP_R SPS_L SPS_R UNASGD VES_L VES_R WED_L WED_R").split()


def map_roi(roi: str) -> tuple[str, str]:
    """(kind, node). kind: brain | unassigned | ambiguous | cord."""
    if roi == "CentralBrain-unspecified" or roi.startswith("Optic-unspecified"):
        return "unassigned", UNASSIGNED_ID
    if roi in AMBIGUOUS:
        return "ambiguous", roi
    m = re.fullmatch(r"(.+)\((L|R)\)", roi)
    if m:
        base, side = m.group(1), m.group(2)
        if base in SIDED_SAME:
            return "brain", f"{base}_{side}"
        if base in MB_PARTS:
            return "brain", f"{MB_PARTS[base]}_{side}"
        if base == "AB":
            return "brain", "FB"
        return "cord", ""
    if roi in UNSIDED_SAME:
        return "brain", roi
    return "cord", ""


def base_region(roi: str) -> str:
    """FlyWire base name a male ROI maps to, without side ('WED(L)' -> 'WED', 'CA(R)' -> 'MB_CA')."""
    kind, node = map_roi(roi)
    if kind != "brain":
        return ""
    return re.sub(r"_(L|R)$", "", node)


def verify_inputs() -> list[dict]:
    out = []
    for role, (name, md5_b64) in FILES.items():
        path = RAW / name
        if not path.exists():
            raise SystemExit(f"missing input {path}; run connectome-etl/fetch_male.sh first")
        h_md5, h_sha = hashlib.md5(), hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8 << 20), b""):
                h_md5.update(chunk)
                h_sha.update(chunk)
        got = base64.b64encode(h_md5.digest()).decode()
        if got != md5_b64:
            raise SystemExit(f"MD5 mismatch for {name}: {got} != {md5_b64}")
        out.append({"role": role, "name": name, "url": f"{BUCKET}/{name}", "bytes": path.stat().st_size,
                    "md5Base64": md5_b64, "sha256": h_sha.hexdigest()})
        log(f"verified {name}")
    return out


def load_bodies() -> dict:
    ann = pf.read_table(RAW / FILES["annotations"][0],
                        columns=["bodyId", "status", "superclass", "class", "type", "instance", "somaSide"]).to_pandas()
    ann = ann[ann["status"] == "Traced"].sort_values("bodyId").reset_index(drop=True)
    ids = ann["bodyId"].to_numpy(np.int64)
    assert np.all(np.diff(ids) > 0), "duplicate traced body ids"
    nt = pf.read_table(RAW / FILES["neurotransmitters"][0],
                       columns=["body", "consensus_nt", "predicted_nt", "celltype_predicted_nt"]).to_pandas()
    nt = nt.set_index("body").reindex(ids)
    cls = np.full(len(ids), NT_CLASSES.index("UNKNOWN"), dtype=np.int8)
    source = {"consensus_nt": 0, "predicted_nt": 0, "celltype_predicted_nt": 0, "none": 0}
    for i, row in enumerate(nt.itertuples(index=False)):
        for col in ("consensus_nt", "predicted_nt", "celltype_predicted_nt"):
            v = getattr(row, col)
            if isinstance(v, str) and v in NT_NAMES:
                cls[i] = NT_CLASSES.index(NT_NAMES[v])
                source[col] += 1
                break
        else:
            source["none"] += 1
    sc = ann["superclass"].fillna("").to_numpy(object)
    return {
        "ann": ann, "ids": ids, "nt": cls, "ntSource": source,
        "brainSuperclass": np.array([bool(BRAIN_SUPERCLASS.match(s)) for s in sc]),
    }


def mb_selection(ann) -> dict:
    t = ann["type"].fillna("")
    c = ann["class"].fillna("")
    kinds = np.full(len(ann), "", dtype=object)
    kinds[(c == "olfactory").to_numpy()] = "ORN"
    alpn = (c == "ALPN").to_numpy()
    uni = alpn & ~t.str.startswith("M_").to_numpy() & ~t.str.contains("+", regex=False).to_numpy()
    kinds[alpn] = "mPN"
    kinds[uni] = "uPN"
    kinds[(c == "Kenyon_Cell").to_numpy()] = "KC"
    kinds[(t == "APL").to_numpy()] = "APL"
    kinds[(c == "MBON").to_numpy()] = "MBON"
    kinds[(c == "DAN").to_numpy()] = "DAN"
    order = ["ORN", "uPN", "mPN", "KC", "APL", "MBON", "DAN"]
    rows = []
    for k in order:
        rows.extend(np.flatnonzero(kinds == k).tolist())
    pos = np.full(len(ann), -1, dtype=np.int64)
    pos[np.array(rows, dtype=np.int64)] = np.arange(len(rows))
    return {"rows": np.array(rows, dtype=np.int64), "pos": pos, "kinds": kinds, "order": order}


def stream_synapses(bodies: dict, mb: dict, timer: Timer) -> dict:
    ids = bodies["ids"]
    N = len(ids)
    brain_nodes = sorted({node for roi in _all_rois() for kind, node in [map_roi(roi)] if kind in ("brain", "unassigned")})
    node_ids = brain_nodes                       # includes UNASGD
    n = len(node_ids)
    codes_of = {node: j for j, node in enumerate(node_ids)}
    amb_code = {roi: n + a for a, roi in enumerate(AMBIGUOUS)}
    R = n + len(AMBIGUOUS)
    POST = np.zeros(N * R, dtype=np.int64)
    PRE = np.zeros(N * R, dtype=np.int64)
    raw_names: list[str] = []
    raw_index: dict[str, int] = {}
    raw_counts: dict[int, int] = {}
    amb_brain = {roi: [0, 0] for roi in AMBIGUOUS}  # [pre is brain superclass, pre is not]
    ann = bodies["ann"]
    t = ann["type"].fillna("")
    is_jo = t.str.startswith("JO-").to_numpy()
    is_gall = t.str.match(r"^(GLNO|LNO|LCNO)").to_numpy()
    terr = {"AMMC": {}, "GA": {}}
    mb_keys: list[np.ndarray] = []
    M = len(mb["rows"])
    stats = {"rows": 0, "rowsPreNotTraced": 0, "rowsPostNotTraced": 0, "nullRoi": 0}
    pending_pre: list[np.ndarray] = []
    pending_post: list[np.ndarray] = []
    dict_cache: dict[tuple, tuple] = {}

    def flush():
        if pending_pre:
            PRE[:] += np.bincount(np.concatenate(pending_pre), minlength=N * R)
            POST[:] += np.bincount(np.concatenate(pending_post), minlength=N * R)
            pending_pre.clear()
            pending_post.clear()

    path = RAW / FILES["synPartners"][0]
    with timer("stream synapse partners"):
        with pa.memory_map(str(path), "r") as source:
            reader = ipc.open_file(source)
            nb = reader.num_record_batches
            for b in range(nb):
                batch = reader.get_batch(b)
                pre_b = batch.column("body_pre").to_numpy()
                post_b = batch.column("body_post").to_numpy()
                roi = batch.column("primary_post")
                stats["rows"] += len(pre_b)
                vals = roi.dictionary.to_pylist()
                key = tuple(vals)
                if key not in dict_cache:
                    code = np.full(len(vals) + 1, -1, dtype=np.int64)   # last slot = null
                    raw = np.zeros(len(vals) + 1, dtype=np.int64)
                    for j, v in enumerate(vals + [None]):
                        name = v if v is not None else "<null>"
                        if name not in raw_index:
                            raw_index[name] = len(raw_names)
                            raw_names.append(name)
                        raw[j] = raw_index[name]
                        kind, node = map_roi(v) if v is not None else ("ambiguous", "<unspecified>")
                        if kind in ("brain", "unassigned"):
                            if node not in codes_of:
                                raise SystemExit(f"ROI {v!r} maps to {node}, which was not in the pre-scanned node list")
                            code[j] = codes_of[node]
                        elif kind == "ambiguous":
                            code[j] = amb_code[node]
                    dict_cache[key] = (code, raw, len(vals))
                code_map, raw_map, nvals = dict_cache[key]
                idx = roi.indices.fill_null(nvals).to_numpy(zero_copy_only=False).astype(np.int64)
                stats["nullRoi"] += int((idx == nvals).sum())
                c = code_map[idx]
                for r_i, cnt in zip(*np.unique(raw_map[idx], return_counts=True)):
                    raw_counts[int(r_i)] = raw_counts.get(int(r_i), 0) + int(cnt)

                pi = np.searchsorted(ids, pre_b)
                qi = np.searchsorted(ids, post_b)
                pi_c = np.minimum(pi, N - 1)
                qi_c = np.minimum(qi, N - 1)
                ok_pre = ids[pi_c] == pre_b
                ok_post = ids[qi_c] == post_b
                stats["rowsPreNotTraced"] += int((~ok_pre).sum())
                stats["rowsPostNotTraced"] += int((~ok_post).sum())
                ok = ok_pre & ok_post

                # territory checks: where do marker neurons make their synapses?
                for label, mask_arr in (("AMMC", is_jo), ("GA", is_gall)):
                    sel = ok & mask_arr[pi_c]
                    if sel.any():
                        for r_i, cnt in zip(*np.unique(raw_map[idx[sel]], return_counts=True)):
                            terr[label][int(r_i)] = terr[label].get(int(r_i), 0) + int(cnt)

                # ambiguous ROIs: count presynaptic superclass (addendum rule)
                for roi_name, ac in amb_code.items():
                    sel = ok & (c == ac)
                    if sel.any():
                        brain = bodies["brainSuperclass"][pi_c[sel]]
                        amb_brain[roi_name][0] += int(brain.sum())
                        amb_brain[roi_name][1] += int((~brain).sum())

                keep = ok & (c >= 0)
                pending_pre.append(pi_c[keep] * R + c[keep])
                pending_post.append(qi_c[keep] * R + c[keep])

                mp = mb["pos"][pi_c]
                mq = mb["pos"][qi_c]
                both = ok & (mp >= 0) & (mq >= 0)
                if both.any():
                    mb_keys.append(mp[both] * M + mq[both])

                if sum(len(x) for x in pending_pre) > 4_000_000:
                    flush()
                if b % 200 == 0:
                    log(f"  batch {b}/{nb}, rows so far {stats['rows']:,}")
            flush()

    POST = POST.reshape(N, R)
    PRE = PRE.reshape(N, R)
    # fold ambiguous ROIs into UNASGD or drop them (addendum rule)
    amb_decision = {}
    un = codes_of[UNASSIGNED_ID]
    for roi_name, ac in amb_code.items():
        brain_n, other_n = amb_brain[roi_name]
        is_brain = brain_n > other_n
        amb_decision[roi_name] = {"synapsesFromBrainSuperclass": brain_n, "synapsesFromOther": other_n,
                                  "decision": "UNASGD" if is_brain else "dropped"}
        if is_brain:
            POST[:, un] += POST[:, ac]
            PRE[:, un] += PRE[:, ac]
    POST = POST[:, :n].copy()
    PRE = PRE[:, :n].copy()
    if mb_keys:
        u, cnt = np.unique(np.concatenate(mb_keys), return_counts=True)
    else:
        u, cnt = np.array([], dtype=np.int64), np.array([], dtype=np.int64)

    def top(counts: dict, k=12):
        items = sorted(counts.items(), key=lambda kv: -kv[1])[:k]
        total = sum(counts.values()) or 1
        return [{"roi": raw_names[i], "synapses": v, "fraction": round(v / total, 4)} for i, v in items]

    territories = {}
    for label, counts in terr.items():
        brain_items = [(i, v) for i, v in counts.items() if base_region(raw_names[i])]
        brain_items.sort(key=lambda kv: -kv[1])
        bases: dict[str, int] = {}
        for i, v in brain_items:
            bases[base_region(raw_names[i])] = bases.get(base_region(raw_names[i]), 0) + v
        best = max(bases.items(), key=lambda kv: kv[1])[0] if bases else None
        territories[label] = {
            "markerTypes": "JO-*" if label == "AMMC" else "GLNO, LNO*, LCNO*",
            "presynapticSitesByRoi": top(counts),
            "brainBaseTotals": dict(sorted(bases.items(), key=lambda kv: -kv[1])[:8]),
            "reroutedTo": best,
        }
    return {
        "node_ids": node_ids, "POST": POST, "PRE": PRE, "stats": stats,
        "rawRoiTotals": {raw_names[i]: v for i, v in sorted(raw_counts.items(), key=lambda kv: -kv[1])},
        "ambiguous": amb_decision, "territories": territories,
        "mbPairs": (u // M, u % M, cnt),
    }


def _all_rois() -> list[str]:
    path = RAW / FILES["synPartners"][0]
    with pa.memory_map(str(path), "r") as source:
        reader = ipc.open_file(source)
        vals: set[str] = set()
        for b in range(reader.num_record_batches):
            d = reader.get_batch(b).column("primary_post").dictionary
            vals.update(v for v in d.to_pylist() if v is not None)
            if b > 3:
                break
    return sorted(vals)


def assign_regions(node_ids: list[str], POST: np.ndarray, PRE: np.ndarray) -> tuple[np.ndarray, dict]:
    n = len(node_ids)
    un = node_ids.index(UNASSIGNED_ID)
    real = np.array([j for j in range(n) if j != un])
    post_real = POST[:, real]
    pre_real = PRE[:, real]
    region = np.full(POST.shape[0], -1, dtype=np.int64)
    has_post = post_real.sum(axis=1) > 0
    region[has_post] = real[np.argmax(post_real[has_post], axis=1)]
    ties_post = int((has_post & ((post_real == post_real.max(axis=1, keepdims=True)).sum(axis=1) > 1)).sum())
    fb = ~has_post & (pre_real.sum(axis=1) > 0)
    region[fb] = real[np.argmax(pre_real[fb], axis=1)]
    only_un = (region < 0) & ((POST[:, un] > 0) | (PRE[:, un] > 0))
    region[only_un] = un
    stats = {
        "inputFromPostArgmax": int(has_post.sum()),
        "inputTiesPost": ties_post,
        "inputFallbackToPreArgmax": int(fb.sum()),
        "inputAssignedUnassigned": int(only_un.sum()),
        "neuronsWithoutBrainSynapses": int((region < 0).sum()),
    }
    return region, stats


def build_projectome(bodies: dict, agg: dict, files: list[dict], timer: Timer) -> dict:
    node_ids = agg["node_ids"]
    n = len(node_ids)
    POST, PRE = agg["POST"], agg["PRE"]
    with timer("assign input regions"):
        region, rstats = assign_regions(node_ids, POST, PRE)
    K = len(NT_CLASSES)
    with timer("aggregate projectome edges"):
        Wnt = np.zeros((n, n, K), dtype=np.int64)
        valid = region >= 0
        for r in range(n):
            rows = valid & (region == r)
            if not rows.any():
                continue
            for k in range(K):
                sel = rows & (bodies["nt"] == k)
                if sel.any():
                    Wnt[r, :, k] = PRE[sel].sum(axis=0)
        Wm = Wnt.sum(axis=2)
        dropped_syn = int(PRE[~valid].sum())
        src, dst = np.nonzero(Wm)
        order = np.lexsort((dst, src))
        e_src, e_dst = src[order], dst[order]
        e_w = Wm[e_src, e_dst]
        e_nt = Wnt[e_src, e_dst]
        neuron_count = np.bincount(region[valid], minlength=n)
        total_syn = int(Wm.sum())
        log(f"projectome: {n} nodes, {len(e_w):,} edges, {total_syn:,} synapses; "
            f"{rstats['neuronsWithoutBrainSynapses']:,} traced neurons have no brain synapses ({dropped_syn:,} synapses dropped)")

    out_dir = OUT_ROOT / PROJECTOME_ID
    out_dir.mkdir(parents=True, exist_ok=True)
    nodes = [{"id": nid, "index": i, "provenance": "MEASURED", "neuronCount": int(neuron_count[i]),
              "inSynapses": int(Wm[:, i].sum()), "outSynapses": int(Wm[i, :].sum()),
              "outNt": {cls: int(Wnt[i, :, k].sum()) for k, cls in enumerate(NT_CLASSES)}} for i, nid in enumerate(node_ids)]
    write_json(out_dir / "nodes.json", nodes)
    graph = {"format": "coo", "n": n, "src": e_src.tolist(), "dst": e_dst.tolist(), "weight": e_w.tolist(),
             "nt": {cls: e_nt[:, k].tolist() for k, cls in enumerate(NT_CLASSES)}}
    import json
    (out_dir / "graph.json").write_text(json.dumps(graph, separators=(",", ":")) + "\n")

    order_w = np.argsort(-e_w, kind="stable")
    top = [{"src": node_ids[e_src[j]], "dst": node_ids[e_dst[j]], "weight": int(e_w[j]), "self": bool(e_src[j] == e_dst[j])} for j in order_w[:25]]
    top_nonself = [{"src": node_ids[e_src[j]], "dst": node_ids[e_dst[j]], "weight": int(e_w[j])} for j in order_w if e_src[j] != e_dst[j]][:25]
    self_syn = int(np.trace(Wm))
    checks = []
    for s, d in [("AL_L", "MB_CA_L"), ("AL_L", "LH_L"), ("AL_R", "MB_CA_R"), ("AL_R", "LH_R"),
                 ("MB_CA_L", "MB_PED_L"), ("MB_CA_L", "MB_VL_L"), ("MB_CA_L", "MB_ML_L"),
                 ("MB_CA_R", "MB_PED_R"), ("MB_CA_R", "MB_VL_R"), ("MB_CA_R", "MB_ML_R"),
                 ("ME_L", "LO_L"), ("LO_L", "LOP_L"), ("ME_R", "LO_R"), ("LO_R", "LOP_R"),
                 ("LA_L", "ME_L"), ("LA_R", "ME_R"), ("PB", "EB"), ("EB", "PB"), ("FB", "EB"), ("GNG", "SAD")]:
        if s in node_ids and d in node_ids:
            si, di = node_ids.index(s), node_ids.index(d)
            wgt = int(Wm[si, di])
            row = Wm[si].copy()
            row[si] = 0
            checks.append({"src": s, "dst": d, "weight": wgt,
                           "rankAmongSrcOutEdgesExclSelf": int((row > wgt).sum()) + 1 if wgt > 0 else None,
                           "fractionOfSrcOutExclSelf": round(float(wgt / row.sum()), 4) if row.sum() else None})
    manifest = {
        "artifactVersion": 1,
        "id": PROJECTOME_ID,
        "level": "projectome",
        "createdAt": now_iso(),
        "source": {
            "dataset": "Janelia FlyEM MaleCNS v1.0 connectome (adult male Drosophila melanogaster, brain and ventral nerve cord), flat-connectome release",
            "files": files, "license": "CC-BY-4.0", "citations": CITATIONS,
            "preRegistration": "docs/flytown/experiments/README.md — 'the male fly (MaleCNS v1.0), pre-registered' and its addendum",
        },
        "preprocessing": {
            "tool": "connectome-etl/build_male.py",
            "steps": [
                "Verify every input against the bucket's MD5.",
                "Neuron universe = bodies with status 'Traced' in the annotation table.",
                "Stream the synapse-partner table (both partners traced, synapse confidence >= 0.5). Each row is one synapse; its region is the ROI of the postsynaptic site (`primary_post`).",
                "Map male ROIs onto FlyWire neuropil names (see roiMapping); nerve-cord and neck ROIs are dropped; CentralBrain-unspecified and Optic-unspecified become UNASGD; '<unspecified>' and 'CRN' are resolved by presynaptic superclass (see ambiguousRois).",
                "input_region(neuron) = brain neuropil (not UNASGD) holding most of its postsynaptic sites; ties -> alphabetically first; no brain postsynaptic sites -> brain neuropil holding most of its presynaptic sites; only UNASGD synapses -> UNASGD; no brain synapses at all -> not part of the brain projectome.",
                "Edge input_region(pre) -> region of the synapse, weight = synapse count; nt[class of pre] += count.",
                "Transmitter per neuron: consensus prediction, else the neuron's prediction, else its cell type's, else UNKNOWN; histamine is its own class HIST.",
            ],
            "regionAssignment": rstats,
            "synapseRows": agg["stats"],
            "rawRoiSynapseTotals": agg["rawRoiTotals"],
            "ambiguousRois": agg["ambiguous"],
            "roiMapping": {roi: (map_roi(roi)[1] or "dropped (nerve cord)") if map_roi(roi)[0] != "ambiguous" else "see ambiguousRois"
                           for roi in agg["rawRoiTotals"] if roi != "<null>"},
            "fafbNodesAbsent": [x for x in FAFB_NODES if x not in node_ids],
            "maleNodesNotInFafb": [x for x in node_ids if x not in FAFB_NODES],
            "ntSourceCounts": bodies["ntSource"],
            "assumptions": [
                {"id": "syn_count_as_weight", "category": "ENGINEERING_CHOICE",
                 "text": "Edge weight = number of synapses. A structural proxy for strength, not a physiological weight; the male release has no gap junctions."},
                {"id": "input_region_argmax_brain_only", "category": "ENGINEERING_CHOICE",
                 "text": "As in the female build, each neuron is collapsed to one input region, but only brain neuropils count, so the male brain is seen as FAFB sees the female one: a brain without its cord."},
                {"id": "traced_partners_only", "category": "ENGINEERING_CHOICE",
                 "text": "Input regions come from synapses between traced bodies only; the female build counted all partners. Stated in the pre-registration."},
                {"id": "edge_dst_is_synapse_location", "category": "ENGINEERING_CHOICE",
                 "text": "Edge destination = ROI of the postsynaptic site, matching the female build's use of the synapse's neuropil."},
                {"id": "nt_per_neuron", "category": "ENGINEERING_CHOICE",
                 "text": "Transmitter class per edge = presynaptic neuron's class (female build: per-connection means). Predictions are statistical, not measurements."},
                {"id": "roi_merges", "category": "INFERRED_FROM_LITERATURE",
                 "text": "CA/PED -> MB_CA/MB_PED; alpha and alpha' lobes -> MB_VL; beta, beta' and gamma lobes -> MB_ML; the asymmetrical body -> FB (it is a fan-shaped body subunit). The male release has no separate AMMC, gall or ocellar ganglion, and an unsided IB."},
            ],
            "territories": agg["territories"],
        },
        "graph": {"nodeCount": n, "edgeCount": int(len(e_w)), "totalSynapses": total_syn, "weightSemantics": "synapse_count",
                  "ntClasses": NT_CLASSES, "unassignedNodeId": UNASSIGNED_ID, "selfEdges": int(sum(1 for i in range(n) if Wm[i, i] > 0))},
        "stats": {"selfEdgeSynapses": self_syn, "selfEdgeFraction": round(self_syn / total_syn, 4),
                  "ntSynapseTotals": {cls: int(Wnt[:, :, k].sum()) for k, cls in enumerate(NT_CLASSES)},
                  "topEdges": top, "topEdgesExcludingSelf": top_nonself, "sanityChecks": checks},
        "build": build_block(timer),
        "checksums": {"nodes.json": "sha256:" + sha256_file(out_dir / "nodes.json"),
                      "graph.json": "sha256:" + sha256_file(out_dir / "graph.json")},
    }
    write_json(out_dir / "manifest.json", manifest)
    log(f"wrote {out_dir}")
    print("\nnodes:", " ".join(node_ids))
    print("absent FAFB nodes:", manifest["preprocessing"]["fafbNodesAbsent"], "| male-only nodes:", manifest["preprocessing"]["maleNodesNotInFafb"])
    print("region assignment:", rstats)
    print("ambiguous ROIs:", agg["ambiguous"])
    for label, t_ in agg["territories"].items():
        print(f"territory {label}: rerouted to {t_['reroutedTo']}; top ROIs {[(x['roi'], x['fraction']) for x in t_['presynapticSitesByRoi'][:6]]}")
    print("\nsanity checks:")
    for ch in checks:
        print(f"  {ch['src']:>8} -> {ch['dst']:<8} w={ch['weight']:>10,}  rank(out of src, excl self)={ch['rankAmongSrcOutEdgesExclSelf']}  frac={ch['fractionOfSrcOutExclSelf']}")
    print(f"self-edge fraction {manifest['stats']['selfEdgeFraction']}; NT totals {manifest['stats']['ntSynapseTotals']}")
    return manifest


def build_mb(bodies: dict, mb: dict, agg: dict, files: list[dict], timer: Timer) -> dict:
    ann = bodies["ann"]
    rows = mb["rows"]
    M = len(rows)
    pre, post, cnt = agg["mbPairs"]
    order = np.lexsort((post, pre))
    pre, post, cnt = pre[order], post[order], cnt[order]
    nt_pre = bodies["nt"][rows[pre]]
    in_syn = np.bincount(post, weights=cnt, minlength=M).astype(np.int64)
    out_syn = np.bincount(pre, weights=cnt, minlength=M).astype(np.int64)
    group_counts: dict[str, int] = {}
    nodes = []
    for k, r in enumerate(rows):
        kind = mb["kinds"][r]
        a = ann.iloc[int(r)]
        side = a["somaSide"] if isinstance(a["somaSide"], str) else None
        groups = {
            "ORN": ["sens:olfactory", "class2:ORN", "type:ORN"],
            "uPN": ["class:uPN", "class:PN", "type:PN"],
            "mPN": ["class:mPN", "class:PN", "type:PN"],
            "KC": ["flag:KC", "class:KC", "type:KC"],
            "APL": ["class:APL", "type:APL"],
            "MBON": ["flag:MBON", "class:MBON", "type:MBON"],
            "DAN": ["flag:MBIN", "class:MBIN", "class2:DAN", "type:MBIN"],
        }[kind] + ([f"side:{side}"] if side in ("L", "R") else [])
        for g in groups:
            group_counts[g] = group_counts.get(g, 0) + 1
        nodes.append({"id": str(int(a["bodyId"])), "index": k, "provenance": "MEASURED",
                      "name": a["instance"] if isinstance(a["instance"], str) else None,
                      "cellType": a["type"] if isinstance(a["type"], str) else None,
                      "class": kind, "hemisphere": side, "groups": groups,
                      "inSynapses": int(in_syn[k]), "outSynapses": int(out_syn[k])})
    out_dir = OUT_ROOT / MB_ID
    out_dir.mkdir(parents=True, exist_ok=True)
    write_json(out_dir / "nodes.json", nodes)
    import json
    graph = {"format": "coo", "n": M, "src": pre.tolist(), "dst": post.tolist(), "weight": cnt.tolist(),
             "nt": {cls: np.where(nt_pre == k, cnt, 0).tolist() for k, cls in enumerate(NT_CLASSES)}}
    (out_dir / "graph.json").write_text(json.dumps(graph, separators=(",", ":")) + "\n")
    kind_counts = {k: int((mb["kinds"][rows] == k).sum()) for k in mb["order"]}
    manifest = {
        "artifactVersion": 1, "id": MB_ID, "level": "neuron", "createdAt": now_iso(),
        "source": {"dataset": "Janelia FlyEM MaleCNS v1.0 connectome (adult male Drosophila melanogaster), olfactory and mushroom-body circuit",
                   "files": files, "license": "CC-BY-4.0", "citations": CITATIONS,
                   "preRegistration": "docs/flytown/experiments/README.md — 'the male fly (MaleCNS v1.0), pre-registered' and its addendum"},
        "preprocessing": {
            "tool": "connectome-etl/build_male.py",
            "steps": [
                "Traced bodies of class olfactory (ORN), ALPN (uniglomerular = type not starting 'M_' and naming a single glomerulus, i.e. no '+'; the rest multiglomerular), Kenyon_Cell, MBON, DAN, and type APL. Both hemispheres.",
                "Edges = synapse counts between those neurons, summed over every ROI, from the synapse-partner table.",
                "Transmitter per edge = presynaptic neuron's class (consensus, else own prediction, else cell type's, else UNKNOWN; histamine = HIST).",
            ],
            "counts": kind_counts,
            "assumptions": [
                {"id": "circuit_subgraph", "category": "ENGINEERING_CHOICE",
                 "text": "Only the olfactory and mushroom-body circuit is included, so label shuffling and rewiring nulls act within this circuit (the larval nulls acted on the whole larval brain)."},
                {"id": "uPN_rule", "category": "INFERRED_FROM_LITERATURE",
                 "text": "Uniglomerular vs multiglomerular projection neurons from the FlyWire/hemibrain naming convention: multiglomerular types start with 'M_'; types naming two glomeruli with '+' are excluded from the uniglomerular layer."},
            ],
        },
        "graph": {"nodeCount": M, "edgeCount": int(len(cnt)), "totalSynapses": int(cnt.sum()), "weightSemantics": "synapse_count", "ntClasses": NT_CLASSES},
        "nodeFields": {"id": "MaleCNS bodyId", "cellType": "annotation type", "class": "ORN|uPN|mPN|KC|APL|MBON|DAN", "hemisphere": "somaSide"},
        "groups": group_counts,
        "build": build_block(timer),
        "checksums": {"nodes.json": "sha256:" + sha256_file(out_dir / "nodes.json"),
                      "graph.json": "sha256:" + sha256_file(out_dir / "graph.json")},
    }
    write_json(out_dir / "manifest.json", manifest)
    log(f"wrote {out_dir}: {M:,} neurons, {len(cnt):,} edges, {int(cnt.sum()):,} synapses; counts {kind_counts}")
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--projectome", action="store_true")
    ap.add_argument("--mb", action="store_true")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    if args.all:
        args.projectome = args.mb = True
    if not (args.projectome or args.mb):
        ap.error("choose --projectome, --mb or --all")
    timer = Timer()
    with timer("verify inputs"):
        files = verify_inputs()
    with timer("load bodies"):
        bodies = load_bodies()
        mb = mb_selection(bodies["ann"])
        log(f"{len(bodies['ids']):,} traced bodies; transmitter sources {bodies['ntSource']}")
    agg = stream_synapses(bodies, mb, timer)
    if args.projectome:
        build_projectome(bodies, agg, files, timer)
    if args.mb:
        build_mb(bodies, mb, agg, files, timer)


if __name__ == "__main__":
    main()
