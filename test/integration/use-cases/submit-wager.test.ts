import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError, TransientInfrastructureError, TransientReason } from "../../../src/application/errors";
import { InjectedFaultError } from "../../../src/application/ports/fault-injector";
import { InternalProcessingError } from "../../../src/application/use-cases/submit-wager-transaction";
import { ValidationError } from "../../../src/domain/errors";
import { InvalidMoneyError } from "../../../src/domain/money/money.errors";
import { FailureCode } from "../../../src/domain/wager/failure-code";
import { IdempotencyConflictError, IdempotencyConflictReason } from "../../../src/domain/wager/idempotency";
import { WagerTransactionStatus as Status } from "../../../src/domain/wager/kinds";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import { assertLedgerInvariant } from "../../support/invariants";
import { countRows, ledgerRows, outboxEventTypes, transactionRows, walletRow } from "../../support/inspect";
import { createUseCaseHarness, CTX, type UseCaseHarness, wagerCommand } from "../../support/use-cases";

let h: UseCaseHarness;

beforeAll(async () => {
  h = await createUseCaseHarness();
});

beforeEach(() => {
  h.faults.reset();
});

afterEach(async () => {
  await assertLedgerInvariant(h.db.sql);
});

afterAll(async () => {
  await h.close();
});

async function wallet(amount = "100.00", currency = "BRL"): Promise<Wallet> {
  return h.createWallet.execute(
    { playerId: `player-${Bun.randomUUIDv7()}`, initialBalance: { amount, currency } },
    CTX,
  );
}

const money = (amount: string, currency = "BRL") => ({ amount, currency });

describe("BET", () => {
  test("debits, writes one DEBIT entry and the Processed + BalanceChanged events", async () => {
    const w = await wallet("100.00");
    const { transaction, replay } = await h.submit.execute(wagerCommand(w, { money: money("25.00") }), CTX);
    expect(replay).toBe(false);
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.resultingBalance?.amount).toBe("75.00");
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "75.00", version: 2 });
    const ledger = await ledgerRows(h.db.sql, w.id);
    expect(ledger.at(-1)).toEqual(
      expect.objectContaining({ wallet_version: 2, direction: "DEBIT", amount: "25.00", transaction_id: transaction.id }),
    );
    expect(await outboxEventTypes(h.db.sql, [transaction.id])).toEqual(["WagerTransactionProcessed"]);
    const [balanceEvent] = await h.db.sql`
      SELECT payload FROM outbox_messages WHERE event_type = 'WalletBalanceChanged' AND payload->'data'->>'transactionId' = ${transaction.id}`;
    expect(balanceEvent.payload.data).toMatchObject({ walletVersion: 2, balanceAfter: money("75.00") });
  });

  test("insufficient funds → REJECTED, auditable, no ledger, no balance change, Rejected event", async () => {
    const w = await wallet("10.00");
    const { transaction } = await h.submit.execute(wagerCommand(w, { money: money("10.01") }), CTX);
    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.resultingBalance?.amount).toBe("10.00");
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "10.00", version: 1 });
    expect(await ledgerRows(h.db.sql, w.id)).toHaveLength(1); // only the opening credit
    expect(await outboxEventTypes(h.db.sql, [transaction.id])).toEqual(["WagerTransactionRejected"]);
  });
});

describe("WIN / LOSS", () => {
  test("WIN credits", async () => {
    const w = await wallet("0.00");
    const { transaction } = await h.submit.execute(wagerCommand(w, { kind: "WIN", money: money("50.00") }), CTX);
    expect(transaction.status).toBe(Status.Processed);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "50.00", version: 2 });
  });

  test("LOSS is processed without a ledger entry or a balance event", async () => {
    const w = await wallet("10.00");
    const bet = await h.submit.execute(wagerCommand(w, { externalTransactionId: `bet-${w.id}`, money: money("5.00") }), CTX);
    const { transaction } = await h.submit.execute(
      wagerCommand(w, { kind: "LOSS", money: money("0.00"), referenceExternalTransactionId: `bet-${w.id}` }),
      CTX,
    );
    expect(transaction.status).toBe(Status.Processed);
    expect(transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "5.00", version: 2 });
    expect(await ledgerRows(h.db.sql, w.id)).toHaveLength(2);
    expect(await outboxEventTypes(h.db.sql, [transaction.id])).toEqual(["WagerTransactionProcessed"]);
    expect(
      await countRows(h.db.sql, "outbox_messages", `event_type = 'WalletBalanceChanged' AND payload->'data'->>'transactionId' = '${transaction.id}'`),
    ).toBe(0);
  });
});

