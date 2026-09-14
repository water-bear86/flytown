---
name: FLYTOWN
description: "A municipal evidence dossier for candid connectome-derived orchestration research."
colors:
  civic-yellow: "oklch(81.8% 0.164 83.4)"
  civic-yellow-soft: "oklch(86.3% 0.159 86.9)"
  oxblood: "oklch(38.1% 0.135 21.5)"
  oxblood-deep: "oklch(27.9% 0.094 20.2)"
  carbon-ink: "oklch(16.6% 0.012 48)"
  carbon-ink-soft: "oklch(25.5% 0.020 50)"
  evidence-paper: "oklch(91.5% 0.051 88.6)"
  evidence-paper-bright: "oklch(96.5% 0.044 89.9)"
  evidence-paper-muted: "oklch(80.8% 0.047 87.8)"
  desk-wood: "oklch(40% 0.097 43.6)"
  measured: "oklch(41.5% 0.063 173.8)"
  engineering-choice: "oklch(48.7% 0.125 41.5)"
  metaphor: "oklch(42.8% 0.097 307.9)"
typography:
  display:
    fontFamily: '"Alfa Slab One", Rockwell, serif'
    fontSize: "clamp(3rem, 5vw, 4.45rem)"
    fontWeight: 400
    lineHeight: 0.94
    letterSpacing: "-0.03em"
  headline:
    fontFamily: '"Alfa Slab One", Rockwell, serif'
    fontSize: "clamp(2.25rem, 4.6vw, 4.75rem)"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  title:
    fontFamily: '"Alfa Slab One", Rockwell, serif'
    fontSize: "clamp(1.5rem, 2.5vw, 2.2rem)"
    fontWeight: 400
    lineHeight: 1.08
  body:
    fontFamily: '"Atkinson Hyperlegible", "Helvetica Neue", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.58
  body-large:
    fontFamily: '"Atkinson Hyperlegible", "Helvetica Neue", sans-serif'
    fontSize: "clamp(1.1rem, 1.6vw, 1.32rem)"
    fontWeight: 400
    lineHeight: 1.42
  label:
    fontFamily: '"Atkinson Hyperlegible", "Helvetica Neue", sans-serif'
    fontSize: "0.72rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
  data:
    fontFamily: '"Fragment Mono", ui-monospace, monospace'
    fontSize: "0.72rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  small: "0.35rem"
  medium: "0.8rem"
spacing:
  space-1: "0.25rem"
  space-2: "0.5rem"
  space-3: "0.75rem"
  space-4: "1rem"
  space-5: "1.5rem"
  space-6: "2rem"
  space-7: "3rem"
  space-8: "4.5rem"
  space-9: "7rem"
  space-10: "8rem"
  gutter: "1.25rem"
components:
  button-ink:
    backgroundColor: "{colors.carbon-ink}"
    textColor: "{colors.evidence-paper-bright}"
    rounded: "0"
    padding: "0.75rem 1rem"
    height: "3.1rem"
  button-ink-hover:
    backgroundColor: "{colors.oxblood}"
    textColor: "{colors.evidence-paper-bright}"
    rounded: "0"
    padding: "0.75rem 1rem"
    height: "3.1rem"
  button-paper:
    backgroundColor: "{colors.evidence-paper-bright}"
    textColor: "{colors.carbon-ink}"
    rounded: "0"
    padding: "0.75rem 1rem"
    height: "3.1rem"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.evidence-paper-bright}"
    rounded: "0"
    padding: "0.75rem 1rem"
    height: "3.1rem"
  finding-stamp:
    backgroundColor: "{colors.oxblood}"
    textColor: "{colors.evidence-paper-bright}"
    typography: "{typography.label}"
    rounded: "0"
    padding: "0.5rem"
  navigation:
    backgroundColor: "{colors.carbon-ink}"
    textColor: "{colors.evidence-paper}"
    rounded: "0"
    height: "4.5rem"
  navigation-action:
    backgroundColor: "{colors.civic-yellow}"
    textColor: "{colors.carbon-ink}"
    rounded: "0"
    padding: "0.75rem 1.5rem"
    height: "4.5rem"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.carbon-ink}"
    rounded: "0"
    padding: "1rem 0.75rem"
  tab-selected:
    backgroundColor: "{colors.oxblood}"
    textColor: "{colors.evidence-paper-bright}"
    rounded: "0"
    padding: "1rem 0.75rem"
  provenance-measured:
    backgroundColor: "{colors.measured}"
    textColor: "{colors.evidence-paper-bright}"
    typography: "{typography.label}"
    rounded: "0"
    padding: "0.25rem 0.5rem"
  evidence-report:
    backgroundColor: "{colors.evidence-paper-bright}"
    textColor: "{colors.carbon-ink}"
    rounded: "0"
    padding: "clamp(1.5rem, 4vw, 4.5rem)"
