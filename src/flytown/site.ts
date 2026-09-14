import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(moduleDirectory, "..", "..");

export const researchSiteAssetsDir = join(packageRoot, "assets", "site");
export const researchSiteTokensPath = join(packageRoot, "tokens.css");

/**
 * Wallets behind the navigation's "Fund the Research" box. They must match
 * the Donate section at the end of README.md character for character.
 */
export const RESEARCH_WALLETS = [
  { chain: "SOL", name: "Solana", address: "79TNuyFNZWhDeFF1RUNA5Xk9Pccvb7xPYqLukBxCeWbb" },
  { chain: "EVM", name: "EVM", address: "0xa2c0abd1a1fcb5aee12f80651ae7f646371a66ed" },
] as const;

export interface ResearchSiteOptions {
  consoleHref?: string;
  consoleLabel?: string;
  consoleCtaLabel?: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function researchSiteHtml(options: ResearchSiteOptions = {}): string {
  const consoleHref = escapeHtml(options.consoleHref ?? "/fly");
  const consoleLabel = escapeHtml(options.consoleLabel ?? "Open console");
  const consoleCtaLabel = escapeHtml(options.consoleCtaLabel ?? "Use the local console");
  const walletRows = RESEARCH_WALLETS.map((wallet) => {
    const addressId = `fund-address-${wallet.chain.toLowerCase()}`;
    return `<li class="site-nav__fund-wallet">
              <span class="site-nav__fund-chain">${escapeHtml(wallet.chain)}</span>
              <code class="site-nav__fund-address" id="${addressId}">${escapeHtml(wallet.address)}</code>
              <button class="site-nav__fund-copy" type="button" data-copy-wallet="${addressId}" data-wallet-name="${escapeHtml(wallet.name)}" aria-label="Copy ${escapeHtml(wallet.name)} wallet address">Copy</button>
            </li>`;
  }).join("\n            ");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#f6b817" />
  <meta name="description" content="Why the claim that $FLYBRAIN launched itself is false, what its public code actually shows, and what FLYTOWN learned by testing real connectome wiring against null controls." />
  <title>FLYTOWN — The token is real. The agency story isn’t.</title>
  <link rel="preload" href="/site/flytown-mayor.webp" as="image" type="image/webp" />
  <link rel="stylesheet" href="/site/site.css?v=20260914a" />
  <script src="/site/site.js?v=20260914a" defer></script>
</head>
<body>
  <a class="skip-link" href="#main">Skip to the findings</a>

  <header class="site-nav" aria-label="Primary navigation">
    <a class="site-nav__brand" href="/" aria-label="FLYTOWN public findings home">
      <span>FLYTOWN</span>
      <small>Public findings</small>
    </a>
    <nav class="site-nav__links" aria-label="Research sections">
      <a href="#claim">The claim</a>
      <a href="#method">Method</a>
      <a href="#evidence">Evidence</a>
      <a href="#value">Why it matters</a>
      <a class="site-nav__github" href="https://github.com/water-bear86/flytown" target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
      <a class="site-nav__icon-link" href="https://x.com/i/communities/2017600885900062998" target="_blank" rel="noreferrer" aria-label="Join the FLYTOWN community on X" title="FLYTOWN community on X">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"/></svg>
      </a>
      <div class="site-nav__fund" data-fund>
        <button class="site-nav__fund-trigger" type="button" aria-expanded="false" aria-controls="fund-panel">
          <span class="site-nav__fund-label">Fund<span class="site-nav__fund-label-rest"> the Research</span></span>
          <svg class="site-nav__fund-caret" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" d="m2.5 4.25 3.5 3.5 3.5-3.5"/></svg>
        </button>
        <div class="site-nav__fund-panel" id="fund-panel" role="group" aria-label="Research funding wallets">
          <p class="site-nav__fund-note">Send magic internet monies to either wallet.</p>
          <ul class="site-nav__fund-wallets">
            ${walletRows}
          </ul>
        </div>
        <span class="site-nav__copy-status" id="fund-copy-status" role="status" aria-live="polite"></span>
      </div>
      <a class="site-nav__console" href="${consoleHref}">${consoleLabel}</a>
    </nav>
  </header>

  <main id="main">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero__copy">
        <h1 id="hero-title">$FLYBRAIN didn’t launch itself.</h1>
        <p class="hero__counterline">The lie is the verb.</p>
        <p class="hero__summary">Its own public code shows a human-authored rig supplied the token details, pair, tax, launch clicks, confirmation, and wallet signature. The connectome moved a cursor inside that ceremony. FLYTOWN tested the deeper computational claim—and the measured wiring did not beat its controls.</p>
        <div class="hero__actions">
          <a class="button button--ink" href="#claim">See what actually launched</a>
          <a class="text-link" href="https://github.com/water-bear86/flytown/blob/master/docs/flytown/experiments/README.md" target="_blank" rel="noreferrer">Read the experiment log <span aria-hidden="true">↗</span></a>
        </div>
        <p class="scope-note"><strong>Scope:</strong> the launch story overstates agency, and our tested computational advantage was null. Neither finding says the published connectome or the external project’s telemetry is fabricated.</p>
      </div>

      <figure class="hero__portrait">
        <img src="/site/flytown-mayor.webp" width="1254" height="1254" alt="The Mayor of FLYTOWN, a hand-drawn fly reclining behind a wooden desk with a cigar" fetchpriority="high" />
        <div class="finding-stamp" aria-label="Finding: null">
          <span>Finding</span>
          <strong>Null</strong>
        </div>
        <figcaption>The Mayor of FLYTOWN. Character witness, not scientific evidence.</figcaption>
      </figure>
    </section>

    <section class="verdict-band" aria-label="Central research verdict">
      <p>A real token exists. A real connectome ran. <strong>Neither fact makes the launch autonomous.</strong></p>
      <a href="#claim">Audit the causal chain</a>
    </section>

    <section class="section section--claim" id="claim" aria-labelledby="claim-title">
      <div class="section-heading">
        <h2 id="claim-title">The token is real. The agency story is not.</h2>
        <p>$FLYBRAIN is an on-chain token. Its official pitch says it was “launched by a fruit fly connectome.” But the project’s public source records a different division of labor: the connectome produced cursor signals while conventional automation supplied the goal, text, market settings, irreversible clicks, and signature.</p>
      </div>

      <div class="claim-target" aria-label="Audited Flybrain token">
        <div>
          <span>Claim audited</span>
          <strong>“Launched by a fruit fly connectome”</strong>
        </div>
        <code>0x4eb990547bce4a982432ca88cf5fae7eed1a2d35</code>
        <a href="https://flybrain.online/" target="_blank" rel="noreferrer">Official claim <span aria-hidden="true">↗</span></a>
      </div>

      <ol class="launch-ledger">
        <li>
          <span class="launch-ledger__index">01</span>
          <h3>A measured map became a human-authored model.</h3>
          <p>The connection graph comes from microscopy. The running “brain” does not. The code gives every neuron identical leaky-integrate-and-fire parameters, turns synapse counts into one fixed voltage multiplier, and leaves a trainable gain for each cell type. Those are consequential engineering choices—not measurements of the living fly.</p>
          <a href="https://github.com/fruitflydev/flycoinrh/blob/cec385e7bf9fb8eca9898f48be5a327bcf6d9408/flysim.py#L1-L20" target="_blank" rel="noreferrer">Read the model <span aria-hidden="true">↗</span></a>
        </li>
        <li>
          <span class="launch-ledger__index">02</span>
          <h3>The rig decided what the cursor was trying to do.</h3>
          <p>The connectome emitted motion and a stop signal from four selected descending-neuron readouts. A script inspected the page’s DOM, chose the nearest unfinished field, and typed a prewritten token value when the stop signal landed inside its box. The fly did not invent the name, ticker, description, target field, or objective.</p>
          <a href="https://github.com/fruitflydev/flycoinrh/blob/cec385e7bf9fb8eca9898f48be5a327bcf6d9408/rhlive.py#L781-L825" target="_blank" rel="noreferrer">Inspect the loop <span aria-hidden="true">↗</span></a>
        </li>
        <li>
          <span class="launch-ledger__index">03</span>
          <h3>The rig completed every decisive operation.</h3>
          <p>Automation accepted the terms, uploaded the image, filled anything the fly missed, selected GOOGL, set the creator tax, moved to the launch control, pressed Launch, and pressed Confirm. The project’s own README admits the fly did not complete the form or choose the pair, tax, X handle, or confirmation.</p>
          <a href="https://github.com/fruitflydev/flycoinrh/blob/cec385e7bf9fb8eca9898f48be5a327bcf6d9408/README.md#L372-L392" target="_blank" rel="noreferrer">Read its admission <span aria-hidden="true">↗</span></a>
        </li>
        <li>
          <span class="launch-ledger__index">04</span>
          <h3>The wallet—not the connectome—made the token exist.</h3>
          <p>A Python-injected wallet signed and broadcast the transaction after scripted confirmation. The receipt proves that a transaction succeeded. It does not prove that the simulated fly understood a token, selected an economic action, consented to terms, or controlled the irreversible step.</p>
          <div class="launch-ledger__sources">
            <a href="https://github.com/fruitflydev/flycoinrh/blob/cec385e7bf9fb8eca9898f48be5a327bcf6d9408/rhlive.py#L1016-L1063" target="_blank" rel="noreferrer">Trace the click <span aria-hidden="true">↗</span></a>
            <a href="https://github.com/fruitflydev/flycoinrh/blob/cec385e7bf9fb8eca9898f48be5a327bcf6d9408/rhprovider.py#L178-L247" target="_blank" rel="noreferrer">Inspect the signer <span aria-hidden="true">↗</span></a>
          </div>
        </li>
      </ol>

      <div class="claim-verdict">
        <p><strong>The lie is the word “launched.”</strong> A connectome-derived cursor participated in a launch orchestrated by human-written software. Every choice that gave the token meaning—and every irreversible action that made it real—came from outside the connectome.</p>
        <p>The public repository now discloses many of these limits. That candor is useful. It does not make the headline causal claim true.</p>
      </div>

      <div class="evidence-boundary">
        <span>Evidence boundary</span>
        <p>FLYTOWN did not reproduce their browser rig, so we do not claim their neuron telemetry is fake. We tested a separate, broader inference: whether measured fly wiring added useful task computation. It did not beat shuffled or rewired controls in our implemented planning and memory roles. That is a result about these roles, not a universal claim about biology. Real anatomy is not, by itself, evidence of agency or advantage.</p>
      </div>
    </section>

    <section class="section section--paper" id="method" aria-labelledby="method-title">
      <div class="section-heading">
        <h2 id="method-title">How did we test the deeper claim?</h2>
        <p>Use the wiring diagram of a real fruit-fly nervous system as the fixed middle of an engineered planner. A task goes in; activity moves through the graph; action scores become a plan for AI workers.</p>
      </div>

      <ol class="signal-path" aria-label="The tested FLYTOWN planning pipeline">
        <li>
          <span class="signal-path__index">A</span>
          <strong>Task</strong>
          <small>Natural-language job</small>
        </li>
        <li>
          <span class="signal-path__index">B</span>
          <strong>Encode</strong>
          <small>Task features become input</small>
          <span class="provenance provenance--metaphor">Metaphor</span>
        </li>
        <li class="signal-path__claim">
          <span class="signal-path__index">C</span>
          <strong>Connectome</strong>
          <small>Activity follows measured edges</small>
          <span class="provenance provenance--measured">Measured topology</span>
        </li>
        <li>
          <span class="signal-path__index">D</span>
          <strong>Dynamics</strong>
          <small>Rates settle or propagate</small>
          <span class="provenance provenance--choice">Engineering choice</span>
        </li>
        <li>
          <span class="signal-path__index">E</span>
          <strong>Read out</strong>
          <small>Populations score actions</small>
          <span class="provenance provenance--choice">Engineering choice</span>
        </li>
        <li>
          <span class="signal-path__index">F</span>
          <strong>Compile</strong>
          <small>Actions become a worker plan</small>
        </li>
      </ol>

      <div class="claim-location">
        <p><strong>The hypothesis lives here:</strong> if biological wiring contributes useful computation, the measured graph should beat an appropriately scrambled version when everything else stays fixed.</p>
      </div>
    </section>

    <section class="section section--atlas" aria-labelledby="atlas-title">
      <div class="section-heading section-heading--inverse">
        <h2 id="atlas-title">The wiring was real. The advantage wasn’t.</h2>
        <p>These diagrams come from the connectome artifacts used by FLYTOWN—not from stock network art. They establish that the test used measured biological wiring. They do not establish that the wiring helped the engineered task.</p>
      </div>

      <div class="connectome-atlas">
        <figure class="connectome-plate">
          <div class="connectome-plate__visual">
            <img src="/site/diagrams/adult-projectome-circle.svg?v=20260913a" width="720" height="720" loading="lazy" alt="Circular diagram of 79 adult fly neuropil regions and the strongest directed connections between them" />
          </div>
          <figcaption>
            <h3>FlyWire FAFB v783 projectome</h3>
            <p>Every region is present. The diagram surfaces the 110 strongest cross-region edges so the overall routing structure stays readable.</p>
            <dl class="atlas-facts">
              <div><dt>Regions</dt><dd>79</dd></div>
              <div><dt>Edges</dt><dd>3,509</dd></div>
              <div><dt>Synapses</dt><dd>54.5M</dd></div>
            </dl>
            <a class="atlas-full" href="/site/diagrams/adult-projectome-circle.svg" target="_blank" rel="noreferrer">Open full-resolution diagram <span aria-hidden="true">↗</span></a>
          </figcaption>
        </figure>

        <figure class="connectome-plate">
          <div class="connectome-plate__visual">
            <img src="/site/diagrams/larval-class-circle.svg?v=20260913a" width="720" height="720" loading="lazy" alt="Circular diagram of 14 annotated neuron classes aggregated from the full larval fly connectome" />
          </div>
          <figcaption>
            <h3>Winding 2023 whole-brain graph</h3>
            <p>All 2,952 neurons remain in the counts. For this view, they are aggregated into 14 annotated classes and the 54 strongest cross-class flows are shown.</p>
            <dl class="atlas-facts">
              <div><dt>Neurons</dt><dd>2,952</dd></div>
              <div><dt>Edges</dt><dd>110,677</dd></div>
              <div><dt>Synapses</dt><dd>352,611</dd></div>
            </dl>
            <a class="atlas-full" href="/site/diagrams/larval-class-circle.svg" target="_blank" rel="noreferrer">Open full-resolution diagram <span aria-hidden="true">↗</span></a>
          </figcaption>
        </figure>
      </div>

      <div class="atlas-key" aria-label="Diagram provenance key">
        <p><span class="provenance provenance--measured">Measured</span> Node identities, counts, edges, directions, and synapse weights come from the checked-in datasets.</p>
        <p><span class="provenance provenance--choice">Engineering choice</span> Circular order, aggregation, edge filtering, scale, and color are explanatory design choices.</p>
      </div>
      <p class="atlas-note">Self-connections are omitted from these two views. The full, unfiltered artifacts remain in the repository. <a href="https://github.com/water-bear86/flytown/blob/master/NOTICE.md" target="_blank" rel="noreferrer">Inspect sources and citations <span aria-hidden="true">↗</span></a></p>
    </section>

    <section class="section section--ink" aria-labelledby="control-title">
      <div class="section-heading section-heading--inverse">
        <h2 id="control-title">Change the wiring. Hold the world still.</h2>
        <p>A strange result is only persuasive if the comparison is ordinary. The strongest tests altered the graph while keeping the task, seed, budget, worker setup, and action-to-plan compiler matched.</p>
      </div>

      <div class="control-rig" role="group" aria-label="Matched real versus null-control experiment">
        <div class="control-rig__arm control-rig__arm--real">
          <span class="control-rig__label">Test</span>
          <h3>Measured wiring</h3>
          <p>Edges from the published connectome artifact.</p>
        </div>
        <div class="control-rig__constants">
          <span>Same fixtures</span>
          <span>Same seeds</span>
          <span>Same budgets</span>
          <span>Same compiler</span>
          <span>Same workers</span>
        </div>
        <div class="control-rig__arm control-rig__arm--null">
          <span class="control-rig__label">Null</span>
          <h3>Shuffled or rewired</h3>
          <p>Labels scrambled or edges degree-preserved.</p>
        </div>
      </div>

      <p class="control-verdict">If the real graph does not beat this null, the wiring has not shown that it is doing the claimed job.</p>
    </section>

    <section class="section section--yellow" id="evidence" aria-labelledby="evidence-title">
      <div class="section-heading">
        <h2 id="evidence-title">Four attempts. Three jobs. The same answer.</h2>
        <p>The implementation improved between attempts. The evidential standard did not: measured wiring still had to beat a relevant scrambled control.</p>
      </div>

      <div class="attempts">
        <div class="attempts__tabs" role="tablist" aria-label="Falsification attempts">
          <button type="button" role="tab" id="tab-region" aria-controls="attempt-region" aria-selected="true" data-attempt-target="attempt-region">
            <span>Region routing</span>
          </button>
          <button type="button" role="tab" id="tab-larva" aria-controls="attempt-larva" aria-selected="false" tabindex="-1" data-attempt-target="attempt-larva">
            <span>Larva prereg</span>
          </button>
          <button type="button" role="tab" id="tab-sparse" aria-controls="attempt-sparse" aria-selected="false" tabindex="-1" data-attempt-target="attempt-sparse">
            <span>Sparse repair</span>
          </button>
          <button type="button" role="tab" id="tab-memory" aria-controls="attempt-memory" aria-selected="false" tabindex="-1" data-attempt-target="attempt-memory">
            <span>Memory role</span>
          </button>
        </div>

        <div class="attempts__reports">
          <article class="attempt-report" id="attempt-region" role="tabpanel" aria-labelledby="tab-region">
            <div class="attempt-report__header">
              <div>
                <h3>The graph recognized anatomy, but not the task.</h3>
                <p class="report-status">Null result</p>
              </div>
              <dl class="artifact-facts">
                <div><dt>Nodes</dt><dd>79</dd></div>
                <div><dt>Edges</dt><dd>3,509</dd></div>
                <div><dt>Synapses</dt><dd>54.5M</dd></div>
              </dl>
            </div>
            <div class="score-pair" aria-label="Termination accuracy: real graph 52 percent, shuffled labels 38 percent, permutation p equals 0.060">
              <div><span>Measured</span><strong>52%</strong><i class="bar bar--52"></i></div>
              <div><span>Shuffled</span><strong>38%</strong><i class="bar bar--38"></i></div>
            </div>
            <p class="stat-line"><code>p = 0.060</code> — not distinguishable under the declared <code>p &lt; 0.05</code> threshold.</p>
            <p>The measured graph repeatedly fell into the same anatomical attractors. Those patterns were interpretable, but they were not task-dependent routing.</p>
          </article>

          <article class="attempt-report" id="attempt-larva" role="tabpanel" aria-labelledby="tab-larva" hidden>
            <div class="attempt-report__header">
              <div>
                <h3>Plasticity fired. It still could not associate tasks.</h3>
                <p class="report-status">Preregistered null</p>
              </div>
              <dl class="artifact-facts">
                <div><dt>Neurons</dt><dd>2,952</dd></div>
                <div><dt>Edges</dt><dd>110,677</dd></div>
                <div><dt>Plastic sites</dt><dd>2,746</dd></div>
              </dl>
            </div>
            <div class="score-pair" aria-label="Termination accuracy: real larval graph with plasticity 68 percent, shuffled graph with plasticity 68 percent">
              <div><span>Measured + plastic</span><strong>68%</strong><i class="bar bar--68"></i></div>
              <div><span>Shuffled + plastic</span><strong>68%</strong><i class="bar bar--68"></i></div>
            </div>
            <p class="stat-line"><code>p = 1.000</code> — the primary comparison was exactly null.</p>
            <p>Every Kenyon cell was active on every task. With a dense code, the same synapses were eligible for depression each time; association-specific learning was impossible in this configuration.</p>
          </article>

          <article class="attempt-report" id="attempt-sparse" role="tabpanel" aria-labelledby="tab-sparse" hidden>
            <div class="attempt-report__header">
              <div>
                <h3>The repaired pipeline transmitted biology—but not an advantage.</h3>
                <p class="report-status">Post-hoc null</p>
              </div>
              <dl class="artifact-facts">
                <div><dt>KC winners</dt><dd>10%</dd></div>
                <div><dt>Comparisons</dt><dd>9</dd></div>
                <div><dt>Seeds × tasks</dt><dd>60</dd></div>
              </dl>
            </div>
            <div class="score-pair" aria-label="Termination accuracy: real graph with plasticity 72 percent, shuffled graph with plasticity 72 percent">
              <div><span>Measured + plastic</span><strong>72%</strong><i class="bar bar--72"></i></div>
              <div><span>Shuffled + plastic</span><strong>72%</strong><i class="bar bar--72"></i></div>
            </div>
            <p class="stat-line"><code>p = 1.000</code> — the primary test was null again.</p>
            <p>Two ablations moved in a biology-consistent direction at uncorrected <code>p = 0.014</code> and <code>0.017</code>, but neither survived correction for nine tests and both involved a constant-policy comparator. Suggestive is not evidence.</p>
          </article>

          <article class="attempt-report" id="attempt-memory" role="tabpanel" aria-labelledby="tab-memory" hidden>
            <div class="attempt-report__header">
              <div>
                <h3>A generic random projection was the better similarity hash.</h3>
                <p class="report-status">Different role, same null</p>
              </div>
              <dl class="artifact-facts">
                <div><dt>Tasks</dt><dd>80</dd></div>
                <div><dt>Model calls</dt><dd>0</dd></div>
                <div><dt>Odor settings</dt><dd>6</dd></div>
              </dl>
            </div>
            <div class="range-table" aria-label="AUC range for same category versus cross category code similarity">
              <span>AUC range</span>
              <div><strong>Measured</strong><code>0.594–0.649</code></div>
              <div><strong>Shuffled</strong><code>0.680–0.740</code></div>
            </div>
            <p>The real circuit separated categories worse at every setting and held-out valence stayed near chance. It did achieve 100% collision-free codes, pointing toward a narrower novelty-detection hypothesis—not evidence for similarity retrieval.</p>
          </article>
        </div>
      </div>

      <p class="evidence-footnote">The early runs used fixture suite v1, including private repositories. The public, pinned v2 suite exists, but the log records no v2 result yet. This limits reproducibility of those numbers and is part of the finding, not a footnote to hide.</p>
    </section>

    <section class="section section--paper" aria-labelledby="washout-title">
      <div class="section-heading">
        <h2 id="washout-title">Where the task signal went</h2>
        <p>The adult projectome did not merely underperform. A diagnostic measurement showed the mechanism: tasks became less distinguishable as activity moved through the real graph.</p>
      </div>

      <figure class="divergence-chart">
        <figcaption>Mean pairwise Jensen–Shannon divergence across 20 fixtures. Lower means tasks look more alike.</figcaption>
        <div class="divergence-chart__legend" aria-hidden="true"><span class="legend-real">Measured graph</span><span class="legend-null">Shuffled labels</span></div>
        <div class="divergence-row">
          <strong>Raw features</strong>
          <div class="divergence-bars"><span class="data-bar data-bar--real data-bar--100">1.816</span><span class="data-bar data-bar--null data-bar--100">1.816</span></div>
        </div>
        <div class="divergence-row">
          <strong>Encoder input</strong>
          <div class="divergence-bars"><span class="data-bar data-bar--real data-bar--30">0.270</span><span class="data-bar data-bar--null data-bar--30">0.270</span></div>
        </div>
        <div class="divergence-row divergence-row--focus">
          <strong>Graph output</strong>
          <div class="divergence-bars"><span class="data-bar data-bar--real data-bar--8">0.032</span><span class="data-bar data-bar--null data-bar--20">0.119</span></div>
        </div>
        <div class="divergence-row">
          <strong>Action scores</strong>
          <div class="divergence-bars"><span class="data-bar data-bar--real data-bar--10">0.048</span><span class="data-bar data-bar--null data-bar--22">0.126</span></div>
        </div>
        <p class="chart-note">The real region-level graph reduced task information about eight times more than the shuffled copy at the graph-output stage.</p>
      </figure>

      <ol class="failure-chain" aria-label="Diagnostic chain from task encoding to constant policy">
        <li><strong>Input narrows</strong><span>Task features lose information in the hand-built encoder.</span></li>
        <li><strong>Attractors dominate</strong><span>Strong recurrent structures pull different inputs toward similar states.</span></li>
        <li><strong>Readout compresses</strong><span>Internal changes barely move normalized action scores.</span></li>
        <li><strong>Policies collapse</strong><span>Different tasks receive the same primary action.</span></li>
        <li><strong>Plans barely change</strong><span>Some selected actions are default or inert in the compiler.</span></li>
      </ol>
    </section>

    <section class="section section--blood" id="value" aria-labelledby="value-title">
      <div class="section-heading section-heading--inverse">
        <h2 id="value-title">A clean negative result buys something.</h2>
        <p>Failure becomes research when it reduces uncertainty, exposes mechanism, and changes what gets built next.</p>
      </div>

      <div class="value-ledger">
        <article>
          <h3>Adapter tuning without a better hypothesis</h3>
          <span>Stopped</span>
          <p>Repeated nulls make continued tuning against the same suite hard to justify.</p>
        </article>
        <article>
          <h3>Why the planner collapsed</h3>
          <span>Found</span>
          <p>Task washout, dense eligibility, compressed readouts, and compiler-inert actions are inspectable failure mechanisms.</p>
        </article>
        <article>
          <h3>The experimental machinery</h3>
          <span>Improved</span>
          <p>Constant-policy warnings, task-sensitivity measures, action-effect labels, public fixtures, and provider preflight came from failed runs.</p>
        </article>
        <article>
          <h3>The next biological questions</h3>
          <span>Narrowed</span>
          <p>Novelty detection and a larger adult mushroom body are specific, preregisterable ideas—not another vague promise to “use a connectome.”</p>
        </article>
      </div>
    </section>

    <section class="section section--paper surviving-result" aria-labelledby="survived-title">
      <div class="section-heading">
        <h2 id="survived-title">The best result wasn’t biological.</h2>
        <p>The full live comparison found that a hand-written rules planner matched the LLM planner’s quality on completable tasks while using much less computation—and knew when not to start work.</p>
      </div>

      <div class="result-ledger">
        <div class="result-ledger__primary">
          <strong>39%</strong>
          <span>fewer tokens per plan overall</span>
          <code>p &lt; 0.0001</code>
        </div>
        <div class="result-ledger__secondary">
          <div><strong>7 / 7</strong><span>correct stop decisions</span><code>p = 0.015</code></div>
          <div><strong>+0.010</strong><span>quality on completable tasks</span><code>p = 0.89 · dead even</code></div>
          <div><strong>37</strong><span>usable paired runs</span><code>20 fixtures × 2 seeds</code></div>
        </div>
      </div>
      <p class="result-reading">The LLM planner always tried to spawn work. Rules could express “blocked,” “needs approval,” and “already done.” FLYTOWN now uses rules as its default planner.</p>
    </section>

    <section class="section section--ink honesty" id="limits" aria-labelledby="limits-title">
      <div class="section-heading section-heading--inverse">
        <h2 id="limits-title">What makes the case credible—and what still weakens it</h2>
        <p>The strongest argument is not that the study was perfect. It is that the project records the places where it was not.</p>
      </div>

      <div class="honesty__columns">
        <div>
          <h3>Safeguards that carry weight</h3>
          <ul class="check-list">
            <li>Primary larval comparisons declared before the artifact existed</li>
            <li>Identical fixtures, seeds, budgets, workers, and plan compiler</li>
            <li>Label-shuffled, degree-preserving, lesion, and ablation controls</li>
            <li>Task-sensitivity checks that disqualify constant policies</li>
            <li>Paired permutation tests and multiple-comparison caution</li>
            <li>Invalid provider run voided; preflight added before the rerun</li>
          </ul>
        </div>
        <div>
          <h3>Limits that remain</h3>
          <ul class="limit-list">
            <li>The mock worker world tests consequence, not real-world quality</li>
            <li>Early v1 fixtures included private repositories</li>
            <li>No evaluation on the new public-v2 suite is recorded yet</li>
            <li>Post-hoc repairs are diagnostic, not confirmatory evidence</li>
            <li>Some live fly traces cannot replay because trained state was not persisted</li>
            <li>The adapters and action mappings remain human engineering choices</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="section section--yellow next-work" aria-labelledby="next-title">
      <div class="section-heading">
        <h2 id="next-title">The next claim should be smaller.</h2>
        <p>Two observations survive as hypotheses worth preregistering. Neither is presented as a result already won.</p>
      </div>
      <div class="next-work__proposals">
        <article>
          <h3>Novelty detection</h3>
          <span class="proposal-label">Proposed test</span>
          <p>The real larval code was collision-free at every tested setting while shuffled codes collided on 11–49% of tasks. Test “have I seen this exact thing?” instead of similarity retrieval.</p>
        </article>
        <article>
          <h3>Adult mushroom body</h3>
          <span class="proposal-label">Proposed substrate</span>
          <p>The adult has roughly 2,000 Kenyon cells versus 144 in the larval artifact. The artifact exists, but the runtime cannot yet load its binary graph.</p>
        </article>
      </div>
    </section>

    <section class="closing" aria-labelledby="closing-title">
      <div>
        <h2 id="closing-title">Inspect it. Reproduce it. Find the flaw.</h2>
        <p>FLYTOWN is MIT-licensed code with documented connectome provenance, experiment reports, null controls, and a local inspection console.</p>
      </div>
      <div class="closing__actions">
        <a class="button button--paper" href="https://github.com/water-bear86/flytown" target="_blank" rel="noreferrer">Open the repository <span aria-hidden="true">↗</span></a>
        <a class="button button--outline" href="https://github.com/water-bear86/flytown/blob/master/docs/flytown/experiments/README.md" target="_blank" rel="noreferrer">Read every run</a>
        <a class="text-link text-link--light" href="${consoleHref}">${consoleCtaLabel}</a>
      </div>
      <div class="install-line" aria-label="Install from source">
        <code>git clone https://github.com/water-bear86/flytown.git</code>
        <button type="button" data-copy-command="git clone https://github.com/water-bear86/flytown.git">Copy command</button>
        <span class="copy-status" role="status" aria-live="polite"></span>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <p><strong>FLYTOWN</strong> · Connectome-derived AI-orchestration research</p>
    <div>
      <a href="https://github.com/water-bear86/flytown/blob/master/PROPOSAL.md" target="_blank" rel="noreferrer">Proposal</a>
      <a href="https://github.com/water-bear86/flytown/blob/master/NOTICE.md" target="_blank" rel="noreferrer">Data provenance</a>
      <a href="https://github.com/water-bear86/flytown/blob/master/LICENSE" target="_blank" rel="noreferrer">MIT license</a>
    </div>
  </footer>
</body>
</html>`;
}