describe("REFUND / ROLLBACK", () => {
  async function placeBet(w: Wallet, amount: string) {
    const externalTransactionId = `bet-${Bun.randomUUIDv7()}`;
    const result = await h.submit.execute(wagerCommand(w, { externalTransactionId, money: money(amount) }), CTX);
    return { ...result, externalTransactionId };
  }

  test("REFUND of a BET restores the balance; a second reversal is REFERENCE_ALREADY_REVERSED", async () => {
    const w = await wallet("100.00");
    const bet = await placeBet(w, "40.00");
    const refund = await h.submit.execute(
      wagerCommand(w, { kind: "REFUND", money: money("40.00"), referenceExternalTransactionId: bet.externalTransactionId }),
      CTX,
    );
    expect(refund.transaction.status).toBe(Status.Processed);
    expect(refund.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "100.00", version: 3 });

    for (const kind of ["REFUND", "ROLLBACK"]) {
      const again = await h.submit.execute(
        wagerCommand(w, { kind, money: money("40.00"), referenceExternalTransactionId: bet.externalTransactionId }),
        CTX,
      );
      expect(again.transaction.status).toBe(Status.Rejected);
      expect(again.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    }
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "100.00", version: 3 });
  });

  test("ROLLBACK of a WIN debits; when it would go negative → REVERSAL_INSUFFICIENT_FUNDS", async () => {
    const w = await wallet("0.00");
    const winId = `win-${Bun.randomUUIDv7()}`;
    await h.submit.execute(wagerCommand(w, { kind: "WIN", externalTransactionId: winId, money: money("30.00") }), CTX);
    await placeBet(w, "20.00"); // balance 10.00
    const rollback = await h.submit.execute(
      wagerCommand(w, { kind: "ROLLBACK", money: money("30.00"), referenceExternalTransactionId: winId }),
      CTX,
    );
    expect(rollback.transaction.status).toBe(Status.Rejected);
    expect(rollback.transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "10.00", version: 3 });

    await h.submit.execute(wagerCommand(w, { kind: "WIN", money: money("25.00") }), CTX); // balance 35.00
    const ok = await h.submit.execute(
      wagerCommand(w, { kind: "ROLLBACK", money: money("30.00"), referenceExternalTransactionId: winId }),
      CTX,
    );
    expect(ok.transaction.status).toBe(Status.Processed);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "5.00", version: 5 });
  });

  test("BET → REFUND → ROLLBACK(REFUND) chain, then the BET cannot be refunded again", async () => {
    const w = await wallet("100.00");
    const bet = await placeBet(w, "10.00");
    const refundId = `refund-${Bun.randomUUIDv7()}`;
    await h.submit.execute(
      wagerCommand(w, {
        kind: "REFUND",
        externalTransactionId: refundId,
        money: money("10.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      CTX,
    );
    const rollback = await h.submit.execute(
      wagerCommand(w, { kind: "ROLLBACK", money: money("10.00"), referenceExternalTransactionId: refundId }),
      CTX,
    );
    expect(rollback.transaction.status).toBe(Status.Processed);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "90.00", version: 4 });
    const again = await h.submit.execute(
      wagerCommand(w, { kind: "REFUND", money: money("10.00"), referenceExternalTransactionId: bet.externalTransactionId }),
      CTX,
    );
    expect(again.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test("WIN on a reversed BET → REFERENCE_ALREADY_REVERSED (A6); WIN on a live BET is allowed", async () => {
    const w = await wallet("100.00");
    const live = await placeBet(w, "10.00");
    const win = await h.submit.execute(
      wagerCommand(w, { kind: "WIN", money: money("30.00"), referenceExternalTransactionId: live.externalTransactionId }),
      CTX,
    );
    expect(win.transaction.status).toBe(Status.Processed);

    const reversed = await placeBet(w, "10.00");
    await h.submit.execute(
      wagerCommand(w, { kind: "ROLLBACK", money: money("10.00"), referenceExternalTransactionId: reversed.externalTransactionId }),
      CTX,
    );
    const lateWin = await h.submit.execute(
      wagerCommand(w, { kind: "WIN", money: money("30.00"), referenceExternalTransactionId: reversed.externalTransactionId }),
      CTX,
    );
    expect(lateWin.transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
  });

  test("REFUND before its BET → PENDING_REFERENCE with event and no balance change", async () => {
    const w = await wallet("100.00");
    const { transaction } = await h.submit.execute(
      wagerCommand(w, { kind: "REFUND", money: money("10.00"), referenceExternalTransactionId: "bet-not-yet" }),
      CTX,
    );
    expect(transaction.status).toBe(Status.PendingReference);
    expect(transaction.resultingBalance).toBeUndefined();
    expect(transaction.nextReferenceAttemptAt).toBeInstanceOf(Date);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "100.00", version: 1 });
    expect(await outboxEventTypes(h.db.sql, [transaction.id])).toEqual(["WagerTransactionPendingReference"]);
  });

  test("reference in another wallet / round → REFERENCE_MISMATCH", async () => {
    const a = await wallet("100.00");
    const b = await wallet("100.00");
    const bet = await placeBet(a, "10.00");
    const crossWallet = await h.submit.execute(
      wagerCommand(b, { kind: "REFUND", money: money("10.00"), referenceExternalTransactionId: bet.externalTransactionId }),
      CTX,
    );
    expect(crossWallet.transaction.failureCode).toBe(FailureCode.ReferenceMismatch);
    const crossRound = await h.submit.execute(
      wagerCommand(a, {
        kind: "REFUND",
        roundId: "round-other",
        money: money("10.00"),
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
      CTX,
    );
    expect(crossRound.transaction.failureCode).toBe(FailureCode.ReferenceMismatch);
  });
});

describe("wallet-level validation", () => {
  test("currency conflict with the wallet → REJECTED CURRENCY_MISMATCH, observed balance in the wallet currency", async () => {
    const w = await wallet("100.00");
    const { transaction } = await h.submit.execute(wagerCommand(w, { money: money("10.00", "USD") }), CTX);
    expect(transaction.status).toBe(Status.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(transaction.resultingBalance?.toJSON()).toEqual(money("100.00"));
  });

  test("player that does not own the wallet → WALLET_PLAYER_MISMATCH", async () => {
    const w = await wallet("100.00");
    const { transaction } = await h.submit.execute(wagerCommand(w, { playerId: "intruder" }), CTX);
    expect(transaction.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });

  test("unknown wallet → NotFoundError, nothing persisted (A9)", async () => {
    const ghost = { id: Bun.randomUUIDv7(), playerId: "nobody" };
    const command = wagerCommand(ghost);
    expect(await h.submit.execute(command, CTX).catch((e) => e)).toBeInstanceOf(NotFoundError);
    expect(await countRows(h.db.sql, "wager_transactions", `idempotency_key = '${command.idempotencyKey}'`)).toBe(0);
  });

  test("invalid payloads are rejected before the database (400 class)", async () => {
    const w = await wallet("100.00");
    expect(await h.submit.execute(wagerCommand(w, { money: money("1e2") }), CTX).catch((e) => e)).toBeInstanceOf(
      InvalidMoneyError,
    );
    expect(await h.submit.execute(wagerCommand(w, { kind: "OPENING" }), CTX).catch((e) => e)).toBeInstanceOf(
      ValidationError,
    );
    expect(await h.submit.execute(wagerCommand(w, { providerId: "internal" }), CTX).catch((e) => e)).toBeInstanceOf(
      ValidationError,
    );
    expect(await h.submit.execute(wagerCommand(w, { kind: "REFUND" }), CTX).catch((e) => e)).toBeInstanceOf(
      ValidationError,
    );
    expect(await h.submit.execute(wagerCommand(w, { money: money("1.00", "JPY") }), CTX).catch((e) => e)).toBeInstanceOf(
      ValidationError,
    );
  });
});

describe("idempotency", () => {
  test("replay returns the original result, including the balance observed at that moment", async () => {
    const w = await wallet("100.00");
    const command = wagerCommand(w, { money: money("30.00") });
    const original = await h.submit.execute(command, CTX);
    await h.submit.execute(wagerCommand(w, { money: money("50.00") }), CTX);
    const replay = await h.submit.execute(command, CTX);
    expect(replay.replay).toBe(true);
    expect(replay.transaction.id).toBe(original.transaction.id);
    expect(replay.transaction.resultingBalance?.amount).toBe("70.00");
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "20.00", version: 3 });
  });

  test("replay of a rejection is the same rejection", async () => {
    const w = await wallet("1.00");
    const command = wagerCommand(w, { money: money("5.00") });
    const first = await h.submit.execute(command, CTX);
    const again = await h.submit.execute(command, CTX);
    expect(again.replay).toBe(true);
    expect(again.transaction.id).toBe(first.transaction.id);
    expect(again.transaction.failureCode).toBe(FailureCode.InsufficientFunds);
  });

  test("same key with a different payload → conflict, never replay", async () => {
    const w = await wallet("100.00");
    const command = wagerCommand(w, { money: money("10.00") });
    await h.submit.execute(command, CTX);
    const error = await h.submit.execute({ ...command, money: money("10.01") }, CTX).catch((e) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).reason).toBe(IdempotencyConflictReason.PayloadMismatch);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "90.00", version: 2 });
  });

  test("same provider + external id under another key → conflict (A13)", async () => {
    const w = await wallet("100.00");
    const command = wagerCommand(w);
    await h.submit.execute(command, CTX);
    const error = await h.submit.execute({ ...command, idempotencyKey: "other-key" }, CTX).catch((e) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as IdempotencyConflictError).reason).toBe(IdempotencyConflictReason.ExternalTransactionReused);
  });

  test("20 identical requests in parallel → one debit, one new result, 19 replays", async () => {
    const w = await wallet("100.00");
    const command = wagerCommand(w, { money: money("10.00") });
    const results = await Promise.all(Array.from({ length: 20 }, () => h.submit.execute(command, CTX)));
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "90.00", version: 2 });
    expect(await ledgerRows(h.db.sql, w.id)).toHaveLength(2);
  });

  test("same key raced on two different wallets: the UNIQUE constraint decides, the loser gets a conflict", async () => {
    const a = await wallet("100.00");
    const b = await wallet("100.00");
    const base = wagerCommand(a, { money: money("10.00") });
    const onB = { ...base, walletId: b.id, playerId: b.playerId };
    // The first request to insert holds its uncommitted row for 300 ms, so the second one passes both
    // idempotency checks, blocks on the unique index and then fails with 23505 → re-read → conflict.
    h.faults.arm("submit:after-transaction-insert", () => Bun.sleep(300));
    const first = h.submit.execute(base, CTX);
    await Bun.sleep(100);
    const outcomes = await Promise.allSettled([first, h.submit.execute(onB, CTX)]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(IdempotencyConflictError);
    expect(await countRows(h.db.sql, "wager_transactions", `idempotency_key = '${base.idempotencyKey}'`)).toBe(1);
    const balances = [(await walletRow(h.db.sql, a.id))!.balance, (await walletRow(h.db.sql, b.id))!.balance].sort();
    expect(balances).toEqual(["100.00", "90.00"]);
  });

  test("§8 smoke: 100.00 and two concurrent bets of 80.00", async () => {
    const w = await wallet("100.00");
    const results = await Promise.all([
      h.submit.execute(wagerCommand(w, { money: money("80.00") }), CTX),
      h.submit.execute(wagerCommand(w, { money: money("80.00") }), CTX),
    ]);
    expect(results.map((r) => r.transaction.status).sort()).toEqual([Status.Processed, Status.Rejected]);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "20.00", version: 2 });
  });
});

