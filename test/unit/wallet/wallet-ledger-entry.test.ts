import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/shared/domain/money.ts";
import { CurrencyMismatchError } from "../../../src/shared/domain/domain-error.ts";
import { LedgerDirection } from "../../../src/wallet/domain/ledger-direction.ts";
import { WalletLedgerEntry, type CreateLedgerEntryProps } from "../../../src/wallet/domain/wallet-ledger-entry.ts";
import { UnbalancedLedgerEntryError } from "../../../src/wallet/domain/wallet-errors.ts";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

const props = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: "entry-1",
  walletId: "wallet-1",
  transactionId: "tx-1",
  direction: LedgerDirection.Debit,
  money: brl("80.00"),
  balanceBefore: brl("100.00"),
  balanceAfter: brl("20.00"),
  sequence: 2,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("WalletLedgerEntry.create", () => {
  test("accepts a balanced debit", () => {
    const entry = WalletLedgerEntry.create(props());
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe("-80.00");
  });

  test("accepts a balanced credit", () => {
    const entry = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl("20.00"), balanceAfter: brl("100.00") }),
    );
    expect(entry.isBalanced()).toBe(true);
    expect(entry.signedAmount().amount).toBe("80.00");
  });

  test("rejects wrong arithmetic", () => {
    expect(() => WalletLedgerEntry.create(props({ balanceAfter: brl("20.01") }))).toThrow(UnbalancedLedgerEntryError);
  });

  test("rejects a debit recorded as credit", () => {
    expect(() => WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit }))).toThrow(
      UnbalancedLedgerEntryError,
    );
  });

  test("rejects zero amount", () => {
    expect(() =>
      WalletLedgerEntry.create(props({ money: brl("0.00"), balanceBefore: brl("10.00"), balanceAfter: brl("10.00") })),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test("rejects negative balance after", () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ balanceBefore: brl("50.00"), balanceAfter: Money.fromSigned({ amount: "-30.00", currency: "BRL" }) }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test.each([0, -1, 1.5])("rejects invalid sequence %p", (sequence) => {
    expect(() => WalletLedgerEntry.create(props({ sequence }))).toThrow(UnbalancedLedgerEntryError);
  });

  test("rejects mixed currencies", () => {
    expect(() => WalletLedgerEntry.create(props({ money: Money.from({ amount: "80.00", currency: "USD" }) }))).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe("immutability", () => {
  test("entries are frozen and expose no mutators", () => {
    const entry = WalletLedgerEntry.create(props());
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl("999.00");
    }).toThrow(TypeError);
  });

  test("does not share the Date instance passed by the caller", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const entry = WalletLedgerEntry.create(props({ createdAt }));
    createdAt.setFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("WalletLedgerEntry.rehydrate", () => {
  test("rebuilds state without revalidating", () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl("21.00") }));
    expect(entry.isBalanced()).toBe(false);
  });
});