---

# Design System: FLYTOWN

## Overview

**Creative North Star: "The Municipal Evidence Dossier"**

FLYTOWN presents public research as a town record made consequential: civic-yellow proclamations, oxblood findings, carbon ink, warm evidence paper, desk wood, stamps, pins, and ruled comparisons. The world is strange enough to hold a cigar-smoking Mayor, but exact enough that the character never masquerades as scientific proof.

The page is editorial and full-bleed, not a grid of generic product cards. Large slab-serif conclusions make the research verdict unavoidable; highly legible body copy explains its scope; monospaced measurements and provenance labels keep evidence inspectable. Material gestures are sparing and functional: paper strips lift, stamps rotate slightly, and rules connect experimental steps.

The system treats candor as the visual authority. Null findings, limits, controls, and the surviving engineering result receive the same compositional weight, so intrigue never depends on an inflated biological claim.

**Key Characteristics:**

- Saturated civic color anchored by carbon ink and warm evidence paper.
- Slab-serif proclamations, hyperlegible explanation, and mono evidence labels.
- Full-width civic bands, ruled experimental flows, stamps, and ledger-like records.
- Physical depth reserved for lifted paper, pinned findings, and actionable evidence.
- A named illustrated Mayor who guides the story without becoming evidence.

## Colors

The palette feels like a town hall, an archive desk, and an oxblood chair under hard civic light; every semantic state also carries a text label or structural cue.

### Primary

- **Civic Yellow** (`civic-yellow`): the dominant public-facing field, selected data bars, primary navigation action, and high-visibility result surface.
- **Soft Civic Yellow** (`civic-yellow-soft`): inverse emphasis for headings, annotations, and hover states on dark or oxblood grounds.

### Secondary

- **Oxblood** (`oxblood`): findings, selected states, null-control bars, counterlines, and the principal focus color.
- **Deep Oxblood** (`oxblood-deep`): the closing civic field, used when the page needs a final, weightier register.
- **Desk Wood** (`desk-wood`): the material bridge between the Mayor artwork and the dossier palette; use as an occasional grounded brown, not a competing accent.

### Tertiary

- **Measured Green** (`measured`): measured-topology provenance only.
- **Engineering Choice Orange** (`engineering-choice`): human-authored dynamics, mappings, and other engineering-choice provenance.
- **Metaphor Violet** (`metaphor`): metaphor provenance only.

### Neutral

- **Carbon Ink** (`carbon-ink`): primary text, navigation, dark research bands, charts, and high-contrast actions.
- **Soft Carbon Ink** (`carbon-ink-soft`): secondary copy on paper where full ink would overstate hierarchy.
- **Evidence Paper** (`evidence-paper`): the default reading ground and interior dossier surface.
- **Bright Evidence Paper** (`evidence-paper-bright`): lifted reports, inverse text, and the clearest paper contrast.
- **Muted Evidence Paper** (`evidence-paper-muted`): supporting text and low-emphasis rules on dark fields.

### Named Rules

**The Verdict Color Rule.** Civic yellow announces the public question; oxblood records the finding; carbon and paper carry the argument.

**The Provenance Is Redundant Rule.** Measured, engineering-choice, and metaphor colors must always appear with their written label; color never carries scientific meaning alone.

**The No Generic Blue Rule.** New actions and charts extend the civic, oxblood, carbon, paper, and provenance palette instead of introducing conventional product-blue accents.

## Typography

**Display Font:** Alfa Slab One (with Rockwell and serif fallbacks)

