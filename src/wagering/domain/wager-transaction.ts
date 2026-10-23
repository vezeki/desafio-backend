import type { Money } from "../../shared/domain/money.ts";
import { invertDirection, LedgerDirection } from "../../wallet/domain/ledger-direction.ts";
import { FailureCode } from "./failure-code.ts";
import { hashWagerPayload } from "./payload-hash.ts";
import { WagerTransactionKind } from "./wager-transaction-kind.ts";
import { TERMINAL_STATUSES, WagerTransactionStatus } from "./wager-transaction-status.ts";
import { InvalidTransactionStateError, InvalidWagerTransactionError } from "./wagering-errors.ts";

export const INTERNAL_PROVIDER_ID = "internal";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  payloadHash: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** Wallet balance observed when the transaction reached a terminal state; returned on replays. */
  balanceAfter?: Money;
  /** Moment the transaction reached a terminal state. */
  processedAt?: Date;
  /** How many times the missing reference was looked up. */
  referenceAttempts: number;
  nextRetryAt?: Date;
}

export type ReferenceEvaluation =
  | { outcome: "NOT_APPLICABLE" }
  | { outcome: "MISSING" }
  | { outcome: "WAITING" }
  | { outcome: "USABLE"; reference: WagerTransaction }
  | { outcome: "INVALID"; failureCode: FailureCode; reason: string };

