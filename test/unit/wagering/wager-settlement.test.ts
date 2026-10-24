import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/shared/domain/money.ts";
import { FailureCode } from "../../../src/wagering/domain/failure-code.ts";
import { ReferenceRetryPolicy } from "../../../src/wagering/domain/reference-retry-policy.ts";
import { WagerTransaction, type CreateWagerTransactionProps } from "../../../src/wagering/domain/wager-transaction.ts";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction-kind.ts";
import { WagerTransactionStatus as Status } from "../../../src/wagering/domain/wager-transaction-status.ts";
import { WagerSettlement } from "../../../src/wagering/domain/wager-settlement.ts";
import { LedgerDirection } from "../../../src/wallet/domain/ledger-direction.ts";
import { INITIAL_WALLET_VERSION, Wallet } from "../../../src/wallet/domain/wallet.ts";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:00:01.000Z");

const settlement = new WagerSettlement(new ReferenceRetryPolicy({ maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 }));

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

function wallet(balance: string, playerId = "player-1"): Wallet {
  return Wallet.open({
    id: "wallet-1",
    playerId,
    initialBalance: brl(balance),
    openingTransactionId: nextId("opening"),
    openingEntryId: nextId("entry"),
    at: T0,
  }).wallet;
}

function transaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  return WagerTransaction.create({
    id: nextId("tx"),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: Kind.Bet,
    money: brl("25.00"),
    createdAt: T0,
    ...overrides,
  });
}

/** Settles against the wallet, resolving the reference the same way the use case does. */
function settle(tx: WagerTransaction, target: Wallet | undefined, reference?: WagerTransaction, dependents: Kind[] = []) {
  return settlement.settle({
    transaction: tx,
    wallet: target,
    reference: tx.evaluateReference(reference, dependents),
    ledgerEntryId: nextId("entry"),
    now: T1,
  });
}

/** A BET of `amount` already processed against `target`. */
function processedBet(target: Wallet, amount = "25.00"): WagerTransaction {
  const bet = transaction({ money: brl(amount) });
  expect(settle(bet, target).outcome).toBe("PROCESSED");
  return bet;
}

describe("BET", () => {
  test("debits the wallet and records the observed balance", () => {
    const target = wallet("100.00");
    const bet = transaction({ money: brl("30.00") });

    const result = settle(bet, target);

    expect(result.outcome).toBe("PROCESSED");
    if (result.outcome !== "PROCESSED") return;
    expect(result.entry?.direction).toBe(LedgerDirection.Debit);
    expect(target.balance.amount).toBe("70.00");
    expect(bet.status).toBe(Status.Processed);
    expect(bet.balanceAfter?.amount).toBe("70.00");
  });

  test("spending the exact balance is allowed", () => {
    const target = wallet("25.00");
    expect(settle(transaction({ money: brl("25.00") }), target).outcome).toBe("PROCESSED");
    expect(target.balance.isZero()).toBe(true);
  });

  test("without funds it is rejected with INSUFFICIENT_FUNDS and the balance is untouched", () => {
    const target = wallet("10.00");
    const bet = transaction({ money: brl("10.01") });

    expect(settle(bet, target).outcome).toBe("REJECTED");
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.balanceAfter?.amount).toBe("10.00");
    expect(target.balance.amount).toBe("10.00");
    expect(target.version).toBe(INITIAL_WALLET_VERSION);
  });
});

