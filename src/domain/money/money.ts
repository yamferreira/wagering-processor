import { CurrencyMismatchError, InvalidCurrencyError, InvalidMoneyError, MoneyOverflowError } from "./money.errors";

/** Contract representation: `{ "amount": "25.00", "currency": "BRL" }`. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Fixed scale for every currency handled by the system (see ARCHITECTURE.md, A3). */
export const MONEY_SCALE = 2;
const MINOR_PER_UNIT = 100n;

/**
 * Strict input format (docs/ARCHITECTURE.md, A1): non-negative, no sign, no leading zeros,
 * exactly two decimal places, at most 18 integer digits (fits NUMERIC(20,2)).
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,17})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Largest absolute value representable by NUMERIC(20,2), in minor units. */
export const MAX_MINOR_UNITS = 10n ** 20n - 1n;

/**
 * Immutable monetary value. Internally an integer number of minor units (cents)
 * as `bigint`, so arithmetic is exact and never touches floating point.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses an input contract. Rejects anything that is not a strict, non-negative 2-decimal string. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("expected an object { amount, currency }");
    }
    const { amount, currency } = props;
    Money.assertCurrency(currency);
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string, e.g. \"25.00\"");
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount ${JSON.stringify(amount)} must be a non-negative decimal with exactly ${MONEY_SCALE} decimal places`,
      );
    }
    const [integerPart, fractionPart] = amount.split(".") as [string, string];
    return new Money(BigInt(integerPart) * MINOR_PER_UNIT + BigInt(fractionPart), currency);
  }

  /** Builds a value from minor units. May be negative (internal arithmetic results); never an input contract. */
  static ofMinorUnits(minor: bigint, currency: string): Money {
    Money.assertCurrency(currency);
    if (typeof minor !== "bigint") {
      throw new InvalidMoneyError("minor units must be a bigint");
    }
    if (minor > MAX_MINOR_UNITS || minor < -MAX_MINOR_UNITS) {
      throw new MoneyOverflowError();
    }
    return new Money(minor, currency);
  }

  static zero(currency: string): Money {
    return Money.ofMinorUnits(0n, currency);
  }

  static isValidCurrency(currency: unknown): currency is string {
    return typeof currency === "string" && CURRENCY_PATTERN.test(currency);
  }

  get minorUnits(): bigint {
    return this.minor;
  }

  /** Decimal string with fixed scale, e.g. "25.00" or "-5.00". */
  get amount(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const integerPart = abs / MINOR_PER_UNIT;
    const fractionPart = (abs % MINOR_PER_UNIT).toString().padStart(MONEY_SCALE, "0");
    return `${negative ? "-" : ""}${integerPart}.${fractionPart}`;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minor + other.minor, this.currency);
  }

  /** True when `this + other` is still representable (NUMERIC(20,2)); `add` would throw otherwise. */
  canAdd(other: Money): boolean {
    this.assertSameCurrency(other);
    const sum = this.minor + other.minor;
    return sum <= MAX_MINOR_UNITS && sum >= -MAX_MINOR_UNITS;
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofMinorUnits(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return Money.ofMinorUnits(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  hasCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (!Money.isValidCurrency(currency)) {
      throw new InvalidCurrencyError(currency);
    }
  }
}
