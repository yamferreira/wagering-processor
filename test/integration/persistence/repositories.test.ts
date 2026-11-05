import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  ConcurrencyConflictError,
  TransientInfrastructureError,
  TransientReason,
  UniqueViolationError,
} from "../../../src/application/errors";
import { WalletBalanceChanged } from "../../../src/domain/messaging/events/wallet-balance-changed";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { Money } from "../../../src/domain/money/money";
import { FailureCode } from "../../../src/domain/wager/failure-code";
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from "../../../src/domain/wager/kinds";
import { WagerTransaction } from "../../../src/domain/wager/wager-transaction";
import { Wallet } from "../../../src/domain/wallet/wallet";
import { assertLedgerInvariant } from "../../support/invariants";
import { createPersistenceHarness, type PersistenceHarness } from "../../support/persistence";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

let h: PersistenceHarness;
const id = () => Bun.randomUUIDv7();
const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const HASH = "d".repeat(64);
const now = () => new Date();

beforeAll(async () => {
  h = await createPersistenceHarness({ lockTimeoutMs: 400, maxRetries: 2 });
});

afterEach(async () => {
  await assertLedgerInvariant(h.db.sql);
});

afterAll(async () => {
  await h.close();
});

/** Opens a wallet with its OPENING transaction and ledger entry, in one unit of work. */
async function openWallet(amount: string): Promise<Wallet> {
  const walletId = id();
  const playerId = `player-${walletId}`;
  const at = now();
  const openingTxId = id();
  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(amount),
    at,
    opening: { transactionId: openingTxId, ledgerEntryId: id() },
  });
  await h.runner.run(async (repos) => {
    await repos.wallets.insert(wallet);
    if (openingEntry) {
      await repos.transactions.insert(
        WagerTransaction.createOpening({ id: openingTxId, walletId, playerId, money: brl(amount), payloadHash: HASH, at }),
      );
      await repos.ledger.insert(openingEntry);
    }
  });
  return wallet;
}

function bet(wallet: Wallet, amount: string, extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  const externalTransactionId = `bet-${id()}`;
  return WagerTransaction.create({
    id: id(),
    providerId: "provider-a",
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: HASH,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "round-1",
    gameId: "game-1",
    kind: Kind.Bet,
    money: brl(amount),
    createdAt: now(),
    ...extra,
  });
}

/** Applies a processed debit under the wallet lock, the way the use case will. */
async function applyBet(walletId: string, amount: string): Promise<WagerTransaction> {
  return h.runner.run(async (repos) => {
    const wallet = await repos.wallets.lockById(walletId);
    if (!wallet) throw new Error("wallet not found");
    const tx = bet(wallet, amount);
    const expectedVersion = wallet.version;
    const entry = wallet.debit({ ledgerEntryId: id(), transactionId: tx.id, money: tx.money, at: now() });
    tx.markProcessed({ referenceTransactionId: undefined, resultingBalance: wallet.balance, at: now() });
    await repos.transactions.insert(tx);
    await repos.ledger.insert(entry);
    await repos.wallets.saveMovement(wallet, expectedVersion);
    await repos.outbox.insert([
      OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { eventId: id(), correlationId: "c", occurredAt: now() })),
    ]);
    return tx;
  });
}

