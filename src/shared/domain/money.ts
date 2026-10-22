import { Decimal as BaseDecimal } from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./domain-error.ts";

export interface MoneyProps {
  amount: string;
  currency: string;
}

export const MONEY_SCALE = 2;
/** Matches the NUMERIC(20,2) columns: 18 integer digits + 2 decimals. */
export const MONEY_MAX_INTEGER_DIGITS = 18;

const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_EVEN });
type Decimal = InstanceType<typeof Decimal>;

/** Non-negative, canonical, exactly two decimals: "0.00", "25.00", "1000.50". No leading zeros, sign or exponent. */
const INPUT_AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
/** Same as input, but allows a leading "-" (used when rehydrating signed internal values). */
const SIGNED_AMOUNT_PATTERN = /^-?(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const MAX_ABSOLUTE_VALUE = new Decimal(10).pow(MONEY_MAX_INTEGER_DIGITS).minus("0.01");

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Builds Money from an external contract: non-negative, exactly two decimals. */
  static from(props: MoneyProps): Money {
    return Money.parse(props, INPUT_AMOUNT_PATTERN);
  }

  /** Builds Money from trusted internal data (database, events), which may be negative. */
  static fromSigned(props: MoneyProps): Money {
    return Money.parse(props, SIGNED_AMOUNT_PATTERN);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.assertCurrency(currency));
  }

  get amount(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Different currencies are never equal; comparing them is not an error. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parse(props: MoneyProps, pattern: RegExp): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("money must be an object with amount and currency");
    }
    const { amount, currency } = props;
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string");
    }
    if (!pattern.test(amount)) {
      throw new InvalidMoneyError(`amount "${amount}" must be a decimal string with exactly ${MONEY_SCALE} decimal places`);
    }
    return Money.of(new Decimal(amount), Money.assertCurrency(currency));
  }

  private static of(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(MAX_ABSOLUTE_VALUE)) {
      throw new InvalidMoneyError(`amount exceeds ${MONEY_MAX_INTEGER_DIGITS} integer digits`);
    }
    if (value.decimalPlaces() > MONEY_SCALE) {
      throw new InvalidMoneyError(`amount has more than ${MONEY_SCALE} decimal places`);
    }
    // Avoids "-0.00" after negating zero.
    return new Money(value.isZero() ? new Decimal(0) : value, currency);
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`currency "${String(currency)}" must be an ISO-4217 code (3 uppercase letters)`);
    }
    return currency;
  }
}
