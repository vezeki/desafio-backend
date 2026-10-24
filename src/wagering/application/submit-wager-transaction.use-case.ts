import { InboxMessage } from "../../messaging/domain/inbox-message.ts";
import type { Clock } from "../../shared/application/clock.ts";
import { UniqueConstraintConflictError } from "../../shared/application/errors.ts";
import type { IdGenerator } from "../../shared/application/id-generator.ts";
import type { TransactionContext, UnitOfWork } from "../../shared/application/unit-of-work.ts";
import { Money, type MoneyProps } from "../../shared/domain/money.ts";
import type { ReferenceEvaluation } from "../domain/wager-transaction.ts";
import { WagerTransaction, type CreateWagerTransactionProps } from "../domain/wager-transaction.ts";
import type { WagerTransactionKind } from "../domain/wager-transaction-kind.ts";
import { WagerSettlement } from "../domain/wager-settlement.ts";
import { settlementEvents } from "./settlement-events.ts";
import { IdempotencyConflictError } from "./wagering-application-errors.ts";
import { toWagerTransactionView, type WagerTransactionView } from "./wager-transaction-view.ts";

/** Business fields of the request, as received from HTTP or from the queue. */
export interface WagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  request: WagerRequest;
  correlationId: string;
  /** Id of the message that carried the request (SQS), recorded as causation of the events. */
  causationId?: string;
  /** Set when the request came from a queue: the message is recorded in the inbox in the same SQL transaction. */
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitWagerTransactionResult {
  transaction: WagerTransactionView;
  /** True when the outcome was decided by an earlier identical request. */
  idempotentReplay: boolean;
}

/** Unique constraints that mean "this request was already registered" and are resolved as replay or conflict. */
const ALREADY_REGISTERED = new Set(["uq_wtx_idempotency_key", "uq_wtx_provider_external"]);
/** Another reversal of the same reference won the race; running again turns it into REFERENCE_ALREADY_REVERSED. */
const REVERSAL_RACE = "uq_wtx_single_reversal";

export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settlement = new WagerSettlement(),
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const props = this.toProps(command);
    // Validates the contract before opening a transaction: an invalid request is never persisted.
    const { payloadHash } = WagerTransaction.create(props);

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.unitOfWork.run((ctx) => this.process(ctx, command, props));
      } catch (error) {
        if (!(error instanceof UniqueConstraintConflictError)) throw error;
        if (error.constraint === REVERSAL_RACE && attempt === 1) continue;
        if (!error.constraint || !ALREADY_REGISTERED.has(error.constraint)) throw error;

        // A concurrent identical request committed first (no wallet lock serialized us, e.g. unknown wallet).
        const replay = await this.unitOfWork.read((ctx) => this.findReplay(ctx, command.idempotencyKey, props, payloadHash));
        if (replay) return replay;
        throw error;
      }
    }
  }

  private async process(
    ctx: TransactionContext,
    command: SubmitWagerTransactionCommand,
    props: CreateWagerTransactionProps,
  ): Promise<SubmitWagerTransactionResult> {
    // Created inside the work: the unit of work may run it again after a deadlock.
    const transaction = WagerTransaction.create(props);
    const now = this.clock.now();

    if (command.inbox && !(await this.recordInbox(ctx, command.inbox, transaction.payloadHash, now))) {
      const replay = await this.findReplay(ctx, command.idempotencyKey, props, transaction.payloadHash);
      if (replay) return replay;
      throw new Error(`Inbox has message ${command.inbox.messageId} but no transaction for key ${command.idempotencyKey}`);
    }

    // Cheap path for retries: no lock needed to answer a replay.
    const early = await this.findReplay(ctx, command.idempotencyKey, props, transaction.payloadHash);
    if (early) return early;

    const wallet = await ctx.wallets.findByIdForUpdate(transaction.walletId);

    // While we waited for the lock, an identical request may have been committed.
    const afterLock = await this.findReplay(ctx, command.idempotencyKey, props, transaction.payloadHash);
    if (afterLock) return afterLock;

    const settlement = this.settlement.settle({
      transaction,
      wallet,
      reference: await this.evaluateReference(ctx, transaction),
      ledgerEntryId: this.ids.next(),
      now,
    });

    ctx.transactions.add(transaction);
    if (settlement.outcome === "PROCESSED" && settlement.entry && wallet) {
      ctx.wallets.save(wallet);
      ctx.ledger.add(settlement.entry);
    }
    const origin = { correlationId: command.correlationId, causationId: command.causationId, occurredAt: now };
    for (const message of settlementEvents(settlement, transaction, wallet, origin, this.ids)) {
      ctx.outbox.add(message);
    }

    return { transaction: toWagerTransactionView(transaction), idempotentReplay: false };
  }

  private async recordInbox(
    ctx: TransactionContext,
    inbox: { consumerName: string; messageId: string },
    payloadHash: string,
    now: Date,
  ): Promise<boolean> {
    const message = InboxMessage.receive({ ...inbox, payloadHash, receivedAt: now });
    message.markProcessed(now);
    return ctx.inbox.tryRecord(message);
  }

  /**
   * Same key and same payload → the stored result. Same key with another payload, or the same provider
   * transaction under another key → conflict. Nothing registered → undefined.
   */
  private async findReplay(
    ctx: TransactionContext,
    idempotencyKey: string,
    props: CreateWagerTransactionProps,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult | undefined> {
    // Decide on the row found, not on which query found it: an identical request may commit between the two lookups.
    const existing =
      (await ctx.transactions.findByIdempotencyKey(idempotencyKey)) ??
      (await ctx.transactions.findByProviderExternalId(props.providerId, props.externalTransactionId));
    if (!existing) return undefined;

    if (existing.idempotencyKey !== idempotencyKey) {
      throw new IdempotencyConflictError(
        `${props.providerId}/${props.externalTransactionId} was already registered under another Idempotency-Key`,
      );
    }
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(`Idempotency-Key ${idempotencyKey} was already used with a different payload`);
    }
    return { transaction: toWagerTransactionView(existing), idempotentReplay: true };
  }

  private async evaluateReference(ctx: TransactionContext, transaction: WagerTransaction): Promise<ReferenceEvaluation> {
    if (!transaction.referenceExternalTransactionId) return transaction.evaluateReference(undefined);
    const reference = await ctx.transactions.findByProviderExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
    const dependents = reference ? await ctx.transactions.findProcessedDependentKinds(reference.id) : [];
    return transaction.evaluateReference(reference, dependents);
  }

  private toProps(command: SubmitWagerTransactionCommand): CreateWagerTransactionProps {
    const { request } = command;
    return {
      id: this.ids.next(),
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      walletId: request.walletId,
      playerId: request.playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: request.kind as WagerTransactionKind,
      money: Money.from(request.money),
      referenceExternalTransactionId: request.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    };
  }
}
