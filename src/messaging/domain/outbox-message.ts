import { ExponentialBackoff } from "../../shared/domain/exponential-backoff.ts";
import type { IntegrationEvent, IntegrationEventEnvelope } from "../../shared/domain/integration-event.ts";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  /** Set while a publisher owns the row; another publisher may take it once this instant has passed. */
  lockedUntil?: Date;
  lockedBy?: string;
  lastError?: string;
  publishedAt?: Date;
}

const LAST_ERROR_MAX_LENGTH = 1_000;

/**
 * Publication never gives up: losing a committed event is not allowed.
 * The delay is capped instead, and `attempts` feeds metrics and alerts.
 */
export const OUTBOX_RETRY_BACKOFF = new ExponentialBackoff({
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  jitterRatio: 0.2,
});

/** Event waiting to be published. Its id is the eventId, so consumers can deduplicate redeliveries. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _lockedUntil?: Date,
    private _lockedBy?: string,
    private _lastError?: string,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const envelope: IntegrationEventEnvelope = event.toJSON();
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      envelope as unknown as Readonly<Record<string, unknown>>,
      new Date(event.occurredAt),
      0,
      new Date(event.occurredAt),
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt && new Date(state.nextAttemptAt),
      state.lockedUntil && new Date(state.lockedUntil),
      state.lockedBy,
      state.lastError,
      state.publishedAt && new Date(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt && new Date(this._nextAttemptAt);
  }

  get lockedUntil(): Date | undefined {
    return this._lockedUntil && new Date(this._lockedUntil);
  }

  get lockedBy(): string | undefined {
    return this._lockedBy;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt && new Date(this._publishedAt);
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  /** Due, and either never leased or the lease has expired. */
  isClaimable(now: Date): boolean {
    const leaseFree = this._lockedUntil === undefined || this._lockedUntil <= now;
    return this.isDue(now) && leaseFree;
  }

  /** Reserves the row for `holder` until `until`. Publishing happens after this reservation is committed. */
  claim(holder: string, until: Date): void {
    this.assertPending("claim");
    if (!holder) throw new Error("a lease needs a holder");
    this._lockedBy = holder;
    this._lockedUntil = new Date(until);
  }

  /** True while `holder` still owns an unexpired lease. */
  heldBy(holder: string, now: Date): boolean {
    return this.isPending() && this._lockedBy === holder && this._lockedUntil !== undefined && this._lockedUntil > now;
  }

  markPublished(at: Date): void {
    this.assertPending("markPublished");
    this._publishedAt = new Date(at);
    this._lastError = undefined;
    this.clearLease();
  }

  /**
   * Counts one failed attempt, remembers the error and schedules the next try.
   * The lease is dropped: the row returns to the pool only when `nextAttemptAt` arrives.
   */
  scheduleRetry(now: Date, backoff: ExponentialBackoff = OUTBOX_RETRY_BACKOFF, random?: () => number, error?: string): void {
    this.assertPending("scheduleRetry");
    this._attempts += 1;
    this._nextAttemptAt = backoff.nextAttemptAt(this._attempts, now, random);
    this._lastError = error?.slice(0, LAST_ERROR_MAX_LENGTH);
    this.clearLease();
  }

  /** Gives the row back without counting an attempt, due again at `nextAttemptAt`. */
  release(nextAttemptAt: Date): void {
    this.assertPending("release");
    this._nextAttemptAt = new Date(nextAttemptAt);
    this.clearLease();
  }

  /** How long the event has been waiting to be published (outbox lag). */
  lagMs(now: Date): number {
    const until = this._publishedAt ?? now;
    return Math.max(0, until.getTime() - this.occurredAt.getTime());
  }

  private assertPending(action: string): void {
    if (!this.isPending()) throw new Error(`Outbox message ${this.id} was already published and cannot ${action}`);
  }

  private clearLease(): void {
    this._lockedBy = undefined;
    this._lockedUntil = undefined;
  }
}
