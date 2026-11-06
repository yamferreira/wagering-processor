import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../../src/domain/errors";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../../src/domain/money/money";
import { applyDecision } from "../../../src/domain/wager/apply-decision";
import { type Decision, decide, type ReferenceLookup } from "../../../src/domain/wager/decide";
import { FailureCode } from "../../../src/domain/wager/failure-code";
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from "../../../src/domain/wager/kinds";
import { ReferenceRetryPolicy } from "../../../src/domain/wager/reference-retry-policy";
import { WagerTransaction } from "../../../src/domain/wager/wager-transaction";
import { brl, buildTx, buildWallet, nextId, processedTx, T0, usd } from "../../support/builders";

const WALLET_ID = "wallet-1";
const wallet = (amount = "100.00") => buildWallet(amount, { id: WALLET_ID });
const found = (reference: WagerTransaction, alreadyReversed = false): ReferenceLookup => ({
  found: true,
  reference,
  alreadyReversed,
});
const notFound: ReferenceLookup = { found: false };

const bet = (overrides = {}) => processedTx({ kind: Kind.Bet, externalTransactionId: "bet-1", ...overrides });
const win = (overrides = {}) => processedTx({ kind: Kind.Win, externalTransactionId: "win-1", ...overrides });
const refund = (overrides = {}) =>
  processedTx({ kind: Kind.Refund, externalTransactionId: "refund-1", referenceExternalTransactionId: "bet-1", ...overrides });
const referencing = (kind: Kind, ref = "bet-1", overrides = {}) =>
  buildTx({ kind, referenceExternalTransactionId: ref, ...overrides });

const rejectedWith = (code: FailureCode) => expect.objectContaining({ type: "REJECT", code });

describe("decide — wallet-level rules", () => {
  test("player that does not own the wallet → WALLET_PLAYER_MISMATCH", () => {
    expect(decide(buildTx({ playerId: "someone-else" }), wallet(), undefined)).toEqual(
      rejectedWith(FailureCode.WalletPlayerMismatch),
    );
  });

  test("currency conflict with the wallet → CURRENCY_MISMATCH", () => {
    expect(decide(buildTx({ money: usd("10.00") }), wallet(), undefined)).toEqual(
      rejectedWith(FailureCode.CurrencyMismatch),
    );
  });

  test("evaluating against another wallet is a programming error", () => {
    expect(() => decide(buildTx({ walletId: "other" }), wallet(), undefined)).toThrow(InvariantViolationError);
  });

  test("a reference without lookup is a programming error", () => {
    expect(() => decide(referencing(Kind.Refund), wallet(), undefined)).toThrow(InvariantViolationError);
  });
});

describe("decide — BET", () => {
  test("debits when the balance is sufficient (including the exact balance)", () => {
    expect(decide(buildTx({ money: brl("100.00") }), wallet(), undefined)).toEqual({
      type: "APPLY",
      direction: LedgerDirection.Debit,
      reference: undefined,
    });
  });

  test("insufficient balance → INSUFFICIENT_FUNDS", () => {
    expect(decide(buildTx({ money: brl("100.01") }), wallet(), undefined)).toEqual(
      rejectedWith(FailureCode.InsufficientFunds),
    );
  });

  test("§8 scenario at the domain level: 100.00 and two bets of 80.00", () => {
    const w = wallet("100.00");
    const policy = ReferenceRetryPolicy.default();
    const first = buildTx({ money: brl("80.00") });
    const second = buildTx({ money: brl("80.00") });
    const outcomes = [first, second].map((tx) =>
      applyDecision(tx, w, decide(tx, w, undefined), { ledgerEntryId: nextId("e"), at: T0, retryPolicy: policy }),
    );
    expect(outcomes.map((o) => o.status)).toEqual([Status.Processed, Status.Rejected]);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(w.balance.amount).toBe("20.00");
  });
});