const REQUIRES_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Kinds each operation may reference. WIN and LOSS may optionally point to the BET of the round. */
const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>>> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  /** Provider-side id of the referenced transaction — not the internal id. */
  readonly referenceExternalTransactionId: string | undefined;
  readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _balanceAfter: Money | undefined;
  private _processedAt: Date | undefined;
  private _referenceAttempts: number;
  private _nextRetryAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = new Date(state.createdAt);
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._balanceAfter = state.balanceAfter;
    this._processedAt = state.processedAt && new Date(state.processedAt);
    this._referenceAttempts = state.referenceAttempts;
    this._nextRetryAt = state.nextRetryAt && new Date(state.nextRetryAt);
  }

  /** Provider-submitted transaction. Starts as PENDING. Throws InvalidWagerTransactionError for invalid contracts. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(FailureCode.KindNotAllowed, "OPENING is internal and cannot be submitted");
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError(FailureCode.ValidationError, `unknown kind "${String(props.kind)}"`);
    }
    WagerTransaction.assertRequiredFields(props);
    WagerTransaction.assertAmount(props.kind, props.money);
    WagerTransaction.assertReferenceRules(props);
    return WagerTransaction.pending(props);
  }

  /** Internal credit that justifies a wallet's initial balance. Already PROCESSED. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(FailureCode.ValidationError, "OPENING amount must be positive");
    }
    const externalId = `opening:${props.walletId}`;
    const transaction = WagerTransaction.pending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalId}`,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: externalId,
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.createdAt,
    });
    transaction.markProcessed(undefined, props.createdAt, props.money);
    return transaction;
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt);
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt && new Date(this._nextRetryAt);
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, at: Date, balanceAfter: Money): void {
    this.assertNotTerminal("markProcessed");
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(this.id, this._status, "markProcessed without its reference");
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = new Date(at);
    this._nextRetryAt = undefined;
  }

  /** Records one more failed lookup of the reference and schedules the next one. */
  markPendingReference(nextRetryAt: Date): void {
    this.assertNotTerminal("markPendingReference");
    if (!this.referenceExternalTransactionId) {
      throw new InvalidTransactionStateError(this.id, this._status, "wait for a reference it does not have");
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;
    this._nextRetryAt = new Date(nextRetryAt);
  }

  reject(code: FailureCode, at: Date, balanceObserved?: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceObserved;
    this._processedAt = new Date(at);
    this._nextRetryAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date(at);
    this._nextRetryAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REQUIRES_REFERENCE.has(this.kind);
  }

  isReversal(): boolean {
    return REQUIRES_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** ROLLBACK inverts the direction of the transaction it reverts; the others have a fixed direction. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        if (!reference) {
          throw new InvalidTransactionStateError(this.id, this._status, "resolve a ROLLBACK direction without reference");
        }
        return invertDirection(reference.ledgerDirectionFor());
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(this.id, this._status, "produce a ledger entry for LOSS");
    }
  }

  /**
   * Decides whether the resolved reference can be used.
   * @param reference transaction found by (providerId, referenceExternalTransactionId), if any
   * @param processedDependentKinds kinds of PROCESSED transactions that already reference it
   */
  evaluateReference(
    reference: WagerTransaction | undefined,
    processedDependentKinds: readonly WagerTransactionKind[] = [],
  ): ReferenceEvaluation {
    if (!this.referenceExternalTransactionId) return { outcome: "NOT_APPLICABLE" };
    if (!reference) return { outcome: "MISSING" };

    const invalid = (failureCode: FailureCode, reason: string): ReferenceEvaluation => ({
      outcome: "INVALID",
      failureCode,
      reason,
    });

    const mismatch = this.findReferenceMismatch(reference);
    if (mismatch) return invalid(FailureCode.ReferenceMismatch, `reference has a different ${mismatch}`);

    if (!ALLOWED_REFERENCE_KINDS[this.kind]?.has(reference.kind)) {
      return invalid(FailureCode.ReferenceKindNotAllowed, `${this.kind} cannot reference ${reference.kind}`);
    }

    if (reference.status === WagerTransactionStatus.Rejected || reference.status === WagerTransactionStatus.Failed) {
      return invalid(FailureCode.ReferenceNotProcessed, `reference is ${reference.status}`);
    }
    if (reference.status !== WagerTransactionStatus.Processed) return { outcome: "WAITING" };

    if (this.isReversal() && !this.money.equals(reference.money)) {
      return invalid(FailureCode.AmountMismatch, `expected ${reference.money}, received ${this.money}`);
    }

    const alreadyReversed = processedDependentKinds.some((kind) => REQUIRES_REFERENCE.has(kind));
    if (alreadyReversed) {
      return invalid(FailureCode.ReferenceAlreadyReversed, "reference was already reverted");
    }

    return { outcome: "USABLE", reference };
  }

  private findReferenceMismatch(reference: WagerTransaction): string | undefined {
    if (reference.providerId !== this.providerId) return "provider";
    if (reference.playerId !== this.playerId) return "player";
    if (reference.walletId !== this.walletId) return "wallet";
    if (reference.money.currency !== this.money.currency) return "currency";
    if (reference.roundId !== this.roundId) return "round";
    return undefined;
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, transition);
    }
  }

  private static pending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction({
      ...props,
      payloadHash: hashWagerPayload({ ...props, money: props.money.toJSON() }),
      status: WagerTransactionStatus.Pending,
      referenceAttempts: 0,
    });
  }

  private static assertRequiredFields(props: CreateWagerTransactionProps): void {
    const required = [
      "id",
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "walletId",
      "playerId",
      "roundId",
      "gameId",
    ] as const;
    for (const field of required) {
      if (typeof props[field] !== "string" || props[field].trim() === "") {
        throw new InvalidWagerTransactionError(FailureCode.ValidationError, `${field} is required`);
      }
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(FailureCode.ValidationError, `providerId "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
  }

  private static assertAmount(kind: WagerTransactionKind, money: Money): void {
    if (money.isNegative()) {
      throw new InvalidWagerTransactionError(FailureCode.ValidationError, "amount cannot be negative");
    }
    if (kind !== WagerTransactionKind.Loss && money.isZero()) {
      throw new InvalidWagerTransactionError(FailureCode.ValidationError, `${kind} amount must be positive`);
    }
  }

  private static assertReferenceRules(props: CreateWagerTransactionProps): void {
    const reference = props.referenceExternalTransactionId;
    if (REQUIRES_REFERENCE.has(props.kind) && !reference) {
      throw new InvalidWagerTransactionError(
        FailureCode.ReferenceRequired,
        `${props.kind} requires referenceExternalTransactionId`,
      );
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerTransactionError(FailureCode.ReferenceNotAllowed, "BET cannot reference another transaction");
    }
    if (reference !== undefined && reference.trim() === "") {
      throw new InvalidWagerTransactionError(FailureCode.ValidationError, "referenceExternalTransactionId cannot be empty");
    }
    if (reference === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(FailureCode.ValidationError, "a transaction cannot reference itself");
    }
  }
}
