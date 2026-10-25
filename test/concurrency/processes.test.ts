import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { SQL } from "bun";
import { loadConfig } from "../../src/config.ts";
import { OutboxMessage } from "../../src/messaging/domain/outbox-message.ts";
import type { WagerRequest } from "../../src/wagering/application/submit-wager-transaction.use-case.ts";
import { createDatabaseIfMissing, databaseUrl, migrate } from "../support/database.ts";
import { createTestPersistence, type TestPersistence } from "../support/orm.ts";
import { expectBalanceMatchesLedger, wageringHarness, type WalletUnderTest } from "../support/wagering.ts";

let p: TestPersistence;
let sqs: SQSClient;
let databaseName: string;
let databaseConnection: string;
const workerPath = new URL("../processes/worker.ts", import.meta.url).pathname;

beforeAll(async () => {
  databaseName = `wagering_proc_${randomUUID().slice(0, 8)}`;
  databaseConnection = await createDatabaseIfMissing(databaseName);
  await migrate(databaseConnection);
  p = await createTestPersistence({ databaseUrl: databaseConnection });
  const config = loadConfig();
  sqs = new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
});

afterAll(async () => {
  sqs.destroy();
  await p.close();
  const admin = new SQL(databaseUrl("postgres"));
  try {
    await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.close();
  }
});

async function fifoQueue(name: string): Promise<string> {
  const created = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }),
  );
  if (!created.QueueUrl) throw new Error(`queue ${name} has no url`);
  return created.QueueUrl;
}

function envelope(request: WagerRequest, messageId = randomUUID()): string {
  return JSON.stringify({
    messageId,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: request,
  });
}

