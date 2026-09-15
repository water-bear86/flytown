> Reproduce: `flytown fly hash --connectome malecns-v1.0-mb-1` (defaults: odour sparseness 0.024, 0.05, 0.10, 0.15; null seeds 1–3). The artifact's graph.json is rebuilt by `connectome-etl/build_male.py --mb`.

# Mushroom body as a task memory — model-free experiments

connectome: malecns-v1.0-mb-1 · corpus: 80 authored tasks over 10 categories · no model calls

## 1. Is the Kenyon-cell code a locality-sensitive hash of tasks?

| odour/keyword | graph | AUC (same vs cross category) | Spearman (code vs keyword similarity) | mean same-cat sim | mean cross-cat sim | distinct codes | active receptors | receptor overlap |
|---|---|---|---|---|---|---|---|---|
| 0.024 | real | 0.656 | 0.205 | 0.279 | 0.250 | 100% | 414.3 | 0.107 |
| 0.024 | shuffled(seed 1) | 0.622 | 0.188 | 0.377 | 0.344 | 100% | – | – |
| 0.024 | shuffled(seed 2) | 0.610 | 0.169 | 0.372 | 0.346 | 100% | – | – |
| 0.024 | shuffled(seed 3) | 0.625 | 0.213 | 0.386 | 0.353 | 100% | – | – |
| 0.024 | random_degree(seed 1) | 0.658 | 0.298 | 0.210 | 0.161 | 100% | – | – |
| 0.024 | random_degree(seed 2) | 0.645 | 0.274 | 0.194 | 0.159 | 100% | – | – |
| 0.024 | random_degree(seed 3) | 0.661 | 0.179 | 0.203 | 0.168 | 100% | – | – |
| 0.05 | real | 0.709 | 0.230 | 0.369 | 0.328 | 100% | 787.4 | 0.194 |
| 0.05 | shuffled(seed 1) | 0.618 | 0.184 | 0.453 | 0.427 | 100% | – | – |
| 0.05 | shuffled(seed 2) | 0.633 | 0.211 | 0.470 | 0.445 | 100% | – | – |
| 0.05 | shuffled(seed 3) | 0.600 | 0.125 | 0.459 | 0.434 | 100% | – | – |
| 0.05 | random_degree(seed 1) | 0.688 | 0.256 | 0.266 | 0.226 | 100% | – | – |
| 0.05 | random_degree(seed 2) | 0.645 | 0.237 | 0.255 | 0.225 | 100% | – | – |
| 0.05 | random_degree(seed 3) | 0.627 | 0.197 | 0.264 | 0.238 | 100% | – | – |
| 0.1 | real | 0.672 | 0.205 | 0.469 | 0.435 | 100% | 1369.7 | 0.363 |
| 0.1 | shuffled(seed 1) | 0.609 | 0.205 | 0.576 | 0.552 | 100% | – | – |
| 0.1 | shuffled(seed 2) | 0.642 | 0.222 | 0.586 | 0.563 | 100% | – | – |
| 0.1 | shuffled(seed 3) | 0.610 | 0.160 | 0.573 | 0.548 | 100% | – | – |
| 0.1 | random_degree(seed 1) | 0.654 | 0.265 | 0.351 | 0.319 | 100% | – | – |
| 0.1 | random_degree(seed 2) | 0.692 | 0.234 | 0.351 | 0.312 | 100% | – | – |
| 0.1 | random_degree(seed 3) | 0.656 | 0.173 | 0.349 | 0.316 | 100% | – | – |
| 0.15 | real | 0.665 | 0.193 | 0.525 | 0.495 | 100% | 1783.2 | 0.519 |
| 0.15 | shuffled(seed 1) | 0.613 | 0.190 | 0.634 | 0.611 | 100% | – | – |
| 0.15 | shuffled(seed 2) | 0.629 | 0.189 | 0.644 | 0.624 | 100% | – | – |
| 0.15 | shuffled(seed 3) | 0.628 | 0.174 | 0.642 | 0.620 | 100% | – | – |
| 0.15 | random_degree(seed 1) | 0.658 | 0.260 | 0.418 | 0.385 | 100% | – | – |
| 0.15 | random_degree(seed 2) | 0.683 | 0.281 | 0.402 | 0.366 | 100% | – | – |
| 0.15 | random_degree(seed 3) | 0.673 | 0.173 | 0.413 | 0.377 | 100% | – | – |

Real minus null:
- odour 0.024 vs shuffled: AUC +0.037, Spearman +0.015
- odour 0.024 vs random_degree: AUC +0.002, Spearman -0.045
- odour 0.05 vs shuffled: AUC +0.092, Spearman +0.056
- odour 0.05 vs random_degree: AUC +0.056, Spearman -0.000
- odour 0.1 vs shuffled: AUC +0.052, Spearman +0.009
- odour 0.1 vs random_degree: AUC +0.005, Spearman -0.019
- odour 0.15 vs shuffled: AUC +0.041, Spearman +0.009
- odour 0.15 vs random_degree: AUC -0.007, Spearman -0.045

AUC 0.5 = code similarity carries no category information. Spearman 0 = the code does not preserve input-space similarity at all.


