import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../../../src/lib/concurrency.js";

describe("mapWithConcurrency", () => {
  it("maps every item and preserves order", async () => {
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it("never runs more than `limit` at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("handles an empty array", async () => {
    const result = await mapWithConcurrency([], 5, async (n: number) => n);
    expect(result).toEqual([]);
  });
});
