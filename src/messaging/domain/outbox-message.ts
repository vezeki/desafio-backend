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
  publishedAt?: Date;
}

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
      state.publishedAt && new Date(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt && new Date(this._nextAttemptAt);
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

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new Error(`Outbox message ${this.id} was already published`);
    }
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and schedules the next one with exponential backoff. */
  scheduleRetry(now: Date, backoff: ExponentialBackoff = OUTBOX_RETRY_BACKOFF, random?: () => number): void {
    if (!this.isPending()) {
      throw new Error(`Outbox message ${this.id} was already published`);
    }
    this._attempts += 1;
    this._nextAttemptAt = backoff.nextAttemptAt(this._attempts, now, random);
  }

  /** How long the event has been waiting to be published (outbox lag). */
  lagMs(now: Date): number {
    const until = this._publishedAt ?? now;
    return Math.max(0, until.getTime() - this.occurredAt.getTime());
  }
}