async function runWorker(env: Record<string, string>, timeoutMs = 20_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", workerPath], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exited = proc.exited.then((code) => code);
  const result = await Promise.race([exited, Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
  if (result === "timeout") {
    proc.kill();
    await proc.exited;
  }
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (result === "timeout") throw new Error(`worker timed out\n${stderr}\n${stdout}`);
  return { code: result, stdout, stderr };
}

/** The child talks to the same database this test opened. Bun's SQL client keeps the url. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const config = loadConfig();
  return {
    DATABASE_URL: databaseConnection,
    AWS_REGION: config.AWS_REGION,
    AWS_ENDPOINT_URL: config.AWS_ENDPOINT_URL,
    AWS_ACCESS_KEY_ID: config.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: config.AWS_SECRET_ACCESS_KEY,
    ...extra,
  };
}

describe.serial("several processes", () => {
  test("a publisher that dies after the send leaves the event unpublished, and another process finishes it", async () => {
    const queueName = `events-proc-${randomUUID().slice(0, 8)}.fifo`;
    const queueUrl = await fifoQueue(queueName);
    const id = p.ids.next();
    const aggregateId = p.ids.next();
    const occurredAt = new Date();
    await p.unitOfWork.run(async (ctx) => {
      ctx.outbox.add(
        OutboxMessage.rehydrate({
          id,
          aggregateId,
          eventType: "WalletBalanceChanged",
          payload: {
            eventId: id,
            eventType: "WalletBalanceChanged",
            aggregateId,
            correlationId: "crash",
            occurredAt: occurredAt.toISOString(),
            version: 1,
            data: { walletId: aggregateId },
          },
          occurredAt,
          attempts: 0,
          nextAttemptAt: occurredAt,
        }),
      );
    });

    const crashed = await runWorker(
      childEnv({
        ROLE: "publish",
        INSTANCE_ID: "dead-publisher",
        SQS_EVENTS_QUEUE_NAME: queueName,
        OUTBOX_LEASE_MS: "2000",
        CRASH_AT: "after-publish",
      }),
    );
    expect(crashed.code, crashed.stderr).toBe(42);

    const [mid] = await p.sql<{ published: boolean }[]>`
      select published_at is not null as published from outbox_messages where id = ${id}`;
    expect(mid!.published).toBe(false);
    expect(await readEventIds(queueUrl)).toContain(id);

    await waitUntilLeaseExpires(id);
    const recovered = await runWorker(
      childEnv({ ROLE: "publish", INSTANCE_ID: "live-publisher", SQS_EVENTS_QUEUE_NAME: queueName, OUTBOX_LEASE_MS: "2000" }),
    );
    expect(recovered.code, recovered.stderr).toBe(0);
    const [done] = await p.sql<{ published: boolean }[]>`
      select published_at is not null as published from outbox_messages where id = ${id}`;
    expect(done!.published).toBe(true);
  }, 30_000);

  test("three processes share one wager queue and each bet is applied once", async () => {
    const suffix = randomUUID().slice(0, 8);
    const queueName = `wager-proc-${suffix}.fifo`;
    const dlqName = `wager-proc-${suffix}-dlq.fifo`;
    await fifoQueue(dlqName);
    const sourceUrl = await fifoQueue(queueName);
    const h = wageringHarness(p);
    const wallets = await Promise.all([h.wallet("100.00"), h.wallet("100.00"), h.wallet("100.00")]);
    for (const wallet of wallets) {
      const request = h.request(wallet, { money: { amount: "10.00", currency: "BRL" } });
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: sourceUrl,
          MessageBody: envelope(request),
          MessageGroupId: wallet.walletId,
          MessageDeduplicationId: randomUUID(),
        }),
      );
    }

    const results = await Promise.all(
      ["a", "b", "c"].map((name) =>
        runWorker(
          childEnv({
            ROLE: "consume",
            INSTANCE_ID: `consumer-${name}`,
            SQS_WAGER_QUEUE_NAME: queueName,
            SQS_WAGER_DLQ_NAME: dlqName,
            WAGER_CONSUMER_WAIT_SECONDS: "1",
            WAGER_CONSUMER_VISIBILITY_SECONDS: "30",
            WAGER_CONSUMER_BATCH_SIZE: "1",
            MAX_MESSAGES: "1",
          }),
        ),
      ),
    );

    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("handled 1");
    }
    expect(new Set(results.map((result) => result.stdout.match(/handled 1 (\S+)/)?.[1])).size).toBe(3);
    for (const wallet of wallets) {
      expect(await debits(wallet.walletId)).toBe(1);
      await expectBalanceMatchesLedger(p.sql, wallet.walletId, "90.00");
    }
  }, 30_000);

  test("a consumer that dies after the commit and before the ack does not debit twice", async () => {
    const suffix = randomUUID().slice(0, 8);
    const queueName = `wager-crash-${suffix}.fifo`;
    const dlqName = `wager-crash-${suffix}-dlq.fifo`;
    await fifoQueue(dlqName);
    const url = await fifoQueue(queueName);
    const h = wageringHarness(p);
    const wallet: WalletUnderTest = await h.wallet("100.00");
    const request = h.request(wallet, { money: { amount: "25.00", currency: "BRL" } });
    const messageId = randomUUID();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: envelope(request, messageId),
        MessageGroupId: wallet.walletId,
        MessageDeduplicationId: randomUUID(),
      }),
    );

    const crashed = await runWorker(
      childEnv({
        ROLE: "consume",
        INSTANCE_ID: "dead-consumer",
        SQS_WAGER_QUEUE_NAME: queueName,
        SQS_WAGER_DLQ_NAME: dlqName,
        WAGER_CONSUMER_WAIT_SECONDS: "1",
        WAGER_CONSUMER_VISIBILITY_SECONDS: "2",
        WAGER_CONSUMER_BATCH_SIZE: "1",
        MAX_MESSAGES: "1",
        CRASH_AT: "after-commit",
      }),
    );
    expect(crashed.code, crashed.stderr).toBe(42);
    expect(await debits(wallet.walletId)).toBe(1);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "75.00");

    const recovered = await runWorker(
      childEnv({
        ROLE: "consume",
        INSTANCE_ID: "live-consumer",
        SQS_WAGER_QUEUE_NAME: queueName,
        SQS_WAGER_DLQ_NAME: dlqName,
        WAGER_CONSUMER_WAIT_SECONDS: "2",
        WAGER_CONSUMER_VISIBILITY_SECONDS: "10",
        WAGER_CONSUMER_BATCH_SIZE: "1",
        MAX_MESSAGES: "1",
        MAX_EMPTY: "6",
      }),
    );
    expect(recovered.code, recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain("handled 1");
    expect(await debits(wallet.walletId)).toBe(1);
    await expectBalanceMatchesLedger(p.sql, wallet.walletId, "75.00");
    const [inbox] = await p.sql<{ count: number }[]>`
      select count(*)::int as count from inbox_messages where message_id = ${messageId}`;
    expect(inbox!.count).toBe(1);
  }, 30_000);
});

async function readEventIds(url: string): Promise<string[]> {
  const ids: string[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && ids.length === 0) {
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    for (const message of received.Messages ?? []) {
      ids.push((JSON.parse(message.Body ?? "{}") as { eventId?: string }).eventId ?? "");
      if (message.ReceiptHandle) {
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }));
      }
    }
  }
  return ids;
}

async function waitUntilLeaseExpires(id: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await p.sql<{ published: boolean; locked_until: string | Date | null }[]>`
      select published_at is not null as published, locked_until from outbox_messages where id = ${id}`;
    if (row!.published) throw new Error("the crashed publisher marked the event");
    const until = row!.locked_until ? new Date(row!.locked_until).getTime() : 0;
    if (until <= Date.now()) return;
    await Bun.sleep(100);
  }
  throw new Error("the lease did not expire");
}

async function debits(walletId: string): Promise<number> {
  const [row] = await p.sql<{ count: number }[]>`
    select count(*)::int as count from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
  return row!.count;
}
