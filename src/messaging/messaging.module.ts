import { Module } from "@nestjs/common";
import { SQSClient } from "@aws-sdk/client-sqs";
import { APP_CONFIG, type AppConfig } from "../config.ts";
import { CLOCK, type Clock } from "../shared/application/clock.ts";
import { APP_METRICS, type AppMetrics } from "../shared/application/metrics.ts";
import { UNIT_OF_WORK, type UnitOfWork } from "../shared/application/unit-of-work.ts";
import { PublishOutboxUseCase } from "./application/publish-outbox.use-case.ts";
import { SqsIntegrationEventPublisher } from "./infrastructure/sqs/sqs-event-publisher.ts";
import { OutboxPublisherWorker } from "./infrastructure/workers/outbox-publisher.worker.ts";

@Module({
  providers: [
    {
      provide: PublishOutboxUseCase,
      inject: [UNIT_OF_WORK, CLOCK, SQSClient, APP_CONFIG, APP_METRICS],
      useFactory: (unitOfWork: UnitOfWork, clock: Clock, sqs: SQSClient, config: AppConfig, metrics: AppMetrics) =>
        new PublishOutboxUseCase(
          unitOfWork,
          clock,
          new SqsIntegrationEventPublisher(sqs, config.SQS_EVENTS_QUEUE_NAME),
          config.INSTANCE_ID,
          config.OUTBOX_LEASE_MS,
          () => {},
          metrics,
        ),
    },
    OutboxPublisherWorker,
  ],
  exports: [PublishOutboxUseCase],
})
export class MessagingModule {}