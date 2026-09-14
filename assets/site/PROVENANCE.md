# Site asset provenance

## Mayor illustration

`flytown-mayor.webp` is a WebP derivative of `flytyownmayor.png`, supplied by the project owner for use as the FLYTOWN hero. The derivative preserves the full 1254 × 1254 composition and removes metadata. This repository does not make an additional ownership claim about the source artwork.

## Fonts

The site self-hosts these fonts from the [Google Fonts repository](https://github.com/google/fonts), all under the SIL Open Font License 1.1 included as `fonts/OFL-1.1.txt`:

- Alfa Slab One Regular, copyright the Alfa Slab One Project Authors.
- Atkinson Hyperlegible Regular and Bold, copyright Braille Institute of America, Inc.
- Fragment Mono Regular, copyright the Fragment Mono Project Authors.

No external font service or runtime CDN is used.

## Connectome diagrams

`diagrams/adult-projectome-circle.svg` and `diagrams/larval-class-circle.svg` are deterministic visual derivatives of the checked-in FLYTOWN connectome artifacts. Run `node scripts/build-connectome-diagrams.mjs` to reproduce them.

- The adult diagram reads `connectome/fafb-v783-projectome-1`, places all 79 neuropil regions on the circle, and draws the 110 highest-weight directed edges between different regions.
- The larval diagram reads `connectome/l1-larva-winding2023-1`, aggregates all 2,952 neurons into 14 `class1` annotations, and draws the 54 highest-weight directed flows between different classes.

Self-connections are omitted from both explanatory views. Node counts, edge counts, directions, and synapse weights are measured-data fields; circular ordering, aggregation, edge filtering, size scaling, and color are presentation choices. Dataset sources, terms, and scientific citations are recorded in the repository `NOTICE.md` and the two artifact manifests.
