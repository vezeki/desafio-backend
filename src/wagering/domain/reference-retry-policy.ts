import { ExponentialBackoff } from "../../shared/domain/exponential-backoff.ts";

export interface ReferenceRetryPolicyOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff for transactions waiting on a missing reference.
 * Defaults: 10 attempts, 2s doubling up to 10min → ~27min until REFERENCE_NOT_FOUND.
 */
export class ReferenceRetryPolicy {
  static readonly DEFAULT_OPTIONS: ReferenceRetryPolicyOptions = {
    maxAttempts: 10,
    baseDelayMs: 2_000,
    maxDelayMs: 10 * 60_000,
  };

  readonly maxAttempts: number;
  private readonly backoff: ExponentialBackoff;

  constructor(options: Partial<ReferenceRetryPolicyOptions> = {}) {
    const resolved = { ...ReferenceRetryPolicy.DEFAULT_OPTIONS, ...options };
    if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
    this.maxAttempts = resolved.maxAttempts;
    this.backoff = new ExponentialBackoff({ baseDelayMs: resolved.baseDelayMs, maxDelayMs: resolved.maxDelayMs });
  }

  /** Delay before the next attempt, given how many attempts were already made (>= 1). */
  delayAfter(attempts: number): number {
    return this.backoff.delayAfter(attempts);
  }

  nextRetryAt(attempts: number, now: Date): Date {
    return this.backoff.nextAttemptAt(attempts, now);
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}
