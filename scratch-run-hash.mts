import { loadConnectome } from "./src/flytown/connectome/artifact.js";
import { hashExperiment, memoryTransferExperiment, renderHashReport } from "./src/flytown/eval/hash-experiment.js";

const id = process.argv[2] ?? "l1-larva-winding2023-1";
const pathway = (process.argv[3] as "feedforward" | "recurrent") ?? "feedforward";
const g = await loadConnectome(id);
const fractions = [0.024, 0.05, 0.10, 0.15];
const h = await hashExperiment(g, { odorFractions: fractions, pathway });
const t: Awaited<ReturnType<typeof memoryTransferExperiment>> = [];
for (const f of fractions) {
  const rows = await memoryTransferExperiment(g, { odorFraction: f, pathway });
  for (const r of rows) t.push({ ...r, variant: `${r.variant} @odour ${f}` });
}
console.log(renderHashReport(h, t, `${g.id} · pathway=${pathway}`));
