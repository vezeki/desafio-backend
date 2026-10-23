/** Identity and causality of an event. A new eventId is required for every event. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

export interface IntegrationEventEnvelope<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601 */
  occurredAt: string;
  version: number;
  data: T;
}

/** Event published to other services. `data` must be plain JSON (MoneyProps, never Money). */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = deepFreeze(structuredClone(props.data));
  }

  /** Serialized envelope stored in the outbox payload. */
  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
    if (this.causationId !== undefined) envelope.causationId = this.causationId;
    return envelope;
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