**Body Font:** Atkinson Hyperlegible (with Helvetica Neue and sans-serif fallbacks)

**Label/Mono Font:** Fragment Mono (with `ui-monospace` and monospace fallbacks)

**Character:** Alfa Slab One makes conclusions feel posted, stamped, and publicly accountable. Atkinson Hyperlegible keeps long-form research accessible, while Fragment Mono is a deliberately scarce signal that a value, threshold, provenance fact, or command should be inspected literally.

### Hierarchy

- **Display** (regular, tightly set): hero proclamations only; keep the measure near 11 characters and allow balanced wrapping.
- **Headline** (regular, tightly set): section verdicts and the closing call, usually constrained to 11–15 characters per line.
- **Title** (regular): report findings, ledger headings, and proposal names.
- **Body** (regular): default explanation on a warm reading ground; long passages stay near the 72-character reading measure.
- **Body Large** (regular): section decks, chart captions, and high-value explanatory conclusions.
- **Label** (bold, uppercase, tracked): status, provenance, navigation microcopy, and short civic annotations.
- **Data** (regular, tabular numerals): measurements, p-values, counts, ranges, commands, and experimental constants.

### Named Rules

**The Proclamation and Proof Rule.** Alfa Slab One states the claim, Atkinson Hyperlegible explains it, and Fragment Mono shows what can be checked.

**The Mono Means Inspectable Rule.** Do not use Fragment Mono as technological decoration; reserve it for literal data, code, identifiers, and provenance.

## Layout

The system alternates full-width paper, yellow, carbon, and oxblood civic bands. Content inside those bands is centered within an 86rem maximum width with a 1.25rem minimum gutter. Reading copy is normally capped at 72 characters, while section headings use an asymmetric two-column grid that places the proclamation beside its explanatory deck.

On wide screens, the first viewport is a near-full-height split field: copy occupies a slightly narrower left column and the Mayor fills the right column as a true image crop. The heading, oxblood counterline, primary action, and scope note remain visible before scroll. The accountability case below it is a four-step ruled ledger: index, finding, explanation, and pinned-source action form one row, with the two wallet sources kept together as a single source group. The circular connectome atlas begins as two equal plates. At 68rem, the ledger drops its source actions beneath the explanation, dense six- and five-step flows recompose, and each atlas plate becomes an image-and-caption row before the overall story stacks.

At 52rem and below, the hero becomes an image-backed composition rather than a reduced split. The Mayor fills the viewport, the crop shifts to 58% horizontally, and the copy sits at the bottom on a 96%-opaque evidence-paper sheet occupying roughly 62% of the field. Navigation collapses to the FLYTOWN mark and the yellow console action; the launch ledger becomes a two-column index-and-content sequence with each explanation and its source links grouped under the same finding; the evidence boundary stacks label above scope; each circular atlas plate stacks diagram above caption; tab controls become a horizontally scrollable four-column strip; and experimental flows become vertical ruled sequences. Below 28rem, the navigation and hero shorten, the paper sheet grows to roughly 66%, and hero actions stack. Short wide viewports reduce vertical hero padding without changing the two-column composition.

Spacing follows the quarter-rem through eight-rem scale in the frontmatter. Use the smaller steps for rule-separated data and labels, the middle steps for component padding and gaps, and the largest steps for section rhythm. Dense evidence may compress internally, but full-width sections retain generous vertical separation.

**The Recompose, Do Not Shrink Rule.** Responsive behavior changes the hero's layering, flow direction, tab access, and evidence grouping; it does not merely scale down desktop geometry.

## Elevation & Depth

FLYTOWN is flat by default. Full-width fields, one- and two-pixel rules, color inversion, and overlapping paper establish hierarchy before shadows do. Two warm, directional shadows are the complete elevation vocabulary; both simulate physical dossier material rather than generic interface lift.

### Shadow Vocabulary

- **Paper Lift** (`shadow-paper`): a soft, close shadow for the hero counterline and bright evidence report.
- **Raised Evidence** (`shadow-raised`): a deeper shadow for primary actions, pinned claim notes, charts, result ledgers, and the mobile hero's paper sheet.

