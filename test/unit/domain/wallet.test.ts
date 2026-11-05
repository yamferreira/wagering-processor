import { describe, expect, test } from "bun:test";
import { InvariantViolationError, ValidationError } from "../../../src/domain/errors";
import { LedgerDirection, type WalletLedgerEntry } from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import { CurrencyMismatchError } from "../../../src/domain/money/money.errors";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { InsufficientFundsError } from "../../../src/domain/wallet/wallet.errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const t0 = new Date("2026-11-05T12:00:00.000Z");
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function openWith(amount: string): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
  return Wallet.open({
    id: nextId("wallet"),
    playerId: "player-1",
    initialBalance: brl(amount),
    at: t0,
    opening: { transactionId: nextId("tx"), ledgerEntryId: nextId("entry") },
  });
}

function movement(amount: string, at = t0) {
  return { ledgerEntryId: nextId("entry"), transactionId: nextId("tx"), money: brl(amount), at };
}

describe("Wallet.open", () => {
  test("zero opening balance → version 1 and no ledger entry", () => {
    const { wallet, openingEntry } = Wallet.open({ id: "w", playerId: "p", initialBalance: brl("0.00"), at: t0 });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("0.00");
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry).toBeUndefined();
  });

  test("positive opening balance → CREDIT entry with walletVersion 1", () => {
    const { wallet, openingEntry } = openWith("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("100.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe("0.00");
    expect(openingEntry?.balanceAfter.amount).toBe("100.00");
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test("positive opening balance without OPENING ids is an invariant violation", () => {
    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance: brl("1.00"), at: t0 })).toThrow(
      InvariantViolationError,
    );
  });

  test("requires id and playerId", () => {
    expect(() => Wallet.open({ id: "", playerId: "p", initialBalance: brl("0.00"), at: t0 })).toThrow(ValidationError);
    expect(() => Wallet.open({ id: "w", playerId: "", initialBalance: brl("0.00"), at: t0 })).toThrow(ValidationError);
  });
});

describe("Wallet.debit / credit", () => {
  test("debit returns the entry, increments version and updates updatedAt", () => {
    const { wallet } = openWith("100.00");
    const later = new Date(t0.getTime() + 1000);
    const entry = wallet.debit(movement("25.00", later));
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe("100.00");
    expect(entry.balanceAfter.amount).toBe("75.00");
    expect(entry.walletVersion).toBe(2);
    expect(wallet.balance.amount).toBe("75.00");
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.toISOString()).toBe(later.toISOString());
  });

  test("credit returns the entry and increments version", () => {
    const { wallet } = openWith("0.00");
    const entry = wallet.credit(movement("10.50"));
    expect(entry.balanceBefore.amount).toBe("0.00");
    expect(entry.balanceAfter.amount).toBe("10.50");
    expect(entry.walletVersion).toBe(2);
    expect(wallet.version).toBe(2);
  });

  test("debit of the exact balance leaves zero", () => {
    const { wallet } = openWith("80.00");
    wallet.debit(movement("80.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("insufficient funds throws and does not change state", () => {
    const { wallet } = openWith("100.00");
    const before = wallet.snapshot();
    expect(() => wallet.debit(movement("100.01"))).toThrow(InsufficientFundsError);
    expect(wallet.snapshot()).toEqual(before);
  });

  test("currency mismatch throws and does not change state", () => {
    const { wallet } = openWith("100.00");
    const usd = { ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) };
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("100.00");
  });

  test("zero movements are rejected and do not bump the version", () => {
    const { wallet } = openWith("100.00");
    expect(() => wallet.credit(movement("0.00"))).toThrow(ValidationError);
    expect(() => wallet.debit(movement("0.00"))).toThrow(ValidationError);
    expect(wallet.version).toBe(1);
  });

  test("move dispatches by direction", () => {
    const { wallet } = openWith("10.00");
    expect(wallet.move(LedgerDirection.Credit, movement("5.00")).direction).toBe(LedgerDirection.Credit);
    expect(wallet.move(LedgerDirection.Debit, movement("15.00")).direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.isZero()).toBe(true);
  });
});

describe("Wallet.rehydrate", () => {
  test("rebuilds state without revalidating", () => {
    const wallet = Wallet.rehydrate({
      id: "w",
      playerId: "p",
      currency: "BRL",
      balance: brl("42.00"),
      version: 7,
      createdAt: t0,
      updatedAt: t0,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe("42.00");
  });
});

describe("Wallet invariant: balance == Σ ledger, never negative, version tracks movements", () => {
  // Deterministic PRNG (mulberry32) so failures are reproducible.
  function prng(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("1000 random operations", () => {
    const random = prng(20261105);
    const { wallet, openingEntry } = openWith("100.00");
    const entries: WalletLedgerEntry[] = openingEntry ? [openingEntry] : [];
    let rejected = 0;

    for (let i = 0; i < 1000; i++) {
      const cents = BigInt(1 + Math.floor(random() * 5000));
      const money = Money.ofMinorUnits(cents, "BRL");
      const props = { ledgerEntryId: nextId("entry"), transactionId: nextId("tx"), money, at: t0 };
      if (random() < 0.55) {
        if (wallet.canDebit(money)) entries.push(wallet.debit(props));
        else {
          rejected++;
          expect(() => wallet.debit(props)).toThrow(InsufficientFundsError);
        }
      } else {
        entries.push(wallet.credit(props));
      }
      expect(wallet.balance.isNegative()).toBe(false);
    }

    const sum = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero("BRL"));
    expect(sum.equals(wallet.balance)).toBe(true);
    expect(wallet.version).toBe(entries.length);
    expect(rejected).toBeGreaterThan(0);
    entries.forEach((entry, index) => {
      expect(entry.walletVersion).toBe(index + 1);
      if (index > 0) expect(entry.balanceBefore.equals(entries[index - 1]!.balanceAfter)).toBe(true);
    });
  });
});
