export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/** Record of a message consumed from a queue. Unique per (consumerName, messageId). */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const field of ["messageId", "consumerName", "payloadHash"] as const) {
      if (!props[field]) throw new Error(`Inbox message requires ${field}`);
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, new Date(props.receivedAt));
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt && new Date(state.processedAt),
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Same messageId with a different body means the producer reused an id: worth an alert, never a reprocess. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new Error(`Inbox message ${this.consumerName}/${this.messageId} was already processed`);
    }
    this._processedAt = new Date(at);
  }
}
