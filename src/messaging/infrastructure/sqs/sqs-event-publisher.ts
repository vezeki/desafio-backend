import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { IntegrationEventPublisher } from "../../application/ports/event-publisher.ts";
import type { OutboxMessage } from "../../domain/outbox-message.ts";

/**
 * FIFO send. `MessageGroupId` is the aggregate, so one wallet stays ordered.
 * `MessageDeduplicationId` is the event id: a republish inside SQS's 5-minute window is dropped.
 * That window is an optimization — the consumer still dedupes by eventId, which is the real guarantee.
 */
export class SqsIntegrationEventPublisher implements IntegrationEventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then((response) => {
        if (!response.QueueUrl) throw new Error(`queue ${this.queueName} has no url`);
        return response.QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }
}
