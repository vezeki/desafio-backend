import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { APP_CONFIG, type AppConfig } from "../../../config.ts";
import { APP_METRICS, type AppMetrics } from "../../../shared/application/metrics.ts";
import { ConsumeWagerMessage } from "../../application/consume-wager-message.ts";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case.ts";
import { SqsWagerQueue } from "../sqs/sqs-wager-queue.ts";
import { WagerConsumer } from "./wager-consumer.ts";

@Injectable()
export class WagerConsumerWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WagerConsumerWorker.name);
  private consumer: WagerConsumer | undefined;

  constructor(
    @Inject(SubmitWagerTransactionUseCase) private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(APP_METRICS) private readonly metrics: AppMetrics,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.WORKERS_ENABLED) return;
    this.consumer = new WagerConsumer(
      new SqsWagerQueue(this.sqs, this.config.SQS_WAGER_QUEUE_NAME, this.config.SQS_WAGER_DLQ_NAME, {
        waitSeconds: this.config.WAGER_CONSUMER_WAIT_SECONDS,
        visibilitySeconds: this.config.WAGER_CONSUMER_VISIBILITY_SECONDS,
      }),
      new ConsumeWagerMessage(this.submit),
      {
        batchSize: this.config.WAGER_CONSUMER_BATCH_SIZE,
        shutdownTimeoutMs: this.config.WAGER_CONSUMER_SHUTDOWN_TIMEOUT_MS,
      },
      {
        retried: (receiveCount, reason) => {
          this.metrics.retry("sqs_visibility");
          this.logger.warn({ receiveCount, reason }, "wager message will be retried");
        },
        deadLettered: (reason) => {
          this.metrics.deadLetter();
          this.logger.error({ reason }, "wager message sent to the dead-letter queue");
        },
        failed: (error) => this.logger.error({ err: error }, "wager consumer failed"),
      },
    );
    this.logger.log({ queue: this.config.SQS_WAGER_QUEUE_NAME }, "wager consumer started");
    this.consumer.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.stop();
    if (this.consumer) this.logger.log("wager consumer stopped");
  }
}
