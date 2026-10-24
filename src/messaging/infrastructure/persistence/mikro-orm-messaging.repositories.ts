import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository, OutboxRepository } from "../../application/ports/messaging-repositories.ts";
import { InboxMessage } from "../../domain/inbox-message.ts";
import type { OutboxMessage } from "../../domain/outbox-message.ts";
import { InboxRecord, OutboxRecord } from "./messaging.records.ts";

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryRecord(message: InboxMessage): Promise<boolean> {
    const result = await this.em
      .createQueryBuilder(InboxRecord)
      .insert({
        consumerName: message.consumerName,
        messageId: message.messageId,
        payloadHash: message.payloadHash,
        receivedAt: message.receivedAt,
        processedAt: message.processedAt ?? null,
      })
      .onConflict(["consumerName", "messageId"])
      .ignore()
      .execute("run");
    return result.affectedRows === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxRecord, { consumerName, messageId });
    if (!record) return undefined;
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    const record = new OutboxRecord();
    record.id = message.id;
    record.aggregateId = message.aggregateId;
    record.eventType = message.eventType;
    record.payload = { ...message.payload };
    record.occurredAt = message.occurredAt;
    record.attempts = message.attempts;
    record.nextAttemptAt = message.nextAttemptAt ?? message.occurredAt;
    record.publishedAt = message.publishedAt ?? null;
    this.em.persist(record);
  }
}
