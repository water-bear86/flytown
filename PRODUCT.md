# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

FLYTOWN is TypeScript on Node.js 20+, served by Express with a dependency-light vanilla HTML/CSS/JavaScript surface and packaged for desktop with Electron. The public research site lives in this repository at `/`; the operational console remains at `/fly`.

## Users

Primary users are developers, AI-agent builders, research-minded technical readers, and curious non-specialists who want to understand what the connectome experiment actually found. The website must make the reasoning accessible without implying biological consciousness or requiring visitors to read the implementation first.

## Product Purpose

FLYTOWN audits the claim that the separate $FLYBRAIN token was “launched by a fruit fly connectome,” then tests a deeper computational premise: whether a real fruit-fly connectome can serve as the fixed topology of a small dynamical planner that routes a swarm of model-backed workers. The source audit shows that the external project’s human-authored rig supplied the goal, token values, market settings, irreversible clicks, confirmation, and wallet signature; the connectome supplied cursor signals inside that ceremony. FLYTOWN’s separate experiments have not shown that measured wiring performs its planning or memory roles better than shuffled or rewired controls. The website makes both findings—and why the research remains valuable—legible, compelling, and actionable while leading interested visitors into the source, methodology, control surface, and published evaluation record.

Success means a visitor can quickly understand why “the fly brain launched the token” is a false causal description, which parts of the external project were measured versus scripted, the independent FLYTOWN hypothesis, the controls and falsification tests, the null result, the useful engineering findings that survived, and where to inspect or reproduce the work.

## Positioning

FLYTOWN is unusually candid open research: it built a real, inspectable connectome-derived planner, tested it against rules, random, shuffled, rewired, ablated, learned, and conventional LLM baselines, and reports that the central biological-routing claim did not survive its controls. Its value is the falsifiable method, reproducible negative result, diagnosis of why the tested pipelines failed, and useful non-biological orchestration findings uncovered along the way.

## Operating Context

- The source product is both a CLI and a local web control surface served by `flytown serve`.
- Users can decide without executing workers, decide and execute, inspect traces, replay stored decisions, inspect connectome artifacts, and read evaluation reports.
- Work is organized through FLYTOWN's vocabulary: insects, castes, flights, forays, morsels, compost, terrariums, sugar, drift, artifacts, and plans.
- The repository, proposal, documentation, experiment logs, and connectome provenance are the factual source for website copy.

## Capabilities and Constraints

- Preserve the existing FLYTOWN name and current vocabulary.
- Identify the audited external token precisely as Robinhood Chain contract `0x4eb990547bce4a982432ca88cf5fae7eed1a2d35`; do not conflate it with FLYTOWN’s separate Solana contract.
- State the accountability conclusion plainly: the token and on-chain transaction are real, but “launched by a fruit fly connectome” falsely assigns agency to the connectome. The site may call that causal claim a lie; it must not escalate the evidence into an unsupported allegation about the creator’s intent, fraud, or fabricated telemetry.
- Ground the claim audit in the external project’s public source at a pinned commit: the connectome-to-cursor readout, DOM-aware target selection, prewritten text insertion, rig-completed fields, human-selected pair and tax, launch and confirmation clicks, and Python wallet signature.
- Keep the evidence boundary explicit: FLYTOWN did not reproduce the external browser rig and does not claim its neuron telemetry is fake. FLYTOWN’s matched tests evaluate a separate broader inference about useful task computation.
- Preserve the distinction between planning and execution: deciding can be free, while execution and live evaluation call the configured model provider.
- Describe the connectome as a fixed topology used by an engineered dynamical system, never as a living mind or biological simulation.
- Keep biological and engineering claims tagged or clearly separated as `MEASURED`, `INFERRED_FROM_LITERATURE`, `ENGINEERING_CHOICE`, or `METAPHOR` wherever the distinction matters.
- Publish honest null results and controls; do not fabricate performance claims, customers, adoption numbers, testimonials, or scientific conclusions.
- State the central result plainly: across region-level planning, neuron-level planning with plasticity, and associative-memory tests, the measured wiring has not yet beaten its relevant null model under the implemented harnesses.
- Distinguish a failed tested configuration from a universal claim about biology. The work falsifies the implemented pipelines and roles; it does not prove that connectomes can never be useful in computation.
- Explain the safeguards that made the conclusion credible: pre-registered comparisons, identical fixtures/seeds/budgets/compiler, shuffled and degree-preserving controls, lesions and ablations, task-sensitivity checks, mock-versus-live separation, paired permutation tests, correction of invalid or underpowered runs, and reproducible public fixtures.
- Present the surviving engineering findings accurately: the hand-written rules planner matched the LLM planner's quality on completable tasks while using 39% fewer tokens overall, and it correctly halted on all seven paired stop cases in the full live comparison.
- Preserve source and data licensing/provenance. The code is MIT; bundled connectome datasets retain their original licenses and citation requirements.
- Preserve the existing contract address exactly if it appears: `Gzj71jijFzPhsDB3N7gV4CKpx69jaPsHS5cV4aSypump`.
- The primary action is to inspect the evidence and methodology, followed by opening the repository or reproducing the evaluation. Installation, the console, and support are secondary.

## Brand Commitments

- Name: FLYTOWN.
- Core pitch: a real animal connectome routing a synthetic swarm.
- Voice: technically exact, candid about limits and null results, confident enough to be strange, and willing to use the insect-world vocabulary without letting the metaphor overtake the science.
- The supplied illustration is the Mayor of FLYTOWN: a cigar-smoking fly at a wooden desk against a saturated yellow ground. The Mayor is the website hero and a named character, not scientific evidence.

## Evidence on Hand

- GitHub repository: `https://github.com/water-bear86/flytown`.
- Audited external source: `https://github.com/fruitflydev/flycoinrh` at commit `cec385e7bf9fb8eca9898f48be5a327bcf6d9408`, plus the project’s own `flybrain.online` claims and disclosure language.
- `README.md`: mechanism, terminology, setup, CLI and web-console behavior, provider model, provenance, and positioning.
- `PROPOSAL.md`: architecture, research framing, milestones, and falsification plan.
- `docs/flytown/experiments/`: recorded evaluations, including null results and live comparisons.
- `docs/flytown/VOCABULARY.md`: authoritative product language.
- `src/flytown/web.ts`: existing vanilla web control surface and connectome API routes.
- `src/server.ts`: Express server and runtime APIs.
- Supplied Mayor artwork from the project owner.
- No customer logos, testimonials, adoption numbers, or externally validated commercial claims were supplied.

## Product Principles

1. Make the mechanism inspectable: show how task signals become activity, actions, and a plan.
2. Earn intrigue without overstating biology: the weirdness is real enough without calling it a mind.
3. Put evidence beside claims: controls, provenance tags, traces, and null results are part of the story.
4. Preserve the useful split between a memorable insect-world identity and rigorous engineering language.
5. Lead technical visitors toward something they can actually inspect, install, or run.

## Accessibility & Inclusion

The public website should meet WCAG 2.2 AA expectations, remain fully usable by keyboard, respect reduced-motion preferences, preserve readable text alternatives for scientific visualizations, and avoid relying on color alone for provenance or result categories.
