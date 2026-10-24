import { UniqueConstraintConflictError, TransientInfrastructureError } from "../../shared/application/errors.ts";
import { InvalidMoneyError } from "../../shared/domain/domain-error.ts";
import { InvalidWagerTransactionError } from "../domain/wagering-errors.ts";
import { IdempotencyConflictError } from "./wagering-application-errors.ts";
import type { SubmitWagerTransactionCommand, SubmitWagerTransactionResult } from "./submit-wager-transaction.use-case.ts";
import { parseWagerMessage, WAGER_CONSUMER_NAME } from "./wager-message.ts";

export type ConsumeOutcome =
  /** The outcome is durable (processed, rejected or waiting). The message must be deleted. */
  | { action: "ack" }
  /** Try again later. The queue's redrive policy dead-letters it after the receive limit. */
  | { action: "retry"; reason: string }
  /** The message can never succeed. Copy it to the DLQ and delete it. */
  | { action: "dead-letter"; reason: string };

export interface WagerSubmitter {
  execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult>;
}

const PERMANENT = [InvalidMoneyError, InvalidWagerTransactionError, IdempotencyConflictError];

/**
 * One queue message, through the same use case as HTTP.
 * The inbox row is written in that use case's SQL transaction, so a crash before the commit
 * leaves no trace and the redelivery is processed normally.
 */
export class ConsumeWagerMessage {
  constructor(private readonly submit: WagerSubmitter) {}

  async execute(body: string): Promise<ConsumeOutcome> {
    const parsed = parseWagerMessage(body);
    if (!parsed.ok) return { action: "dead-letter", reason: parsed.reason };

    try {
      await this.submit.execute({
        idempotencyKey: parsed.message.idempotencyKey,
        request: parsed.message.request,
        correlationId: parsed.message.messageId,
        causationId: parsed.message.messageId,
        inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: parsed.message.messageId },
      });
      return { action: "ack" };
    } catch (error) {
      if (PERMANENT.some((type) => error instanceof type)) {
        return { action: "dead-letter", reason: error instanceof Error ? error.message : String(error) };
      }
      if (error instanceof TransientInfrastructureError || error instanceof UniqueConstraintConflictError) {
        return { action: "retry", reason: error.message };
      }
      // An unexpected error might be a bug or a blip. Retrying lets the redrive policy decide.
      return { action: "retry", reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** Delay before a failed message becomes visible again. Capped so a poison retry does not wait hours. */
export function retryDelaySeconds(receiveCount: number): number {
  const attempt = Math.max(1, Math.trunc(receiveCount));
  return Math.min(2 ** (attempt - 1), 60);
}
