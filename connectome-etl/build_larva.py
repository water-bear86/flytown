#!/usr/bin/env python3
"""
FLYTOWN connectome ETL — Winding et al. 2023 first-instar (L1) larval brain
-> connectome/l1-larva-winding2023-1/ (neuron level, four synapse-type channels).

    python build_larva.py --download   # fetch + verify raw inputs into raw/larva/
    python build_larva.py --build      # build ../connectome/l1-larva-winding2023-1/
    python build_larva.py --all        # both, in that order

Primary connectivity source: Science Data S1 of Winding et al. 2023 (dense per-
synapse-type adjacency matrices a-d / a-a / d-d / d-a), mirrored on GitHub by
brain-networks/larval-drosophila-connectome and pinned to a commit.  Annotations
come from Data S1's own annotations.csv (the paper's cell-type table, which also
carries the mushroom-body neuron names) and from the processed node table of
Pedigo et al. 2023 (neurodata/bilateral-connectome, tag elife-v5 == Zenodo
10.5281/zenodo.7733481).  The Pedigo edge list is used ONLY as a cross-check.

Nothing in nodes.json / graph.json is inferred: it is the published data
re-indexed.  plasticity.json is a curated literature table; every entry is tagged
MEASURED / INFERRED_FROM_LITERATURE / ENGINEERING_CHOICE.  Deterministic given
the pinned inputs; only createdAt and the timings vary.  See README.md ("Larva").
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import time
import zipfile
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
import requests

# Small shared helpers (hashing, JSON, resumable HTTP download, timer, build block).
from build import (Timer, build_block, file_hashes, git_blob_sha1, http_download, log, now_iso,
                   sha256_file, write_json)

# --------------------------------------------------------------------------- #
# Pinned sources
# --------------------------------------------------------------------------- #
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DEFAULT_RAW = HERE / "raw" / "larva"
DEFAULT_OUT = REPO_ROOT / "connectome"
ARTIFACT_ID = "l1-larva-winding2023-1"

# 1) Science Data S1 (Winding et al. 2023), GitHub mirror pinned to a commit.
S1_REPO = "brain-networks/larval-drosophila-connectome"
S1_COMMIT = "15e065f5c29f08c96ccd64ea8fe0f51510629009"  # HEAD of main, 2024-05-03 "Update README.md"
S1_ZIP = "Supplementary-Data-S1.zip"
S1_URL = f"https://raw.githubusercontent.com/{S1_REPO}/{S1_COMMIT}/{S1_ZIP}"
# Members of the zip actually used (names as found inside the archive).
S1_MATRIX = {ch: f"Supplementary-Data-S1/{ch}_connectivity_matrix.csv" for ch in ("aa", "ad", "da", "dd")}
S1_MATRIX_ALL = "Supplementary-Data-S1/all-all_connectivity_matrix.csv"
S1_ANNOTATIONS = "Supplementary-Data-S1/annotations.csv"
S1_INPUTS = "Supplementary-Data-S1/inputs.csv"
S1_OUTPUTS = "Supplementary-Data-S1/outputs.csv"
S1_LICENSE = (
    "NOT CONFIRMED; cite Winding et al. 2023. The Supplementary Data S1 archive carries no licence "
    "file of its own. The GitHub mirror brain-networks/larval-drosophila-connectome has no LICENSE file "
    f"(GitHub API license=null at commit {S1_COMMIT[:8]}); its README says only: 'Connectome data from "
    "Winding et al (2023) Science. These data were originally made available as part of the previously "
    "mentioned manuscript.' The article itself is open access: the PMC full text (PMC7614541) carries two "
    "licence statements, 'exclusive licensee American Association for the Advancement of Science. No claim "
    "to original US government works. https://www.sciencemag.org/about/science-licenses-journal-article-reuse' "
    "and 'This work is licensed under a CC BY 4.0 International license.' (Europe PMC metadata: "
    "isOpenAccess=Y, license='cc by'). Whether CC BY 4.0 extends to the supplementary data file could not be "
    "confirmed (science.org answers automated requests with HTTP 403)."
)

# 2) neurodata/bilateral-connectome (Pedigo et al. 2023, eLife): processed node table + edge list.
#    Pinned to the tagged commit that Zenodo archived (elife-v5); the same two files at the
#    repository HEAD (0ff9bbe0, 2024-04-05) are byte-identical but HEAD swapped the licence.
ND_REPO = "neurodata/bilateral-connectome"
ND_TAG = "elife-v5"
ND_COMMIT = "4482b9022f27d361011c9c7442e32ca51d607d08"
ND_HEAD_COMMIT = "0ff9bbe0515504b88ac827c6a31481db47a92ad2"
ND_FILES = {
    "nodes": "data/processed-elife/unmatched_full_nodes.csv",
    "edgelist": "data/processed-elife/unmatched_full_edgelist.csv",
}
ND_ZENODO_RECORD = "7733481"
ND_ZENODO_DOI = "10.5281/zenodo.7733481"
ND_ZENODO_API = f"https://zenodo.org/api/records/{ND_ZENODO_RECORD}"
ND_ZENODO_KEY = "neurodata/bilateral-connectome-elife-v5.zip"
ND_ZENODO_LOCAL = "bilateral-connectome-elife-v5.zip"
ND_ZENODO_PREFIX = "neurodata-bilateral-connectome-4482b90/"
ND_LICENSE = (
    f"MIT License at the pinned commit {ND_COMMIT[:8]} (tag {ND_TAG}, the version archived as Zenodo "
    f"{ND_ZENODO_DOI}, Zenodo licence id 'other-open'). LICENSE file verbatim: 'MIT License / Copyright (c) "
    "2021, NeuroData Lab at Johns Hopkins University, Benjamin D. Pedigo / Permission is hereby granted, free "
    "of charge, to any person obtaining a copy of this software and associated documentation files (the "
    "\"Software\"), to deal in the Software without restriction, including without limitation the rights to "
    "use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to "
    "permit persons to whom the Software is furnished to do so, subject to the following conditions: The "
    "above copyright notice and this permission notice shall be included in all copies or substantial "
    "portions of the Software. THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, ...'. "
    f"NOTE: the repository HEAD ({ND_HEAD_COMMIT[:8]}, 2024-04-05, commit 'Update LICENSE') replaced this "
    "with the PolyForm Noncommercial License 1.0.0 (GitHub API license key 'other', spdx NOASSERTION); the "
    "two CSV files used here are byte-identical (SHA-256) between the archived MIT commit and HEAD. The "
    "connectivity itself is Winding et al. 2023's; these CSVs are Pedigo et al. 2023's processed form "
    "(eLife article CC BY 4.0)."
)

CHANNELS = ["ad", "aa", "dd", "da"]  # order used everywhere in the artifact
CHANNEL_MEANING = {
    "ad": "axo-dendritic: presynaptic site on the axon of `src`, postsynaptic site on the dendrite of `dst`",
    "aa": "axo-axonic: presynaptic site on the axon of `src`, postsynaptic site on the axon of `dst`",
    "dd": "dendro-dendritic: presynaptic site on the dendrite of `src`, postsynaptic site on the dendrite of `dst`",
    "da": "dendro-axonic: presynaptic site on the dendrite of `src`, postsynaptic site on the axon of `dst`",
}

CITATIONS = [
    "Winding et al. 2023, Science 379:eadd9330, doi:10.1126/science.add9330 (The connectome of an insect brain; primary data = Supplementary Data S1)",
    "Eichler et al. 2017, Nature, doi:10.1038/nature23455 (The complete connectome of a learning and memory centre in an insect brain; mushroom-body cell names, transmitter identities)",
    "Eschbach et al. 2020, Nature Neuroscience, doi:10.1038/s41593-020-0607-9 (Recurrent architecture for adaptive regulation of learning in the insect brain; DAN valences, feedback-neuron transmitters)",
    "Saumweber et al. 2018, Nature Communications, doi:10.1038/s41467-018-03130-1 (Functional architecture of reward learning in mushroom body extrinsic neurons of larval Drosophila; DAN-i1 reward sufficiency)",
    "Pedigo et al. 2023, eLife, doi:10.7554/eLife.83739 (Generative network modeling reveals quantitative definitions of bilateral symmetry exhibited by a whole insect brain connectome; processed node/edge tables)",
    "Saalfeld et al. 2009, Bioinformatics, doi:10.1093/bioinformatics/btp266 (CATMAID: collaborative annotation toolkit for massive amounts of image data; reconstruction platform, skeleton ids)",
    "Jürgensen et al. 2024, iScience, doi:10.1016/j.isci.2023.108640 (Prediction error drives associative learning and conditioned behavior in a spiking model of Drosophila larva; formal KC>MBON learning rule)",
]
CITATION_VERIFICATION = (
    "All seven DOIs resolved through the Crossref REST API on the build date (first author, year, journal and "
    "title matched); Zenodo DOI 10.5281/zenodo.7733481 resolved through the Zenodo and DataCite APIs "
    "(title 'neurodata/bilateral-connectome: elife-v5')."
)

# Pedigo et al. `simple_group` -> the paper's own cell-type spelling (Data S1 annotations.csv `celltype`).
# Verified 1:1 on the 2,606 neurons present in both tables except 6 PN-somato neurons (Data S1 wins).
ND_SIMPLE_GROUP_TO_S1 = {
    "pre-dVNCs": "pre-DN-VNC", "sensories": "sensory", "unk": "Other", "PNs": "PN", "LHNs": "LHN",
    "dVNCs": "DN-VNC", "dSEZs": "DN-SEZ", "PNs-somato": "PN-somato", "KCs": "KC", "LNs": "LN",
    "MB-FBNs": "MB-FBN", "pre-dSEZs": "pre-DN-SEZ", "CNs": "CN", "RGNs": "RGN", "FFNs": "MB-FFN",
    "MBONs": "MBON", "ascendings": "ascending", "MBINs": "MBIN",
}
# additional_annotations tokens that are a modality for `ascending` neurons (Data S1 vocabulary).
ASCENDING_MODALITIES = {"mechano-Ch", "proprio", "noci", "mechano-II/III"}
# Data S1 celltype -> flags, for the 4 neurons that are in the matrices but not in the Pedigo table.
S1_CELLTYPE_FLAGS = {"KC": "KC", "MBON": "MBON", "MBIN": "MBIN", "DN-VNC": "dVNC", "DN-SEZ": "dSEZ", "RGN": "RGN"}


def modality_group(label: str) -> str:
    return "sens:" + label.strip().lower().replace("/", "-").replace(" ", "-")


# --------------------------------------------------------------------------- #
# Step 1: download + verify
# --------------------------------------------------------------------------- #


def gh_json(url: str) -> tuple[dict | list | None, str]:
    try:
        r = requests.get(url, headers={"Accept": "application/vnd.github+json"}, timeout=60)
        if r.ok:
            return r.json(), "OK"
        return None, f"GitHub API HTTP {r.status_code}"
    except requests.RequestException as e:
        return None, f"GitHub API {e.__class__.__name__}"


def fetch_github_file(raw: Path, repo: str, commit: str, path: str, role: str) -> dict:
    """Download `path` from `repo` at `commit` and verify its git blob SHA-1 via the contents API."""
    dest = raw / Path(path).name
    url = f"https://raw.githubusercontent.com/{repo}/{commit}/{path}"
    api, status = gh_json(f"https://api.github.com/repos/{repo}/contents/{path}?ref={commit}")
    expected_sha = api.get("sha") if isinstance(api, dict) else None
    expected_size = int(api["size"]) if isinstance(api, dict) and "size" in api else None
    if dest.exists() and expected_sha and git_blob_sha1(dest) != expected_sha:
        log(f"{dest.name}: present but git blob SHA-1 differs from {commit[:8]}; re-downloading")
        dest.unlink()
    if not dest.exists():
        log(f"{dest.name}: downloading from {url}")
        http_download(url, dest, expected_size)
    md5, sha256, n = file_hashes(dest)
    blob = git_blob_sha1(dest)
    if expected_sha:
        check = "OK" if blob == expected_sha else f"MISMATCH (GitHub {expected_sha})"
    else:
        check = f"unverified ({status})"
    if check.startswith("MISMATCH"):
        raise RuntimeError(f"{dest.name}: git blob SHA-1 {blob} {check}; stopping (never build from unverified data)")
    log(f"{dest.name}: {n:,} bytes, git blob sha1 {blob} check={check}")
    return {"role": role, "name": dest.name, "path": path, "repo": repo, "commit": commit, "url": url,
            "bytes": n, "sha256": sha256, "md5": md5, "gitBlobSha1": blob, "gitBlobSha1Check": check}


def download(raw: Path) -> dict:
    raw.mkdir(parents=True, exist_ok=True)
    repo_license = {}
    for repo in (S1_REPO, ND_REPO):
        meta, status = gh_json(f"https://api.github.com/repos/{repo}")
        repo_license[repo] = (meta.get("license") if isinstance(meta, dict) else f"unverified ({status})")
        log(f"{repo}: GitHub license field = {repo_license[repo]}")

    files = [fetch_github_file(raw, S1_REPO, S1_COMMIT, S1_ZIP, "dataS1")]
    with zipfile.ZipFile(raw / S1_ZIP) as zf:
        names = zf.namelist()
        for member in list(S1_MATRIX.values()) + [S1_MATRIX_ALL, S1_ANNOTATIONS, S1_INPUTS, S1_OUTPUTS]:
            if member not in names:
                raise RuntimeError(f"{S1_ZIP}: expected member {member} not found; contents: {names}")
        members = []
        for info in zf.infolist():
            if info.filename.startswith("__MACOSX") or info.is_dir():
                continue
            data = zf.read(info.filename)
            members.append({"name": info.filename, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                            "used": info.filename in set(S1_MATRIX.values()) | {S1_MATRIX_ALL, S1_ANNOTATIONS, S1_INPUTS, S1_OUTPUTS}})
    log(f"{S1_ZIP}: {len(members)} data members: {[m['name'].split('/')[-1] for m in members]}")

    for role, path in ND_FILES.items():
        files.append(fetch_github_file(raw, ND_REPO, ND_COMMIT, path, f"neurodata_{role}"))

    # Zenodo archive of the same tagged commit: verify MD5 against the record and that the two CSVs
    # inside are byte-identical to the GitHub copies (DOI-backed provenance for the annotation table).
    log(f"fetching {ND_ZENODO_API}")
    rec = requests.get(ND_ZENODO_API, timeout=60).json()
    entry = {f["key"]: f for f in rec["files"]}[ND_ZENODO_KEY]
    algo, _, expected_md5 = entry["checksum"].partition(":")
    assert algo == "md5", entry["checksum"]
    zdest = raw / ND_ZENODO_LOCAL
    if zdest.exists() and file_hashes(zdest)[0] != expected_md5:
        zdest.unlink()
    if not zdest.exists():
        log(f"{ND_ZENODO_LOCAL}: downloading {int(entry['size']) / 1e6:.1f} MB from {entry['links']['self']}")
        http_download(entry["links"]["self"], zdest, int(entry["size"]))
    zmd5, zsha, zn = file_hashes(zdest)
    if zmd5 != expected_md5:
        zdest.unlink()
        raise RuntimeError(f"{ND_ZENODO_LOCAL}: md5 {zmd5} != Zenodo {expected_md5}; file removed")
    by_role = {f["role"]: f for f in files}
    zenodo_members = []
    with zipfile.ZipFile(zdest) as zf:
        for role, path in ND_FILES.items():
            data = zf.read(ND_ZENODO_PREFIX + path)
            sha = hashlib.sha256(data).hexdigest()
            same = sha == by_role[f"neurodata_{role}"]["sha256"]
            zenodo_members.append({"name": ND_ZENODO_PREFIX + path, "bytes": len(data), "sha256": sha,
                                   "identicalToGitHubCopy": same})
            if not same:
                raise RuntimeError(f"{path}: Zenodo archive copy differs from GitHub@{ND_COMMIT[:8]} copy; stopping")
        lic = zf.read(ND_ZENODO_PREFIX + "LICENSE").decode("utf-8", "replace")
    log(f"{ND_ZENODO_LOCAL}: md5 OK; both CSVs identical to the GitHub copies; archive LICENSE starts "
        f"{lic.splitlines()[0]!r}")

    manifest = {
        "downloadedAt": now_iso(),
        "files": files,
        "dataS1Members": members,
        "githubLicenseField": repo_license,
        "dataS1License": S1_LICENSE,
        "neurodata": {
            "repo": ND_REPO, "tag": ND_TAG, "commit": ND_COMMIT, "headCommitAtBuild": ND_HEAD_COMMIT,
            "zenodoRecord": ND_ZENODO_RECORD, "zenodoDoi": rec.get("doi", ND_ZENODO_DOI),
            "zenodoConceptDoi": rec.get("conceptdoi"), "zenodoTitle": rec["metadata"]["title"],
            "zenodoVersion": rec["metadata"].get("version"), "zenodoLicense": rec["metadata"].get("license"),
            "zenodoArchive": {"name": ND_ZENODO_LOCAL, "key": ND_ZENODO_KEY, "url": entry["links"]["self"],
                              "bytes": zn, "sha256": zsha, "md5": zmd5, "zenodoChecksum": entry["checksum"]},
            "zenodoArchiveMembers": zenodo_members,
            "archiveLicenseFirstLine": lic.splitlines()[0],
            "license": ND_LICENSE,
        },
    }
    write_json(raw / "download_manifest.json", manifest)
    log(f"wrote {raw / 'download_manifest.json'}")
    return manifest


def load_download_manifest(raw: Path) -> dict:
    p = raw / "download_manifest.json"
    if not p.exists():
        raise SystemExit(f"{p} missing: run `build_larva.py --download` first")
    m = json.loads(p.read_text())
    for f in m["files"] + [m["neurodata"]["zenodoArchive"]]:
        path = raw / f["name"]
        if not path.exists() or path.stat().st_size != f["bytes"]:
            raise SystemExit(f"{path} missing or size changed since download; re-run --download")
    return m


# --------------------------------------------------------------------------- #
# Step 2: load
# --------------------------------------------------------------------------- #


def load_inputs(raw: Path, timer: Timer) -> dict:
    d: dict = {"schemas": {}}
    with timer("load Data S1 matrices"):
        zf = zipfile.ZipFile(raw / S1_ZIP)
        mats = {}
        for ch, member in list(S1_MATRIX.items()) + [("all", S1_MATRIX_ALL)]:
            df = pd.read_csv(io.BytesIO(zf.read(member)), index_col=0)
            df.index = df.index.astype(np.int64)
            df.columns = df.columns.astype(np.int64)
            if not (df.index.is_unique and df.columns.is_unique and set(df.index) == set(df.columns)):
                raise RuntimeError(f"{member}: index/columns are not the same unique id set")
            v = df.to_numpy()
            if not (np.isfinite(v).all() and (v >= 0).all() and (np.mod(v, 1) == 0).all()):
                raise RuntimeError(f"{member}: expected non-negative integer-valued synapse counts")
            d["schemas"][member.split("/")[-1]] = (
                f"dense {df.shape[0]}x{df.shape[1]} CSV; header row and index column = CATMAID skeleton ids "
                f"(row = presynaptic, column = postsynaptic); float-formatted integer synapse counts "
                f"(min {int(v.min())}, max {int(v.max())}); first row id {int(df.index[0])}"
            )
            mats[ch] = df
        ids = np.array(sorted(mats["ad"].index), dtype=np.int64)
        for ch, df in mats.items():
            if set(df.index) != set(ids):
                raise RuntimeError(f"{ch}: id set differs from the a-d matrix")
        row_orders_identical = all(list(mats[ch].index) == list(mats["ad"].index) for ch in mats)
        A = {ch: mats[ch].reindex(index=ids, columns=ids).to_numpy().astype(np.int64) for ch in mats}
        S = A["ad"] + A["aa"] + A["dd"] + A["da"]
        if not (S == A["all"]).all():
            raise RuntimeError("sum of the four channel matrices != all-all matrix after id alignment; stopping")
        d.update(ids=ids, A={ch: A[ch] for ch in CHANNELS}, S=S, rowOrdersIdentical=row_orders_identical)
        log(f"matrices: {len(ids):,} neurons; synapses per channel "
            f"{ {ch: int(A[ch].sum()) for ch in CHANNELS} }; sum == all-all: True; "
            f"row orders identical across files: {row_orders_identical}")

    with timer("load Data S1 annotations"):
        ann = pd.read_csv(io.BytesIO(zf.read(S1_ANNOTATIONS)), dtype=str, keep_default_na=False)
        d["schemas"]["annotations.csv"] = f"columns={list(ann.columns)}, {len(ann)} rows (one per left/right pair or unpaired neuron)"
        rows = []
        for _, r in ann.iterrows():
            paired = r["left_id"] != "no pair" and r["right_id"] != "no pair"
            for side, col, other in (("L", "left_id", "right_id"), ("R", "right_id", "left_id")):
                if r[col] != "no pair":
                    rows.append({"id": int(r[col]), "s1_side": side, "celltype": r["celltype"],
                                 "annotation": r["additional_annotations"], "cluster": r["level_7_cluster"],
                                 "s1_partner": int(r[other]) if paired else None})
        s1 = pd.DataFrame(rows).set_index("id")
        if not s1.index.is_unique:
            raise RuntimeError("annotations.csv: a skeleton id appears in more than one row")
        inp = pd.read_csv(io.BytesIO(zf.read(S1_INPUTS)), index_col=0)
        outp = pd.read_csv(io.BytesIO(zf.read(S1_OUTPUTS)), index_col=0)
        d["schemas"]["inputs.csv"] = f"columns={list(inp.columns)} ({len(inp)} ids; per-neuron postsynaptic site totals incl. partners outside the matrices)"
        d["schemas"]["outputs.csv"] = f"columns={list(outp.columns)} ({len(outp)} ids)"
        d.update(s1=s1, inputs=inp, outputs=outp)
        log(f"annotations.csv: {len(ann)} rows -> {len(s1):,} ids; celltypes={sorted(s1.celltype.unique())}")

    with timer("load neurodata tables"):
        nd = pd.read_csv(raw / Path(ND_FILES["nodes"]).name, index_col=0, low_memory=False)
        nd.index = nd.index.astype(np.int64)
        d["schemas"]["unmatched_full_nodes.csv"] = f"{nd.shape[0]} rows x {nd.shape[1]} columns; index = skeleton id; columns={list(nd.columns)}"
        el = pd.read_csv(raw / Path(ND_FILES["edgelist"]).name, header=None, names=["source", "target", "weight"])
        d["schemas"]["unmatched_full_edgelist.csv"] = f"headerless; columns source,target,weight ({len(el):,} rows; weight float-formatted integers)"
        d.update(nd=nd, el=el)
        log(f"neurodata nodes: {len(nd):,} rows; edgelist: {len(el):,} rows")
    return d


# --------------------------------------------------------------------------- #
# Step 3: nodes
# --------------------------------------------------------------------------- #


def build_nodes(d: dict) -> tuple[list[dict], dict]:
    ids, S, nd, s1 = d["ids"], d["S"], d["nd"], d["s1"]
    in_syn = S.sum(axis=0)
    out_syn = S.sum(axis=1)
    counts = Counter()
    notes = {"hemisphereFromDataS1": [], "noAnnotationAnywhere": [], "notInNeurodataTable": [],
             "notInDataS1Annotations": 0, "classFallbackToCellType": 0, "classUnknown": 0,
             "cellTypeFromNeurodataFallback": 0, "hemisphereUnknown": []}
    nodes = []
    for k, sid in enumerate(ids):
        sid = int(sid)
        r = nd.loc[sid] if sid in nd.index else None
        a = s1.loc[sid] if sid in s1.index else None
        if r is None:
            notes["notInNeurodataTable"].append(str(sid))
        if a is None:
            notes["notInDataS1Annotations"] += 1
        if r is None and a is None:
            notes["noAnnotationAnywhere"].append(str(sid))

        def rs(col):  # string cell from the neurodata row, None if missing/NaN
            if r is None or col not in r.index:
                return None
            v = r[col]
            return None if (v is None or (isinstance(v, float) and np.isnan(v))) else str(v).strip()

        def rb(col) -> bool:  # boolean flag from the neurodata row (numpy/pandas bools or 'True' strings)
            if r is None or col not in r.index:
                return False
            v = r[col]
            return bool(v) if isinstance(v, (bool, np.bool_)) else str(v).strip() == "True"

        name = rs("name")
        class1 = rs("class1")
        class2 = rs("class2")
        lineage = rs("lineage")
        cell_type = str(a["celltype"]) if a is not None else None
        if cell_type is None and r is not None:
            cell_type = ND_SIMPLE_GROUP_TO_S1.get(rs("simple_group"))
            if cell_type is not None:
                notes["cellTypeFromNeurodataFallback"] += 1
        annotation = str(a["annotation"]) if a is not None else None
        cluster = str(a["cluster"]) if a is not None else None

        hemisphere = rs("hemisphere")
        if hemisphere not in ("L", "R"):
            if a is not None and a["s1_side"] in ("L", "R"):
                hemisphere = a["s1_side"]
                notes["hemisphereFromDataS1"].append(str(sid))
            else:
                hemisphere = "?"
                notes["hemisphereUnknown"].append(str(sid))
        pair_id = None
        paired_with = None
        if r is not None:
            if int(r["pair_id"]) != -1:
                pair_id = str(int(r["pair_id"]))
            if int(r["pair"]) != -1:
                paired_with = str(int(r["pair"]))
        if paired_with is None and a is not None and a["s1_partner"] is not None and not pd.isna(a["s1_partner"]):
            paired_with = str(int(a["s1_partner"]))

        flags = {f: rb(col) for f, col in (("KC", "KCs"), ("MBON", "MBONs"), ("MBIN", "MBINs"),
                                           ("dVNC", "dVNCs"), ("dSEZ", "dSEZs"), ("RGN", "RGNs"))}
        if r is None and cell_type in S1_CELLTYPE_FLAGS:
            flags[S1_CELLTYPE_FLAGS[cell_type]] = True

        groups: list[str] = []
        if class1 and class1 != "unk":
            groups += [f"class:{t.strip()}" for t in class1.split(";") if t.strip()]
        elif cell_type and cell_type != "Other":
            groups.append(f"class:{cell_type}")
            notes["classFallbackToCellType"] += 1
        else:
            groups.append("class:unk")
            notes["classUnknown"] += 1
        if class2:
            groups.append(f"class2:{class2}")
        if cell_type:
            groups.append(f"type:{cell_type}")
        if hemisphere in ("L", "R"):
            groups.append(f"hemisphere:{hemisphere}")
        for f in ("KC", "MBON", "MBIN"):
            if flags[f]:
                groups.append(f"flag:{f}")
        if flags["dVNC"] or flags["dSEZ"]:
            groups.append("flag:DN")
        if flags["dVNC"]:
            groups.append("out:DN-VNC")
        if flags["dSEZ"]:
            groups.append("out:DN-SEZ")
        if flags["RGN"]:
            groups.append("out:RGN")
        if annotation and cell_type == "sensory":
            groups.append(modality_group(annotation))
        elif annotation and cell_type == "ascending":
            for tok in annotation.split(";"):
                if tok.strip() in ASCENDING_MODALITIES:
                    groups.append(modality_group(tok))
        counts.update(groups)
        nodes.append({
            "id": str(sid), "index": k, "provenance": "MEASURED",
            "name": name, "hemisphere": hemisphere, "pairId": pair_id, "pairedWith": paired_with,
            "lineage": lineage, "class1": class1, "class2": class2, "cellType": cell_type,
            "annotation": annotation, "cluster": cluster,
            "groups": groups, "inSynapses": int(in_syn[k]), "outSynapses": int(out_syn[k]),
        })
    # hemisphere disagreements between Data S1's left/right columns and neurodata's hemisphere
    dis = [str(i) for i in s1.index if i in nd.index and s1.at[i, "s1_side"] != str(nd.at[i, "hemisphere"])]
    notes["hemisphereDisagreementsS1vsNeurodata"] = {"count": len(dis), "ids": dis}
    return nodes, {"groupCounts": dict(sorted(counts.items())), **notes}


# --------------------------------------------------------------------------- #
# Step 4: plasticity.json (curated, every entry tagged)
# --------------------------------------------------------------------------- #

# name -> (valence, compartment, evidence).  Names are the paper's own (Data S1 annotations.csv).
DAN_VALENCE = {
    "DAN-i1": ("appetitive", "medial lobe, upper toe (pPAM cluster)",
               "Saumweber et al. 2018: optogenetic activation of DAN-i1 is sufficient as an internal reward "
               "signal (odour-then-DAN-i1 pairing -> appetitive memory; DAN-i1-then-odour -> aversive memory, i.e. "
               "onset rewarding, offset punishing). Eschbach et al. 2020: co-activated with DAN-h1/-k1 as the "
               "optogenetic reward in their paradigm."),
    "DAN-d1": ("aversive", "lateral appendix",
               "Eschbach et al. 2020: pairing an odour with activation of DAN-d1 established aversive memory."),
    "DAN-f1": ("aversive", "intermediate vertical lobe",
               "Eschbach et al. 2020: pairing an odour with activation of DAN-f1 established aversive memory "
               "('the aversive DAN-f1 and DAN-g1')."),
    "DAN-g1": ("aversive", "lower vertical lobe",
               "Eschbach et al. 2020: pairing an odour with activation of DAN-g1 established aversive memory."),
    "DAN-c1": ("unknown", "lower peduncle",
               "Eschbach et al. 2020: pairing an odour with activation of DAN-c1 induced neither appetitive nor "
               "aversive memory; no valence assigned."),
    "DAN-j1": ("unknown", "medial lobe (pPAM cluster)",
               "Saumweber et al. 2018: no suitable driver line ('attempts to generate a suitable driver strain "
               "for DAN-j1 have failed'), untested; Eschbach et al. 2020 only 'sometimes' hit it with the "
               "medial-lobe co-activation line. Cluster membership suggests reward but this is not tested."),
    "DAN-k1": ("unknown", "medial lobe (pPAM cluster)",
               "Saumweber et al. 2018: activation of DAN-k1 alone was without any rewarding effect; Eschbach et "
               "al. 2020 co-activated it with DAN-h1/-i1 as a reward. Not assigned individually."),
}
OAN_NOTE = {
    "OAN-e1": "Eichler et al. 2017: octopaminergic (antibody labelling); Saumweber et al. 2018: OANs as a population are sufficient as an internal reward signal (citing earlier work), individual OAN-e1 not tested here.",
    "OAN-g1": "Eichler et al. 2017: octopaminergic (antibody labelling); individual valence not tested in the cited papers.",
}
MBIN_UNKNOWN_NT = {
    "MBIN-e1": "Eichler et al. 2017: neither dopaminergic nor octopaminergic; transmitter unknown",
    "MBIN-e2": "Eichler et al. 2017: neither dopaminergic nor octopaminergic; transmitter unknown",
    "MBIN-l1": "Eichler et al. 2017: neither dopaminergic nor octopaminergic; transmitter unknown",
    "MBIN-b1": "Eichler et al. 2017: 'not technically accessible' for antibody labelling; transmitter unknown",
    "MBIN-b2": "Eichler et al. 2017: 'not technically accessible' for antibody labelling; transmitter unknown",
}
# label -> (sign, transmitter, confidence, source) for individually named neurons (text-verified statements only)
NODE_SIGNS = {
    "MBON-g1": (-1, "GABA", "reported", "Eichler et al. 2017: 'GABAergic (MBON-g1, -g2, -h1, -h2)'"),
    "MBON-g2": (-1, "GABA", "reported", "Eichler et al. 2017: 'GABAergic (MBON-g1, -g2, -h1, -h2)'"),
    "MBON-h1": (-1, "GABA", "reported", "Eichler et al. 2017: 'GABAergic (MBON-g1, -g2, -h1, -h2)'"),
    "MBON-h2": (-1, "GABA", "reported", "Eichler et al. 2017: 'GABAergic (MBON-g1, -g2, -h1, -h2)'"),
    "MBON-i1": (-1, "glutamate", "probable", "Eichler et al. 2017: 'glutamatergic (MBON-i1, -j1, -k1)', 'could be inhibitory'; Eschbach et al. 2020: 'the glutamatergic MBON-i1', treated as potentially inhibitory"),
    "MBON-j1": (-1, "glutamate", "probable", "Eichler et al. 2017: 'glutamatergic (MBON-i1, -j1, -k1)'; glutamate is usually inhibitory in the insect CNS but this is not confirmed for these cells"),
    "MBON-k1": (-1, "glutamate", "probable", "Eichler et al. 2017: 'glutamatergic (MBON-i1, -j1, -k1)'; as for MBON-j1"),
    "MBON-m1": (-1, "GABA", "reported", "Eschbach et al. 2020: 'the GABAergic MBON-m1'"),
    "FBN-7": (1, "acetylcholine", "reported", "Eschbach et al. 2020: 'the cholinergic FBN-7'"),
    "FBN-23": (-1, "GABA", "reported", "Eschbach et al. 2020: 'the GABAergic FBN-23'"),
    "FB2N-19": (1, "acetylcholine", "reported", "Eschbach et al. 2020: 'the excitatory cholinergic FB2N' (FB2N-19)"),
}


def build_plasticity(nodes: list[dict]) -> tuple[dict, dict]:
    by_label: dict[str, list[dict]] = {}
    for n in nodes:
        if n["annotation"]:
            for tok in n["annotation"].split(";"):
                by_label.setdefault(tok.strip(), []).append(n)

    def ids_for(label: str) -> list[str]:
        return sorted((n["id"] for n in by_label.get(label, [])), key=int)

    def by_hemi(label: str) -> dict:
        return {n["hemisphere"]: n["id"] for n in sorted(by_label.get(label, []), key=lambda n: n["hemisphere"])}

    dan_names = sorted(l for l in by_label if l.startswith("DAN-"))
    oan_names = sorted(l for l in by_label if l.startswith("OAN-"))
    mbon_names = sorted(l for l in by_label if l.startswith("MBON-"))
    mbin_other = sorted(l for l in by_label if l.startswith("MBIN-"))
    dan_by_class2 = sorted((n["id"] for n in nodes if "class2:DAN" in n["groups"]), key=int)
    dan_by_name = sorted((i for l in dan_names for i in ids_for(l)), key=int)
    lists = {"appetitive": [], "aversive": [], "unknown": []}
    dan_entries = {}
    for lbl in dan_names:
        valence, compartment, evidence = DAN_VALENCE.get(lbl, ("unknown", None, "no statement found in the cited papers"))
        lists[valence] += ids_for(lbl)
        dan_entries[lbl] = {"ids": by_hemi(lbl), "valence": valence, "compartment": compartment, "evidence": evidence}
    for k in lists:
        lists[k] = sorted(lists[k], key=int)

    by_node: dict[str, dict] = {}
    for lbl, (sign, nt, conf, src) in NODE_SIGNS.items():
        for n in by_label.get(lbl, []):
            # a cell can carry several labels (the paper annotates two pairs as 'MBON-h1; MBON-h2')
            e = by_node.setdefault(n["id"], {"annotation": n["annotation"], "labels": [], "sign": sign, "nt": nt,
                                             "confidence": conf, "sources": []})
            if (e["sign"], e["nt"]) != (sign, nt):
                raise RuntimeError(f"conflicting transmitter statements for node {n['id']} ({e['labels']} vs {lbl})")
            e["labels"].append(lbl)
            if src not in e["sources"]:
                e["sources"].append(src)
    by_node = dict(sorted(by_node.items(), key=lambda kv: int(kv[0])))

    plasticity = {
        "version": 1,
        "artifact": ARTIFACT_ID,
        "plasticEdges": {
            "channel": "ad",
            "preGroup": "flag:KC",
            "postGroup": "flag:MBON",
            "modulatorGroup": "class2:DAN",
            "rule": (
                "DAN-paired depression: co-activation of a KC and the dopaminergic input to an MBON compartment "
                "depresses that KC->MBON synapse (Eschbach et al. 2020 model: KC-to-MBON weights are modified by a "
                "DAN-dependent, timing-dependent plasticity rule consistent with experimental findings; formal "
                "two-factor rule of Jürgensen et al. 2024, doi:10.1016/j.isci.2023.108640: "
                "Δw_i = −a · e_i(t) · R(t) ≤ 0, where e_i(t) is an exponentially decaying eligibility trace set "
                "to 1 by each spike of presynaptic KC i and R(t) is the reward-triggered DAN spike train; a "
                "homeostatic term Δw_i^h = (w_init − w_i)·M(t)·h ≥ 0 counteracts it on MBON spikes)."
            ),
            "compartmentNote": (
                "The connectome gives KC->MBON edges but no compartment labels per synapse; which DAN gates "
                "which KC->MBON synapse must be resolved by the runtime from DAN->MBON / DAN->KC co-innervation "
                "(each MBIN innervates one compartment, Eichler et al. 2017), or approximated per MBON."
            ),
            "tag": "INFERRED_FROM_LITERATURE",
        },
        "dopaminergic": {
            "appetitive": lists["appetitive"],
            "aversive": lists["aversive"],
            "unknown": lists["unknown"],
            "byName": dan_entries,
            "identification": {
                "method": "names from Data S1 annotations.csv `additional_annotations` (the paper's MBIN naming after Eichler et al. 2017); cross-checked against the neurodata `class2 == DAN` flag",
                "namesFound": dan_names,
                "idsByName": len(dan_by_name),
                "idsByClass2": len(dan_by_class2),
                "identical": dan_by_name == dan_by_class2,
                "absentFromL1": "DAN-h1 (Saumweber et al. 2018, third-instar) is not among the seven L1 DANs listed by Eichler et al. 2017 (DAN-c1, -d1, -f1, -g1, -i1, -j1, -k1) and has no node here.",
                "tag": "MEASURED",
            },
            "source": "Saumweber et al. 2018 (doi:10.1038/s41467-018-03130-1); Eschbach et al. 2020 (doi:10.1038/s41593-020-0607-9); dopaminergic identity: Eichler et al. 2017 (doi:10.1038/nature23455)",
            "tag": "INFERRED_FROM_LITERATURE",
            "note": "valence assignments are from optogenetic substitution experiments (activation paired with odour), not from the connectome; 'unknown' means not established for that cell in the cited papers",
        },
        "octopaminergic": {
            "ids": sorted((i for l in oan_names for i in ids_for(l)), key=int),
            "byName": {l: {"ids": by_hemi(l), "note": OAN_NOTE.get(l, "octopaminergic (Eichler et al. 2017)")} for l in oan_names},
            "absentFromMatrices": "OAN-a1 and OAN-a2 (unpaired midline neurons, Eichler et al. 2017 / Saumweber et al. 2018) are not annotated among the 2,952 matrix neurons",
            "tag": "INFERRED_FROM_LITERATURE",
        },
        "otherModulatory": {
            "byName": {l: {"ids": by_hemi(l), "nt": "unknown", "note": MBIN_UNKNOWN_NT.get(l, "")} for l in mbin_other},
            "tag": "INFERRED_FROM_LITERATURE",
        },
        "mushroomBodyOutputNeurons": {
            "namesFound": mbon_names,
            "ids": sorted((n["id"] for n in nodes if "flag:MBON" in n["groups"]), key=int),
            "tag": "MEASURED",
        },
        "signs": {
            "byGroup": {
                "flag:KC": {"sign": 1, "nt": "acetylcholine", "confidence": "inferred from adult",
                            "source": "Eichler et al. 2017: 'KCs have been shown to be cholinergic in the adult, so it is likely that KC-to-KC connections are depolarizing' (not measured in the larva)",
                            "caveat": "Winding et al. 2023 note that in the adult, a-a connections between otherwise excitatory (cholinergic) KCs were found to be inhibitory (mAChR-B in axon terminals); the `aa` channel of KC->KC edges may therefore carry the opposite sign"},
                "class:APL": {"sign": -1, "nt": "GABA", "confidence": "reported",
                              "source": "Eichler et al. 2017: 'An additional pair of GABAergic neurons, homologous to the anterior paired lateral (APL) neurons in the adult fly, synapses reciprocally with all mature ipsilateral KCs'"},
                "class2:DAN": {"sign": 0, "nt": "dopamine (modulatory)", "confidence": "reported",
                               "source": "Eichler et al. 2017: antibody labelling, 'seven MBINs are dopaminergic (DAN-c1, -d1, -f1, -g1, -i1, -j1, and -k1)'; treated as neuromodulatory (sign 0), acting through the plasticity rule rather than as a fast synaptic drive"},
                "class2:OAN": {"sign": 0, "nt": "octopamine (modulatory)", "confidence": "reported",
                               "source": "Eichler et al. 2017: 'four are octopaminergic (OAN-a1, -a2, -e1, and -g1)'"},
            },
            "byNode": by_node,
            "default": {"sign": 1,
                        "note": "no neurotransmitter data exists for the larval brain connectome; unlisted neurons are treated as excitatory magnitude-only — ENGINEERING_CHOICE",
                        "tag": "ENGINEERING_CHOICE"},
            "unverified": (
                "Per-cell transmitters that the build brief attributed to the cited papers but that could not be "
                "verified in the accessible full texts (they live in figures/supplements only) are deliberately "
                "NOT encoded: MBON-e1 'cholinergic'. Eichler et al. 2017 state only that 'MBONs are glutamatergic, "
                "cholinergic, or GABAergic' for the remaining MBONs."
            ),
            "tag": "INFERRED_FROM_LITERATURE",
        },
    }
    report = {
        "danNames": dan_names, "danIds": len(dan_by_name), "danIdsByClass2": len(dan_by_class2),
        "oanNames": oan_names, "mbinOtherNames": mbin_other, "mbonNames": mbon_names,
        "mbonIds": len(plasticity["mushroomBodyOutputNeurons"]["ids"]),
        "kcIds": sum(1 for n in nodes if "flag:KC" in n["groups"]),
        "signedNodes": len(by_node), "signedLabels": sorted({l for e in by_node.values() for l in e["labels"]}),
        "valenceLists": {k: len(v) for k, v in lists.items()},
    }
    return plasticity, report


# --------------------------------------------------------------------------- #
# Step 5: stats / sanity checks
# --------------------------------------------------------------------------- #


def block(A: dict, pre: np.ndarray, post: np.ndarray) -> dict:
    res = {}
    for ch in CHANNELS:
        sub = A[ch][np.ix_(pre, post)]
        res[ch] = {"synapses": int(sub.sum()), "edges": int((sub > 0).sum())}
    tot = sum(res[ch]["synapses"] for ch in CHANNELS)
    res["totalSynapses"] = tot
    res["channelFractions"] = {ch: (round(res[ch]["synapses"] / tot, 4) if tot else None) for ch in CHANNELS}
    res["dominantChannel"] = max(CHANNELS, key=lambda ch: res[ch]["synapses"]) if tot else None
    return res


def compute_stats(d: dict, nodes: list[dict], src: np.ndarray, dst: np.ndarray, weight: np.ndarray) -> dict:
    A, S, ids = d["A"], d["S"], d["ids"]
    n = len(ids)

    def mask(group: str) -> np.ndarray:
        return np.array([group in nd["groups"] for nd in nodes], dtype=bool)

    kc, mbon, mbin, dan, apl, upn = (mask(g) for g in ("flag:KC", "flag:MBON", "flag:MBIN", "class2:DAN", "class:APL", "class:uPN"))
    pn, sens = mask("type:PN"), mask("type:sensory")
    primary = [next(g[6:] for g in nd["groups"] if g.startswith("class:")) for nd in nodes]

    # KC inputs by presynaptic (primary) class, all channels and a-d only
    to_kc_all = S[:, kc].sum(axis=1)
    to_kc_ad = A["ad"][:, kc].sum(axis=1)
    by_class_all, by_class_ad = Counter(), Counter()
    for i in range(n):
        by_class_all[primary[i]] += int(to_kc_all[i])
        by_class_ad[primary[i]] += int(to_kc_ad[i])
    kc_inputs = {
        "topPresynapticClassesAllChannels": by_class_all.most_common(8),
        "topPresynapticClassesAd": by_class_ad.most_common(8),
        "uPNtoKC": block(A, upn, kc),
        "PNtypeToKC": block(A, pn, kc),
    }
    # KC -> MBON per MBON
    kc_idx, mbon_idx = np.flatnonzero(kc), np.flatnonzero(mbon)
    per_mbon = []
    for j in mbon_idx:
        col = A["ad"][kc_idx, j]
        per_mbon.append({"id": nodes[j]["id"], "name": nodes[j]["annotation"], "kcAdSynapses": int(col.sum()),
                         "kcAdPartners": int((col > 0).sum())})
    lacking = [m for m in per_mbon if m["kcAdSynapses"] == 0]
    kc_mbon = {"block": block(A, kc, mbon), "mbonsWithKcAdInput": len(per_mbon) - len(lacking),
               "mbonsTotal": len(per_mbon), "mbonsWithoutKcAdInput": lacking,
               "kcAdSynapsesPerMbonMedian": float(np.median([m["kcAdSynapses"] for m in per_mbon])) if per_mbon else None}
    motifs = {
        "DAN_to_KC": block(A, dan, kc), "MBIN_to_KC": block(A, mbin, kc), "KC_to_MBIN": block(A, kc, mbin),
        "DAN_to_MBON": block(A, dan, mbon), "MBIN_to_MBON": block(A, mbin, mbon), "MBON_to_MBIN": block(A, mbon, mbin),
        "APL_to_KC": block(A, apl, kc), "KC_to_APL": block(A, kc, apl), "KC_to_KC": block(A, kc, kc),
        "sensory_to_all": block(A, sens, np.ones(n, bool)), "all_to_sensory": block(A, np.ones(n, bool), sens),
    }
    # orientation check: sensory neurons should talk much more than they listen
    orientation = {"sensoryOutSynapses": int(S[sens].sum()), "sensoryInSynapses": int(S[:, sens].sum()),
                   "sensoryNeurons": int(sens.sum()), "neuronsWithZeroIn": int((S.sum(axis=0) == 0).sum()),
                   "zeroInThatAreSensory": int(((S.sum(axis=0) == 0) & sens).sum()),
                   "neuronsWithZeroOut": int((S.sum(axis=1) == 0).sum())}
    # reproduce the paper's text statistics
    paper = {}
    for ch in CHANNELS:
        W = A[ch][A[ch] > 0]
        paper[ch] = {"edges": int(len(W)), "synapses": int(W.sum()),
                     "weakEdgeFraction_1or2": round(float((W <= 2).mean()), 3),
                     "synapseShareInStrongEdges_ge5": round(float(W[W >= 5].sum() / W.sum()), 3),
                     "synapseShareInWeakEdges_1or2": round(float(W[W <= 2].sum() / W.sum()), 3),
                     "maxWeight": int(W.max())}
    W = S[S > 0]
    paper["all"] = {"edges": int(len(W)), "synapses": int(W.sum()),
                    "weakEdgeFraction_1or2": round(float((W <= 2).mean()), 3),
                    "synapseShareInStrongEdges_ge5": round(float(W[W >= 5].sum() / W.sum()), 3),
                    "synapseShareInWeakEdges_1or2": round(float(W[W <= 2].sum() / W.sum()), 3),
                    "maxWeight": int(W.max())}
    nchan = sum((A[ch] > 0).astype(np.int8) for ch in CHANNELS)
    paper["pairsConnectedInOnlyOneChannel"] = round(float((nchan[S > 0] == 1).mean()), 3)
    da, ad = A["da"] > 0, A["ad"] > 0
    paper["daEdgesThatReverseAnAdEdge"] = round(float((da & ad.T)[da].mean()), 3)
    paper["expectedFromWindingText"] = {
        "channelShares": {"ad": 0.666, "aa": 0.258, "dd": 0.058, "da": 0.018},
        "weakEdgeFraction_1or2": {"ad": 0.60, "aa": 0.75, "dd": 0.79, "da": 0.91, "all": 0.66},
        "synapseShareInStrongEdges_ge5": {"ad": 0.61, "all": 0.55},
        "synapseShareInWeakEdges_1or2": {"ad": 0.22, "all": 0.28},
        "pairsConnectedInOnlyOneChannel": 0.95, "daEdgesThatReverseAnAdEdge": 0.63,
    }
    # cross-check against the Pedigo edge list
    el = d["el"]
    el_ids = np.union1d(el["source"].unique(), el["target"].unique())
    pos = {int(i): k for k, i in enumerate(ids)}
    inm = el["source"].isin(pos) & el["target"].isin(pos)
    sub = el[inm]
    mw = S[[pos[int(s)] for s in sub["source"]], [pos[int(t)] for t in sub["target"]]]
    elset = set(zip(sub["source"].astype(int), sub["target"].astype(int)))
    absent = int(sum(1 for i, j in zip(src, dst) if (int(ids[i]), int(ids[j])) not in elset))
    edgelist = {
        "rows": int(len(el)), "distinctIds": int(len(el_ids)), "autapses": int((el["source"] == el["target"]).sum()),
        "synapses": int(el["weight"].sum()),
        "idsNotInMatrices": int((~np.isin(el_ids, ids)).sum()), "matrixIdsNotInEdgelist": int((~np.isin(ids, el_ids)).sum()),
        "edgesWithBothEndsInMatrices": int(len(sub)), "ofWhichWeightIdentical": int((mw == sub["weight"].to_numpy()).sum()),
        "edgesOutsideMatrixIdSet": int((~inm).sum()), "synapsesOutsideMatrixIdSet": int(el.loc[~inm, "weight"].sum()),
        "matrixEdgesAbsentFromEdgelist": absent,
    }
    order = np.argsort(-weight, kind="stable")[:15]
    top = [{"src": nodes[src[j]]["id"], "srcName": nodes[src[j]]["name"], "srcClass": primary[src[j]],
            "dst": nodes[dst[j]]["id"], "dstName": nodes[dst[j]]["name"], "dstClass": primary[dst[j]],
            "weight": int(weight[j]), "channels": {ch: int(A[ch][src[j], dst[j]]) for ch in CHANNELS}} for j in order]
    inp, outp = d["inputs"].reindex(ids), d["outputs"].reindex(ids)
    catmaid = {"inputsCsvTotalPostsynapticSites": int(inp.to_numpy().sum()),
               "outputsCsvTotalPresynapticSites": int(outp.to_numpy().sum()),
               "matrixSynapses": int(S.sum()),
               "matrixInLeqInputsCsvForAllNeurons": bool((S.sum(axis=0) <= inp.sum(axis=1).to_numpy()).all()),
               "matrixOutLeqOutputsCsvForAllNeurons": bool((S.sum(axis=1) <= outp.sum(axis=1).to_numpy()).all()),
               "inputsCsvIdsNotInMatrices": [int(i) for i in d["inputs"].index if int(i) not in pos]}
    return {"kcInputs": kc_inputs, "kcToMbon": kc_mbon, "motifs": motifs, "orientationCheck": orientation,
            "paperTextReproduction": paper, "edgelistCrossCheck": edgelist, "topEdges": top,
            "catmaidSiteTotals": catmaid,
            "weightQuantiles": {q: int(np.quantile(weight, float(q))) for q in ("0.5", "0.9", "0.99", "0.999")}}


# --------------------------------------------------------------------------- #
# Step 6: build the artifact
# --------------------------------------------------------------------------- #


def build(raw: Path, out_dir: Path, timer: Timer) -> dict:
    dl = load_download_manifest(raw)
    d = load_inputs(raw, timer)
    ids, A, S = d["ids"], d["A"], d["S"]
    n = len(ids)

    with timer("assemble nodes"):
        nodes, node_notes = build_nodes(d)

    with timer("assemble graph"):
        src, dst = np.nonzero(S)  # row-major => sorted by (src, dst)
        weight = S[src, dst]
        chan = {ch: A[ch][src, dst] for ch in CHANNELS}
        assert (sum(chan[ch] for ch in CHANNELS) == weight).all()
        E = len(src)
        autapses = int((src == dst).sum())
        log(f"graph: {n:,} nodes, {E:,} edges, {int(weight.sum()):,} synapses, {autapses} autapses")

    with timer("plasticity table"):
        plasticity, plast_report = build_plasticity(nodes)

    with timer("stats + sanity checks"):
        stats = compute_stats(d, nodes, src, dst, weight)

    with timer("write artifact"):
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "nodes.json").write_text(
            "[\n" + ",\n".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in nodes) + "\n]\n",
            encoding="utf-8")
        graph = {"format": "coo", "n": n, "src": src.tolist(), "dst": dst.tolist(), "weight": weight.tolist(),
                 "channels": {ch: chan[ch].tolist() for ch in CHANNELS}}
        (out_dir / "graph.json").write_text(json.dumps(graph, separators=(",", ":")) + "\n", encoding="utf-8")
        write_json(out_dir / "plasticity.json", plasticity)

        nd_all = d["nd"]
        extra = nd_all.loc[[i for i in nd_all.index if int(i) not in set(int(x) for x in ids)]]
        s1_files = [f for f in dl["files"] if f["role"] == "dataS1"]
        nd_files = [f for f in dl["files"] if f["role"].startswith("neurodata_")]
        manifest = {
            "artifactVersion": 1,
            "id": ARTIFACT_ID,
            "level": "neuron",
            "createdAt": now_iso(),
            "source": {
                "dataset": "Drosophila melanogaster first-instar larval brain connectome (Winding et al. 2023)",
                "organism": "Drosophila melanogaster, first-instar (L1) larva, 6 h after hatching; whole brain (both hemispheres) incl. sensory and ascending inputs; VNC not included",
                "reconstruction": "CATMAID manual reconstruction of a serial-section EM volume (Ohyama et al. 2015 volume); node ids are CATMAID skeleton ids",
                "files": [{k: f[k] for k in ("name", "role", "url", "repo", "commit", "bytes", "sha256", "md5", "gitBlobSha1", "gitBlobSha1Check")} for f in s1_files + nd_files],
                "dataS1Members": dl["dataS1Members"],
                "dataS1Mirror": {"repo": S1_REPO, "commit": S1_COMMIT, "githubLicenseField": dl["githubLicenseField"].get(S1_REPO)},
                "annotations": {
                    "dataS1": {"file": S1_ANNOTATIONS, "columnsUsed": ["left_id", "right_id", "celltype", "additional_annotations", "level_7_cluster"]},
                    "neurodata": {
                        "repo": ND_REPO, "tag": ND_TAG, "commit": ND_COMMIT, "zenodoDoi": ND_ZENODO_DOI,
                        "zenodoArchive": dl["neurodata"]["zenodoArchive"], "zenodoArchiveMembers": dl["neurodata"]["zenodoArchiveMembers"],
                        "zenodoLicense": dl["neurodata"].get("zenodoLicense"),
                        "githubLicenseFieldAtHead": dl["githubLicenseField"].get(ND_REPO),
                        "file": ND_FILES["nodes"],
                        "columnsUsed": ["name", "hemisphere", "pair", "pair_id", "lineage", "class1", "class2", "simple_group",
                                        "KCs", "MBONs", "MBINs", "dVNCs", "dSEZs", "RGNs"],
                        "edgelist": ND_FILES["edgelist"] + " (cross-check only)",
                        "license": ND_LICENSE,
                    },
                },
                "license": "Article: CC BY 4.0 (Winding et al. 2023, per the PMC full text and Europe PMC metadata). Data S1 file: " + S1_LICENSE + " Annotation table: see annotations.neurodata.license.",
                "citations": CITATIONS,
                "citationVerification": CITATION_VERIFICATION,
            },
            "preprocessing": {
                "tool": "connectome-etl/build_larva.py",
                "steps": [
                    f"Download {S1_ZIP} from {S1_REPO}@{S1_COMMIT} (verify git blob SHA-1 via the GitHub contents API); download {', '.join(ND_FILES.values())} from {ND_REPO}@{ND_COMMIT} (tag {ND_TAG}; blob SHA-1 verified); download the Zenodo archive {ND_ZENODO_DOI} (MD5 verified against the record) and assert its copies of the two CSVs are byte-identical.",
                    "Read the four Data S1 matrices aa/ad/da/dd (dense skeleton-id x skeleton-id synapse counts, row = presynaptic, column = postsynaptic). The five matrix files list the same 2,952 ids in DIFFERENT row orders; every matrix is re-indexed onto the ascending numeric id list before use, and the aligned sum of the four channels is asserted equal to all-all_connectivity_matrix.csv.",
                    "nodes.json: one entry per matrix neuron, sorted by ascending numeric skeleton id (`id` emitted as a string, `index` = position). Annotation fields are left-joined from Data S1 annotations.csv (paper cell type, additional annotations incl. sensory modality and MB neuron names, level-7 cluster; both left_id and right_id columns are unpivoted) and from the neurodata node table (name, hemisphere, pair, pair_id, lineage, class1, class2, flags). Labels are kept verbatim except that surrounding whitespace is stripped.",
                    "groups: class:<token> for every ';'-separated token of neurodata class1 (fallback: class:<paper cellType> when class1 is 'unk' and the cell type is not 'Other', else class:unk); class2:<class2>; type:<paper cellType> (fallback: neurodata simple_group translated to the paper spelling); hemisphere:L|R; flag:KC / flag:MBON / flag:MBIN from the neurodata KCs/MBONs/MBINs flags; flag:DN when dVNCs or dSEZs; out:DN-VNC / out:DN-SEZ / out:RGN from dVNCs / dSEZs / RGNs; sens:<modality> from additional_annotations for cellType 'sensory' (whole label) and 'ascending' (tokens mechano-Ch, proprio, noci, mechano-II/III), lower-cased with '/' and spaces replaced by '-'.",
                    "inSynapses / outSynapses per node = column / row sums over the four channels (synapses from/to the 2,952 matrix neurons only; Data S1 inputs.csv/outputs.csv count all CATMAID sites and are not used).",
                    "graph.json: COO over (pre, post) pairs with any synapse in any channel; weight = sum of the four channels; channels[ch][i] is the per-channel split of weight[i]; edges sorted by (src, dst); autapses kept.",
                    "plasticity.json: curated from Data S1 neuron names plus the cited papers (full texts read from Europe PMC / PMC); nothing in it is derived from the connectivity.",
                ],
                "inputSchemas": d["schemas"],
                "matrixRowOrdersIdentical": d["rowOrdersIdentical"],
                "neuronUniverse": {
                    "matrixNeurons": n,
                    "inNeurodataTable": n - len(node_notes["notInNeurodataTable"]),
                    "notInNeurodataTable": node_notes["notInNeurodataTable"],
                    "inDataS1Annotations": n - node_notes["notInDataS1Annotations"],
                    "notInDataS1Annotations": node_notes["notInDataS1Annotations"],
                    "noAnnotationAnywhere": node_notes["noAnnotationAnywhere"],
                    "neurodataRowsNotInMatrices": int(len(extra)),
                    "neurodataRowsNotInMatricesBySimpleGroup": {str(k): int(v) for k, v in extra["simple_group"].value_counts().items()},
                    "neurodataRowsNotInMatricesFlags": {c: int((extra[c] == True).sum()) for c in ("motor", "partially_differentiated", "accessory_neurons", "brain_neurons")},
                    "paperText": "Winding et al. 2023 report 3,016 neurons (480 input neurons + 2,536 differentiated brain neurons) and ~548,000 synaptic sites; Data S1's matrices cover 2,952 of them and 352,611 synapses between them.",
                },
                "annotationCoverage": {
                    "hemisphereFromDataS1": node_notes["hemisphereFromDataS1"],
                    "hemisphereUnknown": node_notes["hemisphereUnknown"],
                    "hemisphereDisagreementsS1vsNeurodata": node_notes["hemisphereDisagreementsS1vsNeurodata"],
                    "classFallbackToCellType": node_notes["classFallbackToCellType"],
                    "classUnknown": node_notes["classUnknown"],
                    "cellTypeFromNeurodataFallback": node_notes["cellTypeFromNeurodataFallback"],
                    "simpleGroupToCellTypeMap": ND_SIMPLE_GROUP_TO_S1,
                },
                "assumptions": [
                    {"id": "syn_count_as_weight", "category": "ENGINEERING_CHOICE",
                     "text": "Edge weight = number of manually annotated chemical synaptic contacts between the two skeletons (a polyadic presynaptic site counts once per postsynaptic partner), summed over the four synapse-type channels. A STRUCTURAL proxy: no synapse size, receptor identity, dynamics, gap junctions (absent from the dataset) or neuromodulation."},
                    {"id": "channels_are_synapse_types", "category": "MEASURED",
                     "text": "graph.channels = ['ad','aa','dd','da'] split every edge by the axon/dendrite compartment of the pre- and postsynaptic sites as published in Data S1 (Winding et al. 2023 Fig. 1C/D). These channels take the place the adult artifact gives to neurotransmitter classes. Compartment (axon vs dendrite) assignment is the authors' skeleton split, not ours."},
                    {"id": "no_neurotransmitter_data", "category": "ENGINEERING_CHOICE",
                     "text": "There is NO neurotransmitter information in the larval brain connectome (no nt column, no predictions). The artifact therefore carries no nt field; the only transmitter knowledge is the curated per-group/per-node table in plasticity.json (INFERRED_FROM_LITERATURE) and everything else defaults to an unsigned, magnitude-only edge (sign +1 by convention)."},
                    {"id": "sign_not_encoded", "category": "INFERRED_FROM_LITERATURE",
                     "text": "No sign is encoded in graph.json. Literature for the larval mushroom body: KCs presumed cholinergic (from the adult), APL GABAergic, DANs dopaminergic and OANs octopaminergic (modulatory), several MBONs GABAergic or glutamatergic (see plasticity.json). Any sign the runtime applies must be labelled as inferred."},
                    {"id": "primary_source_is_data_s1", "category": "ENGINEERING_CHOICE",
                     "text": "The Data S1 matrices are the connectivity source; the Pedigo et al. 2023 edge list (3,013 nodes, 111,243 edges, 536 autapses) is used only as a cross-check. Its 65 extra neurons (mostly SEZ motor neurons, immature 'young' KCs and partially differentiated cells) and the 4 matrix neurons it omits explain the difference to this artifact's 110,677 edges / 537 autapses; all 110,298 shared edges have identical weights."},
                    {"id": "row_is_presynaptic", "category": "MEASURED",
                     "text": "Matrix rows are presynaptic and columns postsynaptic. Verified three ways: the Pedigo edge list (source,target,weight) reproduces matrix[row=source][col=target] for every shared edge; per-neuron column sums never exceed Data S1 inputs.csv (postsynaptic site totals) and row sums never exceed outputs.csv; sensory neurons have almost no column (input) synapses."},
                    {"id": "node_annotation_merge", "category": "ENGINEERING_CHOICE",
                     "text": "Two annotation tables are merged. Data S1 annotations.csv (the paper's own) supplies cellType, annotation (incl. sensory modality and MB neuron names) and cluster; the neurodata table supplies name, hemisphere, pair/pair_id, lineage, class1/class2 and the boolean flags. Where the two disagree on hemisphere (32 paired neurons whose Data S1 left_id/right_id placement contradicts their CATMAID names and the neurodata `hemisphere`), the neurodata value is used; Data S1's side is used only for the 2 neurons absent from the neurodata table."},
                    {"id": "class_group_fallback", "category": "ENGINEERING_CHOICE",
                     "text": "class: groups come from neurodata class1 (split on ';' so e.g. 'LHN;CN' yields class:LHN and class:CN). For the 1,129 neurons whose class1 is 'unk', the paper's cell type is used instead when it is a real category (e.g. class:pre-DN-VNC), so that every neuron has the most specific class label available; class:unk marks the remainder (paper category 'Other' or no annotation)."},
                    {"id": "flag_dn_definition", "category": "ENGINEERING_CHOICE",
                     "text": "flag:DN marks descending neurons = neurodata dVNCs OR dSEZs (descending to the ventral nerve cord or to the subesophageal zone). The neurodata flags are inclusive (a neuron with class1 'dSEZ;CN' is flagged), so out:DN-SEZ (184) is larger than the paper's exclusive DN-SEZ cell-type count (164); out:* uses the paper's spellings DN-VNC / DN-SEZ / RGN."},
                    {"id": "sens_modality_source", "category": "ENGINEERING_CHOICE",
                     "text": "sens:<modality> uses Data S1 additional_annotations (the paper's modality labels) for sensory neurons and for ascending neurons that carry a modality token; second-order projection neurons are NOT given sens: groups (their modality is kept verbatim in `annotation`). neurodata class2 (ORN, AN, MN, vtd, photoRh5/6, thermo) is a nerve/receptor-based vocabulary and is exposed as class2: groups instead."},
                    {"id": "plasticity_curation", "category": "INFERRED_FROM_LITERATURE",
                     "text": "plasticity.json designates KC->MBON a-d edges as plastic under dopaminergic modulation and lists DAN valences and transmitter signs ONLY where a statement was found in the full text of the cited papers; unverifiable cells are left 'unknown'. Valences come from optogenetic substitution experiments, not from the connectome."},
                    {"id": "autapses_kept", "category": "ENGINEERING_CHOICE",
                     "text": "Diagonal entries (537 pairs, 783 synapses, mostly a-a between KC branches) are kept as self-edges."},
                ],
            },
            "graph": {
                "nodeCount": n,
                "edgeCount": E,
                "totalSynapses": int(weight.sum()),
                "weightSemantics": "synapse_count",
                "channels": CHANNELS,
                "channelMeaning": CHANNEL_MEANING,
                "channelSynapses": {ch: int(A[ch].sum()) for ch in CHANNELS},
                "channelShares": {ch: round(float(A[ch].sum() / weight.sum()), 4) for ch in CHANNELS},
                "channelEdges": {ch: int((A[ch] > 0).sum()) for ch in CHANNELS},
                "autapses": autapses,
                "autapseSynapses": int(weight[src == dst].sum()),
                "nodeOrder": "ascending numeric CATMAID skeleton id; nodes.json[].index == array position == graph src/dst index",
                "files": {name: {"bytes": (out_dir / name).stat().st_size} for name in ("nodes.json", "graph.json", "plasticity.json")},
            },
            "nodeFields": {
                "id": "CATMAID skeleton id (string)", "index": "0..n-1 position", "provenance": "MEASURED",
                "name": "neurodata `name` (CATMAID neuron name; null for 2 neurons)", "hemisphere": "L | R | ? (neurodata hemisphere; Data S1 side for 2 neurons)",
                "pairId": "neurodata pair_id (string) or null when unpaired", "pairedWith": "skeleton id of the contralateral homologue or null",
                "lineage": "neurodata lineage (verbatim, 'unk' when unknown)", "class1": "neurodata class1 (verbatim, 'unk' when unknown; null when the neuron is not in that table)",
                "class2": "neurodata class2 subclass or null", "cellType": "Data S1 celltype (paper category) or neurodata fallback",
                "annotation": "Data S1 additional_annotations verbatim ('no official annotation' is the paper's own placeholder) or null", "cluster": "Data S1 level_7_cluster or null",
                "groups": "see preprocessing.steps[3]", "inSynapses": "sum of incoming weights", "outSynapses": "sum of outgoing weights",
            },
            "groups": node_notes["groupCounts"],
            "plasticitySummary": plast_report,
            "stats": stats,
            "build": build_block(timer),
            "checksums": {
                "nodes.json": "sha256:" + sha256_file(out_dir / "nodes.json"),
                "graph.json": "sha256:" + sha256_file(out_dir / "graph.json"),
                "plasticity.json": "sha256:" + sha256_file(out_dir / "plasticity.json"),
            },
        }
        write_json(out_dir / "manifest.json", manifest)
        sizes = {name: (out_dir / name).stat().st_size for name in ("manifest.json", "nodes.json", "graph.json", "plasticity.json")}
        log(f"wrote {out_dir}/{{manifest,nodes,graph,plasticity}}.json; sizes={sizes}")

    # ---- console report ----
    print(f"\nNEURONS {n:,}  EDGES {E:,}  SYNAPSES {int(weight.sum()):,}  AUTAPSES {autapses} ({int(weight[src == dst].sum())} syn)")
    print("CHANNELS:", {ch: f"{int(A[ch].sum()):,} ({100 * A[ch].sum() / weight.sum():.1f}%), {int((A[ch] > 0).sum()):,} edges" for ch in CHANNELS})
    print("\nGROUPS (distinct strings with counts):")
    for g, c in node_notes["groupCounts"].items():
        print(f"  {c:5}  {g}")
    print("\nPLASTICITY:", json.dumps(plast_report))
    print("\nKC INPUTS by presynaptic class (all channels):", stats["kcInputs"]["topPresynapticClassesAllChannels"])
    print("KC INPUTS by presynaptic class (a-d only):   ", stats["kcInputs"]["topPresynapticClassesAd"])
    print("uPN->KC:", {ch: stats["kcInputs"]["uPNtoKC"][ch]["synapses"] for ch in CHANNELS})
    print(f"KC->MBON a-d input: {stats['kcToMbon']['mbonsWithKcAdInput']}/{stats['kcToMbon']['mbonsTotal']} MBONs; lacking: {[m['name'] for m in stats['kcToMbon']['mbonsWithoutKcAdInput']]}")
    for k, v in stats["motifs"].items():
        print(f"  {k:16} {v['channelFractions']}  total={v['totalSynapses']}  dominant={v['dominantChannel']}")
    print("\nPAPER TEXT REPRODUCTION:", json.dumps({k: v for k, v in stats["paperTextReproduction"].items() if k != "expectedFromWindingText"}))
    print("EDGELIST CROSS-CHECK:", json.dumps(stats["edgelistCrossCheck"]))
    print("ORIENTATION:", json.dumps(stats["orientationCheck"]))
    print("\nTOP 10 EDGES:")
    for e in stats["topEdges"][:10]:
        print(f"  {e['srcName']!s:40} ({e['srcClass']}) -> {e['dstName']!s:40} ({e['dstClass']}) w={e['weight']} {e['channels']}")
    print("\nFILE SIZES:", sizes)
    return manifest


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download", action="store_true", help="download + verify raw inputs")
    ap.add_argument("--build", action="store_true", help=f"build {ARTIFACT_ID}")
    ap.add_argument("--all", action="store_true", help="--download --build")
    ap.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW)
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    if args.all:
        args.download = args.build = True
    if not (args.download or args.build):
        ap.print_help()
        return 2
    timer = Timer()
    t0 = time.perf_counter()
    if args.download:
        with timer("download"):
            download(args.raw_dir)
    if args.build:
        build(args.raw_dir, args.out_dir / ARTIFACT_ID, timer)
    log(f"timings (s): {json.dumps(timer.timings)}; total {time.perf_counter() - t0:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
