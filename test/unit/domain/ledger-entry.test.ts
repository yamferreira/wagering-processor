import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../../src/domain/errors";
import { LedgerDirection, WalletLedgerEntry } from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-11-05T12:00:00.000Z");

function props(overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) {
  return {
    id: "entry-1",
    walletId: "wallet-1",
    transactionId: "tx-1",
    direction: LedgerDirection.Debit,
    money: brl("25.00"),
    balanceBefore: brl("100.00"),
    balanceAfter: brl("75.00"),
    walletVersion: 2,
    createdAt: at,
    ...overrides,
  };
}

describe("WalletLedgerEntry.create", () => {
  test("accepts a balanced debit and a balanced credit", () => {
    expect(WalletLedgerEntry.create(props()).isBalanced()).toBe(true);
    const credit = WalletLedgerEntry.create(
      props({ direction: LedgerDirection.Credit, balanceBefore: brl("75.00"), balanceAfter: brl("100.00") }),
    );
    expect(credit.isBalanced()).toBe(true);
    expect(credit.signedAmount().amount).toBe("25.00");
  });

  test.each([
    ["debit that does not add up", props({ balanceAfter: brl("76.00") })],
    ["credit with debit arithmetic", props({ direction: LedgerDirection.Credit })],
    ["zero amount", props({ money: brl("0.00"), balanceAfter: brl("100.00") })],
    ["negative balance after", props({ balanceBefore: brl("10.00"), balanceAfter: brl("10.00").subtract(brl("25.00")) })],
    ["mixed currencies", props({ balanceAfter: Money.from({ amount: "75.00", currency: "USD" }) })],
    ["version zero", props({ walletVersion: 0 })],
    ["fractional version", props({ walletVersion: 1.5 })],
    ["missing transaction id", props({ transactionId: "" })],
    ["unknown direction", props({ direction: "SIDEWAYS" as LedgerDirection })],
  ])("rejects %s", (_label, input) => {
    expect(() => WalletLedgerEntry.create(input)).toThrow(InvariantViolationError);
  });
});

describe("WalletLedgerEntry immutability", () => {
  test("instances are frozen and createdAt is a defensive copy", () => {
    const createdAt = new Date(at.getTime());
    const entry = WalletLedgerEntry.create(props({ createdAt }));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { balanceAfter: Money }).balanceAfter = brl("999.00");
    }).toThrow();
    createdAt.setFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe(at.toISOString());
  });

  test("rehydrate does not revalidate persisted state", () => {
    const entry = WalletLedgerEntry.rehydrate(props({ balanceAfter: brl("1.00") }));
    expect(entry.isBalanced()).toBe(false);
  });
});
