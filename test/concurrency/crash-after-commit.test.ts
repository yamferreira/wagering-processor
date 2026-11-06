import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { pidAlive, spawnCluster } from "../support/cluster";
import { waitForQuiescence } from "../support/drain";
import { jsonLogs, killAllInstances } from "../support/instances";
import { assertLedgerInvariant } from "../support/invariants";
import { fireSqs } from "../support/load";
import { createMessagingHarness, type MessagingHarness } from "../support/messaging";
import { wagerCommand } from "../support/use-cases";
import { waitFor } from "../support/wait";

// Real processes, PostgreSQL and LocalStack: explicit timeout per file (Bun ignores bunfig/preload beyond the first file).
setDefaultTimeout(180_000);

/**
 * §13: "worker morto depois do commit e antes do ack". Instance 1 is the only consumer when the
 * message arrives and kills itself (SIGKILL) right after the database commit, before DeleteMessage.
 * The message comes back after the visibility timeout to the other instances: the inbox recognizes
 * it, there is a single effect, and the ack finally happens.
 */
describe("crash after commit and before ack (real processes)", () => {
  let h: MessagingHarness;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "crash", queues: { visibilityTimeoutSeconds: 3 } });
  });
  afterEach(async () => {
    await assertLedgerInvariant(h.db.sql); // §13: the invariant closes every test
  });
  afterAll(async () => {
    await killAllInstances();
    await h.close();
  });

  test("the redelivery is deduplicated by the inbox on another instance; one debit, events published", async () => {
    const wallet = await h.openWallet("100.00");
    const [doomed] = await spawnCluster(h, 1, () => ({
      ROLES: ["consumer"],
      FAULTS: "consumer:after-commit-before-ack=crash*1",
    }));
    const pid = doomed!.proc.pid;
    const command = wagerCommand(wallet, { money: { amount: "30.00", currency: "BRL" } });
    const [messageId] = await fireSqs(h.queues, [command]);

    const exitCode = await doomed!.exited;
    expect(exitCode).not.toBe(0); // died abruptly, no graceful shutdown
    expect(pidAlive(pid)).toBe(false);
    expect(jsonLogs(doomed!).some((line) => line.msg === "shutting down")).toBe(false);

    // The commit happened: transaction, ledger, inbox and outbox are all there…
    const [tx] = await h.db.sql`
      SELECT id, status FROM wager_transactions WHERE provider_id = ${command.providerId} AND external_transaction_id = ${command.externalTransactionId}`;
    expect(tx.status).toBe("PROCESSED");
    const [inbox] = await h.db.sql`SELECT COUNT(*)::int AS n FROM inbox_messages WHERE message_id = ${messageId!}`;
    expect(inbox.n).toBe(1);
    const [outbox] = await h.db.sql`SELECT COUNT(*)::int AS n FROM outbox_messages WHERE aggregate_id IN (${tx.id}, ${wallet.id})`;
    expect(outbox.n).toBeGreaterThanOrEqual(2);
    // …but the message was never acked.
    const depth = await h.queues.input.approximateDepth();
    expect(depth.visible + depth.inFlight).toBe(1);

    // Other instances take over: redelivery → inbox duplicate → ack; their publishers publish the events.
    const survivors = await spawnCluster(h, 2);
    await waitForQuiescence(h.db.sql, h.queues, { timeoutMs: 60_000 });
    const duplicates = survivors.flatMap((s) => jsonLogs(s)).filter((line) => line.outcome === "DUPLICATE_MESSAGE");
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
    expect(duplicates[0]!.messageId).toBe(messageId);

    const [state] = await h.db.sql`
      SELECT w.balance::text AS balance,
             (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id AND l.direction = 'DEBIT') AS debits
        FROM wallets w WHERE w.id = ${wallet.id}`;
    expect(state).toEqual({ balance: "70.00", debits: 1 });
    await assertLedgerInvariant(h.db.sql);
    expect(await Promise.all(survivors.map((s) => s.stop()))).toEqual([0, 0]);
  });
});
