import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { PublishOutboxUseCase } from "../../../src/messaging/application/publish-outbox.use-case.ts";
import type { IntegrationEventPublisher } from "../../../src/messaging/application/ports/event-publisher.ts";
import { OutboxMessage } from "../../../src/messaging/domain/outbox-message.ts";
import { SqsIntegrationEventPublisher } from "../../../src/messaging/infrastructure/sqs/sqs-event-publisher.ts";
import { loadConfig } from "../../../src/config.ts";
import { AdjustableClock } from "../../support/clock.ts";
import { createTestPersistence, type TestPersistence } from "../../support/orm.ts";

let p: TestPersistence;
let day = 0;

beforeAll(async () => {
  p = await createTestPersistence();
});

afterAll(async () => {
  await p.close();
});

/** One calendar day per test, in the past, so rows from the rest of the suite (dated today) are not due. */
function newClock(): AdjustableClock {
  return new AdjustableClock(new Date(Date.UTC(2020, 0, ++day)));
}

/** Only rows this file created: other tests insert outbox rows dated today, and those must keep their schedule. */
async function parkOurLeftovers(): Promise<void> {
  await p.sql`
    update outbox_messages
    set next_attempt_at = '2999-01-01T00:00:00Z', locked_until = null, locked_by = null
    where published_at is null and next_attempt_at < '2021-01-01T00:00:00Z'`;
}

class RecordingPublisher implements IntegrationEventPublisher {
  readonly sent: string[] = [];
  readonly fail = new Set<string>();

  async publish(message: OutboxMessage): Promise<void> {
    if (this.fail.has(message.id)) throw new Error("sqs down");
    this.sent.push(message.id);
  }
}

function publisherFor(clock: AdjustableClock, publisher: IntegrationEventPublisher, instanceId: string) {
  return new PublishOutboxUseCase(p.unitOfWork, clock, publisher, instanceId, 30_000);
}

async function enqueue(clock: AdjustableClock, aggregateId = p.ids.next()): Promise<string> {
  const id = p.ids.next();
  const occurredAt = clock.now();
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
          correlationId: "test",
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
  return id;
}

async function rowOf(id: string) {
  const [row] = await p.sql`
    select published_at is not null as published, attempts, locked_by, last_error
    from outbox_messages where id = ${id}`;
  return row as { published: boolean; attempts: number; locked_by: string | null; last_error: string | null };
}