describe("roundtrip and exact money", () => {
  test("wallet with opening balance at the NUMERIC(20,2) scale used in practice", async () => {
    const wallet = await openWallet("9999999999999999.99");
    const loaded = await h.runner.read((repos) => repos.wallets.findById(wallet.id));
    expect(loaded?.balance.amount).toBe("9999999999999999.99");
    expect(loaded?.balance.minorUnits).toBe(999999999999999999n);
    expect(loaded?.version).toBe(1);
    expect(loaded?.snapshot()).toEqual(wallet.snapshot());
  });

  test("decimal columns come back as strings, never numbers", async () => {
    const wallet = await openWallet("0.10");
    const [row] = await h.orm.em.fork().execute("SELECT balance FROM wallets WHERE id = ?", [wallet.id]);
    expect(typeof row?.balance).toBe("string");
  });

  test("processed bet, ledger page and outbox roundtrip", async () => {
    const wallet = await openWallet("100.00");
    const tx = await applyBet(wallet.id, "25.50");
    const loaded = await h.runner.read((repos) => repos.transactions.findById(tx.id));
    expect(loaded?.snapshot()).toEqual(tx.snapshot());
    expect(loaded?.resultingBalance?.amount).toBe("74.50");

    const page = await h.runner.read((repos) => repos.ledger.page(wallet.id, 0, 10));
    expect(page.entries.map((e) => [e.walletVersion, e.direction, e.money.amount, e.balanceAfter.amount])).toEqual([
      [1, "CREDIT", "100.00", "100.00"],
      [2, "DEBIT", "25.50", "74.50"],
    ]);
    expect(page.nextAfterVersion).toBeUndefined();

    const [outbox] = await h.db.sql`SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = ${wallet.id}`;
    expect(outbox.event_type).toBe("WalletBalanceChanged");
    expect(outbox.payload.data.balanceAfter).toEqual({ amount: "74.50", currency: "BRL" });
  });

  test("ledger pagination is ordered by version and reports the next cursor", async () => {
    const wallet = await openWallet("10.00");
    for (let i = 0; i < 5; i++) await applyBet(wallet.id, "1.00");
    const first = await h.runner.read((repos) => repos.ledger.page(wallet.id, 0, 4));
    expect(first.entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
    expect(first.nextAfterVersion).toBe(4);
    const second = await h.runner.read((repos) => repos.ledger.page(wallet.id, first.nextAfterVersion!, 4));
    expect(second.entries.map((e) => e.walletVersion)).toEqual([5, 6]);
    expect(second.nextAfterVersion).toBeUndefined();
  });

  test("ledger summary sums credits and debits exactly", async () => {
    const wallet = await openWallet("0.30");
    await applyBet(wallet.id, "0.10");
    await applyBet(wallet.id, "0.20");
    const summary = await h.runner.read((repos) => repos.ledger.summarize(wallet.id, "BRL"));
    expect(summary.credits.amount).toBe("0.30");
    expect(summary.debits.amount).toBe("0.30");
    expect(summary.entryCount).toBe(3);
    expect(summary.last?.balanceAfter.amount).toBe("0.00");
  });

  test("rejected and pending transactions roundtrip, including the wallet-currency observed balance", async () => {
    const wallet = await openWallet("5.00");
    const rejected = bet(wallet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });
    rejected.reject(FailureCode.CurrencyMismatch, now(), wallet.balance);
    const pending = bet(wallet, "1.00", { kind: Kind.Refund, referenceExternalTransactionId: "bet-404" });
    pending.markPendingReference(new Date(Date.now() + 2000));
    await h.runner.run(async (repos) => {
      await repos.transactions.insert(rejected);
      await repos.transactions.insert(pending);
    });
    const [r, p] = await h.runner.read(async (repos) => [
      await repos.transactions.findById(rejected.id),
      await repos.transactions.findById(pending.id),
    ]);
    expect(r?.snapshot()).toEqual(rejected.snapshot());
    expect(r?.resultingBalance?.toJSON()).toEqual({ amount: "5.00", currency: "BRL" });
    expect(p?.snapshot()).toEqual(pending.snapshot());
    expect(await h.runner.read((repos) => repos.transactions.findByIdempotencyKey(pending.idempotencyKey))).not.toBeNull();
    expect(
      await h.runner.read((repos) => repos.transactions.findByExternalId("provider-a", pending.externalTransactionId)),
    ).not.toBeNull();
  });

  test("status update is guarded by the expected status", async () => {
    const wallet = await openWallet("5.00");
    const pending = bet(wallet, "1.00", { kind: Kind.Refund, referenceExternalTransactionId: "bet-x" });
    pending.markPendingReference(new Date());
    await h.runner.run((repos) => repos.transactions.insert(pending));
    pending.reject(FailureCode.ReferenceNotFound, now(), wallet.balance);
    await h.runner.run((repos) => repos.transactions.update(pending, Status.PendingReference));
    const stale = WagerTransaction.rehydrate({ ...pending.snapshot(), status: Status.PendingReference });
    stale.markPendingReference(new Date());
    const error = await h.runner.run((repos) => repos.transactions.update(stale, Status.PendingReference)).catch((e) => e);
    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect((error as TransientInfrastructureError).reason).toBe(TransientReason.ConcurrencyConflict);
  });

  test("inbox roundtrip and unique (consumer, message)", async () => {
    const message = InboxMessage.receive({ messageId: "m-1", consumerName: "c", payloadHash: HASH, receivedAt: now() });
    message.markProcessed(now());
    await h.runner.run((repos) => repos.inbox.insert(message));
    const loaded = await h.runner.read((repos) => repos.inbox.find("c", "m-1"));
    expect(loaded?.isProcessed()).toBe(true);
    const error = await h.runner.run((repos) => repos.inbox.insert(message)).catch((e) => e);
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe("inbox_messages_pk");
  });
});

