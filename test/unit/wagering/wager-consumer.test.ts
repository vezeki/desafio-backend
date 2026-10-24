import { describe, expect, test } from "bun:test";
import type { ConsumeOutcome } from "../../../src/wagering/application/consume-wager-message.ts";
import type { ReceivedWagerMessage, WagerQueue } from "../../../src/wagering/application/ports/wager-queue.ts";
import { WagerConsumer } from "../../../src/wagering/infrastructure/workers/wager-consumer.ts";

class FakeQueue implements WagerQueue {
  readonly acked: string[] = [];
  readonly retried: { handle: string; delay: number }[] = [];
  private calls = 0;
  private blocked: ((messages: ReceivedWagerMessage[]) => void) | undefined;
  hold: ((messages: ReceivedWagerMessage[]) => void) | undefined;

  constructor(private readonly first: ReceivedWagerMessage[] | "hold") {}

  receive(): Promise<ReceivedWagerMessage[]> {
    this.calls += 1;
    if (this.calls === 1 && this.first !== "hold") return Promise.resolve(this.first);
    if (this.calls === 1) return new Promise((resolve) => (this.hold = resolve));
    return new Promise((resolve) => (this.blocked = resolve));
  }

  async ack(receiptHandle: string): Promise<void> {
    this.acked.push(receiptHandle);
  }

  async retry(receiptHandle: string, delaySeconds: number): Promise<void> {
    this.retried.push({ handle: receiptHandle, delay: delaySeconds });
  }

  async deadLetter(): Promise<void> {}

  stopReceiving(): void {
    this.blocked?.([]);
    this.blocked = undefined;
  }
}

function message(receiveCount = 1): ReceivedWagerMessage {
  return { sqsMessageId: "sqs-1", receiptHandle: "rh-1", receiveCount, body: "{}" };
}

describe("WagerConsumer shutdown", () => {
  test("a message still running when the timeout hits goes back to the queue", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => (started = resolve));
    const queue = new FakeQueue([message()]);
    const consumer = new WagerConsumer(
      queue,
      {
        async execute(): Promise<ConsumeOutcome> {
          started();
          await gate;
          return { action: "ack" };
        },
      },
      { batchSize: 1, shutdownTimeoutMs: 30 },
    );

    consumer.start();
    await startedPromise;
    try {
      await consumer.stop();
      expect(queue.retried).toEqual([{ handle: "rh-1", delay: 0 }]);
      expect(queue.acked).toEqual([]);
    } finally {
      release();
    }
  });

  test("a retry that already finished is not sent back again on stop", async () => {
    const queue = new FakeQueue([message(3)]);
    let acked!: () => void;
    const ackedPromise = new Promise<void>((resolve) => (acked = resolve));
    const consumer = new WagerConsumer(
      queue,
      { execute: async () => ({ action: "retry", reason: "db down" }) },
      { batchSize: 1, shutdownTimeoutMs: 30 },
    );
    const retry = queue.retry.bind(queue);
    queue.retry = async (handle, delay) => {
      await retry(handle, delay);
      acked();
    };

    consumer.start();
    await ackedPromise;
    await consumer.stop();

    expect(queue.retried).toEqual([{ handle: "rh-1", delay: 4 }]);
  });

  test("a batch that arrives after stop was asked is returned without being handled", async () => {
    const queue = new FakeQueue("hold");
    let handled = false;
    const consumer = new WagerConsumer(
      queue,
      {
        execute: async () => {
          handled = true;
          return { action: "ack" };
        },
      },
      { batchSize: 1, shutdownTimeoutMs: 30 },
    );

    consumer.start();
    const stopping = consumer.stop();
    queue.hold?.([message()]);
    await stopping;

    expect(handled).toBe(false);
    expect(queue.retried).toEqual([{ handle: "rh-1", delay: 0 }]);
    expect(queue.acked).toEqual([]);
  });
});
