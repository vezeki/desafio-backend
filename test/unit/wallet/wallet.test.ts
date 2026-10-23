import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/shared/domain/money.ts";
import { CurrencyMismatchError } from "../../../src/shared/domain/domain-error.ts";
import { LedgerDirection } from "../../../src/wallet/domain/ledger-direction.ts";
import { Wallet } from "../../../src/wallet/domain/wallet.ts";
import type { WalletLedgerEntry } from "../../../src/wallet/domain/wallet-ledger-entry.ts";
import {
  InsufficientFundsError,
  InvalidWalletError,
  InvalidWalletMovementError,
} from "../../../src/wallet/domain/wallet-errors.ts";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-01T00:00:01.000Z");

let seq = 0;
const movement = (money: Money, at = T1) => {
  seq += 1;
  return { entryId: `entry-${seq}`, transactionId: `tx-${seq}`, money, at };
};

function openWallet(initial = "100.00") {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: brl(initial),
    openingTransactionId: "tx-opening",
    openingEntryId: "entry-opening",
    at: T0,
  });
}

function ledgerBalance(entries: WalletLedgerEntry[], currency = "BRL"): Money {
  return entries.reduce((total, entry) => total.add(entry.signedAmount()), Money.zero(currency));
}

describe("Wallet.open", () => {
  test("starts at version 1 with an OPENING credit when the initial balance is positive", () => {
    const { wallet, openingEntry } = openWallet("100.00");

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.transactionId).toBe("tx-opening");
    expect(openingEntry!.balanceBefore.amount).toBe("0.00");
    expect(openingEntry!.balanceAfter.amount).toBe("100.00");
    expect(openingEntry!.sequence).toBe(1);
  });

  test("zero initial balance produces no ledger entry", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: brl("0.00"),
      at: T0,
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
    expect(openingEntry).toBeUndefined();
  });

  test("positive initial balance without an OPENING transaction is rejected", () => {
    expect(() =>
      Wallet.open({ id: "wallet-1", playerId: "player-1", initialBalance: brl("10.00"), at: T0 }),
    ).toThrow(InvalidWalletError);
  });

  test("negative initial balance is rejected", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: Money.fromSigned({ amount: "-1.00", currency: "BRL" }),
        openingTransactionId: "tx",
        openingEntryId: "entry",
        at: T0,
      }),
    ).toThrow(InvalidWalletError);
  });

  test("currency comes from the initial balance", () => {
    const { wallet } = Wallet.open({ id: "w", playerId: "p", initialBalance: Money.zero("USD"), at: T0 });
    expect(wallet.currency).toBe("USD");
  });
});

describe("debit", () => {
  test("decreases the balance, bumps the version and returns the DEBIT entry", () => {
    const { wallet } = openWallet("100.00");
    const entry = wallet.debit(movement(brl("80.00")));

    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(T1.toISOString());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("20.00");
    expect(entry.sequence).toBe(2);
    expect(entry.walletId).toBe(wallet.id);
  });

  test("can debit the whole balance", () => {
    const { wallet } = openWallet("80.00");
    wallet.debit(movement(brl("80.00")));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("insufficient funds throws and leaves state untouched", () => {
    const { wallet } = openWallet("100.00");
    wallet.debit(movement(brl("80.00")));

    expect(() => wallet.debit(movement(brl("80.00")))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("by one cent over the balance is rejected", () => {
    const { wallet } = openWallet("10.00");
    expect(() => wallet.debit(movement(brl("10.01")))).toThrow(InsufficientFundsError);
  });
});

describe("credit", () => {
  test("increases the balance, bumps the version and returns the CREDIT entry", () => {
    const { wallet } = openWallet("100.00");
    const entry = wallet.credit(movement(brl("50.00")));

    expect(wallet.balance.amount).toBe("150.00");
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.amount).toBe("150.00");
  });
});

describe("invalid movements do not change state", () => {
  test.each([
    ["debit", (w: Wallet) => w.debit(movement(usd("1.00")))],
    ["credit", (w: Wallet) => w.credit(movement(usd("1.00")))],
  ])("%s in another currency throws CurrencyMismatchError", (_label, operation) => {
    const { wallet } = openWallet("100.00");
    expect(() => operation(wallet)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test.each([
    ["debit", (w: Wallet) => w.debit(movement(brl("0.00")))],
    ["credit", (w: Wallet) => w.credit(movement(brl("0.00")))],
  ])("%s of zero is rejected (version only changes when the balance changes)", (_label, operation) => {
    const { wallet } = openWallet("100.00");
    expect(() => operation(wallet)).toThrow(InvalidWalletMovementError);
    expect(wallet.version).toBe(1);
  });

  test("negative amounts are rejected", () => {
    const { wallet } = openWallet("100.00");
    expect(() => wallet.credit(movement(brl("10.00").negate()))).toThrow(InvalidWalletMovementError);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("missing transaction id is rejected", () => {
    const { wallet } = openWallet("100.00");
    expect(() => wallet.debit({ entryId: "e", transactionId: "", money: brl("1.00"), at: T1 })).toThrow(
      InvalidWalletMovementError,
    );
  });
});

describe("balance and ledger stay consistent", () => {
  test("after a long sequence of movements, balance == sum of ledger entries and sequences are contiguous", () => {
    const { wallet, openingEntry } = openWallet("100.00");
    const entries: WalletLedgerEntry[] = [openingEntry!];
    const amounts = ["10.00", "0.01", "33.33", "5.50", "99.99", "0.10", "12.34"];

    for (let i = 0; i < 200; i++) {
      const money = brl(amounts[i % amounts.length]!);
      const shouldDebit = i % 3 !== 0;
      if (shouldDebit && wallet.canDebit(money)) {
        entries.push(wallet.debit(movement(money)));
      } else if (shouldDebit) {
        expect(() => wallet.debit(movement(money))).toThrow(InsufficientFundsError);
      } else {
        entries.push(wallet.credit(movement(money)));
      }
      expect(wallet.balance.isNegative()).toBe(false);
    }

    expect(ledgerBalance(entries).equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.sequence)).toEqual(entries.map((_, index) => index + 1));
    expect(wallet.version).toBe(entries.length);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
    }
  });
});

describe("Wallet.rehydrate", () => {
  test("restores state as persisted", () => {
    const wallet = Wallet.rehydrate({
      id: "wallet-1",
      playerId: "player-1",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.balance.amount).toBe("42.00");
    expect(wallet.version).toBe(7);

    const entry = wallet.debit(movement(brl("2.00")));
    expect(entry.sequence).toBe(8);
    expect(wallet.version).toBe(8);
  });

  test("updatedAt getter does not expose internal state", () => {
    const { wallet } = openWallet();
    wallet.updatedAt.setFullYear(2000);
    expect(wallet.updatedAt.toISOString()).toBe(T0.toISOString());
  });
});
