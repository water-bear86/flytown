import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repoRoot, "assets", "site", "diagrams");

const palette = {
  ink: "oklch(16.6% 0.012 48)",
  inkSoft: "oklch(25.5% 0.020 50)",
  yellow: "oklch(81.8% 0.164 83.4)",
  yellowSoft: "oklch(86.3% 0.159 86.9)",
  oxblood: "oklch(38.1% 0.135 21.5)",
  paper: "oklch(91.5% 0.051 88.6)",
  paperBright: "oklch(96.5% 0.044 89.9)",
  paperMuted: "oklch(80.8% 0.047 87.8)",
  measured: "oklch(41.5% 0.063 173.8)",
  choice: "oklch(48.7% 0.125 41.5)",
};

const larvalClasses = [
  "sens",
  "bLN",
  "mPN",
  "uPN",
  "KC",
  "MBIN",
  "MBON",
  "LHN",
  "CN",
  "CX",
  "FFN",
  "dVNC",
  "dSEZ",
  "RGN",
];

const classLabels = {
  sens: "SENSORY",
  bLN: "BROAD LN",
  mPN: "MULTI PN",
  uPN: "UNI PN",
  KC: "KENYON",
  MBIN: "MB INPUT",
  MBON: "MB OUTPUT",
  LHN: "LATERAL HORN",
  CN: "CONVERGENCE",
  CX: "CENTRAL COMPLEX",
  FFN: "FEEDBACK",
  dVNC: "DESC. VNC",
  dSEZ: "DESC. SEZ",
  RGN: "RING GLAND",
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function point(index, count, radius) {
  const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
  return {
    angle,
    x: 360 + Math.cos(angle) * radius,
    y: 360 + Math.sin(angle) * radius,
  };
}

function scaleLog(value, minimum, maximum, low, high) {
  if (maximum <= minimum) return (low + high) / 2;
  const ratio = (Math.log1p(value) - Math.log1p(minimum)) /
    (Math.log1p(maximum) - Math.log1p(minimum));
  return low + Math.max(0, Math.min(1, ratio)) * (high - low);
}

function connectionPath(source, target) {
  const bend = Math.min(76, Math.hypot(source.x - target.x, source.y - target.y) * 0.16);
  const middleX = 360 + Math.cos((source.angle + target.angle) / 2) * bend;
  const middleY = 360 + Math.sin((source.angle + target.angle) / 2) * bend;
  return `M ${source.x.toFixed(2)} ${source.y.toFixed(2)} Q ${middleX.toFixed(2)} ${middleY.toFixed(2)} ${target.x.toFixed(2)} ${target.y.toFixed(2)}`;
}

function svgShell({ title, description, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="720" viewBox="0 0 720 720" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(title)}</title>
  <desc id="description">${escapeXml(description)}</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
      <path d="M 0 0 L 8 4 L 0 8 z" fill="${palette.yellowSoft}" />
    </marker>
  </defs>
  <rect width="720" height="720" fill="${palette.ink}" />
  <circle cx="360" cy="360" r="286" fill="none" stroke="${palette.paper}" stroke-opacity="0.22" stroke-width="1" />
  <circle cx="360" cy="360" r="253" fill="none" stroke="${palette.paper}" stroke-opacity="0.1" stroke-width="1" />
${body}
</svg>
`;
}

async function readArtifact(id) {
  const directory = join(repoRoot, "connectome", id);
  const [manifest, nodes, graph] = await Promise.all([
    readFile(join(directory, "manifest.json"), "utf8").then(JSON.parse),
    readFile(join(directory, "nodes.json"), "utf8").then(JSON.parse),
    readFile(join(directory, "graph.json"), "utf8").then(JSON.parse),
  ]);
  return { manifest, nodes, graph };
}

function adultProjectomeSvg({ manifest, nodes, graph }) {
  const radius = 253;
  const positions = nodes.map((_, index) => point(index, nodes.length, radius));
  const nonSelfEdges = graph.src
    .map((source, index) => ({
      source,
      target: graph.dst[index],
      weight: graph.weight[index],
    }))
    .filter((edge) => edge.source !== edge.target)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 110);
  const weights = nonSelfEdges.map((edge) => edge.weight);
  const minimumWeight = Math.min(...weights);
  const maximumWeight = Math.max(...weights);
  const totals = nodes.map((node) => node.inSynapses + node.outSynapses);
  const minimumTotal = Math.min(...totals);
  const maximumTotal = Math.max(...totals);
  const labelIndexes = new Set();
  const trafficOrder = nodes
    .map((node, index) => ({ index, total: totals[index] }))
    .sort((a, b) => b.total - a.total);
  for (const { index } of trafficOrder) {
    const isTooClose = [...labelIndexes].some((selectedIndex) => {
      const distance = Math.abs(selectedIndex - index);
      return Math.min(distance, nodes.length - distance) < 3;
    });
    if (!isTooClose) labelIndexes.add(index);
    if (labelIndexes.size === 10) break;
  }

  const edges = nonSelfEdges.map((edge) => {
    const width = scaleLog(edge.weight, minimumWeight, maximumWeight, 0.45, 2.4);
    const opacity = scaleLog(edge.weight, minimumWeight, maximumWeight, 0.1, 0.62);
    const source = positions[edge.source];
    const target = positions[edge.target];
    return `  <path d="${connectionPath(source, target)}" fill="none" stroke="${palette.oxblood}" stroke-opacity="${opacity.toFixed(3)}" stroke-width="${width.toFixed(2)}" marker-end="url(#arrow)"><title>${escapeXml(nodes[edge.source].id)} → ${escapeXml(nodes[edge.target].id)}: ${formatInteger(edge.weight)} synapses</title></path>`;
  }).join("\n");

  const ticks = positions.map((position) => {
    const outer = point(positions.indexOf(position), nodes.length, 273);
    return `  <line x1="${position.x.toFixed(2)}" y1="${position.y.toFixed(2)}" x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}" stroke="${palette.paper}" stroke-opacity="0.22" stroke-width="1" />`;
  }).join("\n");

  const nodeMarks = nodes.map((node, index) => {
    const position = positions[index];
    const nodeRadius = scaleLog(totals[index], minimumTotal, maximumTotal, 2.8, 8.5);
    const fill = labelIndexes.has(index) ? palette.yellow : palette.paper;
    return `  <circle cx="${position.x.toFixed(2)}" cy="${position.y.toFixed(2)}" r="${nodeRadius.toFixed(2)}" fill="${fill}" stroke="${palette.ink}" stroke-width="1"><title>${escapeXml(node.id)}: ${formatInteger(node.neuronCount)} neurons, ${formatInteger(node.inSynapses)} incoming synapses</title></circle>`;
  }).join("\n");

  const labels = [...labelIndexes].map((index) => {
    const node = nodes[index];
    const labelPosition = point(index, nodes.length, 304);
    const anchor = labelPosition.x < 345 ? "end" : labelPosition.x > 375 ? "start" : "middle";
    return `  <text x="${labelPosition.x.toFixed(2)}" y="${labelPosition.y.toFixed(2)}" fill="${palette.paperBright}" font-family="Arial, sans-serif" font-size="11" font-weight="700" text-anchor="${anchor}" dominant-baseline="middle">${escapeXml(node.id)}</text>`;
  }).join("\n");

  const body = `${edges}
${ticks}
${nodeMarks}
${labels}
  <circle cx="360" cy="360" r="88" fill="${palette.paper}" stroke="${palette.yellow}" stroke-width="4" />
  <text x="360" y="326" fill="${palette.oxblood}" font-family="Georgia, serif" font-size="14" font-weight="700" text-anchor="middle" letter-spacing="1.6">ADULT PROJECTOME</text>
  <text x="360" y="357" fill="${palette.ink}" font-family="Arial, sans-serif" font-size="28" font-weight="700" text-anchor="middle">79 REGIONS</text>
  <text x="360" y="385" fill="${palette.inkSoft}" font-family="monospace" font-size="13" text-anchor="middle">3,509 DIRECTED EDGES</text>
  <text x="360" y="407" fill="${palette.inkSoft}" font-family="monospace" font-size="13" text-anchor="middle">54.5M SYNAPSES</text>
  <text x="360" y="690" fill="${palette.paperMuted}" font-family="monospace" font-size="10" text-anchor="middle">110 strongest cross-region edges shown · node size = total synapse traffic</text>`;

  return svgShell({
    title: "Adult FlyWire projectome circular wiring diagram",
    description: "All 79 measured neuropil regions arranged around a circle. Curved arrows show the 110 strongest directed connections between different regions. Larger circles represent more incoming and outgoing synapse traffic.",
    body,
  });
}

