import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { ReceivedWagerMessage, WagerQueue } from "../../application/ports/wager-queue.ts";

export interface SqsWagerQueueOptions {
  waitSeconds: number;
  visibilitySeconds: number;
}

export class SqsWagerQueue implements WagerQueue {
  private sourceUrl: Promise<string> | undefined;
  private dlqUrl: Promise<string> | undefined;
  private abort = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    private readonly sourceQueueName: string,
    private readonly dlqName: string,
    private readonly options: SqsWagerQueueOptions,
  ) {}

  async receive(limit: number): Promise<ReceivedWagerMessage[]> {
    const signal = this.abort.signal;
    try {
      const response = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: await this.queueUrl(this.sourceQueueName, "source"),
          MaxNumberOfMessages: Math.min(10, Math.max(1, limit)),
          WaitTimeSeconds: this.options.waitSeconds,
          VisibilityTimeout: this.options.visibilitySeconds,
          MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
        }),
        { abortSignal: signal },
      );
      return (response.Messages ?? []).flatMap((message) => {
        if (!message.ReceiptHandle || !message.MessageId) return [];
        const group = message.Attributes?.MessageGroupId;
        return [
          {
            sqsMessageId: message.MessageId,
            receiptHandle: message.ReceiptHandle,
            receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? "1") || 1,
            body: message.Body ?? "",
            ...(group ? { messageGroupId: group } : {}),
          },
        ];
      });
    } catch (error) {
      if (signal.aborted) return [];
      throw error;
    }
  }

  async ack(receiptHandle: string): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: await this.queueUrl(this.sourceQueueName, "source"), ReceiptHandle: receiptHandle }),
    );
  }

  async retry(receiptHandle: string, delaySeconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(this.sourceQueueName, "source"),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.trunc(delaySeconds)),
      }),
    );
  }

  async deadLetter(message: ReceivedWagerMessage, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(this.dlqName, "dlq"),
        MessageBody: JSON.stringify({ reason: reason.slice(0, 1000), body: message.body }),
        MessageGroupId: message.messageGroupId ?? "poison",
        MessageDeduplicationId: message.sqsMessageId,
      }),
    );
    await this.ack(message.receiptHandle);
  }

  stopReceiving(): void {
    this.abort.abort();
    this.abort = new AbortController();
  }

  private queueUrl(name: string, which: "source" | "dlq"): Promise<string> {
    const current = which === "source" ? this.sourceUrl : this.dlqUrl;
    if (current) return current;
    const resolving = this.sqs
      .send(new GetQueueUrlCommand({ QueueName: name }))
      .then((response) => {
        if (!response.QueueUrl) throw new Error(`queue ${name} has no url`);
        return response.QueueUrl;
      })
      .catch((error: unknown) => {
        if (which === "source") this.sourceUrl = undefined;
        else this.dlqUrl = undefined;
        throw error;
      });
    if (which === "source") this.sourceUrl = resolving;
    else this.dlqUrl = resolving;
    return resolving;
  }
}
