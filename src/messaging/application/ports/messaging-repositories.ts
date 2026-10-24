import type { InboxMessage } from "../../domain/inbox-message.ts";
import type { OutboxMessage } from "../../domain/outbox-message.ts";

export interface InboxRepository {
  /**
   * Records the message immediately (INSERT ... ON CONFLICT DO NOTHING).
   * Returns false when (consumerName, messageId) was already recorded — a redelivery.
   * A concurrent delivery of the same message waits on the unique index until the first one commits or rolls back.
   */
  tryRecord(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
}
