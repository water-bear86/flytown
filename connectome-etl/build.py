#!/usr/bin/env python3
"""
FLYTOWN connectome ETL — FlyWire FAFB v783 -> versioned runtime artifacts.

Single entrypoint.  Subcommands are flags so they compose:

    python build.py --download      # fetch + verify raw inputs into raw/
    python build.py --projectome    # build connectome/fafb-v783-projectome-1/
    python build.py --neuron        # build connectome/fafb-v783-neuron-1/
    python build.py --all           # all of the above, in that order

Everything this script does is deterministic given the pinned inputs below; the
only non-deterministic values in the outputs are the `createdAt` timestamps and
the recorded step timings.  See README.md for the full list of assumptions.

No TypeScript is generated here; the artifacts are plain JSON / Parquet / raw
little-endian typed arrays that a TypeScript runtime loads.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import platform
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.feather as pf
import requests

# --------------------------------------------------------------------------- #
# Pinned sources
# --------------------------------------------------------------------------- #
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DEFAULT_RAW = HERE / "raw"
DEFAULT_OUT = REPO_ROOT / "connectome"

MATERIALIZATION = 783
ZENODO_RECORD = "10676866"
ZENODO_API = f"https://zenodo.org/api/records/{ZENODO_RECORD}"
ZENODO_DOI = "10.5281/zenodo.10676866"

# role -> file name inside the Zenodo record.  flywire_synapses_783.feather (9.5 GB,
# per-synapse table) is deliberately NOT part of this list: everything we need is in
# the per-connection and per-neuron summaries.
ZENODO_FILES = {
    "connections": "proofread_connections_783.feather",
    "post_counts": "per_neuron_neuropil_count_post_783.feather",
    "pre_counts": "per_neuron_neuropil_count_pre_783.feather",
    "root_ids": "proofread_root_ids_783.npy",
}

ANN_REPO = "flyconnectome/flywire_annotations"
ANN_TAG = "v3.1.0"
ANN_COMMIT = "8587524c1748ce5ef2080822a2fc890fc03bf597"  # == tag v3.1.0 (HEAD of main, 2026-07-21)
ANN_PATH = "supplemental_files/Supplemental_file1_neuron_annotations.tsv"
ANN_FILE = "Supplemental_file1_neuron_annotations.tsv"
ANN_URL = f"https://raw.githubusercontent.com/{ANN_REPO}/{ANN_COMMIT}/{ANN_PATH}"
ANN_API = f"https://api.github.com/repos/{ANN_REPO}/contents/{ANN_PATH}?ref={ANN_COMMIT}"
ANN_LICENSE = (
    "NOT STATED: the flyconnectome/flywire_annotations repository contains no LICENSE "
    "file and no license statement (checked at commit 8587524c / tag v3.1.0, GitHub API "
    "reports license=null). Its README asks users to cite Berg et al. 2025, Schlegel et "
    "al. 2024, Matsliah et al. 2024 and Dorkenwald et al. 2024 when using the annotations. "
    "The original Supplemental File 1 was published with Schlegel et al. 2024 (Nature, "
    "open access, CC-BY-4.0); the repository version used here has since been extended "
    "(v3.0.0/v3.1.0, Berg et al. 2025) and carries no explicit license of its own."
)
# Annotation columns copied into neurons.parquet (source name -> output name).
ANN_COLUMNS = {
    "flow": "flow",
    "super_class": "super_class",
    "cell_class": "cell_class",
    "cell_sub_class": "cell_sub_class",
    "cell_type": "cell_type",
    "hemibrain_type": "hemibrain_type",
    "ito_lee_hemilineage": "hemilineage",
    "hartenstein_hemilineage": "hartenstein_hemilineage",
    "side": "side",
    "nerve": "nerve",
    "top_nt": "top_nt",
    "top_nt_conf": "top_nt_conf",
    "known_nt": "known_nt",
    "known_nt_source": "known_nt_source",
}

CITATIONS = [
    "Dorkenwald et al. 2024, Nature, doi:10.1038/s41586-024-07558-y (Neuronal wiring diagram of an adult brain)",
    "Lin, Yang et al. 2024, Nature, doi:10.1038/s41586-024-07968-y (Network statistics of the whole-brain connectome of Drosophila)",
    "Schlegel et al. 2024, Nature, doi:10.1038/s41586-024-07686-5 (Whole-brain annotation and multi-connectome cell typing of Drosophila; cell type annotations)",
    "Eckstein et al. 2024, Cell, doi:10.1016/j.cell.2024.03.016 (Neurotransmitter classification from electron microscopy images at synaptic sites in Drosophila melanogaster; neurotransmitter predictions)",
    "Berg et al. 2025, bioRxiv, doi:10.1101/2025.10.09.680999 (Sexual dimorphism in the complete connectome of the Drosophila male CNS; annotation table v3.x updates)",
    "Matsliah et al. 2024, Nature, doi:10.1038/s41586-024-07981-1 (Neuronal parts list and wiring diagram for a visual system; optic-lobe annotations merged into the annotation table)",
]
# All four DOIs requested by the brief were resolved through the Crossref API on the
# build date (titles/journals/first authors matched); see README.md.

# Neurotransmitter classes, in the fixed order used for nt indices everywhere.
NT_CLASSES = ["ACH", "GABA", "GLUT", "DA", "OCT", "SER"]
NT_AVG_COLUMNS = {
    "ACH": "ach_avg",
    "GABA": "gaba_avg",
    "GLUT": "glut_avg",
    "DA": "da_avg",
    "OCT": "oct_avg",
    "SER": "ser_avg",
}

# Synapses that fall outside every neuropil mesh are labelled "UNASGD" in the
# connections table but "None" (the literal string) in the per-neuron count tables.
# Both spellings are normalised to one pseudo-region id (the connections table's own
# literal) so that no measured synapse is silently dropped and the two tables agree.
UNASSIGNED_RAW_LABELS = {"None", "UNASGD", ""}
UNASSIGNED_ID = "UNASGD"

PROJECTOME_ID = "fafb-v783-projectome-1"
NEURON_ID = "fafb-v783-neuron-1"

# --------------------------------------------------------------------------- #
# Small utilities
# --------------------------------------------------------------------------- #


def log(msg: str) -> None:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def file_hashes(path: Path) -> tuple[str, str, int]:
    """(md5, sha256, bytes) in one pass."""
    md5 = hashlib.md5()
    sha = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            md5.update(chunk)
            sha.update(chunk)
            n += len(chunk)
    return md5.hexdigest(), sha.hexdigest(), n


def sha256_file(path: Path) -> str:
    return file_hashes(path)[1]


def git_blob_sha1(path: Path) -> str:
    size = path.stat().st_size
    h = hashlib.sha1()
    h.update(f"blob {size}\0".encode())
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, obj, indent=2) -> None:
    path.write_text(json.dumps(obj, indent=indent, ensure_ascii=False) + "\n", encoding="utf-8")


class Timer:
    def __init__(self):
        self.timings: dict[str, float] = {}

    def __call__(self, name: str):
        timer = self

        class _T:
            def __enter__(self_):
                self_.t0 = time.perf_counter()
                log(f"--- {name} ---")
                return self_

            def __exit__(self_, *exc):
                timer.timings[name] = round(time.perf_counter() - self_.t0, 2)
                log(f"--- {name}: {timer.timings[name]} s ---")

        return _T()


# --------------------------------------------------------------------------- #
# Step 1: download + verify
# --------------------------------------------------------------------------- #


def http_download(url: str, dest: Path, expected_size: int | None, retries: int = 8) -> None:
    """Streaming download with HTTP Range resume into dest.part, then rename."""
    part = dest.with_name(dest.name + ".part")
    backoff = 5
    for attempt in range(1, retries + 1):
        have = part.stat().st_size if part.exists() else 0
        if expected_size is not None and have >= expected_size:
            break
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with requests.get(url, stream=True, headers=headers, timeout=(30, 180), allow_redirects=True) as r:
                if have and r.status_code == 206:
                    mode = "ab"
                elif r.status_code in (200, 206):
                    mode = "wb"  # server ignored the Range header -> restart
                    have = 0
                else:
                    raise requests.HTTPError(f"HTTP {r.status_code} for {url}")
                done = have
                last_report = done
                with open(part, mode) as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)
                        done += len(chunk)
                        if done - last_report >= 64 << 20:
                            pct = f" ({100 * done / expected_size:.1f}%)" if expected_size else ""
                            log(f"    {dest.name}: {done / 1e6:.0f} MB{pct}")
                            last_report = done
            if expected_size is None or part.stat().st_size >= expected_size:
                break
            log(f"    short read for {dest.name} ({part.stat().st_size}/{expected_size}); resuming")
        except (requests.RequestException, OSError) as e:
            log(f"    attempt {attempt}/{retries} failed for {dest.name}: {e}; retrying in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
    else:
        raise RuntimeError(f"download failed after {retries} attempts: {url}")
    if expected_size is not None and part.stat().st_size != expected_size:
        raise RuntimeError(f"{dest.name}: size {part.stat().st_size} != expected {expected_size}")
    part.replace(dest)


def download(raw: Path) -> dict:
    """Fetch the Zenodo record, download the four files + the annotation TSV, verify."""
    raw.mkdir(parents=True, exist_ok=True)
    record_path = raw / "zenodo_record.json"
    log(f"fetching {ZENODO_API}")
    rec = requests.get(ZENODO_API, timeout=60).json()
    write_json(record_path, rec)
    by_name = {f["key"]: f for f in rec["files"]}
    assert str(rec["metadata"].get("version", "")).startswith("783"), rec["metadata"].get("version")
    log(f"record: {rec['metadata']['title']!r} version={rec['metadata'].get('version')} "
        f"license={rec['metadata'].get('license')} doi={rec.get('doi')}")

    files = []
    for role, name in ZENODO_FILES.items():
        entry = by_name[name]
        url = entry["links"]["self"]
        size = int(entry["size"])
        algo, _, expected = entry["checksum"].partition(":")
        assert algo == "md5", entry["checksum"]
        dest = raw / name
        ok = False
        if dest.exists() and dest.stat().st_size == size:
            md5, sha256, n = file_hashes(dest)
            ok = md5 == expected
            log(f"{name}: present, md5 {'OK' if ok else 'MISMATCH'}")
        if not ok:
            if dest.exists():
                dest.unlink()
            log(f"{name}: downloading {size / 1e6:.1f} MB from {url}")
            http_download(url, dest, size)
            md5, sha256, n = file_hashes(dest)
            if md5 != expected:
                dest.unlink()
                raise RuntimeError(f"{name}: md5 {md5} != Zenodo {expected}; file removed")
            log(f"{name}: md5 OK")
        files.append({
            "role": role,
            "name": name,
            "url": url,
            "bytes": n,
            "sha256": sha256,
            "md5": md5,
            "zenodoChecksum": entry["checksum"],
        })

    # Annotation table, pinned to a commit so the download is reproducible.
    dest = raw / ANN_FILE
    if not dest.exists():
        log(f"{ANN_FILE}: downloading from {ANN_URL}")
        http_download(ANN_URL, dest, None)
    md5, sha256, n = file_hashes(dest)
    blob_sha = git_blob_sha1(dest)
    blob_check = "unverified"
    try:
        api = requests.get(ANN_API, timeout=60)
        if api.ok:
            expected_blob = api.json().get("sha")
            blob_check = "OK" if expected_blob == blob_sha else f"MISMATCH (GitHub {expected_blob})"
        else:
            blob_check = f"unverified (GitHub API HTTP {api.status_code})"
    except requests.RequestException as e:
        blob_check = f"unverified ({e.__class__.__name__})"
    if blob_check.startswith("MISMATCH"):
        raise RuntimeError(f"{ANN_FILE}: git blob sha1 {blob_sha} {blob_check}")
    log(f"{ANN_FILE}: {n / 1e6:.1f} MB, git blob sha1 {blob_sha} check={blob_check}")
    annotations = {
        "repo": ANN_REPO,
        "file": ANN_PATH,
        "commit_or_tag": f"{ANN_TAG} ({ANN_COMMIT})",
        "url": ANN_URL,
        "bytes": n,
        "sha256": sha256,
        "gitBlobSha1": blob_sha,
        "gitBlobSha1Check": blob_check,
        "license": ANN_LICENSE,
    }

    manifest = {
        "downloadedAt": now_iso(),
        "zenodoRecord": ZENODO_RECORD,
        "zenodoDoi": rec.get("doi"),
        "zenodoTitle": rec["metadata"]["title"],
        "zenodoVersion": rec["metadata"].get("version"),
        "zenodoLicense": rec["metadata"].get("license"),
        "files": files,
        "annotations": annotations,
    }
    write_json(raw / "download_manifest.json", manifest)
    log(f"wrote {raw / 'download_manifest.json'}")
    return manifest


def load_download_manifest(raw: Path) -> dict:
    p = raw / "download_manifest.json"
    if not p.exists():
        raise SystemExit(f"{p} missing: run `build.py --download` first")
    m = json.loads(p.read_text())
    for f in m["files"] + [m["annotations"]]:
        path = raw / Path(f["name"] if "name" in f else ANN_FILE).name
        if not path.exists() or path.stat().st_size != f["bytes"]:
            raise SystemExit(f"{path} missing or size changed since download; re-run --download")
    return m


# --------------------------------------------------------------------------- #
# Step 2: load raw tables (shared by both artifacts)
# --------------------------------------------------------------------------- #


def as_string_col(col: pa.ChunkedArray) -> pa.ChunkedArray:
    """Normalise dictionary / large_string columns to plain utf8; nulls and every
    'unassigned' spelling become UNASSIGNED_ID."""
    if not pa.types.is_string(col.type):
        col = col.cast(pa.string())
    col = pc.fill_null(col, UNASSIGNED_ID)
    is_un = pc.is_in(col, value_set=pa.array(sorted(UNASSIGNED_RAW_LABELS), pa.string()))
    return pc.if_else(is_un, pa.scalar(UNASSIGNED_ID, pa.string()), col)


def raw_unassigned_labels(col: pa.ChunkedArray) -> list[str]:
    """Which raw spellings of 'unassigned' (incl. nulls) a column actually contains."""
    if not pa.types.is_string(col.type):
        col = col.cast(pa.string())
    raw = set(col.unique().to_pylist())
    found = sorted(x for x in raw if x is not None and x in UNASSIGNED_RAW_LABELS)
    if None in raw:
        found.append("<null>")
    return found


def distinct_labels(col: pa.ChunkedArray) -> list[str]:
    return sorted(set(as_string_col(col).unique().to_pylist()))


def string_codes(col: pa.ChunkedArray, categories: list[str]) -> np.ndarray:
    """Map a (normalised) string column onto int16 codes for `categories` (-1 = not found)."""
    idx = pc.index_in(as_string_col(col), value_set=pa.array(categories, pa.string()))
    return pc.fill_null(idx, -1).to_numpy().astype(np.int16)


class Data:
    """Lazily loaded, memory-conscious views over the raw tables."""

    def __init__(self, raw: Path, timer: Timer):
        self.raw = raw
        self.timer = timer
        self.dl = load_download_manifest(raw)
        self.schemas: dict[str, str] = {}
        self._conn = None
        self._universe = None
        self._counts: dict[str, dict] = {}
        self._regions = None
        self._ann = None

    # -- connections ------------------------------------------------------- #
    @property
    def conn(self) -> dict:
        if self._conn is None:
            with self.timer("load connections"):
                self._conn = self._load_connections()
        return self._conn

    def _load_connections(self) -> dict:
        path = self.raw / ZENODO_FILES["connections"]
        t = pf.read_table(path)
        self.schemas["connections"] = str(t.schema.remove_metadata())
        cols = t.column_names
        log(f"connections: {t.num_rows:,} rows, columns={cols}")

        def pick(*names):
            for n in names:
                if n in cols:
                    return n
            raise KeyError(f"none of {names} in {cols}")

        pre_col = pick("pre_pt_root_id", "pre_root_id")
        post_col = pick("post_pt_root_id", "post_root_id")
        np_col = pick("neuropil")
        syn_col = pick("syn_count")

        node_ids = distinct_labels(t[np_col])
        unassigned_raw = {"connections": raw_unassigned_labels(t[np_col])}

        pre = t[pre_col].to_numpy().astype(np.int64)
        post = t[post_col].to_numpy().astype(np.int64)
        syn = t[syn_col].to_numpy().astype(np.int64)
        np_code = string_codes(t[np_col], node_ids)
        assert (np_code >= 0).all()
        assert (syn > 0).all(), "expected syn_count > 0 for every connection row"

        nt_info: dict = {}
        if "nt_type" in cols:
            nt_labels = distinct_labels(t["nt_type"])
            nt_classes = [c for c in NT_CLASSES if c in nt_labels] + [c for c in nt_labels if c not in NT_CLASSES]
            nt_code = string_codes(t["nt_type"], nt_classes).astype(np.int8)
            nt_info = {"source": "nt_type column (as published)", "column": "nt_type"}
        else:
            avg_cols = [NT_AVG_COLUMNS[c] for c in NT_CLASSES]
            missing = [c for c in avg_cols if c not in cols]
            if missing:
                raise KeyError(f"no nt_type column and missing probability columns {missing}")
            nt_classes = list(NT_CLASSES)
            m = np.column_stack([t[c].to_numpy().astype(np.float32) for c in avg_cols])
            all_nan = np.isnan(m).all(axis=1)
            m_filled = np.where(np.isnan(m), -1.0, m)
            nt_code = m_filled.argmax(axis=1).astype(np.int8)
            rowmax = m_filled.max(axis=1, keepdims=True)
            ties = ((m_filled == rowmax).sum(axis=1) > 1) & ~all_nan
            if all_nan.any():
                nt_classes.append("UNKNOWN")
                nt_code[all_nan] = len(nt_classes) - 1
            nt_info = {
                "source": "derived: argmax over per-connection mean probabilities",
                "columns": avg_cols,
                "classOrder": nt_classes,
                "tieRows": int(ties.sum()),
                "allNanRows": int(all_nan.sum()),
                "meanTopProbability": float(np.nanmean(rowmax)),
                "topProbabilityQuantiles": {
                    q: float(np.nanquantile(rowmax, float(q))) for q in ("0.05", "0.25", "0.5", "0.75")
                },
            }
            del m, m_filled
        log(f"connections: nodes={len(node_ids)} ntClasses={nt_classes} nt={nt_info.get('source')}")
        return {
            "path": path,
            "rows": t.num_rows,
            "columns": cols,
            "pre": pre,
            "post": post,
            "syn": syn,
            "np_code": np_code,
            "node_ids": node_ids,
            "unassigned_raw": unassigned_raw,
            "nt_code": nt_code,
            "nt_classes": nt_classes,
            "nt_info": nt_info,
        }

    # -- neuron universe --------------------------------------------------- #
    @property
    def universe(self) -> dict:
        """Sorted int64 array of neuron root ids = proofread list ∪ ids in connections."""
        if self._universe is None:
            c = self.conn
            root_ids = np.load(self.raw / ZENODO_FILES["root_ids"]).astype(np.int64)
            self.schemas["root_ids"] = f"npy dtype=uint64 shape={root_ids.shape}"
            in_conn = np.union1d(c["pre"], c["post"])
            u = np.union1d(root_ids, in_conn)
            self._universe = {
                "ids": u,
                "proofread": np.isin(u, root_ids),
                "nProofread": int(len(root_ids)),
                "nInConnections": int(len(in_conn)),
                "nInConnectionsNotProofread": int((~np.isin(in_conn, root_ids)).sum()),
                "nProofreadWithoutConnections": int((~np.isin(root_ids, in_conn)).sum()),
            }
            log(f"universe: {len(u):,} neurons (proofread list {len(root_ids):,}; in connections "
                f"{len(in_conn):,}; in connections but not proofread {self._universe['nInConnectionsNotProofread']}; "
                f"proofread without connections {self._universe['nProofreadWithoutConnections']})")
        return self._universe

    # -- per-neuron per-neuropil synapse counts ---------------------------- #
    def counts(self, which: str) -> dict:
        """which in {'post','pre'} -> dict(root=int64[], np_code=int16[], count=int64[])
        filtered to the neuron universe; np_code indexes conn['node_ids'] (-1 = label not a node)."""
        if which not in self._counts:
            with self.timer(f"load {which} counts"):
                role = "post_counts" if which == "post" else "pre_counts"
                path = self.raw / ZENODO_FILES[role]
                t = pf.read_table(path)
                self.schemas[role] = str(t.schema.remove_metadata())
                cols = t.column_names
                id_col = [c for c in cols if c.endswith("root_id")][0]
                cnt_col = [c for c in cols if c.lower() == "count"][0]
                log(f"{role}: {t.num_rows:,} rows, columns={cols}")
                mask = pc.is_in(t[id_col], value_set=pa.array(self.universe["ids"], pa.int64()))
                t = t.filter(mask)
                labels = set(distinct_labels(t["neuropil"]))
                unknown = sorted(labels - set(self.conn["node_ids"]))
                self.conn["unassigned_raw"][role] = raw_unassigned_labels(t["neuropil"])
                np_code = string_codes(t["neuropil"], self.conn["node_ids"])
                res = {
                    "rows_total": int(mask.length()),
                    "rows_in_universe": t.num_rows,
                    "root": t[id_col].to_numpy().astype(np.int64),
                    "np_code": np_code,
                    "count": t[cnt_col].to_numpy().astype(np.int64),
                    "labels_not_nodes": unknown,
                    "rows_with_label_not_node": int((np_code < 0).sum()),
                }
                log(f"{role}: {res['rows_in_universe']:,} rows for universe neurons; "
                    f"labels not in node set: {unknown} ({res['rows_with_label_not_node']} rows)")
                self._counts[which] = res
        return self._counts[which]

    # -- input / output region per neuron ---------------------------------- #
    @property
    def regions(self) -> dict:
        if self._regions is None:
            with self.timer("assign input/output regions"):
                self._regions = self._assign_regions()
        return self._regions

    def _argmax_region(self, cnt: dict, exclude_code: int) -> tuple[np.ndarray, np.ndarray, int]:
        """Per root id: neuropil code with the max count, ignoring `exclude_code` and codes < 0.
        Ties -> alphabetically first node id.  Returns (roots, codes, tie_count)."""
        keep = (cnt["np_code"] >= 0) & (cnt["np_code"] != exclude_code)
        root = cnt["root"][keep]
        code = cnt["np_code"][keep]
        count = cnt["count"][keep]
        order = np.lexsort((code, -count, root))  # primary root asc, then count desc, then code asc
        root, code, count = root[order], code[order], count[order]
        first = np.r_[True, root[1:] != root[:-1]]
        tie = first[:-1] & (root[1:] == root[:-1]) & (count[1:] == count[:-1])
        return root[first], code[first], int(tie.sum())

    def _assign_regions(self) -> dict:
        ids = self.universe["ids"]
        node_ids = self.conn["node_ids"]
        unassigned_code = node_ids.index(UNASSIGNED_ID) if UNASSIGNED_ID in node_ids else -2
        post = self.counts("post")
        pre = self.counts("pre")
        n = len(ids)

        def place(roots, codes):
            out = np.full(n, -1, np.int16)
            out[np.searchsorted(ids, roots)] = codes
            return out

        # input_region: argmax post counts over real neuropils
        r, c, ties_in = self._argmax_region(post, unassigned_code)
        input_region = place(r, c)
        stats = {"inputFromPostArgmax": int((input_region >= 0).sum()), "inputTiesPost": ties_in}
        # fallback: argmax pre counts over real neuropils
        r, c, ties_pre = self._argmax_region(pre, unassigned_code)
        pre_region = place(r, c)
        fb = (input_region < 0) & (pre_region >= 0)
        input_region[fb] = pre_region[fb]
        stats["inputFallbackToPreArgmax"] = int(fb.sum())
        stats["outputTiesPre"] = ties_pre
        # neurons whose only synapses (post or pre) are outside every neuropil mesh
        any_syn = np.zeros(n, bool)
        for cnt in (post, pre):
            any_syn[np.searchsorted(ids, np.unique(cnt["root"]))] = True
        only_unassigned = (input_region < 0) & any_syn
        if unassigned_code >= 0:
            input_region[only_unassigned] = unassigned_code
        stats["inputAssignedUnassigned"] = int(only_unassigned.sum())
        stats["droppedNeurons"] = int((input_region < 0).sum())
        # how often was UNASSIGNED the true argmax of post counts but overridden by a real neuropil?
        r_all, c_all, _ = self._argmax_region(post, -2)
        true_arg = place(r_all, c_all)
        stats["inputUnassignedArgmaxOverridden"] = int(
            ((true_arg == unassigned_code) & (input_region >= 0) & (input_region != unassigned_code)).sum()
        )
        # output_region: argmax pre counts over real neuropils; fallback UNASSIGNED if only there
        output_region = pre_region.copy()
        any_pre = np.zeros(n, bool)
        any_pre[np.searchsorted(ids, np.unique(pre["root"]))] = True
        only_un_pre = (output_region < 0) & any_pre
        if unassigned_code >= 0:
            output_region[only_un_pre] = unassigned_code
        stats["outputAssignedUnassigned"] = int(only_un_pre.sum())
        stats["outputMissing"] = int((output_region < 0).sum())
        stats["unassignedNodeIndex"] = int(unassigned_code) if unassigned_code >= 0 else None
        log(f"regions: {stats}")
        return {"input": input_region, "output": output_region, "stats": stats}

    # -- annotations ------------------------------------------------------- #
    @property
    def annotations(self) -> dict:
        if self._ann is None:
            with self.timer("load annotations"):
                path = self.raw / ANN_FILE
                ann = pd.read_csv(path, sep="\t", dtype=str, low_memory=False)
                self.schemas["annotations"] = f"tsv columns={list(ann.columns)}"
                log(f"annotations: {len(ann):,} rows, columns={list(ann.columns)}")
                missing_cols = [c for c in ANN_COLUMNS if c not in ann.columns]
                if missing_cols:
                    log(f"annotations: WARNING missing columns {missing_cols}")
                ann["root_id"] = pd.to_numeric(ann["root_id"], errors="coerce")
                bad = int(ann["root_id"].isna().sum())
                ann = ann.dropna(subset=["root_id"]).copy()
                ann["root_id"] = ann["root_id"].astype(np.int64)
                dups = int(ann["root_id"].duplicated().sum())
                ann = ann.drop_duplicates("root_id", keep="first")
                keep = ["root_id"] + [c for c in ANN_COLUMNS if c in ann.columns]
                ann = ann[keep].rename(columns=ANN_COLUMNS)
                if "top_nt_conf" in ann.columns:
                    ann["top_nt_conf"] = pd.to_numeric(ann["top_nt_conf"], errors="coerce").astype(np.float32)
                self._ann = {"df": ann, "rowsWithoutRootId": bad, "duplicateRootIds": dups}
                log(f"annotations: {len(ann):,} unique root ids (no root id: {bad}, duplicates dropped: {dups})")
        return self._ann


# --------------------------------------------------------------------------- #
# Shared manifest pieces
# --------------------------------------------------------------------------- #


def source_block(dl: dict) -> dict:
    return {
        "dataset": "FlyWire FAFB whole-brain connectome (adult female Drosophila melanogaster)",
        "materialization": MATERIALIZATION,
        "zenodoRecord": ZENODO_RECORD,
        "zenodoDoi": dl.get("zenodoDoi", ZENODO_DOI),
        "zenodoTitle": dl.get("zenodoTitle"),
        "files": [
            {"name": f["name"], "url": f["url"], "bytes": f["bytes"], "sha256": f["sha256"],
             "md5": f["md5"], "role": f["role"]}
            for f in dl["files"]
        ],
        "annotations": {
            "repo": dl["annotations"]["repo"],
            "file": dl["annotations"]["file"],
            "commit_or_tag": dl["annotations"]["commit_or_tag"],
            "url": dl["annotations"]["url"],
            "bytes": dl["annotations"]["bytes"],
            "sha256": dl["annotations"]["sha256"],
            "gitBlobSha1": dl["annotations"]["gitBlobSha1"],
            "license": dl["annotations"]["license"],
        },
        "license": "CC-BY-4.0 (Zenodo data release, license id cc-by-4.0); see annotations.license for the annotation table",
        "citations": CITATIONS,
    }


def common_assumptions(data: Data) -> list[dict]:
    nt_info = data.conn["nt_info"]
    return [
        {
            "id": "syn_count_as_weight",
            "category": "ENGINEERING_CHOICE",
            "text": (
                "Edge weight = number of predicted chemical synapses (syn_count summed over the rows that "
                "map onto the edge). This is a STRUCTURAL proxy for connection strength, NOT a physiological "
                "weight: it ignores synapse size, receptor identity, short-term dynamics, electrical "
                "synapses (gap junctions are absent from the dataset) and neuromodulation."
            ),
        },
        {
            "id": "nt_prediction_not_measurement",
            "category": "INFERRED_FROM_LITERATURE",
            "text": (
                "Neurotransmitter labels are statistical predictions from electron-microscopy images "
                "(Eckstein et al. 2024, Cell), NOT measurements. Reported accuracy: 87% per synapse, 94% per "
                "neuron, 91% for known cell types, on the six classes ACH/GABA/GLUT/DA/OCT/SER. Co-transmission "
                "and non-classical transmitters (e.g. neuropeptides, histamine) are not represented."
            ),
        },
        {
            "id": "nt_type_derivation",
            "category": "ENGINEERING_CHOICE",
            "text": (
                "The v783 connections table has no categorical nt_type column; it carries per-connection "
                "mean probabilities (ach_avg, gaba_avg, glut_avg, da_avg, oct_avg, ser_avg) averaged over the "
                "synapses of each (pre, post, neuropil) row. nt_type here = argmax of those six means, in the "
                "fixed class order ACH, GABA, GLUT, DA, OCT, SER (ties -> first in that order; "
                f"{nt_info.get('tieRows', 0)} tied rows, {nt_info.get('allNanRows', 0)} rows with no "
                "probabilities). This mirrors the Codex convention but is computed here."
                if "columns" in nt_info else
                "nt_type taken verbatim from the published nt_type column."
            ),
        },
        {
            "id": "nt_sign",
            "category": "INFERRED_FROM_LITERATURE",
            "text": (
                "No sign (excitatory/inhibitory) is encoded in the artifact; only the transmitter class. "
                "Literature convention for adult Drosophila: ACH is the main excitatory fast transmitter, "
                "GABA is inhibitory (GABA-A/Rdl and GABA-B receptors), GLUT is predominantly inhibitory in the "
                "central brain (GluCl-alpha) but can be excitatory at some synapses (e.g. neuromuscular, some "
                "NMDA/AMPA-like receptors), and DA/OCT/SER are neuromodulatory with receptor-dependent sign. "
                "Any sign assignment is the runtime's choice and must be labelled as inferred."
            ),
        },
        {
            "id": "unassigned_neuropil",
            "category": "ENGINEERING_CHOICE",
            "text": (
                "Synapses lying outside every neuropil mesh are labelled 'UNASGD' in the connections table "
                "but with the literal string 'None' in the per-neuron count tables (observed spellings per "
                f"table: {json.dumps(data.conn['unassigned_raw'])}). Both are treated as the same pseudo-region "
                f"with id '{UNASSIGNED_ID}'. Those synapses are KEPT so that no measured synapse is silently "
                "dropped; treat that node as 'outside annotated neuropils' (tracts, nerves, cell-body rind), "
                "not as a brain region, and ignore it when a neuron's input/output region is chosen unless "
                "the neuron has no synapses anywhere else."
            ),
        },
        {
            "id": "nt_unknown_class",
            "category": "ENGINEERING_CHOICE",
            "text": (
                "Connection rows whose six transmitter probabilities are all missing (NaN) are kept and "
                "labelled with an extra class 'UNKNOWN' (appended to ntClasses only if such rows exist), so "
                "that the per-class breakdown always sums to the edge weight."
            ),
        },
        {
            "id": "neuron_universe",
            "category": "ENGINEERING_CHOICE",
            "text": (
                "Neuron universe = proofread root ids (proofread_root_ids_783.npy) ∪ all pre/post ids in "
                "proofread_connections_783.feather. Per-neuron synapse counts from the per-neuron neuropil "
                "count tables are restricted to this universe (those tables also contain non-proofread "
                "segments, which are ignored)."
            ),
        },
    ]


def build_block(timer: Timer) -> dict:
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": {
            "pandas": pd.__version__,
            "pyarrow": pa.__version__,
            "numpy": np.__version__,
            "requests": requests.__version__,
        },
        "timingsSec": dict(timer.timings),
    }


# --------------------------------------------------------------------------- #
# Step 3: region-level projectome
# --------------------------------------------------------------------------- #


def build_projectome(data: Data, out_dir: Path, timer: Timer) -> dict:
    c = data.conn
    node_ids = c["node_ids"]
    n = len(node_ids)
    K = len(c["nt_classes"])
    regions = data.regions
    ids = data.universe["ids"]

    with timer("aggregate projectome edges"):
        pre_idx = np.searchsorted(ids, c["pre"])
        assert (ids[pre_idx] == c["pre"]).all()
        src = regions["input"][pre_idx].astype(np.int64)
        valid = src >= 0
        dropped_rows = int((~valid).sum())
        dropped_syn = int(c["syn"][~valid].sum())
        key = src[valid] * n + c["np_code"][valid].astype(np.int64)
        w = c["syn"][valid].astype(np.float64)
        nt = c["nt_code"][valid]
        W = np.rint(np.bincount(key, weights=w, minlength=n * n)).astype(np.int64)
        NT = np.stack(
            [np.rint(np.bincount(key[nt == k], weights=w[nt == k], minlength=n * n)).astype(np.int64)
             for k in range(K)], axis=1)  # (n*n, K)
        assert (NT.sum(axis=1) == W).all()
        edge_idx = np.flatnonzero(W > 0)
        e_src = (edge_idx // n).astype(int)
        e_dst = (edge_idx % n).astype(int)
        e_w = W[edge_idx]
        e_nt = NT[edge_idx]  # (E, K)
        Wm = W.reshape(n, n)
        NTm = NT.reshape(n, n, K)
        neuron_count = np.bincount(regions["input"][regions["input"] >= 0], minlength=n)
        total_syn = int(W.sum())
        log(f"projectome: {n} nodes, {len(edge_idx):,} edges, {total_syn:,} synapses "
            f"({dropped_rows} rows / {dropped_syn} synapses dropped for neurons without a region)")

    with timer("write projectome"):
        out_dir.mkdir(parents=True, exist_ok=True)
        nodes = []
        for i, nid in enumerate(node_ids):
            nodes.append({
                "id": nid,
                "index": i,
                "provenance": "MEASURED",
                "neuronCount": int(neuron_count[i]),
                "inSynapses": int(Wm[:, i].sum()),
                "outSynapses": int(Wm[i, :].sum()),
                "outNt": {cls: int(NTm[i, :, k].sum()) for k, cls in enumerate(c["nt_classes"])},
            })
        write_json(out_dir / "nodes.json", nodes)
        graph = {
            "format": "coo",
            "n": n,
            "src": e_src.tolist(),
            "dst": e_dst.tolist(),
            "weight": e_w.tolist(),
            "nt": {cls: e_nt[:, k].tolist() for k, cls in enumerate(c["nt_classes"])},
        }
        (out_dir / "graph.json").write_text(json.dumps(graph, separators=(",", ":")) + "\n")

        # ---- stats for the manifest + sanity report ----
        order = np.argsort(-e_w, kind="stable")
        top = [{"src": node_ids[e_src[j]], "dst": node_ids[e_dst[j]], "weight": int(e_w[j]),
                "self": bool(e_src[j] == e_dst[j])} for j in order[:25]]
        nonself = [j for j in order if e_src[j] != e_dst[j]][:25]
        top_nonself = [{"src": node_ids[e_src[j]], "dst": node_ids[e_dst[j]], "weight": int(e_w[j])} for j in nonself]
        self_syn = int(sum(int(Wm[i, i]) for i in range(n)))
        nt_tot = {cls: int(NT[:, k].sum()) for k, cls in enumerate(c["nt_classes"])}
        nt_rows = {cls: int((c["nt_code"] == k).sum()) for k, cls in enumerate(c["nt_classes"])}
        rank_of = {(int(e_src[j]), int(e_dst[j])): r + 1 for r, j in enumerate(order)}
        checks = []
        for s, d in [("AL_L", "MB_CA_L"), ("AL_L", "LH_L"), ("AL_R", "MB_CA_R"), ("AL_R", "LH_R"),
                     ("MB_CA_L", "MB_PED_L"), ("MB_CA_L", "MB_VL_L"), ("MB_CA_L", "MB_ML_L"),
                     ("MB_CA_R", "MB_PED_R"), ("MB_CA_R", "MB_VL_R"), ("MB_CA_R", "MB_ML_R"),
                     ("ME_L", "LO_L"), ("LO_L", "LOP_L"), ("ME_R", "LO_R"), ("LO_R", "LOP_R"),
                     ("LA_L", "ME_L"), ("LA_R", "ME_R"), ("PB", "EB"), ("EB", "PB"), ("FB", "EB"), ("GNG", "SAD")]:
            if s in node_ids and d in node_ids:
                si, di = node_ids.index(s), node_ids.index(d)
                wgt = int(Wm[si, di])
                out_row = Wm[si].copy()
                out_row[si] = 0
                out_rank = int((out_row > wgt).sum()) + 1 if wgt > 0 else None
                checks.append({"src": s, "dst": d, "weight": wgt, "rankAllEdges": rank_of.get((si, di)),
                               "rankAmongSrcOutEdgesExclSelf": out_rank,
                               "fractionOfSrcOutExclSelf": round(float(wgt / out_row.sum()), 4) if out_row.sum() else None})
        stats = {
            "selfEdgeSynapses": self_syn,
            "selfEdgeFraction": round(self_syn / total_syn, 4),
            "ntSynapseTotals": nt_tot,
            "ntConnectionRowTotals": nt_rows,
            "topEdges": top,
            "topEdgesExcludingSelf": top_nonself,
            "sanityChecks": checks,
        }
        manifest = {
            "artifactVersion": 1,
            "id": PROJECTOME_ID,
            "level": "projectome",
            "createdAt": now_iso(),
            "source": source_block(data.dl),
            "preprocessing": {
                "tool": "connectome-etl/build.py",
                "steps": [
                    f"Download {', '.join(ZENODO_FILES.values())} from Zenodo record {ZENODO_RECORD} and verify MD5 against the record; download {ANN_PATH} from {ANN_REPO}@{ANN_COMMIT} and verify its git blob SHA-1.",
                    "Read proofread_connections_783.feather (one row per (pre_pt_root_id, post_pt_root_id, neuropil) with syn_count and six mean transmitter probabilities).",
                    f"Nodes = sorted distinct values of the connections table's `neuropil` column ('{UNASSIGNED_ID}' = synapses outside every neuropil mesh; the count tables spell the same thing 'None').",
                    "Neuron universe = proofread_root_ids_783.npy ∪ {pre, post ids in the connections table}.",
                    f"input_region(neuron) = neuropil with the maximum postsynaptic (input) synapse count in per_neuron_neuropil_count_post_783.feather, ignoring {UNASSIGNED_ID}; ties -> alphabetically first neuropil id; if the neuron has no post counts in any neuropil, fall back to its max presynaptic-count neuropil (per_neuron_neuropil_count_pre_783.feather); if it only has synapses outside every neuropil, assign {UNASSIGNED_ID}; if it has no counts at all, drop it and count it in droppedNeurons.",
                    "For each connection row (pre, post, neuropil N, syn_count, nt): edge input_region(pre) -> N, weight += syn_count, nt[nt_type] += syn_count.",
                    "nt_type per row = argmax of (ach_avg, gaba_avg, glut_avg, da_avg, oct_avg, ser_avg).",
                    "Per node: neuronCount = neurons whose input_region is the node; inSynapses = sum of incoming edge weights (= all synapses located in the node); outSynapses = sum of outgoing edge weights; outNt = transmitter composition of outgoing synapses.",
                    "Edges sorted by (src, dst); self-edges kept (intra-region connectivity).",
                ],
                "droppedNeurons": regions["stats"]["droppedNeurons"],
                "droppedConnectionRows": dropped_rows,
                "droppedSynapses": dropped_syn,
                "regionAssignment": regions["stats"],
                "neuronUniverse": {k: v for k, v in data.universe.items() if k not in ("ids", "proofread")},
                "connectionsRows": c["rows"],
                "ntDerivation": c["nt_info"],
                "inputSchemas": data.schemas,
                "assumptions": common_assumptions(data) + [
                    {
                        "id": "input_region_argmax",
                        "category": "ENGINEERING_CHOICE",
                        "text": (
                            "Each neuron is collapsed to ONE input region: the neuropil holding the largest "
                            "number of its postsynaptic sites. A region-level edge A -> B therefore means "
                            "'neurons that mostly LISTEN in A make synapses located in B' — information flows "
                            "from where a neuron listens to where it talks. Neurons with inputs spread over "
                            "several neuropils are attributed entirely to their top one (no fractional "
                            "splitting). Alternative not built here (future variant): output_region(pre) -> "
                            "input_region(post), i.e. attribute the synapse to the postsynaptic neuron's "
                            "listening region instead of the synapse's own location."
                        ),
                    },
                    {
                        "id": "edge_dst_is_synapse_location",
                        "category": "ENGINEERING_CHOICE",
                        "text": (
                            "The edge destination is the neuropil in which the synapse itself lies (the "
                            "connections table's `neuropil` column), not the postsynaptic neuron's input "
                            "region. Consequently inSynapses(node) equals the total number of proofread "
                            "synapses located inside that neuropil."
                        ),
                    },
                ],
            },
            "graph": {
                "nodeCount": n,
                "edgeCount": int(len(edge_idx)),
                "totalSynapses": total_syn,
                "weightSemantics": "synapse_count",
                "ntClasses": c["nt_classes"],
                "unassignedNodeId": UNASSIGNED_ID if UNASSIGNED_ID in node_ids else None,
                "selfEdges": int(sum(1 for i in range(n) if Wm[i, i] > 0)),
            },
            "stats": stats,
            "build": build_block(timer),
            "checksums": {
                "nodes.json": "sha256:" + sha256_file(out_dir / "nodes.json"),
                "graph.json": "sha256:" + sha256_file(out_dir / "graph.json"),
            },
        }
        write_json(out_dir / "manifest.json", manifest)
        log(f"wrote {out_dir}/{{manifest,nodes,graph}}.json")

    # ---- console report ----
    print("\nNODES:", ", ".join(node_ids))
    print("\nTOP 15 EDGES (all):")
    for e in top[:15]:
        print(f"  {e['src']:>9} -> {e['dst']:<9} {e['weight']:>10,}{'  (self)' if e['self'] else ''}")
    print("\nTOP 15 EDGES (excluding self-edges):")
    for e in top_nonself[:15]:
        print(f"  {e['src']:>9} -> {e['dst']:<9} {e['weight']:>10,}")
    print("\nSANITY CHECKS:")
    for ch in checks:
        print(f"  {ch['src']:>8} -> {ch['dst']:<8} w={ch['weight']:>9,}  rank(all)={ch['rankAllEdges']}  "
              f"rank(out of src, excl self)={ch['rankAmongSrcOutEdgesExclSelf']}  "
              f"frac of src out={ch['fractionOfSrcOutExclSelf']}")
    print("\nNT totals (synapses):", nt_tot)
    print("NT totals (connection rows):", nt_rows)
    print(f"self-edge synapses: {self_syn:,} ({100 * self_syn / total_syn:.1f}%)\n")
    return manifest


# --------------------------------------------------------------------------- #
# Step 4: neuron-level consolidated graph
# --------------------------------------------------------------------------- #


def build_neuron(data: Data, out_dir: Path, timer: Timer) -> dict:
    c = data.conn
    ids = data.universe["ids"]
    N = len(ids)
    K = len(c["nt_classes"])
    node_ids = c["node_ids"]
    regions = data.regions

    with timer("aggregate neuron edges"):
        pre_idx = np.searchsorted(ids, c["pre"]).astype(np.int64)
        post_idx = np.searchsorted(ids, c["post"]).astype(np.int64)
        assert (ids[pre_idx] == c["pre"]).all() and (ids[post_idx] == c["post"]).all()
        key = pre_idx * N + post_idx
        uniq, inv = np.unique(key, return_inverse=True)
        E = len(uniq)
        w = c["syn"].astype(np.float64)
        weight = np.rint(np.bincount(inv, weights=w, minlength=E)).astype(np.int64)
        ntw = np.stack(
            [np.rint(np.bincount(inv[c["nt_code"] == k], weights=w[c["nt_code"] == k], minlength=E)).astype(np.int64)
             for k in range(K)], axis=1)
        assert (ntw.sum(axis=1) == weight).all()
        nt_major = ntw.argmax(axis=1).astype(np.uint8)
        nt_ties = int(((ntw == ntw.max(axis=1, keepdims=True)).sum(axis=1) > 1).sum())
        src = (uniq // N).astype(np.uint32)
        dst = (uniq % N).astype(np.uint32)
        assert weight.max() < 2**32 and N < 2**32
        total_syn = int(weight.sum())
        self_edges = int((src == dst).sum())
        log(f"neuron graph: {N:,} neurons, {E:,} edges from {c['rows']:,} rows, {total_syn:,} synapses, "
            f"{self_edges} autapses, nt ties {nt_ties}")
        del key, inv, w

    with timer("write neuron artifact"):
        out_dir.mkdir(parents=True, exist_ok=True)
        # graph.bin: concatenated little-endian typed arrays
        arrays = [("src", src.astype("<u4"), "uint32"), ("dst", dst.astype("<u4"), "uint32"),
                  ("weight", weight.astype("<u4"), "uint32"), ("nt", nt_major.astype("u1"), "uint8")]
        layout = []
        offset = 0
        with open(out_dir / "graph.bin", "wb") as f:
            for name, arr, dtype in arrays:
                b = arr.tobytes()
                f.write(b)
                layout.append({"name": name, "dtype": dtype, "offset": offset, "length": E, "byteLength": len(b)})
                offset += len(b)
        bin_sha = sha256_file(out_dir / "graph.bin")
        header = {
            "format": "flytown-typed-arrays",
            "formatVersion": 1,
            "file": "graph.bin",
            "byteOrder": "little",
            "totalBytes": offset,
            "sha256": "sha256:" + bin_sha,
            "edgeCount": E,
            "nodeCount": N,
            "arrays": layout,
            "sortedBy": ["src", "dst"],
            "nodeIndexRef": "neurons.parquet column `index` (== row position; root_id sorted ascending)",
            "weightSemantics": "synapse_count (sum over neuropils of the (pre, post) pair)",
            "ntClasses": c["nt_classes"],
            "ntSemantics": "uint8 index into ntClasses; majority transmitter of the (pre, post) pair by synapse count (ties -> first in ntClasses order)",
            "aggregatedFromRows": c["rows"],
        }
        write_json(out_dir / "graph.header.json", header)

        # neurons.parquet
        ann = data.annotations["df"]
        region_names = np.array(node_ids + [None], dtype=object)
        df = pd.DataFrame({
            "root_id": ids,
            "index": np.arange(N, dtype=np.int32),
            "proofread": data.universe["proofread"],
            "input_region": region_names[np.where(regions["input"] >= 0, regions["input"], len(node_ids))],
            "output_region": region_names[np.where(regions["output"] >= 0, regions["output"], len(node_ids))],
        })
        df["input_region"] = df["input_region"].astype("string")
        df["output_region"] = df["output_region"].astype("string")
        df = df.merge(ann, on="root_id", how="left")
        assert len(df) == N
        for col in ann.columns:
            if col not in ("root_id", "top_nt_conf"):
                df[col] = df[col].astype("string")
        df["annotated"] = df["root_id"].isin(ann["root_id"].to_numpy())
        df.to_parquet(out_dir / "neurons.parquet", engine="pyarrow", index=False, compression="zstd")
        annotated = int(df["annotated"].sum())
        log(f"neurons.parquet: {N:,} rows, {annotated:,} with annotations "
            f"({100 * annotated / N:.1f}%); columns={list(df.columns)}")

        cov = {col: int(df[col].notna().sum()) for col in ann.columns if col != "root_id"}
        top_classes = {
            "super_class": {str(k): int(v) for k, v in df["super_class"].value_counts(dropna=True).head(12).items()}
            if "super_class" in df else {},
            "top_nt": {str(k): int(v) for k, v in df["top_nt"].value_counts(dropna=True).items()}
            if "top_nt" in df else {},
        }
        order = np.argsort(-weight, kind="stable")[:15]
        top_edges = [{"pre": int(ids[src[j]]), "post": int(ids[dst[j]]), "weight": int(weight[j]),
                      "nt": c["nt_classes"][nt_major[j]]} for j in order]
        sizes = {name: (out_dir / name).stat().st_size for name in ("graph.bin", "neurons.parquet", "graph.header.json")}
        manifest = {
            "artifactVersion": 1,
            "id": NEURON_ID,
            "level": "neuron",
            "createdAt": now_iso(),
            "source": source_block(data.dl),
            "preprocessing": {
                "tool": "connectome-etl/build.py",
                "steps": [
                    "Same downloads/verification and neuron universe as fafb-v783-projectome-1.",
                    "neurons.parquet: one row per neuron in the universe, sorted by root_id ascending; `index` = row position and is the node index used by graph.bin.",
                    f"input_region / output_region: argmax of postsynaptic / presynaptic synapse counts per neuropil ({UNASSIGNED_ID} ignored unless it is the only label; null if the neuron has no counts).",
                    f"Annotation columns left-joined from {ANN_PATH} ({ANN_REPO} {ANN_TAG}) on root_id; original labels kept verbatim (e.g. top_nt is spelled 'acetylcholine', not 'ACH'); `annotated` marks rows with a matching annotation.",
                    "graph.bin: rows of the connections table aggregated to (pre, post) pairs: weight = sum of syn_count over neuropils; nt = transmitter class with the largest synapse count in the pair (ties -> first in ntClasses order). Edges sorted by (src, dst). Autapses kept.",
                ],
                "droppedNeurons": regions["stats"]["droppedNeurons"],
                "regionAssignment": regions["stats"],
                "neuronUniverse": {k: v for k, v in data.universe.items() if k not in ("ids", "proofread")},
                "annotations": {
                    "rowsWithoutRootId": data.annotations["rowsWithoutRootId"],
                    "duplicateRootIdsDropped": data.annotations["duplicateRootIds"],
                    "neuronsAnnotated": annotated,
                    "columnCoverage": cov,
                    "columnMap": ANN_COLUMNS,
                },
                "ntDerivation": c["nt_info"],
                "ntMajorityTies": nt_ties,
                "inputSchemas": data.schemas,
                "assumptions": common_assumptions(data) + [
                    {
                        "id": "pair_aggregation",
                        "category": "ENGINEERING_CHOICE",
                        "text": (
                            "Neuropil is dropped when consolidating: a (pre, post) pair that synapses in several "
                            "neuropils becomes one edge whose weight is the total synapse count and whose "
                            "transmitter is the synapse-count-weighted majority across those rows."
                        ),
                    },
                ],
            },
            "graph": {
                "nodeCount": N,
                "edgeCount": E,
                "totalSynapses": total_syn,
                "weightSemantics": "synapse_count",
                "ntClasses": c["nt_classes"],
                "aggregatedFromRows": c["rows"],
                "autapses": self_edges,
                "files": {name: {"bytes": size} for name, size in sizes.items()},
            },
            "stats": {
                "ntEdgeTotals": {cls: int((nt_major == k).sum()) for k, cls in enumerate(c["nt_classes"])},
                "ntSynapseTotals": {cls: int(ntw[:, k].sum()) for k, cls in enumerate(c["nt_classes"])},
                "topEdges": top_edges,
                "annotationValueCounts": top_classes,
                "weightQuantiles": {q: int(np.quantile(weight, float(q))) for q in ("0.5", "0.9", "0.99", "0.999")},
                "maxWeight": int(weight.max()),
            },
            "build": build_block(timer),
            "checksums": {
                "neurons.parquet": "sha256:" + sha256_file(out_dir / "neurons.parquet"),
                "graph.bin": "sha256:" + bin_sha,
                "graph.header.json": "sha256:" + sha256_file(out_dir / "graph.header.json"),
            },
        }
        write_json(out_dir / "manifest.json", manifest)
        log(f"wrote {out_dir}/{{manifest.json,graph.header.json,graph.bin,neurons.parquet}}; sizes={sizes}")
    return manifest


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download", action="store_true", help="download + verify raw inputs")
    ap.add_argument("--projectome", action="store_true", help=f"build {PROJECTOME_ID}")
    ap.add_argument("--neuron", action="store_true", help=f"build {NEURON_ID}")
    ap.add_argument("--all", action="store_true", help="--download --projectome --neuron")
    ap.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW)
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args(argv)
    if args.all:
        args.download = args.projectome = args.neuron = True
    if not (args.download or args.projectome or args.neuron):
        ap.print_help()
        return 2

    timer = Timer()
    t_start = time.perf_counter()
    if args.download:
        with timer("download"):
            download(args.raw_dir)
    if args.projectome or args.neuron:
        data = Data(args.raw_dir, timer)
        if args.projectome:
            build_projectome(data, args.out_dir / PROJECTOME_ID, timer)
        if args.neuron:
            build_neuron(data, args.out_dir / NEURON_ID, timer)
    log(f"timings (s): {json.dumps(timer.timings)}; total {time.perf_counter() - t_start:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
