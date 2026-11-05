import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SubmitWagerCommand } from "../../src/application/use-cases/submit-wager-transaction";
import { pidAlive, spawnCluster } from "../support/cluster";
import { waitForQuiescence } from "../support/drain";
import { killAllInstances } from "../support/instances";
import { assertLedgerInvariant } from "../support/invariants";
import { fireSqs, type HttpResult, postWager } from "../support/load";
import { createMessagingHarness, type MessagingHarness } from "../support/messaging";
import { drainQueue } from "../support/sqs";
import { wagerCommand } from "../support/use-cases";
import { waitFor } from "../support/wait";

// Real processes, PostgreSQL and LocalStack: explicit timeout per file (Bun ignores bunfig/preload beyond the first file).
setDefaultTimeout(180_000);

/**
 * §13: "reinício do serviço com comprovação da consistência final". All 3 instances are SIGKILLed
 * in the middle of an HTTP + SQS load (with references arriving out of order), restarted, and the
 * provider retries whatever HTTP requests did not get an answer. After draining:
 *   - every command has exactly one transaction, in a terminal state;
 *   - reconciliation is consistent for every wallet (HTTP endpoint);
 *   - the outbox is 100% published and every event reached the events queue;
 *   - no due PENDING_REFERENCE is left behind.
 */
