import type { Caste } from "./types.js";

const WORDMARK = [
  " ___  _    __   __ _____   ___  __      __ _  _",
  "| __|| |   \\ \\ / /|_   _| / _ \\ \\ \\    / /| \\| |",
  "| _| | |__  \\ V /   | |  | (_) | \\ \\/\\/ / | .` |",
  "|_|  |____|  |_|    |_|   \\___/   \\_/\\_/  |_|\\_|",
].join("\n");

/** The banner printed before a single `ask` call: the FLYTOWN wordmark and the caste answering. */
export function bannerFor(caste: Caste): string {
  return `${WORDMARK}\n${caste}\n`;
}

/**
 * Print the FLYTOWN banner. Defaults to stderr so piping `ask` output to a
 * file or another command keeps the actual response clean.
 * Suppress with FLYTOWN_NO_BANNER=1.
 */
export function printBanner(
  caste: Caste,
  out: NodeJS.WritableStream = process.stderr,
): void {
  if (process.env.FLYTOWN_NO_BANNER === "1") return;
  out.write(bannerFor(caste) + "\n");
}
