import { describe, expect, test } from "bun:test";
import { InvalidTransactionStateError, InvariantViolationError, ValidationError } from "../../../src/domain/errors";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";
import { FailureCode } from "../../../src/domain/wager/failure-code";
import { VALID_TRANSITIONS, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from "../../../src/domain/wager/kinds";
import { WagerTransaction } from "../../../src/domain/wager/wager-transaction";
import { brl, buildTx, processedTx, T0, txProps } from "../../support/builders";

const ALL_STATUSES = Object.values(Status);

/** Drives a fresh transaction into the given status through valid transitions. */
function inStatus(status: Status): WagerTransaction {
  const tx = buildTx({ kind: Kind.Rollback, referenceExternalTransactionId: "bet-x" });
  switch (status) {
    case Status.Pending:
      break;
    case Status.PendingReference:
      tx.markPendingReference(T0);
      break;
    case Status.Processed:
      tx.markProcessed({ referenceTransactionId: "ref", resultingBalance: brl("1.00"), at: T0 });
      break;
    case Status.Rejected:
      tx.reject(FailureCode.ReferenceNotFound, T0);
      break;
    case Status.Failed:
      tx.fail(FailureCode.InternalInvariantViolation, T0);
      break;
  }
  return tx;
}

function transition(tx: WagerTransaction, to: Status): void {
  switch (to) {
    case Status.Pending:
      throw new InvalidTransactionStateError(tx.status, to); // no API returns to PENDING
    case Status.PendingReference:
      return tx.markPendingReference(T0);
    case Status.Processed:
      return tx.markProcessed({ referenceTransactionId: undefined, resultingBalance: brl("1.00"), at: T0 });
    case Status.Rejected:
      return tx.reject(FailureCode.InsufficientFunds, T0);
    case Status.Failed:
      return tx.fail(FailureCode.InternalInvariantViolation, T0);
  }
}

describe("WagerTransaction state machine", () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const valid = VALID_TRANSITIONS[from].includes(to);
      test(`${from} → ${to} is ${valid ? "valid" : "invalid"}`, () => {
        const tx = inStatus(from);
        if (valid) {
          transition(tx, to);
          expect(tx.status).toBe(to);
        } else {
          expect(() => transition(tx, to)).toThrow(InvalidTransactionStateError);
          expect(tx.status).toBe(from);
        }
      });
    }
  }

  test("terminal states are exactly PROCESSED, REJECTED and FAILED", () => {
    const terminal = ALL_STATUSES.filter((status) => inStatus(status).isTerminal()).sort();
    expect(terminal).toEqual([Status.Failed, Status.Processed, Status.Rejected]);
  });

  test("new transactions are born PENDING", () => {
    expect(buildTx().status).toBe(Status.Pending);
  });

  test("markProcessed records reference, resulting balance and processedAt", () => {
    const tx = buildTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-1" });
    tx.markProcessed({ referenceTransactionId: "internal-bet-1", resultingBalance: brl("100.00"), at: T0 });
    expect(tx.referenceTransactionId).toBe("internal-bet-1");
    expect(tx.resultingBalance?.amount).toBe("100.00");
    expect(tx.processedAt?.toISOString()).toBe(T0.toISOString());
  });

  test("reject records failure code and observed balance", () => {
    const tx = buildTx();
    tx.reject(FailureCode.InsufficientFunds, T0, brl("10.00"));
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.resultingBalance?.amount).toBe("10.00");
  });

  test("reject refuses the FAILED-only code", () => {
    expect(() => buildTx().reject(FailureCode.InternalInvariantViolation, T0)).toThrow(InvariantViolationError);
  });

  test("markPendingReference counts retries only after the first scheduling", () => {
    const tx = buildTx({ kind: Kind.Rollback, referenceExternalTransactionId: "bet-1" });
    const first = new Date(T0.getTime() + 2000);
    tx.markPendingReference(first);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt?.toISOString()).toBe(first.toISOString());
    tx.markPendingReference(new Date(T0.getTime() + 6000));
    tx.markPendingReference(new Date(T0.getTime() + 14000));
    expect(tx.referenceAttempts).toBe(2);
    tx.markProcessed({ referenceTransactionId: "r", resultingBalance: brl("1.00"), at: T0 });
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });
});

