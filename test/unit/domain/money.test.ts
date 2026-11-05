import { describe, expect, test } from "bun:test";
import { MAX_MINOR_UNITS, Money } from "../../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InvalidCurrencyError,
  InvalidMoneyError,
  MoneyOverflowError,
} from "../../../src/domain/money/money.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from — accepted inputs", () => {
  test.each([
    ["0.00", 0n],
    ["0.01", 1n],
    ["25.00", 2500n],
    ["1000.50", 100050n],
    ["9999999999999999.99", 999999999999999999n],
    ["999999999999999999.99", MAX_MINOR_UNITS],
  ])("%p → %p minor units", (amount, minor) => {
    const money = brl(amount);
    expect(money.minorUnits).toBe(minor);
    expect(money.amount).toBe(amount);
    expect(money.currency).toBe("BRL");
  });
});

describe("Money.from — rejected inputs (strict contract, PLAN A1)", () => {
  test.each([
    ["empty string", ""],
    ["blank", " "],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["scientific notation", "1e2"],
    ["scientific notation with decimals", "1.00e2"],
    ["negative", "-1.00"],
    ["explicit plus sign", "+1.00"],
    ["comma separator", "1,00"],
    ["leading zero", "01.00"],
    ["more than 2 decimals", "1.000"],
    ["rounding candidate", "1.005"],
    ["no decimals", "1"],
    ["one decimal", "1.5"],
    ["trailing dot", "1."],
    ["leading dot", ".50"],
    ["surrounding spaces", " 1.00 "],
    ["hex", "0x10"],
    ["thousands separator", "1_000.00"],
    ["19 integer digits (exceeds NUMERIC(20,2))", "1000000000000000000.00"],
  ])("%s (%p)", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("non-string amounts are rejected at runtime", () => {
    for (const amount of [25, 25.5, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, 25n, {}]) {
      expect(() => Money.from({ amount: amount as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    }
  });

  test("non-object props are rejected", () => {
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidMoneyError);
  });

  test.each(["", "brl", "BR", "BRLL", "B1L", " BRL", 1 as unknown as string, undefined as unknown as string])(
    "invalid currency %p",
    (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidCurrencyError);
    },
  );
});

describe("Money arithmetic is exact (no floating point, no rounding)", () => {
  test("0.10 + 0.20 == 0.30", () => {
    expect(brl("0.10").add(brl("0.20")).equals(brl("0.30"))).toBe(true);
  });

  test("adding 0.01 one thousand times yields exactly 10.00", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
    expect(total.amount).toBe("10.00");
  });

  test("subtract may produce an internal negative value, formatted with fixed scale", () => {
    const result = brl("20.00").subtract(brl("25.05"));
    expect(result.isNegative()).toBe(true);
    expect(result.amount).toBe("-5.05");
    expect(result.toJSON()).toEqual({ amount: "-5.05", currency: "BRL" });
  });

  test("negate", () => {
    expect(brl("7.30").negate().amount).toBe("-7.30");
    expect(brl("7.30").negate().negate().equals(brl("7.30"))).toBe(true);
    expect(brl("0.00").negate().isZero()).toBe(true);
  });

  test("small values keep two decimals", () => {
    expect(brl("0.05").amount).toBe("0.05");
    expect(brl("0.05").negate().amount).toBe("-0.05");
  });

  test("arithmetic beyond NUMERIC(20,2) overflows explicitly", () => {
    const max = Money.ofMinorUnits(MAX_MINOR_UNITS, "BRL");
    expect(() => max.add(brl("0.01"))).toThrow(MoneyOverflowError);
    expect(() => Money.ofMinorUnits(MAX_MINOR_UNITS + 1n, "BRL")).toThrow(MoneyOverflowError);
  });
});

describe("Money predicates and comparisons", () => {
  test("isZero / isPositive / isNegative", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").isNegative()).toBe(false);
    expect(brl("0.00").isPositive()).toBe(false);
  });

  test("isLessThan / isGreaterThan / equals", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
    expect(brl("80.01").isGreaterThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").equals(brl("80.00"))).toBe(true);
    expect(brl("80.00").equals(Money.from({ amount: "80.00", currency: "USD" }))).toBe(false);
  });

  test("toString and toJSON use the fixed scale", () => {
    expect(brl("25.00").toString()).toBe("25.00 BRL");
    expect(JSON.stringify({ money: brl("25.00") })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });
});

describe("Money currency conflicts", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });

  test.each([
    ["add", (a: Money, b: Money) => a.add(b)],
    ["subtract", (a: Money, b: Money) => a.subtract(b)],
    ["isLessThan", (a: Money, b: Money) => a.isLessThan(b)],
    ["isGreaterThan", (a: Money, b: Money) => a.isGreaterThan(b)],
  ])("%s throws CurrencyMismatchError", (_name, op) => {
    expect(() => op(brl("1.00"), usd)).toThrow(CurrencyMismatchError);
  });

  test("error carries a stable code", () => {
    try {
      brl("1.00").add(usd);
      throw new Error("unreachable");
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).code).toBe("CURRENCY_MISMATCH");
    }
  });
});

describe("Money immutability", () => {
  test("instances are frozen and operations return new instances", () => {
    const a = brl("10.00");
    const b = a.add(brl("1.00"));
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.amount).toBe("10.00");
    expect(b).not.toBe(a);
    expect(() => {
      (a as unknown as { currency: string }).currency = "USD";
    }).toThrow();
  });
});