describe("restart with proof of final consistency (real processes)", () => {
  let h: MessagingHarness;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "restart", queues: { visibilityTimeoutSeconds: 3 } });
  });
  afterAll(async () => {
    await killAllInstances();
    await h.close();
  });

  // Short lease: items a killed worker had claimed are taken over quickly by the restarted ones.
  const clusterConfig = () => ({
    PENDING_REF_BASE_MS: 100,
    PENDING_REF_CAP_MS: 1_000,
    PENDING_REF_MAX_ATTEMPTS: 8,
    PENDING_REF_LEASE_MS: 2_000,
  });

  test("SIGKILL of every instance mid-load, restart, drain → consistent", async () => {
    const first = await spawnCluster(h, 3, clusterConfig);
    const firstPids = first.map((i) => i.proc.pid);

    const wallets = await Promise.all(Array.from({ length: 15 }, () => h.openWallet("500.00")));
    const viaHttp: SubmitWagerCommand[] = [];
    const viaSqs: SubmitWagerCommand[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 10; i++) {
        const bet = wagerCommand(wallet, { roundId: `r-${i}`, money: { amount: "7.00", currency: "BRL" } });
        const settle = wagerCommand(wallet, {
          kind: i % 2 === 0 ? "REFUND" : "WIN",
          roundId: bet.roundId,
          referenceExternalTransactionId: bet.externalTransactionId,
          money: { amount: i % 2 === 0 ? "7.00" : "3.50", currency: "BRL" },
        });
        (i % 2 === 0 ? viaHttp : viaSqs).push(bet);
        (i % 2 === 0 ? viaSqs : viaHttp).push(settle);
      }
    }

    // Start the load and pull the plug on every instance while it is in flight.
    const answered = new Map<SubmitWagerCommand, HttpResult>();
    const errors: string[] = [];
    const loadStartedAt = Date.now();
    const urls = first.map((i) => i.baseUrl);
    const httpLoad = Promise.all(
      viaHttp.map(async (command, i) => {
        await Bun.sleep(i * 15); // spread over ~2 s so the kill lands mid-load
        try {
          answered.set(command, await postWager(urls[i % 3]!, command));
        } catch (error) {
          // connection refused/reset by the crash: the provider will retry with the same key
          errors.push(String(error));
        }
      }),
    );
    const sqsLoad = fireSqs(h.queues, viaSqs, { groupBy: "random" });
    // Kill once a real part of the load has committed (and the rest is still in flight).
    const committed = await waitFor(async () => {
      const [row] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE kind <> 'OPENING'`;
      return row.n >= 60 ? row.n : undefined;
    }, { description: "part of the load committed", timeoutMs: 30_000, intervalMs: 10 });
    console.log(`[restart] killing at t=${Date.now() - loadStartedAt}ms: committed=${committed}/300 http answered=${answered.size}`);
    await Promise.all(first.map((instance) => instance.kill()));
    await Promise.all([httpLoad, sqsLoad]);
    await waitFor(() => firstPids.every((pid) => !pidAlive(pid)), { description: "all killed", timeoutMs: 5_000 });

    const unanswered = viaHttp.filter((command) => !answered.has(command) || answered.get(command)!.status >= 500);
    console.log(`[restart] http answered=${answered.size}/${viaHttp.length} unanswered=${unanswered.length} sqs=${viaSqs.length}`);
    expect(unanswered.length).toBeGreaterThan(0); // the kill really happened mid-load
    expect(answered.size).toBeGreaterThan(0);

    // Restart and let the provider retry the HTTP requests that never got an answer.
    const second = await spawnCluster(h, 3, clusterConfig);
    const retryUrls = second.map((i) => i.baseUrl);
    const retries = await Promise.all(unanswered.map((command, i) => postWager(retryUrls[i % 3]!, command)));
    expect(retries.every((r) => [200, 201, 202, 422].includes(r.status))).toBe(true);
    await waitForQuiescence(h.db.sql, h.queues, { timeoutMs: 90_000 });
    // Every reference exists in the end, so nothing may stay pending — including the items a killed
    // worker had leased (they become due again when the lease expires).
    const [leased] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`;
    await waitFor(async () => {
      const [row] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE status IN ('PENDING', 'PENDING_REFERENCE')`;
      return row.n === 0;
    }, { description: "no transaction left pending", timeoutMs: 30_000, intervalMs: 200 });
    await waitForQuiescence(h.db.sql, h.queues, { timeoutMs: 30_000 });
    console.log(`[restart] pending items recovered after lease expiry: ${leased.n}`);

    // Exactly one transaction per command, all terminal.
    const all = [...viaHttp, ...viaSqs];
    const rows = await h.db.sql`
      SELECT provider_id || ':' || external_transaction_id AS key, status
        FROM wager_transactions WHERE wallet_id IN ${h.db.sql(wallets.map((w) => w.id))} AND kind <> 'OPENING'`;
    expect(rows).toHaveLength(all.length);
    expect(new Set(rows.map((r: { key: string }) => r.key)).size).toBe(all.length);
    const statuses = new Set(rows.map((r: { status: string }) => r.status));
    expect([...statuses].every((s) => s === "PROCESSED" || s === "REJECTED")).toBe(true);

    // Reconciliation through the API of the restarted instances.
    for (const [i, wallet] of wallets.entries()) {
      const response = await fetch(`${retryUrls[i % 3]}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
      const report = (await response.json()) as { consistent: boolean };
      expect(report.consistent).toBe(true);
    }
    await assertLedgerInvariant(h.db.sql);

    const [leftovers] = await h.db.sql`
      SELECT (SELECT COUNT(*)::int FROM outbox_messages WHERE published_at IS NULL) AS unpublished,
             (SELECT COUNT(*)::int FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= now()) AS due_pending`;
    expect(leftovers).toEqual({ unpublished: 0, due_pending: 0 });
    const bodies = await drainQueue(h.queues.events, { idleRounds: 2 });
    const delivered = new Set(bodies.map((b) => JSON.parse(b).eventId as string));
    const outbox = await h.db.sql`SELECT id::text AS id FROM outbox_messages`;
    expect(outbox.filter((row: { id: string }) => !delivered.has(row.id))).toEqual([]);
    const [dlq] = [await h.queues.dlq.approximateDepth()];
    expect(dlq.visible + dlq.inFlight).toBe(0);
    console.log(`[restart] events=${outbox.length} delivered=${bodies.length} duplicates=${bodies.length - delivered.size}`);

    expect(await Promise.all(second.map((i) => i.stop()))).toEqual([0, 0, 0]);
  });
});