describe("WIN and LOSS", () => {
  test("WIN credits, with or without referencing the BET", () => {
    const target = wallet("100.00");
    const bet = processedBet(target);

    const referencing = transaction({ kind: Kind.Win, money: brl("50.00"), referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(referencing, target, bet).outcome).toBe("PROCESSED");
    expect(referencing.referenceTransactionId).toBe(bet.id);

    const standalone = transaction({ kind: Kind.Win, money: brl("5.00") });
    expect(settle(standalone, target).outcome).toBe("PROCESSED");
    expect(target.balance.amount).toBe("130.00");
  });

  test("LOSS is processed without ledger entry and without touching the balance", () => {
    const target = wallet("100.00");
    const loss = transaction({ kind: Kind.Loss, money: brl("0.00") });

    const result = settle(loss, target);

    expect(result).toEqual({ outcome: "PROCESSED" });
    expect(loss.balanceAfter?.amount).toBe("100.00");
    expect(target.version).toBe(INITIAL_WALLET_VERSION);
  });
});

describe("REFUND", () => {
  test("credits back the BET amount", () => {
    const target = wallet("100.00");
    const bet = processedBet(target, "40.00");
    const refund = transaction({ kind: Kind.Refund, money: brl("40.00"), referenceExternalTransactionId: bet.externalTransactionId });

    expect(settle(refund, target, bet).outcome).toBe("PROCESSED");
    expect(target.balance.amount).toBe("100.00");
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test("a BET already reverted cannot be refunded again", () => {
    const target = wallet("100.00");
    const bet = processedBet(target);
    const refund = transaction({ kind: Kind.Refund, money: brl("25.00"), referenceExternalTransactionId: bet.externalTransactionId });

    expect(settle(refund, target, bet, [Kind.Refund]).outcome).toBe("REJECTED");
    expect(refund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test("a partial amount is rejected with AMOUNT_MISMATCH", () => {
    const target = wallet("100.00");
    const bet = processedBet(target);
    const refund = transaction({ kind: Kind.Refund, money: brl("10.00"), referenceExternalTransactionId: bet.externalTransactionId });

    expect(settle(refund, target, bet).outcome).toBe("REJECTED");
    expect(refund.failureCode).toBe(FailureCode.AmountMismatch);
  });

  test("referencing a WIN is not allowed", () => {
    const target = wallet("100.00");
    const win = transaction({ kind: Kind.Win, money: brl("5.00") });
    settle(win, target);
    const refund = transaction({ kind: Kind.Refund, money: brl("5.00"), referenceExternalTransactionId: win.externalTransactionId });

    expect(settle(refund, target, win).outcome).toBe("REJECTED");
    expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test("a WIN on a BET already refunded is rejected: a cancelled round does not pay", () => {
    const target = wallet("100.00");
    const bet = processedBet(target);
    const refund = transaction({ kind: Kind.Refund, money: brl("25.00"), referenceExternalTransactionId: bet.externalTransactionId });
    settle(refund, target, bet);
    const win = transaction({ kind: Kind.Win, money: brl("50.00"), referenceExternalTransactionId: bet.externalTransactionId });

    expect(settle(win, target, bet, [Kind.Refund]).outcome).toBe("REJECTED");
    expect(win.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits it back", () => {
    const target = wallet("100.00");
    const bet = processedBet(target, "60.00");
    const rollback = transaction({ kind: Kind.Rollback, money: brl("60.00"), referenceExternalTransactionId: bet.externalTransactionId });

    const result = settle(rollback, target, bet);

    expect(result.outcome === "PROCESSED" && result.entry?.direction).toBe(LedgerDirection.Credit);
    expect(target.balance.amount).toBe("100.00");
  });

  test("of a WIN debits it back", () => {
    const target = wallet("100.00");
    const win = transaction({ kind: Kind.Win, money: brl("50.00") });
    settle(win, target);
    const rollback = transaction({ kind: Kind.Rollback, money: brl("50.00"), referenceExternalTransactionId: win.externalTransactionId });

    const result = settle(rollback, target, win);

    expect(result.outcome === "PROCESSED" && result.entry?.direction).toBe(LedgerDirection.Debit);
    expect(target.balance.amount).toBe("100.00");
  });

  test("of a WIN already spent is rejected with REVERSAL_INSUFFICIENT_FUNDS, distinct from a BET without funds", () => {
    const target = wallet("0.00");
    const win = transaction({ kind: Kind.Win, money: brl("50.00") });
    settle(win, target);
    processedBet(target, "45.00");
    const rollback = transaction({ kind: Kind.Rollback, money: brl("50.00"), referenceExternalTransactionId: win.externalTransactionId });

    expect(settle(rollback, target, win).outcome).toBe("REJECTED");
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(target.balance.amount).toBe("5.00");
  });

  test("of a REFUND takes the refunded amount back", () => {
    const target = wallet("100.00");
    const bet = processedBet(target);
    const refund = transaction({ kind: Kind.Refund, money: brl("25.00"), referenceExternalTransactionId: bet.externalTransactionId });
    settle(refund, target, bet);
    const rollback = transaction({ kind: Kind.Rollback, money: brl("25.00"), referenceExternalTransactionId: refund.externalTransactionId });

    expect(settle(rollback, target, refund).outcome).toBe("PROCESSED");
    expect(target.balance.amount).toBe("75.00");
  });
});

describe("references that are not usable yet", () => {
  test("a missing reference leaves the transaction waiting, with a retry scheduled", () => {
    const target = wallet("100.00");
    const refund = transaction({ kind: Kind.Refund, referenceExternalTransactionId: "bet-not-arrived" });

    expect(settle(refund, target).outcome).toBe("PENDING_REFERENCE");
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextRetryAt).toEqual(new Date(T1.getTime() + 1_000));
    expect(target.version).toBe(INITIAL_WALLET_VERSION);
  });

  test("after the last attempt a missing reference becomes REFERENCE_NOT_FOUND", () => {
    const target = wallet("100.00");
    const refund = transaction({ kind: Kind.Refund, referenceExternalTransactionId: "never-arrives" });

    expect(settle(refund, target).outcome).toBe("PENDING_REFERENCE");
    expect(settle(refund, target).outcome).toBe("PENDING_REFERENCE");
    expect(settle(refund, target).outcome).toBe("REJECTED");
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(refund.referenceAttempts).toBe(2);
  });

  test("a reference that is itself still pending makes the dependent wait too", () => {
    const target = wallet("100.00");
    const pendingRefund = transaction({ kind: Kind.Refund, referenceExternalTransactionId: "missing-bet" });
    settle(pendingRefund, target);
    const rollback = transaction({
      kind: Kind.Rollback,
      money: brl("25.00"),
      referenceExternalTransactionId: pendingRefund.externalTransactionId,
    });

    expect(settle(rollback, target, pendingRefund).outcome).toBe("PENDING_REFERENCE");
  });
});

describe("wallet checks", () => {
  test("an unknown wallet is rejected without an observed balance", () => {
    const bet = transaction();
    expect(settle(bet, undefined).outcome).toBe("REJECTED");
    expect(bet.failureCode).toBe(FailureCode.WalletNotFound);
    expect(bet.balanceAfter).toBeUndefined();
  });

  test("a wallet of another player is rejected without exposing its balance", () => {
    const bet = transaction();
    expect(settle(bet, wallet("100.00", "player-2")).outcome).toBe("REJECTED");
    expect(bet.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect(bet.balanceAfter).toBeUndefined();
  });

  test("a transaction in another currency is rejected with CURRENCY_MISMATCH", () => {
    const target = wallet("100.00");
    const bet = transaction({ money: Money.from({ amount: "10.00", currency: "USD" }) });

    expect(settle(bet, target).outcome).toBe("REJECTED");
    expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(target.balance.amount).toBe("100.00");
  });

  test("the wallet checks come before the reference: no pending state for a transaction that can never apply", () => {
    const refund = transaction({ kind: Kind.Refund, referenceExternalTransactionId: "missing" });
    expect(settle(refund, undefined).outcome).toBe("REJECTED");
    expect(refund.failureCode).toBe(FailureCode.WalletNotFound);
  });
});