describe("PublishOutboxUseCase", () => {
  test("a claimed event is published and then marked, so the next tick leaves it alone", async () => {
    await parkOurLeftovers();
    const clock = newClock();
    const id = await enqueue(clock);
    const recording = new RecordingPublisher();

    expect(await publisherFor(clock, recording, "instance-a").execute(10)).toMatchObject({ published: 1, failed: 0 });
    expect(recording.sent).toEqual([id]);
    expect(await rowOf(id)).toMatchObject({ published: true, attempts: 0, locked_by: null });

    expect(await publisherFor(clock, recording, "instance-a").execute(10)).toMatchObject({ claimed: 0 });
  });

  test("events of one aggregate go out in the order they happened", async () => {
    await parkOurLeftovers();
    const clock = newClock();
    const aggregateId = p.ids.next();
    const first = await enqueue(clock, aggregateId);
    clock.advance(1_000);
    const second = await enqueue(clock, aggregateId);
    const recording = new RecordingPublisher();

    await publisherFor(clock, recording, "instance-a").execute(10);

    expect(recording.sent).toEqual([first, second]);
  });

  test("a failed send holds back the later events of the same aggregate", async () => {
    await parkOurLeftovers();
    const clock = newClock();
    const aggregateId = p.ids.next();
    const first = await enqueue(clock, aggregateId);
    clock.advance(1_000);
    const second = await enqueue(clock, aggregateId);
    const recording = new RecordingPublisher();
    recording.fail.add(first);

    expect(await publisherFor(clock, recording, "instance-a").execute(10)).toMatchObject({ claimed: 2, published: 0, failed: 1 });
    expect(recording.sent).toEqual([]);

    const rows = await p.sql`
      select id, attempts, next_attempt_at from outbox_messages
      where id = ${first} or id = ${second} order by occurred_at`;
    expect(rows.map((row: { attempts: number }) => row.attempts)).toEqual([1, 0]);
    expect(rows[0].next_attempt_at.toISOString()).toBe(rows[1].next_attempt_at.toISOString());
  });

  test("a failed aggregate does not hold back a different one", async () => {
    await parkOurLeftovers();
    const clock = newClock();
    const failed = await enqueue(clock);
    const other = await enqueue(clock);
    const recording = new RecordingPublisher();
    recording.fail.add(failed);

    await publisherFor(clock, recording, "instance-a").execute(10);

    expect(recording.sent).toEqual([other]);
    expect((await rowOf(other)).published).toBe(true);
    expect((await rowOf(failed)).published).toBe(false);
  });

  test("a failed send is rescheduled and published once the backoff has passed", async () => {
    await parkOurLeftovers();
    const clock = newClock();
    const id = await enqueue(clock);
    const recording = new RecordingPublisher();
    recording.fail.add(id);

    expect(await publisherFor(clock, recording, "instance-a").execute(10)).toMatchObject({ claimed: 1, published: 0, failed: 1 });
    expect(await rowOf(id)).toMatchObject({ published: false, attempts: 1, locked_by: null, last_error: "sqs down" });

    recording.fail.delete(id);
    expect((await publisherFor(clock, recording, "instance-a").execute(10)).claimed).toBe(0);

    clock.advance(1_000);
    expect(await publisherFor(clock, recording, "instance-a").execute(10)).toMatchObject({ published: 1 });
    expect(recording.sent).toEqual([id]);
    expect((await rowOf(id)).published).toBe(true);
  });

  test("a publisher that dies holding the lease loses it, and another instance publishes", async () => {
    await parkOurLeftovers();
    const clock = newClock();
    const id = await enqueue(clock);
    await p.unitOfWork.run(async (ctx) => {
      await ctx.outbox.claimDue(clock.now(), new Date(clock.now().getTime() + 1_000), "dead-instance", 10);
    });
    expect((await rowOf(id)).locked_by).toBe("dead-instance");

    const recording = new RecordingPublisher();
    expect((await publisherFor(clock, recording, "instance-b").execute(10)).claimed).toBe(0);

    clock.advance(1_001);
    expect(await publisherFor(clock, recording, "instance-b").execute(10)).toMatchObject({ published: 1 });
    expect(recording.sent).toEqual([id]);
    expect((await rowOf(id)).published).toBe(true);
  });

  test("two publishers share the outbox and each event is sent once", async () => {
    await parkOurLeftovers();
    const clock = newClock();
    const ids = await Promise.all(Array.from({ length: 12 }, () => enqueue(clock)));
    const recording = new RecordingPublisher();

    await Promise.all([
      publisherFor(clock, recording, "instance-a").execute(50),
      publisherFor(clock, recording, "instance-b").execute(50),
    ]);

    for (const id of ids) {
      expect(recording.sent.filter((sent) => sent === id)).toEqual([id]);
      expect((await rowOf(id)).published).toBe(true);
    }
  });
});

describe("SqsIntegrationEventPublisher", () => {
  test("the committed envelope arrives on the FIFO queue exactly once", async () => {
    await parkOurLeftovers();
    const config = loadConfig();
    const sqs = new SQSClient({
      region: config.AWS_REGION,
      endpoint: config.AWS_ENDPOINT_URL,
      credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
    });
    const queueName = "integration-events-test.fifo";
    await sqs.send(new CreateQueueCommand({ QueueName: queueName, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } }));

    const clock = newClock();
    const id = await enqueue(clock);
    const useCase = new PublishOutboxUseCase(p.unitOfWork, clock, new SqsIntegrationEventPublisher(sqs, queueName), "instance-sqs", 30_000);
    expect(await useCase.execute(10)).toMatchObject({ published: 1 });

    const queueUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl!;
    const bodies: { eventId?: string }[] = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !bodies.some((body) => body.eventId === id)) {
      const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      for (const message of received.Messages ?? []) {
        bodies.push(JSON.parse(message.Body ?? "{}"));
        await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
      }
    }

    expect(bodies.filter((body) => body.eventId === id)).toHaveLength(1);
    expect((await rowOf(id)).published).toBe(true);
    sqs.destroy();
  }, 20_000);
});
