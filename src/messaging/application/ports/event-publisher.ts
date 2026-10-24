import type { OutboxMessage } from "../../domain/outbox-message.ts";

/** Sends one committed event. A second send of the same message must stay safe for whoever consumes it. */
export interface IntegrationEventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
