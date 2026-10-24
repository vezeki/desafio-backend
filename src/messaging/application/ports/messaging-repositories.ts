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
  findByIdForUpdate(id: string): Promise<OutboxMessage | undefined>;
  /**
   * Due, unlocked rows, locked with `FOR UPDATE SKIP LOCKED` and leased to `lockedBy` until `until`.
   * Must run inside `UnitOfWork.run`: the lease is visible to the other publishers only after that transaction commits.
   */
  claimDue(now: Date, until: Date, lockedBy: string, limit: number): Promise<OutboxMessage[]>;
  /** Persists bookkeeping of a message loaded or claimed in this transaction. */
  save(message: OutboxMessage): void;
}
