export interface ReceivedWagerMessage {
  /** Stable id assigned by SQS. Used as the DLQ deduplication id. */
  sqsMessageId: string;
  receiptHandle: string;
  receiveCount: number;
  body: string;
  /** FIFO group, usually the wallet id. Absent when the broker did not return it. */
  messageGroupId?: string;
}

export interface WagerQueue {
  receive(limit: number): Promise<ReceivedWagerMessage[]>;
  /** Delete the message. Called only after the outcome was committed. */
  ack(receiptHandle: string): Promise<void>;
  /** Make the message visible again after `delaySeconds` (0 returns it immediately). */
  retry(receiptHandle: string, delaySeconds: number): Promise<void>;
  /** Copy the message to the dead-letter queue and delete it from the source. */
  deadLetter(message: ReceivedWagerMessage, reason: string): Promise<void>;
  /** Abort a long poll so shutdown does not wait for it. */
  stopReceiving(): void;
}