describe("atomicity and failure handling", () => {
  test.each([
    "submit:after-transaction-insert",
    "submit:after-ledger-insert",
    "submit:before-outbox-insert",
  ] as const)("a crash at %s leaves nothing behind; a retry applies exactly once", async (point) => {
    const w = await wallet("100.00");
    const command = wagerCommand(w, { money: money("10.00") });
    h.faults.throwAt(point, () => new InjectedFaultError(point));
    expect(await h.submit.execute(command, CTX).catch((e) => e)).toBeInstanceOf(InjectedFaultError);
    expect(await countRows(h.db.sql, "wager_transactions", `idempotency_key = '${command.idempotencyKey}'`)).toBe(0);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "100.00", version: 1 });
    expect(await ledgerRows(h.db.sql, w.id)).toHaveLength(1);
    expect(await countRows(h.db.sql, "outbox_messages", `payload->'data'->>'walletId' = '${w.id}'`)).toBe(2); // opening only

    const retry = await h.submit.execute(command, CTX);
    expect(retry.replay).toBe(false);
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "90.00", version: 2 });
  });

  test("a transient failure propagates as transient and persists nothing", async () => {
    const w = await wallet("100.00");
    const command = wagerCommand(w);
    h.faults.throwAt(
      "submit:before-outbox-insert",
      () => new TransientInfrastructureError(TransientReason.ConnectionFailure, "db gone"),
    );
    expect(await h.submit.execute(command, CTX).catch((e) => e)).toBeInstanceOf(TransientInfrastructureError);
    expect(await countRows(h.db.sql, "wager_transactions", `idempotency_key = '${command.idempotencyKey}'`)).toBe(0);
  });

  test("a permanent internal error is recorded as FAILED (A16) and replays as FAILED", async () => {
    const w = await wallet("100.00");
    const command = wagerCommand(w);
    h.faults.throwAt("submit:after-ledger-insert", () => new TypeError("unexpected bug"));
    const error = await h.submit.execute(command, CTX).catch((e) => e);
    expect(error).toBeInstanceOf(InternalProcessingError);
    const failedId = (error as InternalProcessingError).transactionId;
    expect(failedId).toBeString();
    expect(await walletRow(h.db.sql, w.id)).toEqual({ balance: "100.00", version: 1 });
    const replay = await h.submit.execute(command, CTX);
    expect(replay.replay).toBe(true);
    expect(replay.transaction.id).toBe(failedId!);
    expect(replay.transaction.status).toBe(Status.Failed);
    expect(replay.transaction.failureCode).toBe(FailureCode.InternalInvariantViolation);
  });
});

