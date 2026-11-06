import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHttpHarness, type HttpHarness } from "../support/http";
import { assertLedgerInvariant } from "../support/invariants";
import { fireHttp } from "../support/load";
import { wagerCommand } from "../support/use-cases";

// Real PostgreSQL: explicit timeout per file (Bun ignores bunfig/preload beyond the first file).
setDefaultTimeout(120_000);

/**
 * §8: balance 100.00, two different BETs of 80.00 at the same time → exactly one PROCESSED, one
 * REJECTED (INSUFFICIENT_FUNDS), final balance 20.00, one DEBIT. Repeated 20 times, then both are
 * retried and nothing changes.
 */
describe("§8 scenario: two simultaneous BETs competing for the same balance", () => {
  let h: HttpHarness;

  beforeAll(async () => {
    h = await createHttpHarness();
  });
  afterEach(async () => {
    await assertLedgerInvariant(h.db.sql); // §13: the invariant closes every test
  });
  afterAll(async () => {
    await h.close();
  });

  test("20 repetitions: always 1 PROCESSED + 1 REJECTED INSUFFICIENT_FUNDS, balance 20.00; retries change nothing", async () => {
    for (let round = 0; round < 20; round++) {
      const created = await h.request("POST", "/wallets", {
        body: { playerId: `p-${crypto.randomUUID()}`, initialBalance: { amount: "100.00", currency: "BRL" } },
      });
      expect(created.status).toBe(201);
      const wallet = { id: created.body.id as string, playerId: created.body.playerId as string };
      const bets = [0, 1].map(() => wagerCommand(wallet, { money: { amount: "80.00", currency: "BRL" } }));

      const results = await fireHttp([h.baseUrl], bets);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      const rejected = results.find((r) => r.status === 422)!;
      expect(rejected.body.error).toMatchObject({ code: "INSUFFICIENT_FUNDS", status: "REJECTED", idempotentReplay: false });
      expect(rejected.body.error.balance).toEqual({ amount: "20.00", currency: "BRL" }); // observed after the winner

      const [state] = await h.db.sql`
        SELECT w.balance::text AS balance,
               (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id AND l.direction = 'DEBIT') AS debits,
               (SELECT COUNT(*)::int FROM wager_transactions t WHERE t.wallet_id = w.id AND t.status = 'PROCESSED' AND t.kind = 'BET') AS processed,
               (SELECT COUNT(*)::int FROM wager_transactions t WHERE t.wallet_id = w.id AND t.status = 'REJECTED') AS rejected
          FROM wallets w WHERE w.id = ${wallet.id}`;
      expect(state).toEqual({ balance: "20.00", debits: 1, processed: 1, rejected: 1 });

      // Provider retries both: replays with the original statuses, no new effect.
      const retries = await fireHttp([h.baseUrl], bets);
      expect(retries.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(retries.every((r) => (r.body.idempotentReplay ?? r.body.error?.idempotentReplay) === true)).toBe(true);
      const [after] = await h.db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
      expect(after.balance).toBe("20.00");
    }
  });
});
