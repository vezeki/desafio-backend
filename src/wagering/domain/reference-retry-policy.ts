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
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;

  constructor(options: Partial<ReferenceRetryPolicyOptions> = {}) {
    const resolved = { ...ReferenceRetryPolicy.DEFAULT_OPTIONS, ...options };
    if (!Number.isInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
      throw new RangeError("maxAttempts must be a positive integer");
    }
    if (resolved.baseDelayMs <= 0 || resolved.maxDelayMs < resolved.baseDelayMs) {
      throw new RangeError("delays must be positive and maxDelayMs >= baseDelayMs");
    }
    this.maxAttempts = resolved.maxAttempts;
    this.baseDelayMs = resolved.baseDelayMs;
    this.maxDelayMs = resolved.maxDelayMs;
  }

  /** Delay before the next attempt, given how many attempts were already made (>= 1). */
  delayAfter(attempts: number): number {
    const exponent = Math.max(0, attempts - 1);
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }

  nextRetryAt(attempts: number, now: Date): Date {
    return new Date(now.getTime() + this.delayAfter(attempts));
  }

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }
}
