import type { ConsumeOutcome } from "../../application/consume-wager-message.ts";
import { retryDelaySeconds } from "../../application/consume-wager-message.ts";
import type { ReceivedWagerMessage, WagerQueue } from "../../application/ports/wager-queue.ts";

export interface WagerMessageHandler {
  execute(body: string): Promise<ConsumeOutcome>;
}

export interface WagerConsumerOptions {
  batchSize: number;
  /** How long shutdown waits for a message already being processed before returning it to the queue. */
  shutdownTimeoutMs: number;
  /**
   * Runs after the SQL transaction committed and before the ack.
   * The process-crash test exits here. Production does not set it.
   */
  afterCommit?: () => void;
}

export interface WagerConsumerLog {
  retried(receiveCount: number, reason: string): void;
  deadLettered(reason: string): void;
  failed(error: unknown): void;
}

const SILENT_LOG: WagerConsumerLog = {
  retried() {},
  deadLettered() {},
  failed() {},
};

/**
 * Long-polls the wager queue. Ack happens only after `ConsumeWagerMessage` returns, which is only
 * after the SQL transaction committed. Shutdown stops polling, waits for what is in flight, and
 * gives back anything that did not finish.
 */
export class WagerConsumer {
  private running = false;
  private loopPromise: Promise<void> = Promise.resolve();
  private readonly inflight = new Set<Promise<void>>();
  private readonly inflightHandles = new Set<string>();

  constructor(
    private readonly queue: WagerQueue,
    private readonly handler: WagerMessageHandler,
    private readonly options: WagerConsumerOptions,
    private readonly log: WagerConsumerLog = SILENT_LOG,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop();
  }

  /** One receive, used by tests. Does not start the loop. */
  async pollOnce(): Promise<number> {
    const batch = await this.queue.receive(this.options.batchSize);
    await Promise.all(batch.map((message) => this.track(message)));
    return batch.length;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.queue.stopReceiving();
    await this.loopPromise;
    await Promise.race([Promise.all([...this.inflight]), Bun.sleep(this.options.shutdownTimeoutMs)]);
    await this.giveBack([...this.inflightHandles]);
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let batch: ReceivedWagerMessage[];
      try {
        batch = await this.queue.receive(this.options.batchSize);
      } catch (error) {
        if (!this.running) return;
        this.log.failed(error);
        await Bun.sleep(1_000);
        continue;
      }
      if (!this.running) {
        // Received after shutdown was asked: nothing started, so every receipt goes straight back.
        await this.release(batch.map((message) => message.receiptHandle));
        return;
      }
      for (const message of batch) void this.track(message);
    }
  }

  private track(message: ReceivedWagerMessage): Promise<void> {
    this.inflightHandles.add(message.receiptHandle);
    const work = this.dispatch(message).finally(() => {
      this.inflight.delete(work);
    });
    this.inflight.add(work);
    return work;
  }

  private async dispatch(message: ReceivedWagerMessage): Promise<void> {
    let outcome: ConsumeOutcome;
    try {
      outcome = await this.handler.execute(message.body);
    } catch (error) {
      outcome = { action: "retry", reason: error instanceof Error ? error.message : String(error) };
    }
    // Whoever deletes the handle owns the receipt. stop() may have given it back already.
    if (!this.inflightHandles.delete(message.receiptHandle)) return;
    try {
      if (outcome.action === "ack") {
        this.options.afterCommit?.();
        await this.queue.ack(message.receiptHandle);
      } else if (outcome.action === "dead-letter") {
        this.log.deadLettered(outcome.reason);
        await this.queue.deadLetter(message, outcome.reason);
      } else {
        this.log.retried(message.receiveCount, outcome.reason);
        await this.queue.retry(message.receiptHandle, retryDelaySeconds(message.receiveCount));
      }
    } catch (error) {
      this.log.failed(error);
    }
  }

  /** Returns receipts this loop still owns. A receipt already acked is left alone. */
  private async giveBack(handles: string[]): Promise<void> {
    const owned = handles.filter((handle) => this.inflightHandles.delete(handle));
    await this.release(owned);
  }

  private async release(handles: string[]): Promise<void> {
    await Promise.all(
      handles.map((handle) => this.queue.retry(handle, 0).catch((error: unknown) => this.log.failed(error))),
    );
  }
}
