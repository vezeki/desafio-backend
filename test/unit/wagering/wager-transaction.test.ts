import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/shared/domain/money.ts";
import { LedgerDirection } from "../../../src/wallet/domain/ledger-direction.ts";
import { FailureCode } from "../../../src/wagering/domain/failure-code.ts";
import { hashWagerPayload } from "../../../src/wagering/domain/payload-hash.ts";
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from "../../../src/wagering/domain/wager-transaction.ts";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction-kind.ts";
import { WagerTransactionStatus as Status } from "../../../src/wagering/domain/wager-transaction-status.ts";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "../../../src/wagering/domain/wagering-errors.ts";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:00:01.000Z");

let counter = 0;
function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  counter += 1;
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${counter}`;
  return {
    id: `tx-${counter}`,
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
  };
}

const create = (overrides: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(overrides));

function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const transaction = create(overrides);
  transaction.markProcessed(undefined, T1, brl("100.00"));
  return transaction;
}

function expectInvalid(fn: () => unknown, code: FailureCode) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidWagerTransactionError);
    expect((error as InvalidWagerTransactionError).code).toBe(code);
    return;
  }
  throw new Error(`expected InvalidWagerTransactionError(${code})`);
}

describe("WagerTransaction.create", () => {
  test("starts as PENDING with the payload hash computed from business fields", () => {
    const input = props();
    const transaction = WagerTransaction.create(input);

    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.referenceAttempts).toBe(0);
    expect(transaction.payloadHash).toBe(hashWagerPayload({ ...input, money: input.money.toJSON() }));
  });

  test("OPENING cannot be submitted", () => {
    expectInvalid(() => create({ kind: Kind.Opening }), FailureCode.KindNotAllowed);
  });

  test("unknown kind is rejected", () => {
    expectInvalid(() => create({ kind: "JACKPOT" as Kind }), FailureCode.ValidationError);
  });

  test.each([Kind.Refund, Kind.Rollback])("%s requires a reference", (kind) => {
    expectInvalid(() => create({ kind }), FailureCode.ReferenceRequired);
  });

  test("BET cannot reference another transaction", () => {
    expectInvalid(() => create({ referenceExternalTransactionId: "ext-0" }), FailureCode.ReferenceNotAllowed);
  });

  test("a transaction cannot reference itself", () => {
    expectInvalid(
      () => create({ kind: Kind.Refund, externalTransactionId: "same", referenceExternalTransactionId: "same" }),
      FailureCode.ValidationError,
    );
  });

  test.each(["providerId", "externalTransactionId", "idempotencyKey", "walletId", "playerId", "roundId", "gameId"])(
    "%s is required",
    (field) => {
      expectInvalid(() => create({ [field]: " " }), FailureCode.ValidationError);
    },
  );

  test("the internal provider id is reserved", () => {
    expectInvalid(() => create({ providerId: "internal" }), FailureCode.ValidationError);
  });

  test.each([Kind.Bet, Kind.Win, Kind.Refund])("%s of zero is rejected", (kind) => {
    const reference = kind === Kind.Refund ? { referenceExternalTransactionId: "ext-0" } : {};
    expectInvalid(() => create({ kind, money: brl("0.00"), ...reference }), FailureCode.ValidationError);
  });

  test("LOSS of zero is accepted (it only records the outcome)", () => {
    expect(create({ kind: Kind.Loss, money: brl("0.00") }).status).toBe(Status.Pending);
  });
});

describe("WagerTransaction.createOpening", () => {
  test("is an internal, already processed credit", () => {
    const opening = WagerTransaction.createOpening({
      id: "tx-opening",
      walletId: "wallet-1",
      playerId: "player-1",
      money: brl("1000.00"),
      createdAt: T0,
    });
    expect(opening.kind).toBe(Kind.Opening);
    expect(opening.status).toBe(Status.Processed);
    expect(opening.providerId).toBe("internal");
    expect(opening.balanceAfter?.amount).toBe("1000.00");
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("state machine", () => {
  test("PENDING → PROCESSED stores reference, balance and time", () => {
    const transaction = create();
    transaction.markProcessed(undefined, T1, brl("75.00"));

    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.balanceAfter?.amount).toBe("75.00");
    expect(transaction.processedAt?.toISOString()).toBe(T1.toISOString());
    expect(transaction.isTerminal()).toBe(true);
  });

  test("PENDING → REJECTED keeps the failure code and the observed balance", () => {
    const transaction = create();
    transaction.reject(FailureCode.InsufficientFunds, T1, brl("20.00"));

    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.balanceAfter?.amount).toBe("20.00");
  });

  test("PENDING → FAILED", () => {
    const transaction = create();
    transaction.fail(FailureCode.ProcessingFailed, T1);
    expect(transaction.status).toBe(Status.Failed);
    expect(transaction.failureCode).toBe(FailureCode.ProcessingFailed);
  });

  test("PENDING → PENDING_REFERENCE → PENDING_REFERENCE → PROCESSED", () => {
    const refund = create({ kind: Kind.Refund, referenceExternalTransactionId: "ext-bet" });
    const retryAt = new Date("2026-01-01T00:00:05.000Z");

    refund.markPendingReference(retryAt);
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextRetryAt?.toISOString()).toBe(retryAt.toISOString());

    refund.markPendingReference(new Date("2026-01-01T00:00:10.000Z"));
    expect(refund.referenceAttempts).toBe(2);

    refund.markProcessed("tx-bet", T1, brl("100.00"));
    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe("tx-bet");
    expect(refund.nextRetryAt).toBeUndefined();
  });

  test("PENDING_REFERENCE → REJECTED when the reference never arrives", () => {
    const refund = create({ kind: Kind.Refund, referenceExternalTransactionId: "ext-bet" });
    refund.markPendingReference(T1);
    refund.reject(FailureCode.ReferenceNotFound, T1);
    expect(refund.status).toBe(Status.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test("cannot wait for a reference it does not have", () => {
    expect(() => create().markPendingReference(T1)).toThrow(InvalidTransactionStateError);
  });

  test("a reversal cannot be processed without its reference", () => {
    const refund = create({ kind: Kind.Refund, referenceExternalTransactionId: "ext-bet" });
    expect(() => refund.markProcessed(undefined, T1, brl("1.00"))).toThrow(InvalidTransactionStateError);
  });

  const terminalStates: [string, (t: WagerTransaction) => void][] = [
    ["PROCESSED", (t) => t.markProcessed(undefined, T1, brl("1.00"))],
    ["REJECTED", (t) => t.reject(FailureCode.InsufficientFunds, T1)],
    ["FAILED", (t) => t.fail(FailureCode.ProcessingFailed, T1)],
  ];
  const transitions: [string, (t: WagerTransaction) => void][] = [
    ["markProcessed", (t) => t.markProcessed(undefined, T1, brl("1.00"))],
    ["reject", (t) => t.reject(FailureCode.InsufficientFunds, T1)],
    ["fail", (t) => t.fail(FailureCode.ProcessingFailed, T1)],
    ["markPendingReference", (t) => t.markPendingReference(T1)],
  ];

  for (const [stateName, reach] of terminalStates) {
    for (const [transitionName, transition] of transitions) {
      test(`${stateName} is terminal: ${transitionName} throws`, () => {
        const transaction = create({ kind: Kind.Win, referenceExternalTransactionId: "ext-bet" });
        reach(transaction);
        const snapshot = { status: transaction.status, failureCode: transaction.failureCode };

        expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
        expect({ status: transaction.status, failureCode: transaction.failureCode }).toEqual(snapshot);
      });
    }
  }
});

describe("domain queries", () => {
  test("affectsBalance is false only for LOSS", () => {
    expect(create({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    for (const kind of [Kind.Bet, Kind.Win]) expect(create({ kind }).affectsBalance()).toBe(true);
  });

  test("requiresReference only for REFUND and ROLLBACK", () => {
    expect(create({ kind: Kind.Refund, referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
    expect(create({ kind: Kind.Rollback, referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
    expect(create({ kind: Kind.Win }).requiresReference()).toBe(false);
  });

  test("matchesPayload compares the hash", () => {
    const transaction = create();
    expect(transaction.matchesPayload(transaction.payloadHash)).toBe(true);
    expect(transaction.matchesPayload("0".repeat(64))).toBe(false);
  });
});

describe("ledgerDirectionFor", () => {
  test("fixed directions", () => {
    expect(create({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(create({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(create({ kind: Kind.Refund, referenceExternalTransactionId: "x" }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test.each([
    [Kind.Bet, LedgerDirection.Credit],
    [Kind.Win, LedgerDirection.Debit],
    [Kind.Refund, LedgerDirection.Debit],
  ])("ROLLBACK of %s is %s", (referenceKind, expected) => {
    const reference = create({ kind: referenceKind, ...(referenceKind === Kind.Refund ? { referenceExternalTransactionId: "y" } : {}) });
    const rollback = create({ kind: Kind.Rollback, referenceExternalTransactionId: reference.externalTransactionId });
    expect(rollback.ledgerDirectionFor(reference)).toBe(expected);
  });

  test("ROLLBACK without the reference cannot decide its direction", () => {
    expect(() => create({ kind: Kind.Rollback, referenceExternalTransactionId: "x" }).ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });

  test("LOSS has no ledger direction", () => {
    expect(() => create({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });
});

describe("evaluateReference", () => {
  const bet = () => processed({ kind: Kind.Bet, money: brl("25.00") });
  const refundOf = (reference: WagerTransaction, overrides: Partial<CreateWagerTransactionProps> = {}) =>
    create({ kind: Kind.Refund, referenceExternalTransactionId: reference.externalTransactionId, ...overrides });
  const rollbackOf = (reference: WagerTransaction, overrides: Partial<CreateWagerTransactionProps> = {}) =>
    create({
      kind: Kind.Rollback,
      referenceExternalTransactionId: reference.externalTransactionId,
      money: reference.money,
      ...overrides,
    });

  test("not applicable without a reference", () => {
    expect(create({ kind: Kind.Win }).evaluateReference(undefined)).toEqual({ outcome: "NOT_APPLICABLE" });
  });

  test("MISSING when the reference has not arrived", () => {
    expect(refundOf(bet()).evaluateReference(undefined)).toEqual({ outcome: "MISSING" });
  });

  test("USABLE for a valid REFUND of a processed BET", () => {
    const reference = bet();
    expect(refundOf(reference).evaluateReference(reference)).toEqual({ outcome: "USABLE", reference });
  });

  test("WAITING when the reference exists but is not terminal yet", () => {
    const pendingBet = create({ kind: Kind.Bet });
    expect(refundOf(pendingBet).evaluateReference(pendingBet).outcome).toBe("WAITING");
  });

  test.each([
    ["provider", { providerId: "provider-b" }],
    ["player", { playerId: "player-2" }],
    ["wallet", { walletId: "wallet-2" }],
    ["round", { roundId: "round-2" }],
    ["currency", { money: Money.from({ amount: "25.00", currency: "USD" }) }],
  ])("REFERENCE_MISMATCH when the %s differs", (_label, overrides) => {
    const reference = bet();
    const result = refundOf(reference, overrides).evaluateReference(reference);
    expect(result).toMatchObject({ outcome: "INVALID", failureCode: FailureCode.ReferenceMismatch });
  });

  test("REFUND can only reference BET", () => {
    const win = processed({ kind: Kind.Win });
    expect(refundOf(win, { money: win.money }).evaluateReference(win)).toMatchObject({
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test.each([Kind.Bet, Kind.Win])("ROLLBACK can reference %s", (kind) => {
    const reference = processed({ kind });
    expect(rollbackOf(reference).evaluateReference(reference).outcome).toBe("USABLE");
  });

  test("ROLLBACK can reference REFUND", () => {
    const refund = refundOf(bet());
    refund.markProcessed("tx-bet", T1, brl("100.00"));
    expect(rollbackOf(refund).evaluateReference(refund).outcome).toBe("USABLE");
  });

  test("ROLLBACK cannot reference another ROLLBACK", () => {
    const rollback = rollbackOf(bet());
    rollback.markProcessed("tx-bet", T1, brl("100.00"));
    expect(rollbackOf(rollback).evaluateReference(rollback)).toMatchObject({
      failureCode: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test("REFERENCE_NOT_PROCESSED when the reference was rejected", () => {
    const rejectedBet = create({ kind: Kind.Bet });
    rejectedBet.reject(FailureCode.InsufficientFunds, T1);
    expect(refundOf(rejectedBet).evaluateReference(rejectedBet)).toMatchObject({
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });

  test("AMOUNT_MISMATCH when a reversal amount differs (no partial reversal)", () => {
    const reference = bet();
    expect(refundOf(reference, { money: brl("10.00") }).evaluateReference(reference)).toMatchObject({
      failureCode: FailureCode.AmountMismatch,
    });
  });

  test.each<[string, Kind]>([
    ["REFUND after REFUND", Kind.Refund],
    ["REFUND after ROLLBACK", Kind.Rollback],
  ])("REFERENCE_ALREADY_REVERSED: %s of the same BET", (_label, previous) => {
    const reference = bet();
    expect(refundOf(reference).evaluateReference(reference, [previous])).toMatchObject({
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test("REFERENCE_ALREADY_REVERSED: ROLLBACK after REFUND of the same BET", () => {
    const reference = bet();
    expect(rollbackOf(reference).evaluateReference(reference, [Kind.Refund])).toMatchObject({
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test("REFERENCE_ALREADY_REVERSED: WIN for a BET that was refunded", () => {
    const reference = bet();
    const win = create({ kind: Kind.Win, referenceExternalTransactionId: reference.externalTransactionId });
    expect(win.evaluateReference(reference, [Kind.Refund])).toMatchObject({
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test("a WIN of the BET does not block its ROLLBACK", () => {
    const reference = bet();
    expect(rollbackOf(reference).evaluateReference(reference, [Kind.Win]).outcome).toBe("USABLE");
  });
});

describe("WagerTransaction.rehydrate", () => {
  test("restores a terminal transaction as persisted", () => {
    const original = create();
    original.reject(FailureCode.InsufficientFunds, T1, brl("20.00"));

    const restored = WagerTransaction.rehydrate({
      ...props({ id: original.id, externalTransactionId: original.externalTransactionId }),
      payloadHash: original.payloadHash,
      status: original.status,
      failureCode: original.failureCode,
      balanceAfter: original.balanceAfter,
      processedAt: original.processedAt,
      referenceAttempts: 0,
    });

    expect(restored.status).toBe(Status.Rejected);
    expect(restored.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(restored.balanceAfter?.amount).toBe("20.00");
    expect(restored.matchesPayload(original.payloadHash)).toBe(true);
    expect(() => restored.markProcessed(undefined, T1, brl("1.00"))).toThrow(InvalidTransactionStateError);
  });
});
