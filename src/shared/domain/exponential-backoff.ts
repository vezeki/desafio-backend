export interface ExponentialBackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the delay that is randomized (0 = deterministic, 0.2 = up to 20% shorter). */
  jitterRatio?: number;
}

export class ExponentialBackoff {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;

  constructor(options: ExponentialBackoffOptions) {
    const jitterRatio = options.jitterRatio ?? 0;
    if (options.baseDelayMs <= 0 || options.maxDelayMs < options.baseDelayMs) {
      throw new RangeError("delays must be positive and maxDelayMs >= baseDelayMs");
    }
    if (jitterRatio < 0 || jitterRatio >= 1) {
      throw new RangeError("jitterRatio must be in [0, 1)");
    }
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.jitterRatio = jitterRatio;
  }

  /** Delay before the next attempt, given how many attempts were already made (>= 1). */
  delayAfter(attempts: number, random: () => number = Math.random): number {
    const exponent = Math.max(0, attempts - 1);
    const delay = Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
    return Math.round(delay * (1 - this.jitterRatio * random()));
  }

  nextAttemptAt(attempts: number, now: Date, random?: () => number): Date {
    return new Date(now.getTime() + this.delayAfter(attempts, random));
  }
}