Small rotations reinforce the physical grammar: the finding stamp rests at approximately -1.5 degrees, the counterline at -1 degree, and a pinned claim at -0.35 degrees. These are purposeful imperfections, not a general license to tilt content.

### Named Rules

**The Flat Record Rule.** Surfaces remain flat unless they behave like a lifted sheet, pinned finding, or evidence-bearing action.

**The One Desk-Lamp Rule.** Every shadow shares the same warm downward light; do not add glows, glass blur, or unrelated elevation styles.

## Shapes

The shipped public site uses hard rectangular corners for navigation, buttons, reports, stamps, tabs, ledgers, and charts. Shape comes from bands, paper strips, clipped image fields, one- and two-pixel rules, diamond flow markers, and slight physical rotations—not from a family of rounded cards. Small and medium radius primitives exist for adjacent product surfaces, but they are not applied to the dossier components documented here.

Rules are structural: borders divide experimental constants, connect signal stages, and turn findings into records. A diamond marker may indicate direction or a step transition; it should not become an ornamental pattern.

**The Filed Edge Rule.** Public-findings components are square and ruled. Use a radius only when extending an already rounded adjacent surface, not as a default modernization pass.

## Components

### Buttons

Buttons feel like solid civic controls: compact, square, high-contrast, and plainly worded.

- **Shape:** hard rectangular corners, a 3.1rem minimum height, bold body text, and compact 0.75rem by 1rem padding.
- **Primary:** carbon ink on bright evidence paper text with the raised-evidence shadow; hover changes the field to oxblood.
- **Paper:** bright evidence paper on carbon text with the same raised-evidence shadow; used on the deep-oxblood closing field.
- **Outline:** transparent on dark fields with a translucent paper rule; hover turns the rule civic yellow.
- **Active / Focus:** active controls move down by 0.0625rem. Keyboard focus uses a 0.125rem oxblood outline, a 0.0625rem offset, and a 0.375rem bright-paper outer ring.
- **Disabled:** preserve the label, reduce opacity to 55%, and use a not-allowed cursor.

### Chips

Provenance labels and the Finding / Null stamp behave like filed annotations, not filter pills.

- **Style:** square, compact, uppercase, and tracked; the stamp uses oxblood with a carbon border and a paper divider.
- **Semantic variants:** measured green, engineering-choice orange, and metaphor violet always retain visible text labels.
- **Motion:** the finding stamp enters once with a 700ms decelerating drop-and-settle motion when JavaScript is ready.

### Cards / Containers

Containers feel like reports, ledgers, control rigs, or pinned evidence rather than interchangeable cards.

- **Corner Style:** square throughout the public findings surface.
- **Background:** bright paper for a lifted report; carbon, oxblood, or civic yellow for ledger-like structural blocks.
- **Shadow Strategy:** use paper lift on reports and raised evidence only when the container is intentionally lifted from its band.
- **Border:** one-pixel dividers for ordinary records and two-pixel rules where a process begins or ends.
- **Internal Padding:** normally 1.5rem through 4.5rem, responsive to viewport width and evidence density.

### Accountability Launch Ledger

The claim audit is a four-step causal record, not a general feature list. Each ruled row pairs a monospaced oxblood index with a slab-serif finding, a bounded explanation, and a direct link to the pinned external source. The wallet step keeps “Trace the click” and “Inspect the signer” in one source-link group so the irreversible UI action and conventional transaction signer remain visibly connected.

The ledger follows a dark claim-target strip containing the exact audited statement, contract address, and official-claim link. It resolves into an oxblood two-part verdict, then a separate ruled evidence boundary that states what FLYTOWN did not reproduce, what its own controls tested, and how narrowly the result may be generalized. At narrow widths, source links move below their explanation without leaving the corresponding ledger row; the two wallet links stay grouped and left-aligned.

### Circular Connectome Atlas

The atlas presents the adult projectome and larval whole-brain graph as square circular diagrams on carbon fields, paired with evidence-paper captions, literal counts, and a civic-yellow top rule. The diagram imagery establishes authentic checked-in topology while the adjacent provenance key explicitly labels circular order, aggregation, filtering, scale, and color as engineering choices.

