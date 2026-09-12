import { performFlight, type FlightOptions, type FlightResult } from "./flight.js";
import type { Compost } from "./compost.js";

export interface RerollOptions {
  flightId: string;
  cwd: string;
  compost: Compost;
  noFallback?: boolean;
  budgetTokens?: number;
  maxOutputTokensPerCall?: number;
  onStep?: FlightOptions["onStep"];
  rewardFn?: FlightOptions["rewardFn"];
}

export async function reroll(opts: RerollOptions): Promise<FlightResult> {
  const original = await opts.compost.getFlight(opts.flightId);
  if (!original) {
    throw new Error(`Flight ${opts.flightId} not found in the Compost.`);
  }
  return performFlight({
    task: original.task,
    swarmSize: original.swarmSize,
    scanGlobs: original.scanGlobs,
    cwd: opts.cwd,
    compost: opts.compost,
    personality: original.personality,
    rewardFn: opts.rewardFn,
    noFallback: opts.noFallback,
    budgetTokens: opts.budgetTokens,
    maxOutputTokensPerCall: opts.maxOutputTokensPerCall,
    onStep: opts.onStep,
  });
}
