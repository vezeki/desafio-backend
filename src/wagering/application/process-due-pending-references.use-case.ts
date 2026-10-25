import type { Clock } from "../../shared/application/clock.ts";
import { UniqueConstraintConflictError } from "../../shared/application/errors.ts";
import type { IdGenerator } from "../../shared/application/id-generator.ts";
import { noopMetrics, type AppMetrics } from "../../shared/application/metrics.ts";
import type { TransactionContext, UnitOfWork } from "../../shared/application/unit-of-work.ts";
import type { WagerTransaction } from "../domain/wager-transaction.ts";
import { WagerSettlement } from "../domain/wager-settlement.ts";
import { persistSettlement, resolveReference } from "./settlement-persistence.ts";
import { toWagerTransactionView, type WagerTransactionView } from "./wager-transaction-view.ts";

export const DEFAULT_PENDING_REFERENCE_BATCH = 20;

/** Another reversal of the same reference committed first; a retry sees REFERENCE_ALREADY_REVERSED. */
const REVERSAL_RACE = "uq_wtx_single_reversal";

export interface PendingReferenceTick {
  claimed: number;
  processed: number;
  rejected: number;
  stillWaiting: number;
}

export interface PendingReferenceOutcome {
  transaction: WagerTransactionView;
  outcome: "PROCESSED" | "REJECTED" | "PENDING_REFERENCE";
}

/**
 * Picks up `PENDING_REFERENCE` rows whose `nextRetryAt` has passed, one SQL transaction per row.
 * `FOR UPDATE SKIP LOCKED` lets several instances share the work without claiming the same row.
 */
export class ProcessDuePendingReferencesUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settlement = new WagerSettlement(),
    private readonly metrics: AppMetrics = noopMetrics,
  ) {}

  async execute(limit = DEFAULT_PENDING_REFERENCE_BATCH): Promise<PendingReferenceTick> {
    const tick: PendingReferenceTick = { claimed: 0, processed: 0, rejected: 0, stillWaiting: 0 };
    for (let i = 0; i < limit; i++) {
      const result = await this.processNext();
      if (!result) break;
      tick.claimed += 1;
      if (result.outcome === "PROCESSED") tick.processed += 1;
      else if (result.outcome === "REJECTED") tick.rejected += 1;
      else tick.stillWaiting += 1;
    }
    return tick;
  }

  private async processNext(): Promise<PendingReferenceOutcome | undefined> {
    for (let attempt = 1; ; attempt++) {
      const started = performance.now();
      try {
        const outcome = await this.unitOfWork.run((ctx) => this.claimAndSettle(ctx));
        if (outcome) this.record(outcome, (performance.now() - started) / 1000);
        return outcome;
      } catch (error) {
        if (error instanceof UniqueConstraintConflictError && error.constraint === REVERSAL_RACE && attempt === 1) {
          continue;
        }
        throw error;
      }
    }
  }

  private async claimAndSettle(ctx: TransactionContext): Promise<PendingReferenceOutcome | undefined> {
    const now = this.clock.now();
    const [transaction] = await ctx.transactions.claimDuePendingReferences(now, 1);
    if (!transaction) return undefined;
    return this.settleClaimed(ctx, transaction, now);
  }

  private async settleClaimed(
    ctx: TransactionContext,
    transaction: WagerTransaction,
    now: Date,
  ): Promise<PendingReferenceOutcome> {
    const wallet = await ctx.wallets.findByIdForUpdate(transaction.walletId);
    const settlement = this.settlement.settle({
      transaction,
      wallet,
      reference: await resolveReference(ctx, transaction),
      ledgerEntryId: this.ids.next(),
      now,
    });
    persistSettlement(
      ctx,
      settlement,
      transaction,
      wallet,
      "save",
      {
        correlationId: `pending-reference:${transaction.id}`,
        causationId: transaction.id,
        occurredAt: now,
      },
      this.ids,
    );
    return { transaction: toWagerTransactionView(transaction), outcome: settlement.outcome };
  }

  /** A row that is still waiting was already counted when it was first stored. This tick only retries it. */
  private record(outcome: PendingReferenceOutcome, seconds: number): void {
    this.metrics.observeProcessing(seconds);
    if (outcome.outcome === "PENDING_REFERENCE") this.metrics.retry("pending_reference");
    else this.metrics.transactionSettled(outcome.transaction.kind, outcome.outcome);
  }
}