function larvalClassSvg({ manifest, nodes, graph }) {
  const classIndex = new Map(larvalClasses.map((name, index) => [name, index]));
  const nodeCounts = larvalClasses.map((name) => nodes.filter((node) => node.class1 === name).length);
  const positions = larvalClasses.map((_, index) => point(index, larvalClasses.length, 246));
  const aggregated = new Map();

  graph.src.forEach((sourceIndex, edgeIndex) => {
    const sourceClass = nodes[sourceIndex]?.class1;
    const targetClass = nodes[graph.dst[edgeIndex]]?.class1;
    if (!classIndex.has(sourceClass) || !classIndex.has(targetClass) || sourceClass === targetClass) return;
    const key = `${sourceClass}\u0000${targetClass}`;
    aggregated.set(key, (aggregated.get(key) ?? 0) + graph.weight[edgeIndex]);
  });

  const edges = [...aggregated.entries()]
    .map(([key, weight]) => {
      const [source, target] = key.split("\u0000");
      return { source, target, weight };
    })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 54);
  const weights = edges.map((edge) => edge.weight);
  const minimumWeight = Math.min(...weights);
  const maximumWeight = Math.max(...weights);
  const minimumCount = Math.min(...nodeCounts);
  const maximumCount = Math.max(...nodeCounts);

  const edgeMarks = edges.map((edge) => {
    const source = positions[classIndex.get(edge.source)];
    const target = positions[classIndex.get(edge.target)];
    const width = scaleLog(edge.weight, minimumWeight, maximumWeight, 0.6, 4.2);
    const opacity = scaleLog(edge.weight, minimumWeight, maximumWeight, 0.13, 0.74);
    return `  <path d="${connectionPath(source, target)}" fill="none" stroke="${palette.yellowSoft}" stroke-opacity="${opacity.toFixed(3)}" stroke-width="${width.toFixed(2)}" marker-end="url(#arrow)"><title>${escapeXml(classLabels[edge.source])} → ${escapeXml(classLabels[edge.target])}: ${formatInteger(edge.weight)} synapses</title></path>`;
  }).join("\n");

  const nodeMarks = larvalClasses.map((name, index) => {
    const position = positions[index];
    const count = nodeCounts[index];
    const radius = scaleLog(count, minimumCount, maximumCount, 8, 18);
    const fill = name === "KC" ? palette.measured : name === "MBIN" || name === "MBON" ? palette.oxblood : palette.yellow;
    const labelPosition = point(index, larvalClasses.length, 294);
    const anchor = labelPosition.x < 345 ? "end" : labelPosition.x > 375 ? "start" : "middle";
    return `  <circle cx="${position.x.toFixed(2)}" cy="${position.y.toFixed(2)}" r="${radius.toFixed(2)}" fill="${fill}" stroke="${palette.paperBright}" stroke-width="2"><title>${escapeXml(classLabels[name])}: ${formatInteger(count)} neurons</title></circle>
  <text x="${labelPosition.x.toFixed(2)}" y="${(labelPosition.y - 5).toFixed(2)}" fill="${palette.paperBright}" font-family="Arial, sans-serif" font-size="11" font-weight="700" text-anchor="${anchor}">${escapeXml(classLabels[name])}</text>
  <text x="${labelPosition.x.toFixed(2)}" y="${(labelPosition.y + 9).toFixed(2)}" fill="${palette.paperMuted}" font-family="monospace" font-size="10" text-anchor="${anchor}">${formatInteger(count)} N</text>`;
  }).join("\n");

  const body = `${edgeMarks}
${nodeMarks}
  <circle cx="360" cy="360" r="92" fill="${palette.paper}" stroke="${palette.measured}" stroke-width="4" />
  <text x="360" y="321" fill="${palette.oxblood}" font-family="Georgia, serif" font-size="14" font-weight="700" text-anchor="middle" letter-spacing="1.6">LARVAL BRAIN</text>
  <text x="360" y="354" fill="${palette.ink}" font-family="Arial, sans-serif" font-size="22" font-weight="700" text-anchor="middle">2,952 NEURONS</text>
  <text x="360" y="382" fill="${palette.inkSoft}" font-family="monospace" font-size="13" text-anchor="middle">110,677 EDGES</text>
  <text x="360" y="404" fill="${palette.inkSoft}" font-family="monospace" font-size="13" text-anchor="middle">352,611 SYNAPSES</text>
  <text x="360" y="690" fill="${palette.paperMuted}" font-family="monospace" font-size="10" text-anchor="middle">14 annotated classes · 54 strongest cross-class flows shown</text>`;

  return svgShell({
    title: "Larval connectome circular class wiring diagram",
    description: "Fourteen annotated neuron classes from the full 2,952-neuron larval connectome arranged around a circle. Curved arrows show the 54 strongest aggregated connections between different classes. Larger circles represent classes with more neurons.",
    body,
  });
}

const [adult, larva] = await Promise.all([
  readArtifact("fafb-v783-projectome-1"),
  readArtifact("l1-larva-winding2023-1"),
]);

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(join(outputDirectory, "adult-projectome-circle.svg"), adultProjectomeSvg(adult), "utf8"),
  writeFile(join(outputDirectory, "larval-class-circle.svg"), larvalClassSvg(larva), "utf8"),
]);

process.stdout.write("Wrote adult-projectome-circle.svg and larval-class-circle.svg\n");