describe("queries and reconciliation", () => {
  test("transactions are found by id and by provider + external id", async () => {
    const w = await wallet("100.00");
    const command = wagerCommand(w);
    const { transaction } = await h.submit.execute(command, CTX);
    expect((await h.getTransaction.byId(transaction.id)).id).toBe(transaction.id);
    expect((await h.getTransaction.byExternalId(command.providerId, command.externalTransactionId)).id).toBe(transaction.id);
    expect(await h.getTransaction.byId(Bun.randomUUIDv7()).catch((e) => e)).toBeInstanceOf(NotFoundError);
    expect(await h.getTransaction.byExternalId("provider-a", "nope").catch((e) => e)).toBeInstanceOf(NotFoundError);
  });

  test("ledger cursor is stable while new entries are appended", async () => {
    const w = await wallet("100.00");
    for (let i = 0; i < 4; i++) await h.submit.execute(wagerCommand(w, { money: money("1.00") }), CTX);
    const first = await h.getLedger.execute({ walletId: w.id, limit: 3 });
    expect(first.entries.map((e) => e.walletVersion)).toEqual([1, 2, 3]);
    expect(first.nextCursor).toBeString();
    await Promise.all(Array.from({ length: 3 }, () => h.submit.execute(wagerCommand(w, { money: money("1.00") }), CTX)));
    const second = await h.getLedger.execute({ walletId: w.id, cursor: first.nextCursor!, limit: 3 });
    expect(second.entries.map((e) => e.walletVersion)).toEqual([4, 5, 6]);
    const third = await h.getLedger.execute({ walletId: w.id, cursor: second.nextCursor!, limit: 3 });
    expect(third.entries.map((e) => e.walletVersion)).toEqual([7, 8]);
    expect(third.nextCursor).toBeNull();
    expect(await h.getLedger.execute({ walletId: w.id, cursor: "%%%" }).catch((e) => e)).toBeInstanceOf(ValidationError);
    expect(await h.getLedger.execute({ walletId: w.id, limit: 0 }).catch((e) => e)).toBeInstanceOf(ValidationError);
  });

  test("reconciliation of a busy wallet is consistent", async () => {
    const w = await wallet("100.00");
    await Promise.all(Array.from({ length: 10 }, () => h.submit.execute(wagerCommand(w, { money: money("3.33") }), CTX)));
    await h.submit.execute(wagerCommand(w, { kind: "WIN", money: money("0.30") }), CTX);
    const report = await h.reconcile.execute(w.id);
    expect(report.consistent).toBe(true);
    expect(report.storedBalance.amount).toBe("67.00");
    expect(report.calculatedBalance.amount).toBe("67.00");
    expect(report.difference.amount).toBe("0.00");
    expect(report.checkedEntries).toBe(12);
    expect(h.divergences).toEqual([]);
    expect(await h.reconcile.execute(Bun.randomUUIDv7()).catch((e) => e)).toBeInstanceOf(NotFoundError);
  });
});
