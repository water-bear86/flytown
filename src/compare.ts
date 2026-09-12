import type { Compost } from "./compost.js";
import type { Morsel, Flight } from "./types.js";

export interface FlightSnapshot {
  flight: Flight;
  totalTokens: number;
  totalMorsels: number;
  avgDriftRate: number;
  passRate: number;
  winner?: Morsel;
}

export interface ComparisonReport {
  a: FlightSnapshot;
  b: FlightSnapshot;
  taskMatches: boolean;
}

export async function compareFlights(
  compost: Compost,
  flightIdA: string,
  flightIdB: string,
): Promise<ComparisonReport | null> {
  const [snapA, snapB] = await Promise.all([
    snapshot(compost, flightIdA),
    snapshot(compost, flightIdB),
  ]);
  if (!snapA || !snapB) return null;
  return {
    a: snapA,
    b: snapB,
    taskMatches: snapA.flight.task === snapB.flight.task,
  };
}

async function snapshot(compost: Compost, flightId: string): Promise<FlightSnapshot | null> {
  const flight = await compost.getFlight(flightId);
  if (!flight) return null;
  const all = await compost.allMorsels();
  const inFlight = all.filter((l) => l.flightId === flightId);

  const totalTokens = inFlight.reduce(
    (s, l) => s + (l.usage?.totalTokens ?? 0),
    0,
  );
  const driftSum = inFlight.reduce((s, l) => s + l.drift.driftRate, 0);
  const avgDriftRate = inFlight.length > 0 ? driftSum / inFlight.length : 0;

  const verdicts = Object.values(flight.guardVerdicts);
  const passes = verdicts.filter((v) => v.passed).length;
  const passRate = verdicts.length > 0 ? passes / verdicts.length : 0;

  const winner = flight.winnerMorselId
    ? inFlight.find((l) => l.id === flight.winnerMorselId) ??
      (await compost.getMorsel(flight.winnerMorselId)) ??
      undefined
    : undefined;

  return {
    flight,
    totalTokens,
    totalMorsels: inFlight.length,
    avgDriftRate,
    passRate,
    winner: winner ?? undefined,
  };
}
