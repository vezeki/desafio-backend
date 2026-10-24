import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { loadConfig } from "../../../src/config.ts";
import { ConsumeWagerMessage } from "../../../src/wagering/application/consume-wager-message.ts";
import { WAGER_CONSUMER_NAME } from "../../../src/wagering/application/wager-message.ts";
import type { WagerRequest } from "../../../src/wagering/application/submit-wager-transaction.use-case.ts";
import { SqsWagerQueue } from "../../../src/wagering/infrastructure/sqs/sqs-wager-queue.ts";
import { WagerConsumer } from "../../../src/wagering/infrastructure/workers/wager-consumer.ts";
import { WagerTransactionStatus } from "../../../src/wagering/domain/wager-transaction-status.ts";
import { createTestPersistence, type TestPersistence } from "../../support/orm.ts";
import { expectBalanceMatchesLedger, wageringHarness, type WalletUnderTest } from "../../support/wagering.ts";

let p: TestPersistence;
let sqs: SQSClient;
let sourceName: string;
let dlqName: string;
let sourceUrl: string;
let dlqUrl: string;

beforeAll(async () => {
  p = await createTestPersistence();
  const config = loadConfig();
  sqs = new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
  const suffix = randomUUID().slice(0, 8);
  sourceName = `wager-consumer-${suffix}.fifo`;
  dlqName = `wager-consumer-${suffix}-dlq.fifo`;
  const dlq = await sqs.send(
    new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }),
  );
  dlqUrl = dlq.QueueUrl!;
  const arn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }))).Attributes?.QueueArn;
  if (!arn) throw new Error("dead-letter queue has no arn");
  const source = await sqs.send(
    new CreateQueueCommand({
      QueueName: sourceName,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: "5" }),
      },
    }),
  );
  sourceUrl = source.QueueUrl!;
});

afterAll(async () => {
  sqs.destroy();
  await p.close();
});

function envelope(request: WagerRequest, messageId = randomUUID()): string {
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: "2026-07-29T15:00:00.000Z",
    data: request,
  });
}

async function send(body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: sourceUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

function consumer(): WagerConsumer {
  return new WagerConsumer(new SqsWagerQueue(sqs, sourceName, dlqName, { waitSeconds: 1, visibilitySeconds: 30 }), new ConsumeWagerMessage(wageringHarness(p).submit), {
    batchSize: 5,
    shutdownTimeoutMs: 1_000,
  });
}

async function drain(loop: WagerConsumer): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await loop.pollOnce()) === 0) return;
  }
}

async function counts(url: string): Promise<{ visible: string; hidden: string }> {
  const attributes = (
    await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    )
  ).Attributes;
  return {
    visible: attributes?.ApproximateNumberOfMessages ?? "?",
    hidden: attributes?.ApproximateNumberOfMessagesNotVisible ?? "?",
  };
}

async function assertEmpty(url: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  let last = { visible: "?", hidden: "?" };
  while (Date.now() < deadline) {
    last = await counts(url);
    if (last.visible === "0" && last.hidden === "0") return;
    await Bun.sleep(50);
  }
  throw new Error(`queue not empty visible=${last.visible} hidden=${last.hidden}`);
}

async function dlqBodies(expected: number): Promise<string[]> {
  const bodies: string[] = [];
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline && bodies.length < expected) {
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    for (const message of received.Messages ?? []) bodies.push(message.Body ?? "");
  }
  return bodies;
}

async function debits(walletId: string): Promise<number> {
  const [row] = await p.sql<{ count: number }[]>`
    select count(*)::int as count from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return row!.count;
}

async function stored(key: string): Promise<{ status: string; failure_code: string | null } | undefined> {
  const [row] = await p.sql<{ status: string; failure_code: string | null }[]>`
    select status, failure_code from wager_transactions where idempotency_key = ${key}`;
  return row;
}

describe.serial("wager queue consumer", () => {
  test("a bet is debited once, and a redelivery of the same message id does not debit again", async () => {
    const h = wageringHarness(p);
    const wallet: WalletUnderTest = await h.wallet("100.00");
    const request = h.request(wallet, { money: { amount: "25.00", currency: "BRL" } });
    const messageId = randomUUID();
    const body = envelope(request, messageId);

    await send(body, wallet.walletId);
    await send(body, wallet.walletId);
    await drain(consumer());

    expect(await debits(wallet.walletId)).toBe(1);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "75.00");
    const [inbox] = await p.sql<{ count: number }[]>`
      select count(*)::int as count from inbox_messages
      where consumer_name = ${WAGER_CONSUMER_NAME} and message_id = ${messageId}`;
    expect(inbox!.count).toBe(1);
    await assertEmpty(sourceUrl);
  }, 20_000);

  test("insufficient funds is persisted and acked, not dead-lettered", async () => {
    const h = wageringHarness(p);
    const wallet = await h.wallet("5.00");
    const request = h.request(wallet, { money: { amount: "10.00", currency: "BRL" } });

    await send(envelope(request), wallet.walletId);
    await drain(consumer());

    expect(await stored(`${request.providerId}:${request.externalTransactionId}`)).toMatchObject({
      status: WagerTransactionStatus.Rejected,
      failure_code: "INSUFFICIENT_FUNDS",
    });
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "5.00");
    await assertEmpty(sourceUrl);
    await assertEmpty(dlqUrl);
  }, 20_000);

  test("invalid JSON goes to the DLQ and an idempotency conflict does too", async () => {
    const h = wageringHarness(p);
    const wallet = await h.wallet("100.00");
    const request = h.request(wallet, { money: { amount: "10.00", currency: "BRL" } });
    await h.send(request);

    await send("{", wallet.walletId);
    await send(envelope({ ...request, money: { amount: "11.00", currency: "BRL" } }), wallet.walletId);
    await drain(consumer());

    const bodies = await dlqBodies(2);
    expect(bodies.some((body) => body.includes("not valid JSON"))).toBe(true);
    expect(bodies.some((body) => body.includes("already used"))).toBe(true);
    expect(await stored(`${request.providerId}:${request.externalTransactionId}`)).toMatchObject({
      status: WagerTransactionStatus.Processed,
    });
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "90.00");
    await assertEmpty(sourceUrl);
  }, 20_000);
});
