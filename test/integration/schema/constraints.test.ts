import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createTestDatabase, expectSqlError, type TestDatabase } from "../../support/db";
import { assertLedgerInvariant, findLedgerDivergences } from "../../support/invariants";
import { insertLedger, insertTx, type SeededWallet, seedBet, seedWallet, uuid } from "../../support/sql-fixtures";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

/**
 * Every guarantee of §5/§6 that lives in the schema, probed with raw SQL that bypasses the
 * application. SQLSTATE: 23505 unique, 23514 check, 23503 foreign key, 23001 restrict (triggers).
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await assertLedgerInvariant(db.sql);
});

afterAll(async () => {
  await db.drop();
});

describe("positive control", () => {
  test("a consistent wallet + opening + bet commits", async () => {
    const wallet = await seedWallet(db.sql, { balance: "100.00" });
    await seedBet(db.sql, wallet, { amount: "25.00", before: "100.00", after: "75.00", version: 2 });
    const [row] = await db.sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${wallet.walletId}`;
    expect(row).toEqual({ balance: "75.00", version: 2 });
  });

  test("a wallet opened with zero has no entries and its first credit is version 2", async () => {
    const wallet = await seedWallet(db.sql, { balance: "0.00" });
    await db.sql.begin(async (tx) => {
      const winId = await insertTx(tx, { wallet_id: wallet.walletId, player_id: wallet.playerId, kind: "WIN", amount: "5.00" });
      await insertLedger(tx, {
        wallet_id: wallet.walletId,
        transaction_id: winId,
        direction: "CREDIT",
        amount: "5.00",
        balance_before: "0.00",
        balance_after: "5.00",
        wallet_version: 2,
      });
      await tx`UPDATE wallets SET balance = 5.00, version = 2 WHERE id = ${wallet.walletId}`;
    });
  });
});

describe("wallets", () => {
  test("at most one wallet per playerId + currency", async () => {
    const wallet = await seedWallet(db.sql, { balance: "0.00" });
    const { state, error } = await expectSqlError(() => seedWallet(db.sql, { balance: "0.00", playerId: wallet.playerId }));
    expect(state).toBe("23505");
    expect((error as { constraint?: string }).constraint).toBe("wallets_player_currency_uq");
  });

  test("the same player may hold wallets in different currencies", async () => {
    const wallet = await seedWallet(db.sql, { balance: "0.00" });
    await seedWallet(db.sql, { balance: "0.00", playerId: wallet.playerId, currency: "USD" });
  });

  test("balance can never be negative", async () => {
    const wallet = await seedWallet(db.sql, { balance: "0.00" });
    const { state } = await expectSqlError(() => db.sql`UPDATE wallets SET balance = -0.01 WHERE id = ${wallet.walletId}`);
    expect(state).toBe("23514");
  });

  test("currency must be ISO-4217 shaped", async () => {
    const { state } = await expectSqlError(() => seedWallet(db.sql, { balance: "0.00", currency: "brl" }));
    expect(state).toBe("23514");
  });

  test("a positive balance without ledger entries is rejected at commit (deferred)", async () => {
    const { state } = await expectSqlError(
      () => db.sql`INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
                   VALUES (${uuid()}, ${`p-${uuid()}`}, 'BRL', 100.00, 1, now(), now())`,
    );
    expect(state).toBe("23514");
  });

  test("changing the balance without a ledger entry is rejected at commit", async () => {
    const wallet = await seedWallet(db.sql, { balance: "100.00" });
    const silent = await expectSqlError(
      () => db.sql`UPDATE wallets SET balance = 1000.00 WHERE id = ${wallet.walletId}`,
    );
    expect(silent.state).toBe("23514");
    const bumped = await expectSqlError(
      () => db.sql`UPDATE wallets SET balance = 1000.00, version = 2 WHERE id = ${wallet.walletId}`,
    );
    expect(bumped.state).toBe("23514");
  });
});

describe("wallet_ledger_entries (append-only, balanced, chained)", () => {
  let wallet: SeededWallet;

  beforeAll(async () => {
    wallet = await seedWallet(db.sql, { balance: "100.00" });
    await seedBet(db.sql, wallet, { amount: "10.00", before: "100.00", after: "90.00", version: 2 });
  });

  test("UPDATE is forbidden", async () => {
    const { state } = await expectSqlError(
      () => db.sql`UPDATE wallet_ledger_entries SET amount = 1.00 WHERE wallet_id = ${wallet.walletId}`,
    );
    expect(state).toBe("23001");
  });

  test("DELETE is forbidden", async () => {
    const { state } = await expectSqlError(
      () => db.sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${wallet.walletId}`,
    );
    expect(state).toBe("23001");
  });

  test("TRUNCATE is forbidden", async () => {
    const { state } = await expectSqlError(() => db.sql`TRUNCATE wallet_ledger_entries CASCADE`);
    expect(state).toBe("23001");
  });

  async function betTx(): Promise<string> {
    return insertTx(db.sql, { wallet_id: wallet.walletId, player_id: wallet.playerId, kind: "BET", amount: "5.00" });
  }

  test("arithmetic must balance (balance_after = balance_before ± amount)", async () => {
    const txId = await betTx();
    const { state, error } = await expectSqlError(() =>
      insertLedger(db.sql, {
        wallet_id: wallet.walletId,
        transaction_id: txId,
        direction: "DEBIT",
        amount: "5.00",
        balance_before: "90.00",
        balance_after: "86.00",
        wallet_version: 3,
      }),
    );
    expect(state).toBe("23514");
    expect((error as { constraint?: string }).constraint).toBe("ledger_arithmetic");
  });

  test("an entry must continue the previous one (balance_before = previous balance_after)", async () => {
    const txId = await betTx();
    const { state } = await expectSqlError(() =>
      insertLedger(db.sql, {
        wallet_id: wallet.walletId,
        transaction_id: txId,
        direction: "DEBIT",
        amount: "5.00",
        balance_before: "100.00",
        balance_after: "95.00",
        wallet_version: 3,
      }),
    );
    expect(state).toBe("23514");
  });

  test("versions cannot be skipped or repeated", async () => {
    const txId = await betTx();
    for (const version of [2, 4]) {
      const { state } = await expectSqlError(() =>
        insertLedger(db.sql, {
          wallet_id: wallet.walletId,
          transaction_id: txId,
          direction: "DEBIT",
          amount: "5.00",
          balance_before: "90.00",
          balance_after: "85.00",
          wallet_version: version,
        }),
      );
      expect(state).toBe("23514");
    }
  });

  test("an entry that is not reflected in the wallet balance is rejected at commit", async () => {
    const txId = await betTx();
    const { state } = await expectSqlError(() =>
      insertLedger(db.sql, {
        wallet_id: wallet.walletId,
        transaction_id: txId,
        direction: "DEBIT",
        amount: "5.00",
        balance_before: "90.00",
        balance_after: "85.00",
        wallet_version: 3,
      }),
    );
    expect(state).toBe("23514");
  });

  test("at most one entry per transaction", async () => {
    const [{ transaction_id }] = await db.sql`
      SELECT transaction_id FROM wallet_ledger_entries WHERE wallet_id = ${wallet.walletId} AND wallet_version = 2`;
    const { state, error } = await expectSqlError(() =>
      db.sql.begin(async (tx) => {
        await insertLedger(tx, {
          wallet_id: wallet.walletId,
          transaction_id: transaction_id,
          direction: "DEBIT",
          amount: "10.00",
          balance_before: "90.00",
          balance_after: "80.00",
          wallet_version: 3,
        });
        await tx`UPDATE wallets SET balance = 80.00, version = 3 WHERE id = ${wallet.walletId}`;
      }),
    );
    expect(state).toBe("23505");
    expect((error as { constraint?: string }).constraint).toBe("ledger_transaction_uq");
  });

  test("entry currency must be the wallet currency", async () => {
    const txId = await betTx();
    const { state } = await expectSqlError(() =>
      insertLedger(db.sql, {
        wallet_id: wallet.walletId,
        currency: "USD",
        transaction_id: txId,
        direction: "DEBIT",
        amount: "5.00",
        balance_before: "90.00",
        balance_after: "85.00",
        wallet_version: 3,
      }),
    );
    expect(state).toBe("23503");
  });

  test("entry transaction must belong to the same wallet", async () => {
    const other = await seedWallet(db.sql, { balance: "0.00" });
    const foreignTx = await insertTx(db.sql, { wallet_id: other.walletId, player_id: other.playerId, kind: "WIN" });
    const { state } = await expectSqlError(() =>
      insertLedger(db.sql, {
        wallet_id: wallet.walletId,
        transaction_id: foreignTx,
        direction: "CREDIT",
        amount: "10.00",
        balance_before: "90.00",
        balance_after: "100.00",
        wallet_version: 3,
      }),
    );
    expect(state).toBe("23503");
  });

  test("zero or negative amounts are rejected", async () => {
    const txId = await betTx();
    const { state } = await expectSqlError(() =>
      insertLedger(db.sql, {
        wallet_id: wallet.walletId,
        transaction_id: txId,
        direction: "DEBIT",
        amount: "0.00",
        balance_before: "90.00",
        balance_after: "90.00",
        wallet_version: 3,
      }),
    );
    expect(state).toBe("23514");
  });
});

describe("wager_transactions", () => {
  let wallet: SeededWallet;

  beforeAll(async () => {
    wallet = await seedWallet(db.sql, { balance: "100.00" });
  });

  const tx = (overrides: Partial<Parameters<typeof insertTx>[1]> = {}) =>
    insertTx(db.sql, { wallet_id: wallet.walletId, player_id: wallet.playerId, ...overrides });

  test("idempotency key is unique", async () => {
    await tx({ idempotency_key: "dup-key" });
    const { state, error } = await expectSqlError(() => tx({ idempotency_key: "dup-key" }));
    expect(state).toBe("23505");
    expect((error as { constraint?: string }).constraint).toBe("wager_tx_idempotency_key_uq");
  });

  test("(provider_id, external_transaction_id) is unique", async () => {
    await tx({ external_transaction_id: "ext-dup", idempotency_key: "k1" });
    const { state, error } = await expectSqlError(() => tx({ external_transaction_id: "ext-dup", idempotency_key: "k2" }));
    expect(state).toBe("23505");
    expect((error as { constraint?: string }).constraint).toBe("wager_tx_provider_external_uq");
  });

  test("a transaction can be reversed only once (REFUND or ROLLBACK)", async () => {
    const betId = await tx({ kind: "BET", external_transaction_id: "bet-rev" });
    await tx({ kind: "REFUND", reference_external_transaction_id: "bet-rev", reference_transaction_id: betId });
    const { state, error } = await expectSqlError(() =>
      tx({ kind: "ROLLBACK", reference_external_transaction_id: "bet-rev", reference_transaction_id: betId }),
    );
    expect(state).toBe("23505");
    expect((error as { constraint?: string }).constraint).toBe("wager_tx_single_reversal_uq");
    // A rejected attempt does not consume the reversal slot.
    await tx({
      kind: "ROLLBACK",
      reference_external_transaction_id: "bet-rev",
      reference_transaction_id: betId,
      status: "REJECTED",
      failure_code: "REFERENCE_ALREADY_REVERSED",
    });
  });

  test("a reference must live in the same wallet", async () => {
    const other = await seedWallet(db.sql, { balance: "0.00" });
    const foreignBet = await insertTx(db.sql, { wallet_id: other.walletId, player_id: other.playerId, kind: "BET" });
    const { state } = await expectSqlError(() =>
      tx({ kind: "REFUND", reference_external_transaction_id: "x", reference_transaction_id: foreignBet }),
    );
    expect(state).toBe("23503");
  });

  test.each([
    ["REFUND without reference", { kind: "REFUND" }],
    ["ROLLBACK without reference", { kind: "ROLLBACK" }],
    ["BET with reference", { kind: "BET", reference_external_transaction_id: "x" }],
    ["zero BET", { kind: "BET", amount: "0.00" }],
    ["negative amount", { kind: "LOSS", amount: "-1.00" }],
    ["unknown kind", { kind: "JACKPOT" }],
    ["unknown status", { status: "DONE" }],
    ["internal provider on a non-OPENING kind", { provider_id: "internal" }],
    ["missing round on a BET", { round_id: null }],
    ["PROCESSED without processed_at", { processed_at: null }],
    ["PROCESSED without resulting balance", { resulting_balance: null }],
    ["REJECTED without failure code", { status: "REJECTED" }],
    ["failure code on PROCESSED", { failure_code: "INSUFFICIENT_FUNDS" }],
    ["PENDING_REFERENCE without schedule", { kind: "REFUND", reference_external_transaction_id: "x", status: "PENDING_REFERENCE" }],
    ["malformed payload hash", { payload_hash: "not-a-hash" }],
  ])("rejects %s", async (_label, overrides) => {
    const { state } = await expectSqlError(() => tx(overrides));
    expect(state).toBe("23514");
  });

  test("LOSS with zero amount is accepted (A2)", async () => {
    await tx({ kind: "LOSS", amount: "0.00" });
  });

  test("terminal transactions are immutable", async () => {
    const id = await tx({ kind: "BET" });
    const { state } = await expectSqlError(
      () => db.sql`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' WHERE id = ${id}`,
    );
    expect(state).toBe("23001");
  });

  test("immutable columns cannot change even while pending", async () => {
    const id = await tx({
      kind: "REFUND",
      reference_external_transaction_id: "later",
      status: "PENDING_REFERENCE",
      resulting_balance: null,
      next_reference_attempt_at: new Date(),
    });
    const { state } = await expectSqlError(() => db.sql`UPDATE wager_transactions SET amount = 999.00 WHERE id = ${id}`);
    expect(state).toBe("23001");
    // Scheduling columns may change.
    await db.sql`UPDATE wager_transactions SET reference_attempts = 1, next_reference_attempt_at = now() WHERE id = ${id}`;
  });

  test("transactions cannot be deleted or truncated", async () => {
    const id = await tx();
    expect((await expectSqlError(() => db.sql`DELETE FROM wager_transactions WHERE id = ${id}`)).state).toBe("23001");
    expect((await expectSqlError(() => db.sql`TRUNCATE wager_transactions CASCADE`)).state).toBe("23001");
  });
});

describe("invariant helper", () => {
  test("detects a divergence when the guard triggers are bypassed (superuser only)", async () => {
    const wallet = await seedWallet(db.sql, { balance: "50.00" });
    await db.sql`ALTER TABLE wallets DISABLE TRIGGER wallet_check_ledger`;
    try {
      await db.sql`UPDATE wallets SET balance = 51.00 WHERE id = ${wallet.walletId}`;
      const divergences = await findLedgerDivergences(db.sql, [wallet.walletId]);
      expect(divergences).toEqual([
        expect.objectContaining({ wallet_id: wallet.walletId, balance: "51.00", ledger_sum: "50.00" }),
      ]);
      await db.sql`UPDATE wallets SET balance = 50.00 WHERE id = ${wallet.walletId}`;
    } finally {
      await db.sql`ALTER TABLE wallets ENABLE TRIGGER wallet_check_ledger`;
    }
  });
});

describe("outbox and inbox", () => {
  const insertOutbox = (id: string) =>
    db.sql`INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
           VALUES (${id}, 'agg', 'WalletBalanceChanged', ${{ a: 1 }}, now(), now())`;

  test("outbox payload is immutable and publication is final", async () => {
    const id = uuid();
    await insertOutbox(id);
    const changed = await expectSqlError(
      () => db.sql`UPDATE outbox_messages SET payload = ${{ a: 2 }} WHERE id = ${id}`,
    );
    expect(changed.state).toBe("23001");
    await db.sql`UPDATE outbox_messages SET attempts = 1, next_attempt_at = now() WHERE id = ${id}`;
    await db.sql`UPDATE outbox_messages SET published_at = now(), next_attempt_at = NULL WHERE id = ${id}`;
    const republished = await expectSqlError(
      () => db.sql`UPDATE outbox_messages SET published_at = now() + interval '1 day' WHERE id = ${id}`,
    );
    expect(republished.state).toBe("23001");
  });

  test("outbox id (eventId) is unique", async () => {
    const id = uuid();
    await insertOutbox(id);
    expect((await expectSqlError(() => insertOutbox(id))).state).toBe("23505");
  });

  test("inbox is unique by (consumer_name, message_id) and immutable", async () => {
    const insertInbox = (consumer: string) =>
      db.sql`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
             VALUES (${consumer}, 'msg-1', ${"b".repeat(64)}, now())`;
    await insertInbox("wager-transactions");
    await insertInbox("events-audit");
    expect((await expectSqlError(() => insertInbox("wager-transactions"))).state).toBe("23505");
    const changed = await expectSqlError(
      () => db.sql`UPDATE inbox_messages SET payload_hash = ${"c".repeat(64)} WHERE message_id = 'msg-1'`,
    );
    expect(changed.state).toBe("23001");
  });
});
