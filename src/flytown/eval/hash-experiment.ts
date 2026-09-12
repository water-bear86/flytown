/**
 * Two cheap, model-free experiments on the mushroom body as a memory.
 *
 * 1. `hashExperiment` — is the Kenyon-cell code a locality-sensitive hash of
 *    tasks, and is the REAL wiring better at it than a label-shuffled or
 *    degree-preserving-rewired copy of the same graph? Pre-registered
 *    prediction (from Dasgupta/Stevens/Navlakha 2017): the real PN→KC
 *    projection should preserve input similarity at least as well as the
 *    nulls. If it does not, the fly-hashing claim does not transfer to this
 *    encoding and the memory idea is dead at the root.
 *
 * 2. `memoryTransferExperiment` — train the memory on one half of each task
 *    category and test recall on the held-out half. Does the retrieved
 *    valence carry the right sign for tasks the memory has never seen? This
 *    is the generalisation claim that makes the memory useful at all, and it
 *    is again compared against the nulls.
 *
 * Both are deterministic and involve no model calls.
 */
import { randomDegreePreserving, shuffleLabels, type ConnectomeGraph } from "../connectome/artifact.js";
import { FlyMemory, codeSimilarity, hashQuality, type HashQuality } from "../memory.js";
import { deriveSignals, type RepoSignals, type TaskSignals } from "../signals.js";
import { pairedPermutation } from "./harness.js";
import { TASK_CORPUS, type CorpusTask } from "./corpus.js";

export type GraphVariantName = "real" | "shuffled" | "random_degree";

export function variantOf(graph: ConnectomeGraph, variant: GraphVariantName, seed: number): ConnectomeGraph {
  switch (variant) {
    case "shuffled": return shuffleLabels(graph, seed);
    case "random_degree": return randomDegreePreserving(graph, seed);
    default: return graph;
  }
}

const EMPTY_REPO: RepoSignals = { present: false, fileCount: 0, languages: {}, hasTests: false, hasPackageManifest: false, frameworks: [], truncated: false };

/** Signals for corpus tasks, computed once (no repository scan — the corpus is repo-free). */
export async function corpusSignals(tasks: CorpusTask[] = TASK_CORPUS): Promise<{ task: CorpusTask; signals: TaskSignals }[]> {
  const out: { task: CorpusTask; signals: TaskSignals }[] = [];
  for (const task of tasks) out.push({ task, signals: await deriveSignals({ task: task.task, cwd: "/nonexistent", repo: EMPTY_REPO }) });
  return out;
}

export interface HashExperimentRow extends HashQuality { variant: string; odorFraction?: number; activeReceptors?: number; receptorOverlap?: number }

export interface HashExperimentOptions {
  seeds?: number[];
  sparseness?: number;
  /** receptor fractions per keyword to sweep (default: one run at the adapter default) */
  odorFractions?: number[];
  pathway?: "feedforward" | "recurrent";
}

export async function hashExperiment(graph: ConnectomeGraph, opts: HashExperimentOptions = {}): Promise<{ rows: HashExperimentRow[]; realVsNull: { odorFraction?: number; null: string; aucDiff: number; spearmanDiff: number }[] }> {
  const seeds = opts.seeds ?? [1, 2, 3];
  const fractions = opts.odorFractions ?? [undefined as unknown as number];
  const items = await corpusSignals();
  const rows: HashExperimentRow[] = [];
  const realVsNull: { odorFraction?: number; null: string; aucDiff: number; spearmanDiff: number }[] = [];
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  for (const odorFraction of fractions) {
    const perVariant = new Map<string, HashQuality[]>();
    for (const variant of ["real", "shuffled", "random_degree"] as GraphVariantName[]) {
      // The real graph has no seed dependence; the nulls are averaged over seeds.
      const useSeeds = variant === "real" ? [0] : seeds;
      for (const seed of useSeeds) {
        const g = variantOf(graph, variant, seed);
        const mem = new FlyMemory({ graph: g, sparseness: opts.sparseness, odorFraction, pathway: opts.pathway });
        const coded = items.map(({ task, signals }) => ({ code: mem.fingerprint(signals), category: task.category, keywords: signals.keywords }));
        const q = hashQuality(coded);
        const od = variant === "real" ? mem.odorStats(items.map((it) => it.signals)) : undefined;
        rows.push({ variant: variant === "real" ? "real" : `${variant}(seed ${seed})`, odorFraction, ...q, activeReceptors: od?.meanActiveReceptors, receptorOverlap: od?.meanPairwiseOverlap });
        if (!perVariant.has(variant)) perVariant.set(variant, []);
        perVariant.get(variant)!.push(q);
      }
    }
    const real = perVariant.get("real")![0];
    for (const n of ["shuffled", "random_degree"] as const) {
      realVsNull.push({
        odorFraction, null: n,
        aucDiff: real.auc - mean(perVariant.get(n)!.map((q) => q.auc)),
        spearmanDiff: real.spearman - mean(perVariant.get(n)!.map((q) => q.spearman)),
      });
    }
  }
  return { rows, realVsNull };
}

