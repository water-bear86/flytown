# Connectome circle diagrams

These SVGs are deterministic views of the checked-in FLYTOWN connectome artifacts. Regenerate them from the repository root with:

```sh
node scripts/build-connectome-diagrams.mjs
```

## Adult projectome

`adult-projectome-circle.svg` reads `connectome/fafb-v783-projectome-1/nodes.json` and `graph.json`. It places all 79 measured neuropil regions on the ring and draws the 110 strongest non-self region-to-region edges. Node size encodes total incoming plus outgoing synapse traffic. Ten high-traffic regions receive non-overlapping text labels.

## Larval class view

`larval-class-circle.svg` reads `connectome/l1-larva-winding2023-1/nodes.json` and `graph.json`. It aggregates the measured 2,952-neuron graph into fourteen named `class1` groups and draws the 54 strongest non-self class-to-class flows. Node size encodes the number of neurons in the displayed class.

## Interpretation and licensing

The underlying nodes, edges, weights, and annotations come from the versioned connectome artifacts. Circular ordering, class selection, aggregation, label selection, edge filtering, radius, and color are `ENGINEERING_CHOICE` visualization decisions. Self-edges are omitted from both diagrams for legibility. The diagrams are explanatory views, not additional experimental results.

The source artifacts retain their upstream licenses and citation requirements. See the repository `NOTICE.md` and the artifact manifests for the FlyWire FAFB v783 and Winding et al. 2023 citations.
