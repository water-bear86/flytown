# Mushroom body as a task memory — model-free experiments

connectome: l1-larva-winding2023-1 · pathway=feedforward · corpus: 80 authored tasks over 10 categories · no model calls

## 1. Is the Kenyon-cell code a locality-sensitive hash of tasks?

| odour/keyword | graph | AUC (same vs cross category) | Spearman (code vs keyword similarity) | mean same-cat sim | mean cross-cat sim | distinct codes | active receptors | receptor overlap |
|---|---|---|---|---|---|---|---|---|
| 0.024 | real | 0.649 | 0.181 | 0.177 | 0.107 | 100% | 6.1 | 0.102 |
| 0.024 | shuffled(seed 1) | 0.687 | 0.146 | 0.507 | 0.252 | 56% | – | – |
| 0.024 | shuffled(seed 2) | 0.700 | 0.154 | 0.512 | 0.274 | 51% | – | – |
| 0.024 | shuffled(seed 3) | 0.683 | 0.179 | 0.493 | 0.280 | 55% | – | – |
| 0.024 | random_degree(seed 1) | 0.663 | 0.157 | 0.356 | 0.188 | 75% | – | – |
| 0.024 | random_degree(seed 2) | 0.688 | 0.149 | 0.351 | 0.179 | 75% | – | – |
| 0.024 | random_degree(seed 3) | 0.688 | 0.166 | 0.360 | 0.176 | 74% | – | – |
| 0.05 | real | 0.645 | 0.166 | 0.177 | 0.122 | 100% | 11.4 | 0.171 |
| 0.05 | shuffled(seed 1) | 0.687 | 0.145 | 0.490 | 0.259 | 64% | – | – |
| 0.05 | shuffled(seed 2) | 0.698 | 0.163 | 0.482 | 0.271 | 65% | – | – |
| 0.05 | shuffled(seed 3) | 0.697 | 0.170 | 0.491 | 0.299 | 68% | – | – |
| 0.05 | random_degree(seed 1) | 0.676 | 0.194 | 0.374 | 0.227 | 85% | – | – |
| 0.05 | random_degree(seed 2) | 0.653 | 0.172 | 0.299 | 0.202 | 98% | – | – |
| 0.05 | random_degree(seed 3) | 0.658 | 0.165 | 0.326 | 0.205 | 91% | – | – |
| 0.1 | real | 0.594 | 0.127 | 0.145 | 0.114 | 100% | 20.1 | 0.324 |
| 0.1 | shuffled(seed 1) | 0.726 | 0.148 | 0.506 | 0.295 | 76% | – | – |
| 0.1 | shuffled(seed 2) | 0.718 | 0.169 | 0.472 | 0.297 | 89% | – | – |
| 0.1 | shuffled(seed 3) | 0.706 | 0.148 | 0.526 | 0.365 | 83% | – | – |
| 0.1 | random_degree(seed 1) | 0.642 | 0.206 | 0.401 | 0.277 | 91% | – | – |
| 0.1 | random_degree(seed 2) | 0.612 | 0.095 | 0.331 | 0.266 | 99% | – | – |
| 0.1 | random_degree(seed 3) | 0.601 | 0.141 | 0.342 | 0.274 | 95% | – | – |
| 0.15 | real | 0.604 | 0.164 | 0.180 | 0.143 | 100% | 26.8 | 0.477 |
| 0.15 | shuffled(seed 1) | 0.719 | 0.180 | 0.533 | 0.332 | 76% | – | – |
| 0.15 | shuffled(seed 2) | 0.680 | 0.170 | 0.518 | 0.372 | 85% | – | – |
| 0.15 | shuffled(seed 3) | 0.713 | 0.154 | 0.569 | 0.407 | 84% | – | – |
| 0.15 | random_degree(seed 1) | 0.619 | 0.153 | 0.426 | 0.330 | 95% | – | – |
| 0.15 | random_degree(seed 2) | 0.567 | 0.110 | 0.434 | 0.396 | 99% | – | – |
| 0.15 | random_degree(seed 3) | 0.586 | 0.124 | 0.426 | 0.366 | 98% | – | – |

Real minus null:
- odour 0.024 vs shuffled: AUC -0.041, Spearman +0.021
- odour 0.024 vs random_degree: AUC -0.031, Spearman +0.023
- odour 0.05 vs shuffled: AUC -0.049, Spearman +0.006
- odour 0.05 vs random_degree: AUC -0.017, Spearman -0.012
- odour 0.1 vs shuffled: AUC -0.123, Spearman -0.029
- odour 0.1 vs random_degree: AUC -0.025, Spearman -0.021
- odour 0.15 vs shuffled: AUC -0.099, Spearman -0.004
- odour 0.15 vs random_degree: AUC +0.014, Spearman +0.035

AUC 0.5 = code similarity carries no category information. Spearman 0 = the code does not preserve input-space similarity at all.

## 2. Does a stored association generalise to held-out tasks?

| graph | sign accuracy on held-out | mean \|valence shift\| | same-cat code overlap | cross-cat | same − cross | p (sign) |
|---|---|---|---|---|---|---|
| real @odour 0.024 | 45% | 0.0088 | 0.181 | 0.107 | +0.074 | 0.633 |
| shuffled @odour 0.024 | 23% | 0.0003 | 0.516 | 0.269 | +0.247 | 0.028 |
| random_degree @odour 0.024 | 48% | 0.0002 | 0.369 | 0.181 | +0.188 | 0.778 |
| real @odour 0.05 | 50% | 0.0093 | 0.180 | 0.122 | +0.058 | 1.000 |
| shuffled @odour 0.05 | 23% | 0.0003 | 0.497 | 0.277 | +0.220 | 0.109 |
| random_degree @odour 0.05 | 48% | 0.0002 | 0.341 | 0.212 | +0.129 | 0.858 |
| real @odour 0.1 | 48% | 0.0131 | 0.147 | 0.116 | +0.030 | 0.865 |
| shuffled @odour 0.1 | 25% | 0.0004 | 0.507 | 0.320 | +0.187 | 0.324 |
| random_degree @odour 0.1 | 53% | 0.0002 | 0.366 | 0.274 | +0.092 | 0.254 |
| real @odour 0.15 | 50% | 0.0122 | 0.182 | 0.145 | +0.037 | 1.000 |
| shuffled @odour 0.15 | 26% | 0.0005 | 0.544 | 0.371 | +0.174 | 0.465 |
| random_degree @odour 0.15 | 45% | 0.0004 | 0.435 | 0.365 | +0.070 | 0.707 |

Sign accuracy 50% = retrieval is uninformative about whether a task of this kind went well or badly. "same − cross" > 0 is the generalisation mechanism: held-out tasks must share more code with their own category's training tasks than with others.