export interface TransferRow {
  variant: string;
  /** mean |valenceShift| on held-out tasks — is anything retrieved at all? */
  meanAbsShift: number;
  /** fraction of held-out tasks whose retrieved valence has the correct sign */
  signAccuracy: number;
  /** same-category recall minus cross-category recall (the generalisation signal) */
  sameMinusCross: number;
  /** mean code overlap between a held-out task and its same-category training tasks */
  sameCodeOverlap: number;
  crossCodeOverlap: number;
  episodes: number;
  p?: number;
}

/**
 * Train: store one half of each category with a category-specific reward
 * (categories that need care get a punishment, categories that go fine get a
 * reward). Test: on the held-out half, does recall reproduce the sign?
 *
 * The reward assignment is an ENGINEERING_CHOICE standing in for real outcome
 * history: "investigation / blocked / security" categories are labelled bad
 * (0.1) because a direct attempt on them does go badly in both the mock world
 * and the live runs, and "answer / stop-early" categories good (0.9).
 */
const BAD_CATEGORIES = new Set(["ambiguous_failure", "misleading_hypothesis", "genuinely_blocked", "security_sensitive", "multi_file_impl"]);

export async function memoryTransferExperiment(graph: ConnectomeGraph, opts: { seeds?: number[]; sparseness?: number; odorFraction?: number; pathway?: "feedforward" | "recurrent" } = {}): Promise<TransferRow[]> {
  const seeds = opts.seeds ?? [1, 2, 3];
  const items = await corpusSignals();
  const train = items.filter((it) => it.task.variant === "a");
  const test = items.filter((it) => it.task.variant === "b");
  const rows: TransferRow[] = [];
  const shiftsByVariant = new Map<string, number[]>();

  for (const variant of ["real", "shuffled", "random_degree"] as GraphVariantName[]) {
    const useSeeds = variant === "real" ? [0] : seeds;
    const acc: TransferRow[] = [];
    for (const seed of useSeeds) {
      const g = variantOf(graph, variant, seed);
      const mem = new FlyMemory({ graph: g, sparseness: opts.sparseness, odorFraction: opts.odorFraction, pathway: opts.pathway });
      const trainCodes = train.map((it) => ({ category: it.task.category, code: mem.fingerprint(it.signals) }));
      for (const it of train) mem.store(it.signals, BAD_CATEGORIES.has(it.task.category) ? 0.1 : 0.9);
      const shifts: number[] = [];
      let correct = 0;
      let sameOverlap = 0, crossOverlap = 0, sameN = 0, crossN = 0;
      const sameRecall: number[] = [], crossRecall: number[] = [];
      for (const it of test) {
        const r = mem.recall(it.signals);
        const expectedNegative = BAD_CATEGORIES.has(it.task.category);
        shifts.push(r.valenceShift);
        if (r.valenceShift !== 0 && (r.valenceShift < 0) === expectedNegative) correct++;
        const code = mem.fingerprint(it.signals);
        for (const t of trainCodes) {
          const s = codeSimilarity(code, t.code);
          if (t.category === it.task.category) { sameOverlap += s; sameN++; sameRecall.push(s); }
          else { crossOverlap += s; crossN++; crossRecall.push(s); }
        }
      }
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
      acc.push({
        variant, meanAbsShift: mean(shifts.map(Math.abs)), signAccuracy: test.length ? correct / test.length : 0,
        sameMinusCross: (sameN ? sameOverlap / sameN : 0) - (crossN ? crossOverlap / crossN : 0),
        sameCodeOverlap: sameN ? sameOverlap / sameN : 0, crossCodeOverlap: crossN ? crossOverlap / crossN : 0,
        episodes: mem.episodes,
      });
      if (!shiftsByVariant.has(variant)) shiftsByVariant.set(variant, []);
      shiftsByVariant.get(variant)!.push(...shifts.map((s, i) => (BAD_CATEGORIES.has(test[i].task.category) ? -s : s)));
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    rows.push({
      variant, meanAbsShift: mean(acc.map((a) => a.meanAbsShift)), signAccuracy: mean(acc.map((a) => a.signAccuracy)),
      sameMinusCross: mean(acc.map((a) => a.sameMinusCross)), sameCodeOverlap: mean(acc.map((a) => a.sameCodeOverlap)),
      crossCodeOverlap: mean(acc.map((a) => a.crossCodeOverlap)), episodes: acc[0]?.episodes ?? 0,
    });
  }
  // Is the retrieved valence signed correctly more often than chance, per variant?
  for (const row of rows) {
    const signed = shiftsByVariant.get(row.variant as GraphVariantName) ?? [];
    // "correct sign" as a paired quantity: +|shift| when correct, −|shift| when wrong.
    row.p = signed.length ? pairedPermutation(signed.map((s) => (s > 0 ? 1 : s < 0 ? -1 : 0)), 5000, 11).p : undefined;
  }
  return rows;
}

export function renderHashReport(h: { rows: HashExperimentRow[]; realVsNull: { odorFraction?: number; null: string; aucDiff: number; spearmanDiff: number }[] }, transfer: TransferRow[], graphId: string): string {
  const L: string[] = [];
  L.push(`# Mushroom body as a task memory — model-free experiments`, ``, `connectome: ${graphId} · corpus: ${TASK_CORPUS.length} authored tasks over 10 categories · no model calls`, ``);
  L.push(`## 1. Is the Kenyon-cell code a locality-sensitive hash of tasks?`, ``);
  L.push(`| odour/keyword | graph | AUC (same vs cross category) | Spearman (code vs keyword similarity) | mean same-cat sim | mean cross-cat sim | distinct codes | active receptors | receptor overlap |`);
  L.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const r of h.rows) L.push(`| ${r.odorFraction !== undefined ? r.odorFraction : "default"} | ${r.variant} | ${r.auc.toFixed(3)} | ${r.spearman.toFixed(3)} | ${r.meanSameSimilarity.toFixed(3)} | ${r.meanCrossSimilarity.toFixed(3)} | ${(r.distinctCodes * 100).toFixed(0)}% | ${r.activeReceptors !== undefined ? r.activeReceptors.toFixed(1) : "–"} | ${r.receptorOverlap !== undefined ? r.receptorOverlap.toFixed(3) : "–"} |`);
  L.push(``, `Real minus null:`, ...h.realVsNull.map((d) => `- odour ${d.odorFraction !== undefined ? d.odorFraction : "default"} vs ${d.null}: AUC ${d.aucDiff >= 0 ? "+" : ""}${d.aucDiff.toFixed(3)}, Spearman ${d.spearmanDiff >= 0 ? "+" : ""}${d.spearmanDiff.toFixed(3)}`), ``);
  L.push(`AUC 0.5 = code similarity carries no category information. Spearman 0 = the code does not preserve input-space similarity at all.`, ``);
  L.push(`## 2. Does a stored association generalise to held-out tasks?`, ``);
  L.push(`| graph | sign accuracy on held-out | mean \\|valence shift\\| | same-cat code overlap | cross-cat | same − cross | p (sign) |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const r of transfer) L.push(`| ${r.variant} | ${(r.signAccuracy * 100).toFixed(0)}% | ${r.meanAbsShift.toFixed(4)} | ${r.sameCodeOverlap.toFixed(3)} | ${r.crossCodeOverlap.toFixed(3)} | ${r.sameMinusCross >= 0 ? "+" : ""}${r.sameMinusCross.toFixed(3)} | ${r.p !== undefined ? r.p.toFixed(3) : "–"} |`);
  L.push(``, `Sign accuracy 50% = retrieval is uninformative about whether a task of this kind went well or badly. "same − cross" > 0 is the generalisation mechanism: held-out tasks must share more code with their own category's training tasks than with others.`, ``);
  return L.join("\n");
}
