import type { Clock } from "../../src/shared/application/clock.ts";

/** Deterministic clock for tests that drive retry schedules. */
export class AdjustableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