describe("decide — WIN", () => {
  test("without reference credits the wallet", () => {
    expect(decide(buildTx({ kind: Kind.Win }), wallet(), undefined)).toEqual({
      type: "APPLY",
      direction: LedgerDirection.Credit,
      reference: undefined,
    });
  });

  test("referencing a processed BET of the same round credits and links the reference", () => {
    const reference = bet();
    const decision = decide(referencing(Kind.Win), wallet(), found(reference));
    expect(decision).toEqual({ type: "APPLY", direction: LedgerDirection.Credit, reference });
  });

  test("WIN amount does not need to match the BET (A5)", () => {
    const decision = decide(referencing(Kind.Win, "bet-1", { money: brl("500.00") }), wallet(), found(bet()));
    expect(decision.type).toBe("APPLY");
  });

  test("missing reference → PENDING_REFERENCE", () => {
    expect(decide(referencing(Kind.Win), wallet(), notFound)).toEqual({ type: "PENDING_REFERENCE", waitingFor: "REFERENCE_MISSING" });
  });

  test("referencing a non-BET → REFERENCE_KIND_NOT_ALLOWED", () => {
    expect(decide(referencing(Kind.Win, "win-1"), wallet(), found(win()))).toEqual(
      rejectedWith(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("referencing an already reversed BET → REFERENCE_ALREADY_REVERSED (A6)", () => {
    expect(decide(referencing(Kind.Win), wallet(), found(bet(), true))).toEqual(
      rejectedWith(FailureCode.ReferenceAlreadyReversed),
    );
  });
});

describe("decide — LOSS", () => {
  test("records the outcome without moving the balance", () => {
    expect(decide(buildTx({ kind: Kind.Loss, money: brl("0.00") }), wallet(), undefined)).toEqual({
      type: "RECORD_ONLY",
      reference: undefined,
    });
  });

  test("with a valid reference links it", () => {
    const reference = bet();
    expect(decide(referencing(Kind.Loss), wallet(), found(reference))).toEqual({ type: "RECORD_ONLY", reference });
  });

  test("with a missing reference waits", () => {
    expect(decide(referencing(Kind.Loss), wallet(), notFound)).toEqual({ type: "PENDING_REFERENCE", waitingFor: "REFERENCE_MISSING" });
  });
});

describe("decide — REFUND", () => {
  test("of a processed BET credits the same amount", () => {
    const reference = bet();
    expect(decide(referencing(Kind.Refund), wallet(), found(reference))).toEqual({
      type: "APPLY",
      direction: LedgerDirection.Credit,
      reference,
    });
  });

  test("of a WIN → REFERENCE_KIND_NOT_ALLOWED", () => {
    expect(decide(referencing(Kind.Refund, "win-1"), wallet(), found(win()))).toEqual(
      rejectedWith(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("with a different amount → REFERENCE_AMOUNT_MISMATCH", () => {
    expect(decide(referencing(Kind.Refund, "bet-1", { money: brl("10.00") }), wallet(), found(bet()))).toEqual(
      rejectedWith(FailureCode.ReferenceAmountMismatch),
    );
  });

  test("of an already reversed BET → REFERENCE_ALREADY_REVERSED", () => {
    expect(decide(referencing(Kind.Refund), wallet(), found(bet(), true))).toEqual(
      rejectedWith(FailureCode.ReferenceAlreadyReversed),
    );
  });

  test("missing reference → PENDING_REFERENCE", () => {
    expect(decide(referencing(Kind.Refund), wallet(), notFound)).toEqual({ type: "PENDING_REFERENCE", waitingFor: "REFERENCE_MISSING" });
  });

  test("reference still pending → waits (A7)", () => {
    const pending = buildTx({ kind: Kind.Bet, externalTransactionId: "bet-1" });
    expect(decide(referencing(Kind.Refund), wallet(), found(pending))).toEqual({
      type: "PENDING_REFERENCE",
      waitingFor: "REFERENCE_IN_FLIGHT",
    });
  });

  test("reference rejected → REFERENCE_NOT_PROCESSED (A7)", () => {
    const rejected = buildTx({ kind: Kind.Bet, externalTransactionId: "bet-1" });
    rejected.reject(FailureCode.InsufficientFunds, T0, brl("0.00"));
    expect(decide(referencing(Kind.Refund), wallet(), found(rejected))).toEqual(
      rejectedWith(FailureCode.ReferenceNotProcessed),
    );
  });

  test("reference failed → REFERENCE_NOT_PROCESSED", () => {
    const failed = buildTx({ kind: Kind.Bet, externalTransactionId: "bet-1" });
    failed.fail(FailureCode.InternalInvariantViolation, T0);
    expect(decide(referencing(Kind.Refund), wallet(), found(failed))).toEqual(
      rejectedWith(FailureCode.ReferenceNotProcessed),
    );
  });
});

describe("decide — ROLLBACK", () => {
  test("of a BET credits", () => {
    expect(decide(referencing(Kind.Rollback), wallet(), found(bet()))).toEqual(
      expect.objectContaining({ type: "APPLY", direction: LedgerDirection.Credit }),
    );
  });

  test("of a WIN debits", () => {
    expect(decide(referencing(Kind.Rollback, "win-1"), wallet(), found(win()))).toEqual(
      expect.objectContaining({ type: "APPLY", direction: LedgerDirection.Debit }),
    );
  });

  test("of a REFUND debits", () => {
    expect(decide(referencing(Kind.Rollback, "refund-1"), wallet(), found(refund()))).toEqual(
      expect.objectContaining({ type: "APPLY", direction: LedgerDirection.Debit }),
    );
  });

  test("that would make the balance negative → REVERSAL_INSUFFICIENT_FUNDS (distinct from a bet)", () => {
    const decision = decide(referencing(Kind.Rollback, "win-1"), wallet("10.00"), found(win()));
    expect(decision).toEqual(rejectedWith(FailureCode.ReversalInsufficientFunds));
  });

  test.each([
    ["LOSS", () => processedTx({ kind: Kind.Loss, externalTransactionId: "loss-1" })],
    ["ROLLBACK", () => processedTx({ kind: Kind.Rollback, externalTransactionId: "rb-1", referenceExternalTransactionId: "x" })],
    [
      "OPENING",
      () =>
        WagerTransaction.createOpening({
          id: "open",
          walletId: WALLET_ID,
          playerId: "player-1",
          money: brl("1.00"),
          payloadHash: "c".repeat(64),
          at: T0,
        }),
    ],
  ])("of a %s → REFERENCE_KIND_NOT_ALLOWED", (_label, makeReference) => {
    expect(decide(referencing(Kind.Rollback, "whatever"), wallet(), found(makeReference()))).toEqual(
      rejectedWith(FailureCode.ReferenceKindNotAllowed),
    );
  });

  test("of an already reversed transaction → REFERENCE_ALREADY_REVERSED", () => {
    expect(decide(referencing(Kind.Rollback), wallet(), found(bet(), true))).toEqual(
      rejectedWith(FailureCode.ReferenceAlreadyReversed),
    );
  });

  test("with a different amount → REFERENCE_AMOUNT_MISMATCH", () => {
    expect(decide(referencing(Kind.Rollback, "bet-1", { money: brl("1.00") }), wallet(), found(bet()))).toEqual(
      rejectedWith(FailureCode.ReferenceAmountMismatch),
    );
  });
});

describe("decide — reference must belong to the same provider, player, wallet, currency and round", () => {
  test.each([
    ["providerId", { providerId: "provider-b" }],
    ["playerId", { playerId: "player-2" }],
    ["walletId", { walletId: "wallet-2" }],
    ["currency", { money: usd("25.00") }],
    ["roundId", { roundId: "round-2" }],
  ])("%s mismatch → REFERENCE_MISMATCH", (field, overrides) => {
    const decision = decide(referencing(Kind.Refund), wallet(), found(bet(overrides)));
    expect(decision as unknown).toEqual({ type: "REJECT", code: FailureCode.ReferenceMismatch, details: { field } });
  });
});

describe("applyDecision", () => {
  const policy = ReferenceRetryPolicy.of({ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 3000 });
  const ctx = () => ({ ledgerEntryId: nextId("entry"), at: T0, retryPolicy: policy });

  test("APPLY moves the balance, creates one entry and stores the resulting balance", () => {
    const w = wallet("100.00");
    const tx = buildTx({ money: brl("25.00") });
    const outcome = applyDecision(tx, w, decide(tx, w, undefined), ctx());
    expect(outcome.status).toBe(Status.Processed);
    if (outcome.status !== Status.Processed) throw new Error("unreachable");
    expect(outcome.ledgerEntry?.transactionId).toBe(tx.id);
    expect(outcome.ledgerEntry?.balanceAfter.amount).toBe("75.00");
    expect(tx.resultingBalance?.amount).toBe("75.00");
    expect(w.version).toBe(2);
  });

  test("REJECT changes nothing in the wallet and produces no entry", () => {
    const w = wallet("10.00");
    const before = w.snapshot();
    const tx = buildTx({ money: brl("25.00") });
    const outcome = applyDecision(tx, w, decide(tx, w, undefined), ctx());
    expect(outcome).toEqual({ status: Status.Rejected, code: FailureCode.InsufficientFunds });
    expect(w.snapshot()).toEqual(before);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.resultingBalance?.amount).toBe("10.00");
  });

  test("RECORD_ONLY (LOSS) processes without an entry and without bumping the version", () => {
    const w = wallet("10.00");
    const tx = buildTx({ kind: Kind.Loss, money: brl("0.00") });
    const outcome = applyDecision(tx, w, decide(tx, w, undefined), ctx());
    expect(outcome).toEqual({ status: Status.Processed, ledgerEntry: undefined });
    expect(w.version).toBe(1);
  });

  test("ROLLBACK of a BET restores the balance and links the internal reference id", () => {
    const w = wallet("100.00");
    const reference = bet();
    const tx = referencing(Kind.Rollback);
    applyDecision(tx, w, decide(tx, w, found(reference)), ctx());
    expect(w.balance.equals(Money.from({ amount: "125.00", currency: "BRL" }))).toBe(true);
    expect(tx.referenceTransactionId).toBe(reference.id);
  });

  test("PENDING_REFERENCE schedules with backoff and rejects REFERENCE_NOT_FOUND when exhausted", () => {
    const w = wallet();
    const tx = referencing(Kind.Refund);
    const decision: Decision = { type: "PENDING_REFERENCE", waitingFor: "REFERENCE_MISSING" };
    const first = applyDecision(tx, w, decision, ctx());
    expect(first).toEqual({ status: Status.PendingReference, nextAttemptAt: new Date(T0.getTime() + 1000) });
    const retry1 = applyDecision(tx, w, decision, ctx());
    expect(retry1).toEqual({ status: Status.PendingReference, nextAttemptAt: new Date(T0.getTime() + 2000) });
    const retry2 = applyDecision(tx, w, decision, ctx());
    expect(retry2).toEqual({ status: Status.PendingReference, nextAttemptAt: new Date(T0.getTime() + 3000) });
    const retry3 = applyDecision(tx, w, decision, ctx());
    expect(retry3).toEqual({ status: Status.Rejected, code: FailureCode.ReferenceNotFound });
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(w.version).toBe(1);
  });
  test("a reference that exists but is still pending never spends attempts nor exhausts the budget", () => {
    const w = wallet();
    const tx = referencing(Kind.Rollback, "win-1");
    const decision: Decision = { type: "PENDING_REFERENCE", waitingFor: "REFERENCE_IN_FLIGHT" };
    for (let round = 0; round < 10; round++) {
      const outcome = applyDecision(tx, w, decision, ctx());
      // Re-checked at the backoff cap as a safety net; the wake-up resolves it when the reference ends.
      expect(outcome).toEqual({ status: Status.PendingReference, nextAttemptAt: new Date(T0.getTime() + policy.maxDelayMs) });
    }
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
  });

  test("attempts spent while the reference was missing are kept when it shows up still pending", () => {
    const w = wallet();
    const tx = referencing(Kind.Rollback, "win-1");
    applyDecision(tx, w, { type: "PENDING_REFERENCE", waitingFor: "REFERENCE_MISSING" }, ctx());
    applyDecision(tx, w, { type: "PENDING_REFERENCE", waitingFor: "REFERENCE_MISSING" }, ctx());
    expect(tx.referenceAttempts).toBe(1);
    applyDecision(tx, w, { type: "PENDING_REFERENCE", waitingFor: "REFERENCE_IN_FLIGHT" }, ctx());
    expect(tx.referenceAttempts).toBe(1);
  });
});

describe("ReferenceRetryPolicy", () => {
  test("default is 10 retries, 2s base, 5 min cap (≈18.5 min until rejection)", () => {
    const policy = ReferenceRetryPolicy.default();
    const delays = Array.from({ length: 10 }, (_, n) => policy.delayMs(n));
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(1_110_000);
    expect(policy.isExhausted(9)).toBe(false);
    expect(policy.isExhausted(10)).toBe(true);
  });

  test("rejects invalid configuration", () => {
    expect(() => ReferenceRetryPolicy.of({ maxAttempts: 0, baseDelayMs: 1, maxDelayMs: 1 })).toThrow();
    expect(() => ReferenceRetryPolicy.of({ maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 5 })).toThrow();
  });
});