describe("error translation", () => {
  test("duplicate idempotency key surfaces as UniqueViolationError with the constraint name", async () => {
    const wallet = await openWallet("5.00");
    const first = bet(wallet, "1.00");
    first.reject(FailureCode.InsufficientFunds, now(), wallet.balance);
    await h.runner.run((repos) => repos.transactions.insert(first));
    const duplicate = bet(wallet, "1.00", { idempotencyKey: first.idempotencyKey });
    duplicate.reject(FailureCode.InsufficientFunds, now(), wallet.balance);
    const error = await h.runner.run((repos) => repos.transactions.insert(duplicate)).catch((e) => e);
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe("wager_tx_idempotency_key_uq");
  });

  test("a stale version never overwrites the balance (bounded retries, then transient)", async () => {
    const wallet = await openWallet("100.00");
    await applyBet(wallet.id, "10.00"); // wallet is now at version 2
    let attempts = 0;
    const error = await h.runner
      .run(async (repos) => {
        attempts += 1;
        const stale = Wallet.rehydrate({ ...wallet.snapshot() }); // version 1, balance 100.00
        const entry = stale.debit({ ledgerEntryId: id(), transactionId: id(), money: brl("1.00"), at: now() });
        void entry;
        await repos.wallets.saveMovement(stale, 1);
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect((error as TransientInfrastructureError).reason).toBe(TransientReason.ConcurrencyConflict);
    expect((error as Error).cause).toBeInstanceOf(ConcurrencyConflictError);
    expect(attempts).toBe(3); // first try + maxRetries (2)
    const current = await h.runner.read((repos) => repos.wallets.findById(wallet.id));
    expect(current?.balance.amount).toBe("90.00");
  });
});

describe("pessimistic lock is per wallet row (no global lock)", () => {
  test("while wallet X is locked, X times out and Y commits", async () => {
    const x = await openWallet("100.00");
    const y = await openWallet("100.00");

    let releaseX!: () => void;
    const xHeld = new Promise<void>((resolve) => {
      releaseX = resolve;
    });
    let xLocked!: () => void;
    const xLockAcquired = new Promise<void>((resolve) => {
      xLocked = resolve;
    });

    const holder = h.runner.run(async (repos) => {
      await repos.wallets.lockById(x.id);
      xLocked();
      await xHeld;
    });
    await xLockAcquired;

    // Same wallet: blocks until lock_timeout (400 ms) and fails as a transient error.
    const started = performance.now();
    const blocked = await h.runner.run((repos) => repos.wallets.lockById(x.id)).catch((e) => e);
    const waited = performance.now() - started;
    expect(blocked).toBeInstanceOf(TransientInfrastructureError);
    expect((blocked as TransientInfrastructureError).reason).toBe(TransientReason.LockTimeout);
    expect(waited).toBeGreaterThanOrEqual(350);

    // Different wallet: proceeds and commits while X is still held.
    const tx = await applyBet(y.id, "10.00");
    expect(tx.status).toBe(Status.Processed);

    releaseX();
    await holder;
    const [xAfter, yAfter] = await h.runner.read(async (repos) => [
      await repos.wallets.findById(x.id),
      await repos.wallets.findById(y.id),
    ]);
    expect(xAfter?.balance.amount).toBe("100.00");
    expect(yAfter?.balance.amount).toBe("90.00");
  });

  test("concurrent debits on the same wallet serialize without lost updates", async () => {
    const wallet = await openWallet("100.00");
    await Promise.all(Array.from({ length: 20 }, () => applyBet(wallet.id, "1.00")));
    const after = await h.runner.read((repos) => repos.wallets.findById(wallet.id));
    expect(after?.balance.amount).toBe("80.00");
    expect(after?.version).toBe(21);
  });
});
