import { EntitySchema, PrimaryKeyProp } from "@mikro-orm/core";

export class InboxRecord {
  [PrimaryKeyProp]?: ["consumerName", "messageId"];
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string", columnType: "char(64)" },
    receivedAt: { type: "datetime", columnType: "timestamptz" },
    processedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
  },
});

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  lockedUntil?: Date | null;
  lockedBy?: string | null;
  lastError?: string | null;
  publishedAt?: Date | null;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "uuid" },
    eventType: { type: "string" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { type: "datetime", columnType: "timestamptz" },
    attempts: { type: "integer" },
    nextAttemptAt: { type: "datetime", columnType: "timestamptz" },
    lockedUntil: { type: "datetime", columnType: "timestamptz", nullable: true },
    lockedBy: { type: "string", nullable: true },
    lastError: { type: "string", nullable: true },
    publishedAt: { type: "datetime", columnType: "timestamptz", nullable: true },
  },
});
