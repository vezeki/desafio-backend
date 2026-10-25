import { SQSClient } from "@aws-sdk/client-sqs";
import { loadConfig } from "../../src/config.ts";
import { PublishOutboxUseCase } from "../../src/messaging/application/publish-outbox.use-case.ts";
import { SqsIntegrationEventPublisher } from "../../src/messaging/infrastructure/sqs/sqs-event-publisher.ts";
import { ConsumeWagerMessage } from "../../src/wagering/application/consume-wager-message.ts";
import { SubmitWagerTransactionUseCase } from "../../src/wagering/application/submit-wager-transaction.use-case.ts";
import { SqsWagerQueue } from "../../src/wagering/infrastructure/sqs/sqs-wager-queue.ts";
import { WagerConsumer } from "../../src/wagering/infrastructure/workers/wager-consumer.ts";
import { createTestPersistence } from "../support/orm.ts";

/**
 * One short-lived process for the crash and multi-instance tests.
 * `CRASH_AT=after-commit` exits after the wager transaction commits and before the ack.
 * `CRASH_AT=after-publish` exits after SQS accepts the event and before `published_at` is set.
 */
const crashAt = process.env.CRASH_AT;

function crash(point: "after-commit" | "after-publish"): void {
  if (crashAt !== point) return;
  process.stdout.write(`crash ${point}\n`);
  process.exit(42);
}

const persistence = await createTestPersistence({ databaseUrl: loadConfig().DATABASE_URL });

try {
  if (process.env.ROLE === "publish") await publish();
  else if (process.env.ROLE === "consume") await consume();
  else throw new Error(`unknown ROLE ${process.env.ROLE}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await persistence.close();
}

async function publish(): Promise<void> {
  const config = loadConfig();
  const sqs = new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
  try {
    const tick = await new PublishOutboxUseCase(
      persistence.unitOfWork,
      persistence.clock,
      new SqsIntegrationEventPublisher(sqs, config.SQS_EVENTS_QUEUE_NAME),
      config.INSTANCE_ID,
      config.OUTBOX_LEASE_MS,
      () => crash("after-publish"),
    ).execute(config.OUTBOX_BATCH_SIZE);
    process.stdout.write(`published ${tick.published} claimed ${tick.claimed}\n`);
  } finally {
    sqs.destroy();
  }
}

async function consume(): Promise<void> {
  const config = loadConfig();
  const sqs = new SQSClient({
    region: config.AWS_REGION,
    endpoint: config.AWS_ENDPOINT_URL,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
  const consumer = new WagerConsumer(
    new SqsWagerQueue(sqs, config.SQS_WAGER_QUEUE_NAME, config.SQS_WAGER_DLQ_NAME, {
      waitSeconds: config.WAGER_CONSUMER_WAIT_SECONDS,
      visibilitySeconds: config.WAGER_CONSUMER_VISIBILITY_SECONDS,
    }),
    new ConsumeWagerMessage(new SubmitWagerTransactionUseCase(persistence.unitOfWork, persistence.ids, persistence.clock)),
    {
      batchSize: config.WAGER_CONSUMER_BATCH_SIZE,
      shutdownTimeoutMs: config.WAGER_CONSUMER_SHUTDOWN_TIMEOUT_MS,
      afterCommit: () => crash("after-commit"),
    },
  );
  const maxMessages = Number(process.env.MAX_MESSAGES ?? "20");
  const maxEmpty = Number(process.env.MAX_EMPTY ?? "4");
  let handled = 0;
  let empty = 0;
  try {
    while (handled < maxMessages && empty < maxEmpty) {
      const received = await consumer.pollOnce();
      if (received === 0) empty += 1;
      else {
        handled += received;
        empty = 0;
      }
    }
    process.stdout.write(`handled ${handled} ${config.INSTANCE_ID}\n`);
  } finally {
    sqs.destroy();
  }
}
