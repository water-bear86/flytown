// Writes connectome/malecns-v1.0-projectome-1/adapters-rerouted.json: the default
// region adapters with only the AMMC and GA entries re-pointed to the male regions
// named by the build's territory checks (pre-registered robustness variant M1b).
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { defaultProjectomeAdapters } = await import(join(root, "dist/flytown/connectome/adapters.js"));
const dir = join(root, "connectome/malecns-v1.0-projectome-1");
const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
const territories = manifest.preprocessing.territories;
const reroute = { AMMC: territories.AMMC.reroutedTo, GA: territories.GA.reroutedTo };
if (!reroute.AMMC || !reroute.GA) throw new Error(`territory checks missing a target: ${JSON.stringify(reroute)}`);

const table = defaultProjectomeAdapters();
const changed = [];
const repoint = (where, key, entries) => (entries ?? []).map((e) => {
  if (!(e.group in reroute)) return e;
  changed.push(`${where}.${key}: ${e.group} -> ${reroute[e.group]} (weight ${e.weight})`);
  return { ...e, group: reroute[e.group], note: `${e.note ? e.note + "; " : ""}rerouted from ${e.group} (M1b)` };
});
for (const k of Object.keys(table.encoder)) table.encoder[k] = repoint("encoder", k, table.encoder[k]);
for (const k of Object.keys(table.readout)) table.readout[k] = repoint("readout", k, table.readout[k]);
table.rerouting = {
  variant: "M1b",
  rule: "AMMC -> ROI holding most presynaptic sites of JO-* neurons; GA -> ROI holding most presynaptic sites of GLNO, LNO*, LCNO* neurons (pre-registered addendum, 2026-09-14)",
  reroute, changed,
};
await writeFile(join(dir, "adapters-rerouted.json"), JSON.stringify(table, null, 2) + "\n", "utf8");
process.stdout.write(`wrote adapters-rerouted.json\n${changed.join("\n")}\n`);