describe("WagerTransaction.create validation", () => {
  test.each([
    ["OPENING", { kind: Kind.Opening }],
    ["REFUND without reference", { kind: Kind.Refund }],
    ["ROLLBACK without reference", { kind: Kind.Rollback }],
    ["BET with reference", { kind: Kind.Bet, referenceExternalTransactionId: "other" }],
    ["self reference", { kind: Kind.Refund, externalTransactionId: "same", referenceExternalTransactionId: "same" }],
    ["empty reference", { kind: Kind.Win, referenceExternalTransactionId: "" }],
    ["reserved provider", { providerId: "internal" }],
    ["empty roundId", { roundId: "" }],
    ["empty idempotency key", { idempotencyKey: "" }],
    ["zero BET", { money: brl("0.00") }],
    ["zero WIN", { kind: Kind.Win, money: brl("0.00") }],
    ["zero REFUND", { kind: Kind.Refund, referenceExternalTransactionId: "b", money: brl("0.00") }],
    ["negative amount", { money: brl("0.00").subtract(brl("1.00")) }],
    ["unknown kind", { kind: "JACKPOT" as Kind }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => WagerTransaction.create(txProps(overrides))).toThrow(ValidationError);
  });

  test("LOSS accepts zero (A2) and WIN/LOSS accept an optional reference (A5)", () => {
    expect(buildTx({ kind: Kind.Loss, money: brl("0.00") }).money.isZero()).toBe(true);
    expect(buildTx({ kind: Kind.Win, referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(true);
    expect(buildTx({ kind: Kind.Loss, referenceExternalTransactionId: "bet-1" }).hasReference()).toBe(true);
    expect(buildTx({ kind: Kind.Win }).hasReference()).toBe(false);
  });
});

describe("WagerTransaction queries", () => {
  test("affectsBalance is false only for LOSS", () => {
    expect(buildTx({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(buildTx({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(buildTx({ kind: Kind.Win }).affectsBalance()).toBe(true);
  });

  test("requiresReference is true for REFUND and ROLLBACK", () => {
    expect(buildTx({ kind: Kind.Refund, referenceExternalTransactionId: "b" }).requiresReference()).toBe(true);
    expect(buildTx({ kind: Kind.Rollback, referenceExternalTransactionId: "b" }).requiresReference()).toBe(true);
    expect(buildTx({ kind: Kind.Win }).requiresReference()).toBe(false);
    expect(buildTx({ kind: Kind.Bet }).requiresReference()).toBe(false);
  });

  test("matchesPayload compares the payload hash", () => {
    const tx = buildTx({ payloadHash: "f".repeat(64) });
    expect(tx.matchesPayload("f".repeat(64))).toBe(true);
    expect(tx.matchesPayload("e".repeat(64))).toBe(false);
  });

  test.each([
    ["BET", Kind.Bet, undefined, LedgerDirection.Debit],
    ["WIN", Kind.Win, undefined, LedgerDirection.Credit],
    ["REFUND", Kind.Refund, undefined, LedgerDirection.Credit],
    ["ROLLBACK(BET)", Kind.Rollback, Kind.Bet, LedgerDirection.Credit],
    ["ROLLBACK(WIN)", Kind.Rollback, Kind.Win, LedgerDirection.Debit],
    ["ROLLBACK(REFUND)", Kind.Rollback, Kind.Refund, LedgerDirection.Debit],
  ])("ledgerDirectionFor %s", (_label, kind, referenceKind, expected) => {
    const needsRef = kind === Kind.Refund || kind === Kind.Rollback;
    const tx = buildTx({ kind, ...(needsRef ? { referenceExternalTransactionId: "ref" } : {}) });
    const reference = referenceKind
      ? processedTx({
          kind: referenceKind,
          ...(referenceKind === Kind.Refund ? { referenceExternalTransactionId: "bet" } : {}),
        })
      : undefined;
    expect(tx.ledgerDirectionFor(reference)).toBe(expected);
  });

  test("ledgerDirectionFor rejects LOSS, ROLLBACK without reference and ROLLBACK of LOSS/ROLLBACK", () => {
    expect(() => buildTx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvariantViolationError);
    const rollback = buildTx({ kind: Kind.Rollback, referenceExternalTransactionId: "r" });
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvariantViolationError);
    expect(() => rollback.ledgerDirectionFor(processedTx({ kind: Kind.Loss }))).toThrow(InvariantViolationError);
    expect(() =>
      rollback.ledgerDirectionFor(processedTx({ kind: Kind.Rollback, referenceExternalTransactionId: "x" })),
    ).toThrow(InvariantViolationError);
  });
});

describe("OPENING transaction (A17)", () => {
  test("is internal, already PROCESSED and credits the opening balance", () => {
    const tx = WagerTransaction.createOpening({
      id: "tx-open",
      walletId: "w-1",
      playerId: "p-1",
      money: brl("1000.00"),
      payloadHash: "b".repeat(64),
      at: T0,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.providerId).toBe("internal");
    expect(tx.externalTransactionId).toBe("opening:w-1");
    expect(tx.idempotencyKey).toBe("internal:opening:w-1");
    expect(tx.roundId).toBeUndefined();
    expect(tx.status).toBe(Status.Processed);
    expect(tx.resultingBalance?.amount).toBe("1000.00");
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe("rehydrate", () => {
  test("rebuilds terminal state without revalidating", () => {
    const original = processedTx();
    const copy = WagerTransaction.rehydrate(original.snapshot());
    expect(copy.snapshot()).toEqual(original.snapshot());
    expect(copy.isTerminal()).toBe(true);
  });
});