Every plate includes an underlined “Open full-resolution diagram” action in oxblood on evidence paper, changing to carbon ink on hover. Keep that action with the plate’s caption and counts so the reduced in-page view never becomes a dead-end illustration. The desktop atlas is a two-plate spread; compact desktop uses stacked plates with side-by-side diagram and caption; narrow screens stack each diagram above its caption while preserving the full-resolution links.

### Inputs / Fields

The public findings page has no data-entry field. The install control is the only field-like pattern: a bright-paper command line with a carbon copy button, horizontal command scrolling, and a polite live status message. Preserve this explicit command/action split rather than styling it as an editable text input.

### Navigation

The navigation is a sticky 4.5rem carbon masthead with a slab-serif civic-yellow wordmark, uppercase supporting label, ruled section links, and a civic-yellow console action. Hover changes ordinary links to soft civic yellow and lightens the console action. At 52rem and below, hide the supporting label and research-section links while keeping the brand and console action; below 28rem the masthead reduces to 4rem.

### Evidence Tabs

The attempt selector is a vertical, square-edged ruled list beside its report on wide screens. The selected tab inverts to oxblood and bright paper; hover adds a translucent paper wash. On narrow screens it becomes a horizontally scrollable, snap-aligned tab strip. Arrow keys move between tabs, Home and End jump to the first and last, selection uses roving `tabindex`, and every tab names its panel through ARIA.

### Mayor Hero Portrait

The Mayor is a named character witness and the page's hero, never scientific evidence. The shipping raster is the full 1254 × 1254 WebP derivative of the project-owner-supplied `flytyownmayor.png`; it preserves the complete composition and removes metadata. Keep a visible caption that says the character is not evidence, an equivalent descriptive alt text, explicit intrinsic dimensions, and the local provenance record. Authorization for this build does not create an additional ownership claim, so any replacement or redistribution must preserve source and permission documentation.

### Motion and Reduced Motion

Entrance motion is limited to the finding stamp, hero proclamation, and oxblood paper counterline. Durations range from 700ms to 900ms with the project's decelerating ease; ordinary hover states use 160–180ms transitions. When `prefers-reduced-motion: reduce` is active, disable smooth scrolling and collapse all animation and transition durations to 0.01ms for a single iteration. Meaning and final state must never depend on animation.

### Interaction and Accessibility

A skip link moves directly to the findings and becomes visible on focus. Links stay underlined unless their component role is already visually explicit. On evidence paper, full-resolution atlas actions use oxblood with the shared 0.1em underline and 0.2em offset; inverse evidence links use soft civic yellow. Charts and score pairs carry text alternatives with literal values; status and provenance never rely on color alone. Copy feedback uses a polite live region. All controls preserve a strong two-layer keyboard focus treatment, and the reading surface maintains high contrast across paper and inverse bands.

## Do's and Don'ts

### Do:

- **Do** make the verdict legible in the first viewport and place scope language beside the claim.
- **Do** use ruled flows, ledgers, stamps, and paper sheets when they clarify experimental structure.
- **Do** keep Alfa Slab One for proclamations, Atkinson Hyperlegible for explanation, and Fragment Mono for inspectable facts.
- **Do** recompose the hero, tabs, grids, and process flows at the documented breakpoints.
- **Do** label measured biology, engineering choices, and metaphor in words as well as color.
- **Do** preserve the Mayor raster's local provenance, caption, intrinsic size, and non-evidence framing.
- **Do** preserve keyboard focus, tab semantics, reduced motion, and textual chart equivalents.

### Don't:

- **Don't** turn the public findings surface into pale rounded cards, glass panels, or a generic research dashboard.
- **Don't** use the Mayor, insect vocabulary, or network imagery as evidence for a biological claim.
- **Don't** introduce decorative monospace, unlabelled semantic color, or product-blue accents.
- **Don't** add shadows to ordinary sections or containers that are not physically lifted evidence.
- **Don't** shrink the desktop hero mechanically; preserve the image-backed paper-sheet composition on narrow screens.
- **Don't** round dossier components merely because small and medium radius primitives exist elsewhere.
- **Don't** replace or redistribute the Mayor artwork without carrying forward its authorization and provenance record.
