import type { Compost } from "./compost.js";
import type { Morsel, Flight, GuardVerdict } from "./types.js";

export async function renderFlightGraph(
  compost: Compost,
  flightId: string,
): Promise<string | null> {
  const flight = await compost.getFlight(flightId);
  if (!flight) return null;

  const ids = new Set<string>();
  if (flight.contextMorselId) ids.add(flight.contextMorselId);
  for (const id of flight.foragerMorselIds) ids.add(id);
  for (const id of Object.values(flight.stingMorselIds)) ids.add(id);
  if (flight.soldierMorselId) ids.add(flight.soldierMorselId);
  // guards aren't in the flight manifest by id — find them via parent links
  const allMorsels = await compost.allMorsels();
  const guardByForager = new Map<string, Morsel>();
  for (const l of allMorsels) {
    if (l.caste !== "guard" || l.flightId !== flightId) continue;
    const foragerId = l.parentMorselIds?.[0];
    if (foragerId) guardByForager.set(foragerId, l);
  }

  const morselById = new Map<string, Morsel>();
  for (const id of ids) {
    const l = await compost.getMorsel(id);
    if (l) morselById.set(id, l);
  }
  for (const t of guardByForager.values()) morselById.set(t.id, t);

  const lines: string[] = [];
  lines.push(`flight ${flight.id}  outcome=${flight.outcome}  swarm=${flight.swarmSize}  personality=${flight.personality}`);
  lines.push(`task: ${truncate(flight.task, 100)}`);
  lines.push("");

  if (flight.contextMorselId) {
    const r = morselById.get(flight.contextMorselId);
    lines.push(`├─ scout    ${flight.contextMorselId}${formatTokens(r)}`);
  }

  for (let i = 0; i < flight.foragerMorselIds.length; i++) {
    const gid = flight.foragerMorselIds[i];
    const forager = morselById.get(gid);
    const stingId = flight.stingMorselIds[gid];
    const guard = guardByForager.get(gid);
    const verdict = flight.guardVerdicts[gid];
    const isWinner = gid === flight.winnerMorselId;

    const head = `${i === flight.foragerMorselIds.length - 1 && !flight.soldierMorselId ? "└─" : "├─"} forager  ${gid}${formatRewardOrTokens(forager)}${isWinner ? "  ★ winner" : ""}`;
    lines.push(head);
    if (stingId) {
      lines.push(`│   ├─ wasp    ${stingId}${formatTokens(morselById.get(stingId))}`);
    }
    if (guard) {
      lines.push(
        `│   └─ guard   ${guard.id}${formatVerdict(verdict)}${formatTokens(guard)}`,
      );
    } else {
      lines.push(`│   └─ guard   (no verdict)`);
    }
  }

  if (flight.soldierMorselId) {
    const soldier = morselById.get(flight.soldierMorselId);
    lines.push(
      `└─ soldier  ${flight.soldierMorselId}${formatTokens(soldier)}  ★ winner (fallback)`,
    );
  }

  // Phase 1+6 artifact lineage block
  const artifact = await compost.getArtifactByFlightId(flightId);
  if (artifact) {
    lines.push("");
    lines.push("artifact lineage:");
    if (artifact.parentArtifactIds.length > 0) {
      const all = await compost.allArtifacts();
      const byId = new Map(all.map((a) => [a.id, a] as const));
      for (const pid of artifact.parentArtifactIds) {
        const p = byId.get(pid);
        if (p) lines.push(`  ⤴ parent ${p.id}  flight=${p.flightId}  task="${truncate(p.task, 60)}"`);
        else lines.push(`  ⤴ parent ${pid}  (missing)`);
      }
    }
    lines.push(`  ★ this  ${artifact.id}  claims=${artifact.claims.length}  open=${artifact.openQuestions.length}`);
    const all = await compost.allArtifacts();
    const children = all.filter((a) => a.parentArtifactIds.includes(artifact.id));
    for (const c of children) {
      lines.push(`  ⤵ child  ${c.id}  flight=${c.flightId}  task="${truncate(c.task, 60)}"`);
    }
  }

  return lines.join("\n");
}

export async function renderMorselAncestry(
  compost: Compost,
  rootId: string,
  maxDepth = 12,
): Promise<string | null> {
  const root = await compost.getMorsel(rootId);
  if (!root) return null;
  const seen = new Set<string>();
  const lines: string[] = [];

  async function walk(id: string, prefix: string, depth: number) {
    if (depth > maxDepth) {
      lines.push(prefix + "... (depth cap)");
      return;
    }
    if (seen.has(id)) {
      lines.push(prefix + `(cycle: ${id})`);
      return;
    }
    seen.add(id);
    const l = await compost.getMorsel(id);
    if (!l) {
      lines.push(prefix + `(missing ${id})`);
      return;
    }
    lines.push(`${prefix}${l.caste.padEnd(9)} ${l.id}${formatRewardOrTokens(l)}`);
    const parents = l.parentMorselIds ?? [];
    for (let i = 0; i < parents.length; i++) {
      const isLast = i === parents.length - 1;
      const newPrefix = prefix + (isLast ? "└─ " : "├─ ");
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      lines.push(newPrefix.trimEnd());
      // Replace the trailing branch with a real call:
      lines.pop();
      await walk(parents[i], newPrefix, depth + 1);
      // After recursion, future siblings use childPrefix as their indent
      // (handled by passing newPrefix above; this is just a placeholder).
      void childPrefix;
    }
  }

  await walk(rootId, "", 0);
  return lines.join("\n");
}

function formatVerdict(v?: GuardVerdict): string {
  if (!v) return "";
  return `  [${v.passed ? "PASS" : "FAIL"} score=${v.score.toFixed(2)}]`;
}

function formatTokens(l: Morsel | undefined): string {
  if (!l?.usage) return "";
  return `  (${l.usage.totalTokens} tok)`;
}

function formatRewardOrTokens(l: Morsel | undefined): string {
  if (!l) return "";
  const r = l.reward !== undefined ? `  sugar=${l.reward.toFixed(3)}` : "";
  return r + formatTokens(l);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
