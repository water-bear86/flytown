import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { swarmVariant } from "../swarm-prompt.js";

describe("swarmVariant", () => {
  it("returns the bare task when swarmSize is 1", () => {
    assert.equal(swarmVariant("do thing", 0, 1), "do thing");
  });

  it("returns the bare task when swarmSize is 0 or negative", () => {
    assert.equal(swarmVariant("do thing", 0, 0), "do thing");
    assert.equal(swarmVariant("do thing", 0, -1), "do thing");
  });

  it("appends a distinct hint per index when swarmSize > 1", () => {
    const a = swarmVariant("task", 0, 3);
    const b = swarmVariant("task", 1, 3);
    const c = swarmVariant("task", 2, 3);
    assert.notEqual(a, b);
    assert.notEqual(b, c);
    assert.notEqual(a, c);
    for (const v of [a, b, c]) assert.match(v, /Forager \d+ of 3/);
  });

  it("wraps around when index exceeds the hint pool", () => {
    const a = swarmVariant("task", 0, 100);
    const b = swarmVariant("task", 9, 100);
    // both reference the same hint pool; with index 9 we wrap
    assert.match(a, /Forager 1 of 100/);
    assert.match(b, /Forager 10 of 100/);
  });

  it("returns the bare task for non-finite swarmSize", () => {
    assert.equal(swarmVariant("task", 0, NaN), "task");
    assert.equal(swarmVariant("task", 0, Infinity), "task");
  });

  it("throws on a negative or non-integer index when swarmSize > 1", () => {
    assert.throws(() => swarmVariant("task", -1, 3), RangeError);
    assert.throws(() => swarmVariant("task", 0.5, 3), RangeError);
    assert.throws(() => swarmVariant("task", NaN, 3), RangeError);
  });
});
