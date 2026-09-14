# FLYTOWN public site — design QA

Date: 2026-09-13

Route: `/`

Operational-console regression route: `/fly`

## Review matrix

| Viewport | Result | Notes |
| --- | --- | --- |
| 1440 × 900 | Pass | Accountability-first hero, Mayor portrait, source ledger, and every major content section captured and inspected. |
| 1440 × 1600 | Pass | Adult and larval atlas plates, captions, measurements, and provenance key captured together with no clipping. |
| 1280 × 800 | Pass | Primary action ends at y=600 and the scope statement at y=663; both are visible without scrolling. |
| 768 × 1024 | Pass | Responsive layout has no document-level horizontal overflow. |
| 414 × 812 | Pass | Hero preserves the accusation, Mayor, finding, explanation, action, and scope qualifier with no page overflow. |
| 390 × 844 | Pass | Mobile hero, four-step launch-source ledger, verdict, evidence boundary, and research flow captured and inspected. |
| 390 × 1600 | Pass | Atlas plates stack in reading order; captions, statistics, provenance labels, and the transition into the control comparison remain legible. |
| 375 × 812 | Pass | No document-level horizontal overflow; the scope qualifier ends at y=796. |
| 320 × 812 | Pass | Narrowest supported check has no document-level horizontal overflow; compact type and a single action keep the accusation and full scope qualifier in the first viewport. |

## Interaction and accessibility checks

- Evidence tabs switch the visible report by pointer.
- `ArrowRight` wraps focus and selection from Memory role to Region routing.
- The clone control changes to `Copied` and announces `Clone command copied to the clipboard.` through a status region.
- Local fonts finish loading before settled screenshots are taken.
- The hero image has descriptive alternative text; its caption explicitly identifies the Mayor as a character witness rather than evidence.
- The page uses visible keyboard focus, semantic landmarks, a skip link, native links and buttons, and a reduced-motion override.
- Provenance and result labels are expressed in text, not color alone.
- Both connectome diagrams have descriptive alternative text, intrinsic dimensions, and successful 720 × 720 loads.
- Each connectome diagram links to its standalone SVG so fine labels can be inspected at full resolution on narrow screens.
- The atlas is labelled by its heading and the provenance key has an accessible name.

## Content and evidence checks

- The first viewport states the accountability finding plainly: the token exists, but the public code does not support autonomous launch agency.
- The audited external token is identified by its Robinhood Chain contract, and all four causal-chain references are pinned to commit `cec385e7bf9fb8eca9898f48be5a327bcf6d9408`.
- The source ledger separates the measured connection graph from the engineered neuron model, DOM-aware target selection, rig-completed market and launch operations, and conventional wallet signature.
- The final ledger row links directly to the pinned Python signing and raw-transaction broadcast implementation.
- The page acknowledges the external repository's own disclosure while explaining why that disclosure does not repair the headline causal claim.
- The evidence boundary explicitly avoids alleging fraudulent intent, fabricated telemetry, or direct reproduction of the external browser rig.
- The thesis names the null result in the first viewport and limits it to the implemented pipelines and roles.
- The method flow separates metaphor, measured topology, and engineering choices.
- The adult atlas includes every one of the 79 region nodes and the strongest 110 non-self region-to-region edges from the checked-in projectome.
- The larval atlas keeps all 2,952 neurons in the counts, aggregates them into 14 named classes for this view, and surfaces the strongest 54 non-self class flows.
- The page identifies node/edge/weight fields as measured while explicitly identifying circular order, aggregation, filtering, scale, and color as engineering choices.
- The matched-control diagram keeps fixtures, seeds, budgets, compiler, and workers constant while changing the wiring.
- The page includes quantitative results, failure diagnostics, safeguards, limitations, and proposed next hypotheses.
- The supplied Mayor artwork is framed as identity and narrative, never as scientific proof.

## Severity disposition

- P0: none found.
- P1: the final reviewer flagged insufficient contrast on the new full-resolution atlas links. They now use oxblood on evidence paper with an ink hover state; the recaptured mobile atlas was scored resolved.
- P2: the reviewer requested direct access to the Python signer and zoomable circle diagrams. The fourth ledger row now links to the pinned signing/broadcast implementation, and both atlas plates link to their standalone SVGs.
- Earlier hierarchy fixes remain resolved: the narrow-screen scope qualifier is visible in the first viewport, and the verdict stamp belongs to the Mayor portrait rather than the heading flow.

Finish-review disposition: `ship`, with no remaining P0, P1, or P2 findings and no visible regressions in the recaptured packet.

The in-app browser's stitched full-page capture produced malformed repeated frames, so the checked review packet uses validated viewport captures for the hero and each major section instead. This is a capture-tool limitation, not a page defect.
