import type { Compost } from "./compost.js";
import type { Morsel, Flight } from "./types.js";

export async function exportFlightMarkdown(
  compost: Compost,
  flightId: string,
): Promise<string | null> {
  const flight = await compost.getFlight(flightId);
  if (!flight) return null;

  const all = await compost.allMorsels();
  const inFlight = all.filter((l) => l.flightId === flightId);
  const morselById = new Map(inFlight.map((l) => [l.id, l]));

  const parts: string[] = [];
  parts.push(`# Flight \`${flight.id}\``);
  parts.push("");
  parts.push(
    `- **Outcome:** ${flight.outcome}\n` +
      `- **Personality:** ${flight.personality}\n` +
      `- **Swarm size:** ${flight.swarmSize}\n` +
      `- **Started:** ${new Date(flight.startedAt).toISOString()}\n` +
      `- **Finished:** ${flight.finishedAt ? new Date(flight.finishedAt).toISOString() : "(unfinished)"}\n` +
      `- **Scan globs:** ${flight.scanGlobs.length === 0 ? "(none)" : flight.scanGlobs.map((g) => `\`${g}\``).join(", ")}\n` +
      `- **Total morsels:** ${inFlight.length}\n` +
      `- **Total tokens:** ${inFlight.reduce((s, l) => s + (l.usage?.totalTokens ?? 0), 0)}`,
  );
  parts.push("");
  parts.push(`## Task`);
  parts.push("");
  parts.push("```");
  parts.push(flight.task);
  parts.push("```");
  parts.push("");

  if (flight.contextMorselId) {
    const r = morselById.get(flight.contextMorselId);
    parts.push(`## Scout context (\`${flight.contextMorselId}\`)`);
    parts.push("");
    parts.push(formatMorselMeta(r));
    parts.push("");
    parts.push(r ? r.output : "(missing)");
    parts.push("");
  }

  parts.push(`## Forager swarm`);
  parts.push("");
  for (const gid of flight.foragerMorselIds) {
    const forager = morselById.get(gid);
    const verdict = flight.guardVerdicts[gid];
    const stingId = flight.stingMorselIds[gid];
    const sting = stingId ? morselById.get(stingId) : null;
    const isWinner = gid === flight.winnerMorselId;
    parts.push(
      `### Forager \`${gid}\`${isWinner ? "  ★ winner" : ""}`,
    );
    parts.push("");
    parts.push(formatMorselMeta(forager));
    if (verdict) {
      parts.push(
        `- **Guard:** ${verdict.passed ? "PASS" : "FAIL"} (score ${verdict.score.toFixed(2)})\n` +
          `- **Critique:** ${verdict.critique}`,
      );
    }
    parts.push("");
    parts.push(forager ? forager.output : "(missing)");
    parts.push("");
    if (sting) {
      parts.push(`#### Wasp sting (\`${sting.id}\`)`);
      parts.push("");
      parts.push(formatMorselMeta(sting));
      parts.push("");
      parts.push(sting.output);
      parts.push("");
    }
  }

  if (flight.soldierMorselId) {
    const soldier = morselById.get(flight.soldierMorselId);
    parts.push(`## Soldier fallback (\`${flight.soldierMorselId}\`)`);
    parts.push("");
    parts.push(formatMorselMeta(soldier));
    parts.push("");
    parts.push(soldier ? soldier.output : "(missing)");
    parts.push("");
  }

  if (flight.winnerMorselId) {
    const winner = morselById.get(flight.winnerMorselId);
    parts.push(`## Winner`);
    parts.push("");
    parts.push(`**Morsel id:** \`${flight.winnerMorselId}\``);
    parts.push("");
    parts.push(winner ? winner.output : "(missing)");
    parts.push("");
  }

  return parts.join("\n");
}

function formatMorselMeta(morsel: Morsel | undefined): string {
  if (!morsel) return "_(missing from Compost)_";
  const u = morsel.usage;
  return (
    `- **Model:** \`${morsel.model}\`\n` +
    `- **Personality:** ${morsel.personality}\n` +
    (u
      ? `- **Tokens:** ${u.totalTokens} (prompt ${u.promptTokens} / completion ${u.completionTokens})\n`
      : "") +
    `- **Drift rate:** ${morsel.drift.driftRate.toFixed(4)}` +
    (morsel.reward !== undefined ? `\n- **Sugar:** ${morsel.reward.toFixed(3)}` : "")
  );
}
