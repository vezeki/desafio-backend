import { describe, expect, test } from "bun:test";
import { ReferenceRetryPolicy } from "../../../src/wagering/domain/reference-retry-policy.ts";

describe("ReferenceRetryPolicy", () => {
  const policy = new ReferenceRetryPolicy({ maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 5_000 });

  test("doubles the delay after each attempt, up to the cap", () => {
    expect([1, 2, 3, 4, 5, 6].map((attempts) => policy.delayAfter(attempts))).toEqual([
      1_000, 2_000, 4_000, 5_000, 5_000, 5_000,
    ]);
  });

  test("computes the next retry date from now", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(policy.nextRetryAt(2, now).toISOString()).toBe("2026-01-01T00:00:02.000Z");
  });

  test("is exhausted after maxAttempts", () => {
    expect(policy.isExhausted(4)).toBe(false);
    expect(policy.isExhausted(5)).toBe(true);
  });

  test("defaults give roughly half an hour before giving up", () => {
    const defaults = new ReferenceRetryPolicy();
    let total = 0;
    for (let attempts = 1; attempts < defaults.maxAttempts; attempts++) total += defaults.delayAfter(attempts);
    expect(total / 60_000).toBeGreaterThan(10);
    expect(total / 60_000).toBeLessThan(60);
  });

  test("rejects invalid options", () => {
    expect(() => new ReferenceRetryPolicy({ maxAttempts: 0 })).toThrow(RangeError);
    expect(() => new ReferenceRetryPolicy({ baseDelayMs: 10_000, maxDelayMs: 1_000 })).toThrow(RangeError);
  });
});
