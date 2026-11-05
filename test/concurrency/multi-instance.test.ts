import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SubmitWagerCommand } from "../../src/application/use-cases/submit-wager-transaction";
import { spawnCluster } from "../support/cluster";
import { waitForQuiescence } from "../support/drain";
import { type Instance, killAllInstances } from "../support/instances";
import { assertLedgerInvariant } from "../support/invariants";
import { fireHttp, fireSqs } from "../support/load";
import { createMessagingHarness, type MessagingHarness } from "../support/messaging";
import { drainQueue } from "../support/sqs";
import { wagerCommand } from "../support/use-cases";

// Real processes, PostgreSQL and LocalStack: explicit timeout per file (Bun ignores bunfig/preload beyond the first file).
setDefaultTimeout(180_000);

/**
 * §5/§8/§13 — 3 real instances (API + consumer + publisher + worker each) sharing one database and
 * one set of queues. The same wallet is hit through every instance, over HTTP and SQS at once.
 */
describe("3 instances against the same wallets", () => {
  let h: MessagingHarness;
  let instances: Instance[];
  let urls: string[];

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "multi", queues: { visibilityTimeoutSeconds: 5 } });
    instances = await spawnCluster(h, 3);
    urls = instances.map((i) => i.baseUrl);
  });
  afterAll(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    await killAllInstances();
    await h.close();
  });

  async function walletState(walletId: string) {
    const [row] = await h.db.sql`
      SELECT w.balance::text AS balance,
             (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id AND l.direction = 'DEBIT') AS debits
        FROM wallets w WHERE w.id = ${walletId}`;
    return row as { balance: string; debits: number };
  }

  test("§8 across instances, 10×: the two competing BETs go to different instances", async () => {
    for (let round = 0; round < 10; round++) {
      const wallet = await h.openWallet("100.00");
      const bets = [0, 1].map(() => wagerCommand(wallet, { money: { amount: "80.00", currency: "BRL" } }));
      const results = await fireHttp([urls[round % 3]!, urls[(round + 1) % 3]!], bets);
      expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(new Set(results.map((r) => r.target)).size).toBe(2);
      expect(await walletState(wallet.id)).toEqual({ balance: "20.00", debits: 1 });
    }
  });

  test("§8 with one BET over HTTP and the other over SQS at the same time", async () => {
    for (let round = 0; round < 5; round++) {
      const wallet = await h.openWallet("100.00");
      const [overHttp, overSqs] = [0, 1].map(() => wagerCommand(wallet, { money: { amount: "80.00", currency: "BRL" } }));
      await Promise.all([fireHttp([urls[round % 3]!], [overHttp!]), fireSqs(h.queues, [overSqs!])]);
      await waitForQuiescence(h.db.sql, h.queues);
      const [counts] = await h.db.sql`
        SELECT COUNT(*) FILTER (WHERE status = 'PROCESSED')::int AS processed,
               COUNT(*) FILTER (WHERE status = 'REJECTED' AND failure_code = 'INSUFFICIENT_FUNDS')::int AS rejected
          FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind = 'BET'`;
      expect(counts).toEqual({ processed: 1, rejected: 1 });
      expect(await walletState(wallet.id)).toEqual({ balance: "20.00", debits: 1 });
    }
  });

  test("the same BET 50×: 30 over HTTP round-robin + 20 over SQS (random groups) → 1 debit", async () => {
    const wallet = await h.openWallet("100.00");
    const command = wagerCommand(wallet, { money: { amount: "25.00", currency: "BRL" } });
    const [httpResults] = await Promise.all([
      fireHttp(urls, Array.from({ length: 30 }, () => command)),
      fireSqs(h.queues, Array.from({ length: 20 }, () => command), { groupBy: "random" }),
    ]);
    await waitForQuiescence(h.db.sql, h.queues);
    const statuses = httpResults.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBeLessThanOrEqual(1); // the winner may have been an SQS message
    expect(statuses.every((s) => s === 201 || s === 200)).toBe(true);
    expect(new Set(httpResults.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance: "75.00", debits: 1 });
  });

  test("mixed load over 20 wallets (HTTP + SQS, references out of order): every wallet reconciles", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => h.openWallet("200.00")));
    const viaHttp: SubmitWagerCommand[] = [];
    const viaSqs: SubmitWagerCommand[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 6; i++) {
        const bet = wagerCommand(wallet, { roundId: `r-${i}`, money: { amount: "10.00", currency: "BRL" } });
        const settle = wagerCommand(wallet, {
          kind: i % 3 === 0 ? "ROLLBACK" : i % 3 === 1 ? "WIN" : "LOSS",
          roundId: bet.roundId,
          referenceExternalTransactionId: bet.externalTransactionId,
          money: { amount: i % 3 === 0 ? "10.00" : i % 3 === 1 ? "15.00" : "0.00", currency: "BRL" },
        });
        // Bets and their settlements go through different channels, so either can arrive first.
        (i % 2 === 0 ? viaHttp : viaSqs).push(bet);
        (i % 2 === 0 ? viaSqs : viaHttp).push(settle);
      }
    }
    const [httpResults] = await Promise.all([fireHttp(urls, viaHttp), fireSqs(h.queues, viaSqs, { groupBy: "random" })]);
    expect(httpResults.every((r) => [201, 202].includes(r.status))).toBe(true);
    await waitForQuiescence(h.db.sql, h.queues);

    const [pending] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE status IN ('PENDING', 'PENDING_REFERENCE', 'FAILED')`;
    expect(pending.n).toBe(0);
    for (const [i, wallet] of wallets.entries()) {
      const response = await fetch(`${urls[i % 3]}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
      const report = (await response.json()) as { consistent: boolean; storedBalance: { amount: string } };
      expect(report.consistent).toBe(true);
      // 6 BETs (−60) + 2 ROLLBACKs (+20) + 2 WINs (+30) + 2 LOSSes (0) = 190.00
      expect(report.storedBalance.amount).toBe("190.00");
    }
    await assertLedgerInvariant(h.db.sql);

    // Outbox: 100% published, and every event reached the events queue at least once.
    const bodies = await drainQueue(h.queues.events, { idleRounds: 2 });
    const delivered = new Set(bodies.map((b) => JSON.parse(b).eventId as string));
    const outbox = await h.db.sql`SELECT id::text AS id FROM outbox_messages`;
    expect(outbox.filter((row: { id: string }) => !delivered.has(row.id))).toEqual([]);
    console.log(`[multi-instance] events=${outbox.length} delivered=${bodies.length} duplicates=${bodies.length - delivered.size}`);
  });
});
