import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { bannerFor, printBanner } from "../banners.js";
import { CASTES } from "../types.js";

describe("banners", () => {
  it("renders the FLYTOWN wordmark and names the caste", () => {
    for (const caste of CASTES) {
      const b = bannerFor(caste);
      assert.equal(typeof b, "string");
      assert.ok(b.includes("|____|"), "wordmark present");
      assert.ok(b.trimEnd().endsWith(caste), `banner names ${caste}`);
    }
  });

  it("is suppressed by FLYTOWN_NO_BANNER=1", () => {
    const chunks: string[] = [];
    const out = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WritableStream;
    const prev = process.env.FLYTOWN_NO_BANNER;
    try {
      process.env.FLYTOWN_NO_BANNER = "1";
      printBanner("forager", out);
      assert.equal(chunks.length, 0);
      delete process.env.FLYTOWN_NO_BANNER;
      printBanner("forager", out);
      assert.equal(chunks.length, 1);
    } finally {
      if (prev === undefined) delete process.env.FLYTOWN_NO_BANNER;
      else process.env.FLYTOWN_NO_BANNER = prev;
    }
  });
});
