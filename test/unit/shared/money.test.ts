import { describe, expect, test } from "bun:test";
import { Money } from "../../../src/shared/domain/money.ts";
import { CurrencyMismatchError, InvalidMoneyError } from "../../../src/shared/domain/domain-error.ts";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
  test.each(["0.00", "0.01", "25.00", "1000.50", "999999999999999999.99"])("accepts %p", (amount) => {
    expect(brl(amount).amount).toBe(amount);
  });

  test.each([
    ["empty string", ""],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["scientific notation", "1e3"],
    ["scientific notation with decimals", "2.50e1"],
    ["more than 2 decimals", "1.234"],
    ["fewer than 2 decimals", "1.5"],
    ["integer without decimals", "25"],
    ["negative value", "-1.00"],
    ["explicit plus sign", "+1.00"],
    ["leading zero", "01.00"],
    ["comma as separator", "1,00"],
    ["thousands separator", "1,000.00"],
    ["whitespace", " 1.00"],
    ["hexadecimal", "0x10"],
    ["more than 18 integer digits", "1000000000000000000.00"],
  ])("rejects %s", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejects amount sent as number", () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["", "brl", "BR", "BRLL", "R$", "12A"])("rejects currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("Money.fromSigned", () => {
  test("accepts negative values from trusted sources", () => {
    expect(Money.fromSigned({ amount: "-10.50", currency: "BRL" }).amount).toBe("-10.50");
  });

  test("still rejects invalid formats", () => {
    expect(() => Money.fromSigned({ amount: "-1.5", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.fromSigned({ amount: "-1e2", currency: "BRL" })).toThrow(InvalidMoneyError);
  });
});

describe("arithmetic", () => {
  test("is exact where floating point is not (0.10 + 0.20 = 0.30)", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("adds and subtracts keeping two decimals", () => {
    expect(brl("100.00").subtract(brl("80.00")).amount).toBe("20.00");
    expect(brl("0.05").add(brl("0.05")).amount).toBe("0.10");
  });

  test("accumulating many cents has no drift", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 10_000; i++) total = total.add(brl("0.01"));
    expect(total.amount).toBe("100.00");
  });

  test("handles values beyond Number.MAX_SAFE_INTEGER exactly", () => {
    expect(brl("900719925474099.10").add(brl("0.01")).amount).toBe("900719925474099.11");
  });

  test("subtract can produce negative values (the Wallet is responsible for forbidding it)", () => {
    const result = brl("10.00").subtract(brl("10.01"));
    expect(result.isNegative()).toBe(true);
    expect(result.amount).toBe("-0.01");
  });

  test("negate", () => {
    expect(brl("25.00").negate().amount).toBe("-25.00");
    expect(brl("25.00").negate().negate().equals(brl("25.00"))).toBe(true);
  });

  test("negating zero does not produce -0.00", () => {
    expect(Money.zero("BRL").negate().amount).toBe("0.00");
  });

  test("rejects results that overflow the persisted precision", () => {
    expect(() => brl("999999999999999999.99").add(brl("0.01"))).toThrow(InvalidMoneyError);
  });

  test("is immutable: operations return new instances", () => {
    const original = brl("50.00");
    const sum = original.add(brl("10.00"));
    expect(original.amount).toBe("50.00");
    expect(sum).not.toBe(original);
  });

  test("instances are frozen at runtime", () => {
    const money = brl("50.00");
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { currency: string }).currency = "USD";
    }).toThrow(TypeError);
  });
});

describe("currency conflicts", () => {
  test.each([
    ["add", (a: Money, b: Money) => a.add(b)],
    ["subtract", (a: Money, b: Money) => a.subtract(b)],
    ["isLessThan", (a: Money, b: Money) => a.isLessThan(b)],
  ])("%s between different currencies throws", (_label, operation) => {
    expect(() => operation(brl("1.00"), usd("1.00"))).toThrow(CurrencyMismatchError);
  });

  test("equals between different currencies is false, not an error", () => {
    expect(brl("1.00").equals(usd("1.00"))).toBe(false);
  });
});

describe("predicates", () => {
  test("isZero / isPositive / isNegative", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").negate().isNegative()).toBe(true);
    expect(Money.zero("BRL").isPositive()).toBe(false);
    expect(Money.zero("BRL").isNegative()).toBe(false);
  });

  test("isLessThan", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
  });
});

describe("serialization", () => {
  test("toJSON returns the contract format", () => {
    expect(brl("25.00").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(JSON.stringify({ money: brl("25.00") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });

  test("round-trips through toJSON", () => {
    const money = brl("1234.56");
    expect(Money.from(money.toJSON()).equals(money)).toBe(true);
  });

  test("toString", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
  });
});
