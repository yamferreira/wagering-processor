import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHttpHarness, type HttpHarness } from "../support/http";
import { assertLedgerInvariant } from "../support/invariants";
import { fireHttp, fireSqs } from "../support/load";
import { createMessagingHarness, type MessagingHarness } from "../support/messaging";
import { wagerCommand } from "../support/use-cases";
import { waitFor } from "../support/wait";

// Real PostgreSQL/LocalStack: explicit timeout per file (Bun ignores bunfig/preload beyond the first file).
setDefaultTimeout(120_000);

/** §13: "a mesma aposta enviada 50 vezes em paralelo → um único débito" — over HTTP and over SQS. */
async function debits(sql: HttpHarness["db"]["sql"], walletId: string): Promise<number> {
  const [row] = await sql`SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
  return row.n;
}

describe("the same BET 50× in parallel over HTTP", () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await createHttpHarness();
  });
  afterAll(async () => {
    await assertLedgerInvariant(h.db.sql);
    await h.close();
  });

  test("1 debit, exactly one 201 and 49 idempotent 200 replays with the same body", async () => {
    const created = await h.request("POST", "/wallets", {
      body: { playerId: `p-${crypto.randomUUID()}`, initialBalance: { amount: "100.00", currency: "BRL" } },
    });
    const wallet = { id: created.body.id as string, playerId: created.body.playerId as string };
    const command = wagerCommand(wallet, { money: { amount: "25.00", currency: "BRL" } });

    const results = await fireHttp([h.baseUrl], Array.from({ length: 50 }, () => command));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);

    const transactionIds = new Set(results.map((r) => r.body.transactionId));
    expect(transactionIds.size).toBe(1);
    for (const result of results) {
      expect(result.body.balance).toEqual({ amount: "75.00", currency: "BRL" });
      expect(result.body.idempotentReplay).toBe(result.status === 200);
    }
    expect(await debits(h.db.sql, wallet.id)).toBe(1);
    const [row] = await h.db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(row.balance).toBe("75.00");
  });

  test("repeated 5 times on fresh wallets (no lucky interleaving)", async () => {
    for (let round = 0; round < 5; round++) {
      const created = await h.request("POST", "/wallets", {
        body: { playerId: `p-${crypto.randomUUID()}`, initialBalance: { amount: "50.00", currency: "BRL" } },
      });
      const wallet = { id: created.body.id as string, playerId: created.body.playerId as string };
      const command = wagerCommand(wallet, { money: { amount: "10.00", currency: "BRL" } });
      const results = await fireHttp([h.baseUrl], Array.from({ length: 50 }, () => command));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(49);
      expect(await debits(h.db.sql, wallet.id)).toBe(1);
    }
  });
});

describe("the same BET 50× in parallel over SQS", () => {
  let h: MessagingHarness;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "same-bet", config: { CONSUMER_CONCURRENCY: 20 } });
    await h.start({ ROLES: ["consumer"] });
    await h.start({ ROLES: ["consumer"] }); // two consumers competing for the same messages' effects
  });
  afterAll(async () => {
    await assertLedgerInvariant(h.db.sql);
    await h.close();
  });

  const settled = async (walletId: string, messageIds: string[]) => {
    await waitFor(
      async () => {
        const [row] = await h.db.sql`
          SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id IN ${h.db.sql(messageIds)}`;
        const depth = await h.queues.input.approximateDepth();
        return row.n === messageIds.length && depth.visible + depth.inFlight === 0;
      },
      { description: "all 50 messages consumed", timeoutMs: 60_000 },
    );
    return debits(h.db.sql, walletId);
  };

  test("50 distinct messageIds, same Idempotency-Key, 50 distinct MessageGroupIds → 1 debit", async () => {
    const wallet = await h.openWallet("100.00");
    const command = wagerCommand(wallet, { money: { amount: "25.00", currency: "BRL" } });
    const messageIds = await fireSqs(h.queues, Array.from({ length: 50 }, () => command), { groupBy: "random" });
    expect(await settled(wallet.id, messageIds)).toBe(1);
    const [row] = await h.db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(row.balance).toBe("75.00");
    const [txs] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind = 'BET'`;
    expect(txs.n).toBe(1);
  });

  test("the same messageId delivered 50× through distinct groups → 1 debit, 1 inbox row", async () => {
    const wallet = await h.openWallet("100.00");
    const command = wagerCommand(wallet, { money: { amount: "25.00", currency: "BRL" } });
    const messageId = `msg-${crypto.randomUUID()}`;
    await fireSqs(h.queues, Array.from({ length: 50 }, () => command), {
      groupBy: "random",
      messageIds: Array.from({ length: 50 }, () => messageId),
    });
    await waitFor(
      async () => {
        const depth = await h.queues.input.approximateDepth();
        return depth.visible + depth.inFlight === 0 && (await debits(h.db.sql, wallet.id)) === 1;
      },
      { description: "consumed", timeoutMs: 60_000 },
    );
    const [inbox] = await h.db.sql`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId}`;
    expect(inbox.n).toBe(1);
    expect(await debits(h.db.sql, wallet.id)).toBe(1);
  });
});
