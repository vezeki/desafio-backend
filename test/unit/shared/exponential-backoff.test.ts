import { describe, expect, test } from "bun:test";
import { ExponentialBackoff } from "../../../src/shared/domain/exponential-backoff.ts";

describe("ExponentialBackoff", () => {
  test("doubles up to the cap", () => {
    const backoff = new ExponentialBackoff({ baseDelayMs: 100, maxDelayMs: 1_000 });
    expect([1, 2, 3, 4, 5, 6].map((attempts) => backoff.delayAfter(attempts))).toEqual([100, 200, 400, 800, 1_000, 1_000]);
  });

  test("jitter only shortens the delay, within the ratio", () => {
    const backoff = new ExponentialBackoff({ baseDelayMs: 1_000, maxDelayMs: 10_000, jitterRatio: 0.2 });
    expect(backoff.delayAfter(1, () => 0)).toBe(1_000);
    expect(backoff.delayAfter(1, () => 0.5)).toBe(900);
    expect(backoff.delayAfter(1, () => 0.999)).toBeGreaterThanOrEqual(800);
  });

  test("rejects invalid options", () => {
    expect(() => new ExponentialBackoff({ baseDelayMs: 0, maxDelayMs: 1 })).toThrow(RangeError);
    expect(() => new ExponentialBackoff({ baseDelayMs: 10, maxDelayMs: 5 })).toThrow(RangeError);
    expect(() => new ExponentialBackoff({ baseDelayMs: 1, maxDelayMs: 5, jitterRatio: 1 })).toThrow(RangeError);
  });
});
