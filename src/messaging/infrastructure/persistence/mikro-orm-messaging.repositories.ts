import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import type { InboxRepository, OutboxRepository } from "../../application/ports/messaging-repositories.ts";
import { InboxMessage } from "../../domain/inbox-message.ts";
import { OutboxMessage } from "../../domain/outbox-message.ts";
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

function toOutboxMessage(record: OutboxRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    lockedUntil: record.lockedUntil ?? undefined,
    lockedBy: record.lockedBy ?? undefined,
    lastError: record.lastError ?? undefined,
    publishedAt: record.publishedAt ?? undefined,
  });
}

function copyBookkeeping(message: OutboxMessage, record: OutboxRecord): void {
  record.attempts = message.attempts;
  // The column is NOT NULL; publishing keeps the scheduled instant instead of clearing it.
  record.nextAttemptAt = message.nextAttemptAt ?? record.nextAttemptAt;
  record.lockedUntil = message.lockedUntil ?? null;
  record.lockedBy = message.lockedBy ?? null;
  record.lastError = message.lastError ?? null;
  record.publishedAt = message.publishedAt ?? null;
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  private readonly tracked = new Map<string, OutboxRecord>();

  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    const record = new OutboxRecord();
    record.id = message.id;
    record.aggregateId = message.aggregateId;
    record.eventType = message.eventType;
    record.payload = { ...message.payload };
    record.occurredAt = message.occurredAt;
    record.nextAttemptAt = message.occurredAt;
    copyBookkeeping(message, record);
    this.em.persist(record);
    this.tracked.set(message.id, record);
  }

  async findByIdForUpdate(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(OutboxRecord, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
    return this.track(record);
  }

  async claimDue(now: Date, until: Date, lockedBy: string, limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxRecord,
      {
        publishedAt: null,
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      },
      { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, orderBy: { occurredAt: "asc", id: "asc" }, limit },
    );
    return records.flatMap((record) => {
      const message = toOutboxMessage(record);
      message.claim(lockedBy, until);
      copyBookkeeping(message, record);
      this.tracked.set(message.id, record);
      return [message];
    });
  }

  save(message: OutboxMessage): void {
    const record = this.tracked.get(message.id);
    if (!record) throw new Error(`Outbox message ${message.id} was not loaded in this transaction`);
    copyBookkeeping(message, record);
  }

  private track(record: OutboxRecord | null): OutboxMessage | undefined {
    if (!record) return undefined;
    this.tracked.set(record.id, record);
    return toOutboxMessage(record);
  }
}
