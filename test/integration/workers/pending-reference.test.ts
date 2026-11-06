import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TransientInfrastructureError, TransientReason } from "../../../src/application/errors";
import { silentLogger } from "../../../src/application/ports/logger";
import type { SubmitWagerCommand } from "../../../src/application/use-cases/submit-wager-transaction";
import { WagerTransactionStatus } from "../../../src/domain/wager/kinds";
import type { Wallet } from "../../../src/domain/wallet/wallet";
import { buildContainer, type Container } from "../../../src/infrastructure/app/container";
import type { Runtime } from "../../../src/infrastructure/app/runtime";
import { assertLedgerInvariant } from "../../support/invariants";
import { createMessagingHarness, type MessagingHarness, sendEnvelope, wagerEnvelope } from "../../support/messaging";
import { CTX, wagerCommand } from "../../support/use-cases";
import { waitFor } from "../../support/wait";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

/**
 * PENDING_REFERENCE worker (§7.1, A7, A28). The "slow" runtime has a 60 s first retry, so a
 * dependent that resolves within seconds can only have been woken up by its reference arriving.
 */
type Row = { id: string; status: string; failure_code: string | null; reference_attempts: number };

async function txRow(h: MessagingHarness, command: Pick<SubmitWagerCommand, "providerId" | "externalTransactionId">) {
  const [row] = await h.db.sql`
    SELECT id, status, failure_code, reference_attempts FROM wager_transactions
     WHERE provider_id = ${command.providerId} AND external_transaction_id = ${command.externalTransactionId}`;
  return row as Row | undefined;
}

async function statusOf(h: MessagingHarness, command: SubmitWagerCommand): Promise<string | undefined> {
  return (await txRow(h, command))?.status;
}

async function balance(h: MessagingHarness, walletId: string): Promise<string> {
  const [row] = await h.db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${walletId}`;
  return row.balance;
}

async function eventsOf(h: MessagingHarness, aggregateId: string): Promise<string[]> {
  const rows = await h.db.sql`SELECT event_type FROM outbox_messages WHERE aggregate_id = ${aggregateId} ORDER BY occurred_at, id`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

async function ledger(h: MessagingHarness, walletId: string): Promise<string[]> {
  const rows = await h.db.sql`
    SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY wallet_version`;
  return rows.map((r: { direction: string; amount: string }) => `${r.direction} ${r.amount}`);
}

function bet(wallet: Wallet, amount = "25.00", round = `round-${crypto.randomUUID().slice(0, 8)}`) {
  return wagerCommand(wallet, { kind: "BET", roundId: round, money: { amount, currency: "BRL" } });
}

function referencing(wallet: Wallet, kind: string, reference: SubmitWagerCommand, amount = reference.money.amount) {
  return wagerCommand(wallet, {
    kind,
    roundId: reference.roundId,
    referenceExternalTransactionId: reference.externalTransactionId,
    money: { amount, currency: "BRL" },
  });
}

async function post(runtime: Runtime, command: SubmitWagerCommand) {
  const { idempotencyKey, ...body } = command;
  const response = await fetch(`http://127.0.0.1:${runtime.port}/wagering/transactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("PENDING_REFERENCE resolution", () => {
  let h: MessagingHarness;
  let slow: Runtime;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "pending" });
    slow = await h.start({
      ROLES: ["api", "consumer", "pending-worker"],
      PENDING_REF_BASE_MS: 60_000,
      PENDING_REF_CAP_MS: 300_000,
      PENDING_REF_MAX_ATTEMPTS: 10,
    });
  });
  afterEach(async () => {
    await assertLedgerInvariant(h.db.sql);
  });
  afterAll(async () => {
    await h.close();
  });

  test("HTTP: ROLLBACK before its BET → 202 PENDING_REFERENCE; the BET wakes it up and it is applied", async () => {
    const wallet = await h.openWallet("100.00");
    const theBet = bet(wallet);
    const rollback = referencing(wallet, "ROLLBACK", theBet);

    const pending = await post(slow, rollback);
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ status: "PENDING_REFERENCE", balance: null, idempotentReplay: false });
    expect(await eventsOf(h, pending.body.transactionId)).toEqual(["WagerTransactionPendingReference"]);

    expect((await post(slow, theBet)).status).toBe(201);
    await waitFor(async () => (await statusOf(h, rollback)) === "PROCESSED", { description: "woken ROLLBACK", timeoutMs: 10_000 });

    expect(await balance(h, wallet.id)).toBe("100.00");
    expect(await ledger(h, wallet.id)).toEqual(["CREDIT 100.00", "DEBIT 25.00", "CREDIT 25.00"]);
    expect(await eventsOf(h, pending.body.transactionId)).toEqual([
      "WagerTransactionPendingReference",
      "WagerTransactionProcessed",
    ]);
    // A12: the replay now reports the current (terminal) state.
    const replay = await post(slow, rollback);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: "PROCESSED", idempotentReplay: true, balance: { amount: "100.00", currency: "BRL" } });
  });

  test("SQS: REFUND before its BET is pending, then applied when the BET arrives", async () => {
    const wallet = await h.openWallet("100.00");
    const theBet = bet(wallet, "40.00");
    const refund = referencing(wallet, "REFUND", theBet);
    await sendEnvelope(h.queues, wagerEnvelope(refund));
    await waitFor(async () => (await statusOf(h, refund)) === "PENDING_REFERENCE", { description: "pending" });
    await sendEnvelope(h.queues, wagerEnvelope(theBet));
    await waitFor(async () => (await statusOf(h, refund)) === "PROCESSED", { description: "woken REFUND", timeoutMs: 10_000 });
    expect(await balance(h, wallet.id)).toBe("100.00");
    expect(await ledger(h, wallet.id)).toEqual(["CREDIT 100.00", "DEBIT 40.00", "CREDIT 40.00"]);
  });

  test("REFUND and ROLLBACK both pending on the same BET: one is applied, the other REFERENCE_ALREADY_REVERSED", async () => {
    const wallet = await h.openWallet("100.00");
    const theBet = bet(wallet);
    const refund = referencing(wallet, "REFUND", theBet);
    const rollback = referencing(wallet, "ROLLBACK", theBet);
    expect((await post(slow, refund)).status).toBe(202);
    expect((await post(slow, rollback)).status).toBe(202);
    expect((await post(slow, theBet)).status).toBe(201);

    await waitFor(
      async () => {
        const statuses = [await statusOf(h, refund), await statusOf(h, rollback)];
        return statuses.every((s) => s === "PROCESSED" || s === "REJECTED") ? statuses : undefined;
      },
      { description: "both resolved", timeoutMs: 10_000 },
    );
    const rows = [await txRow(h, refund), await txRow(h, rollback)];
    expect(rows.filter((r) => r?.status === "PROCESSED")).toHaveLength(1);
    expect(rows.find((r) => r?.status === "REJECTED")?.failure_code).toBe("REFERENCE_ALREADY_REVERSED");
    expect(await balance(h, wallet.id)).toBe("100.00");
    expect(await ledger(h, wallet.id)).toEqual(["CREDIT 100.00", "DEBIT 25.00", "CREDIT 25.00"]);
  });

  test("cascade: ROLLBACK of a WIN that is itself waiting for its BET resolves once the BET arrives", async () => {
    const wallet = await h.openWallet("100.00");
    const theBet = bet(wallet);
    const win = referencing(wallet, "WIN", theBet, "50.00");
    const rollbackWin = referencing(wallet, "ROLLBACK", win, "50.00");
    expect((await post(slow, win)).status).toBe(202);
    expect((await post(slow, rollbackWin)).status).toBe(202); // reference exists but is PENDING_REFERENCE (A7)
    expect((await post(slow, theBet)).status).toBe(201);

    await waitFor(async () => (await statusOf(h, rollbackWin)) === "PROCESSED", { description: "cascade", timeoutMs: 10_000 });
    expect(await statusOf(h, win)).toBe("PROCESSED");
    expect(await balance(h, wallet.id)).toBe("75.00");
    expect(await ledger(h, wallet.id)).toEqual(["CREDIT 100.00", "DEBIT 25.00", "CREDIT 50.00", "DEBIT 50.00"]);
  });

  test.each([
    ["REJECTED", "a BET without funds"],
    ["FAILED", "a WIN hit by a permanent internal error"],
  ])("a reference that ends %s (%s) wakes its dependent at once: REJECTED with REFERENCE_NOT_PROCESSED", async (ending) => {
    const wallet = await h.openWallet("10.00");
    const reference = ending === "REJECTED" ? bet(wallet, "50.00") : referencing(wallet, "WIN", bet(wallet), "5.00");
    const dependent = referencing(wallet, "ROLLBACK", reference);
    expect((await post(slow, dependent)).status).toBe(202); // first retry only in 60 s

    if (ending === "FAILED") h.faults.throwAt("submit:before-outbox-insert", () => new Error("simulated defect"), 1);
    const outcome = await h.container.submit.execute(reference, CTX).then(
      (result) => result.transaction.status as string,
      () => "FAILED",
    );
    expect(outcome).toBe(ending);
    expect((await txRow(h, reference))?.status).toBe(ending);

    const row = await waitFor(async () => {
      const current = await txRow(h, dependent);
      return current?.status === "REJECTED" ? current : undefined;
    }, { description: "dependent woken up", timeoutMs: 5_000 });
    expect(row.failure_code).toBe("REFERENCE_NOT_PROCESSED");
    expect(await eventsOf(h, row.id)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    expect(await balance(h, wallet.id)).toBe("10.00");
  });
});

describe("PENDING_REFERENCE: a reference that exists but is still pending", () => {
  let h: MessagingHarness;
  let fast: Runtime;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "pending-in-flight" });
    // Budget: 3 retries, 1 s apart (each transaction gives up ~3 s after it first became pending).
    fast = await h.start({
      ROLES: ["api", "pending-worker"],
      PENDING_REF_BASE_MS: 1_000,
      PENDING_REF_CAP_MS: 1_000,
      PENDING_REF_MAX_ATTEMPTS: 3,
      PENDING_REF_POLL_MS: 50,
    });
  });
  afterEach(async () => {
    await assertLedgerInvariant(h.db.sql);
  });
  afterAll(async () => {
    await h.close();
  });

  test("ROLLBACK(WIN) → WIN(BET) → BET: the ROLLBACK waits for the WIN without spending attempts and the balance ends at 90.00", async () => {
    const wallet = await h.openWallet("100.00");
    const theBet = bet(wallet, "10.00");
    const win = referencing(wallet, "WIN", theBet, "30.00");
    const rollbackWin = referencing(wallet, "ROLLBACK", win, "30.00");

    const startedAt = Date.now();
    expect((await post(fast, rollbackWin)).status).toBe(202); // its own budget would end at ~3 s
    await Bun.sleep(1_500); // one retry spent while the WIN is really missing
    expect((await post(fast, win)).status).toBe(202); // the WIN's budget ends at ~4.5 s
    await Bun.sleep(3_700 - (Date.now() - startedAt)); // past the ROLLBACK's budget, before the WIN's

    const waiting = await txRow(h, rollbackWin);
    expect(waiting?.status).toBe("PENDING_REFERENCE");
    expect(waiting!.reference_attempts).toBe(1); // only the retry made while the WIN was missing

    expect((await post(fast, theBet)).status).toBe(201);
    await waitFor(async () => (await statusOf(h, rollbackWin)) === "PROCESSED", { description: "cascade", timeoutMs: 10_000 });
    expect(await statusOf(h, win)).toBe("PROCESSED");
    expect(await balance(h, wallet.id)).toBe("90.00");
    expect(await ledger(h, wallet.id)).toEqual(["CREDIT 100.00", "DEBIT 10.00", "CREDIT 30.00", "DEBIT 30.00"]);
  });
});

describe("concurrent PENDING_REFERENCE workers", () => {
  let h: MessagingHarness;
  let workers: Container[];

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "pending-workers", config: { PENDING_REF_BATCH_SIZE: 5, PENDING_REF_LEASE_MS: 500 } });
    workers = await Promise.all([1, 2].map(() => buildContainer(h.config, { logger: silentLogger })));
  });
  afterEach(async () => {
    await assertLedgerInvariant(h.db.sql);
  });
  afterAll(async () => {
    for (const worker of workers) await worker.close();
    await h.close();
  });

  test("2 workers over 40 pending transactions: each one is resolved exactly once", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => h.openWallet("100.00")));
    const arriving: SubmitWagerCommand[] = [];
    const dependents: SubmitWagerCommand[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 4; i++) {
        const theBet = bet(wallet, "5.00");
        const rollback = referencing(wallet, "ROLLBACK", theBet);
        await h.container.submit.execute(rollback, CTX);
        dependents.push(rollback);
        if (i % 2 === 0) arriving.push(theBet); // half of the BETs show up, half never do
      }
    }
    for (const theBet of arriving) await h.container.submit.execute(theBet, CTX);

    const totals = { PROCESSED: 0, REJECTED: 0, FAILED: 0, STILL_PENDING: 0, SKIPPED: 0, RETRY_LATER: 0 };
    const deadline = Date.now() + 30_000;
    const loop = async (worker: Container) => {
      while (Date.now() < deadline) {
        const [row] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`;
        if (row.n === 0) return;
        const round = await worker.resolvePending.runRound();
        for (const [key, value] of Object.entries(round.resolutions)) totals[key as keyof typeof totals] += value;
        if (round.claimed === 0) await Bun.sleep(20);
      }
    };
    await Promise.all(workers.map(loop));

    expect(totals.PROCESSED).toBe(20);
    expect(totals.REJECTED).toBe(20);
    const ids = (await Promise.all(dependents.map((d) => txRow(h, d)))).map((r) => r!.id);
    const terminalEvents = await h.db.sql`
      SELECT aggregate_id, COUNT(*)::int AS n FROM outbox_messages
       WHERE aggregate_id IN ${h.db.sql(ids)} AND event_type IN ('WagerTransactionProcessed', 'WagerTransactionRejected')
       GROUP BY aggregate_id`;
    expect(terminalEvents).toHaveLength(40);
    expect(terminalEvents.every((r: { n: number }) => r.n === 1)).toBe(true);
    for (const wallet of wallets) expect(await balance(h, wallet.id)).toBe("100.00"); // each BET rolled back once
  });

  test("retry budget exhausted: REJECTED with REFERENCE_NOT_FOUND and WagerTransactionRejected is emitted", async () => {
    const wallet = await h.openWallet("100.00");
    const orphan = referencing(wallet, "ROLLBACK", bet(wallet)); // the BET never arrives
    const result = await h.container.submit.execute(orphan, CTX); // harness policy: 3 attempts, 50 ms → 200 ms
    expect(result.transaction.status).toBe(WagerTransactionStatus.PendingReference);

    const row = await waitFor(async () => {
      await workers[0]!.resolvePending.runRound();
      const current = await txRow(h, orphan);
      return current?.status === "REJECTED" ? current : undefined;
    }, { description: "exhausted", timeoutMs: 15_000, intervalMs: 50 });
    expect(row.failure_code).toBe("REFERENCE_NOT_FOUND");
    expect(row.reference_attempts).toBe(h.config.PENDING_REF_MAX_ATTEMPTS - 1);
    expect(await eventsOf(h, row.id)).toEqual(["WagerTransactionPendingReference", "WagerTransactionRejected"]);
    expect(await balance(h, wallet.id)).toBe("100.00");
  });

  test("a worker that dies after claiming releases the items when the lease expires", async () => {
    const wallet = await h.openWallet("100.00");
    const orphan = referencing(wallet, "ROLLBACK", bet(wallet)); // stays pending (no BET)
    const { transaction } = await h.container.submit.execute(orphan, CTX);
    await Bun.sleep(100); // due (first retry after 50 ms)

    const claimed = await workers[0]!.resolvePending.claim(); // …and this worker "dies" here
    expect(claimed.map((c) => c.id)).toContain(transaction.id);
    const during = await workers[1]!.resolvePending.claim();
    expect(during.map((c) => c.id)).not.toContain(transaction.id); // leased: invisible to others

    await Bun.sleep(h.config.PENDING_REF_LEASE_MS + 100);
    const after = await workers[1]!.resolvePending.claim();
    expect(after.map((c) => c.id)).toContain(transaction.id);
    for (const claim of after) await workers[1]!.resolvePending.resolve(claim);
    expect((await txRow(h, orphan))?.reference_attempts).toBe(1); // the lost claim was not counted
  });
});

describe("PENDING_REFERENCE worker: a failing item does not stop the others", () => {
  let h: MessagingHarness;

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "pending-isolation", config: { PENDING_REF_LEASE_MS: 300 } });
  });
  afterEach(async () => {
    h.faults.reset();
    await assertLedgerInvariant(h.db.sql);
  });
  afterAll(async () => {
    await h.close();
  });

  /** Two ROLLBACKs on two wallets, both woken up (due now) by their BET: one worker round claims both. */
  async function twoDueRollbacks() {
    const wallets = [await h.openWallet("100.00"), await h.openWallet("100.00")];
    const bets = wallets.map((wallet) => bet(wallet));
    const rollbacks = wallets.map((wallet, i) => referencing(wallet, "ROLLBACK", bets[i]!));
    for (const rollback of rollbacks) await h.container.submit.execute(rollback, CTX);
    for (const theBet of bets) await h.container.submit.execute(theBet, CTX);
    return { wallets, rollbacks };
  }

  test("a permanent error is recorded as FAILED for that item and the rest of the batch is applied", async () => {
    const { wallets, rollbacks } = await twoDueRollbacks();
    h.faults.throwAt("pending:before-apply", () => new Error("simulated defect"), 1);

    const round = await h.container.resolvePending.runRound(); // must not throw
    expect(round.claimed).toBe(2);
    expect(round.resolutions).toMatchObject({ FAILED: 1, PROCESSED: 1 });

    const rows = await Promise.all(rollbacks.map((rollback) => txRow(h, rollback)));
    const failedIndex = rows.findIndex((row) => row?.status === "FAILED");
    expect(failedIndex).toBeGreaterThanOrEqual(0);
    expect(rows[failedIndex]!.failure_code).toBe("INTERNAL_INVARIANT_VIOLATION");
    expect(rows[1 - failedIndex]!.status).toBe("PROCESSED");
    expect(await balance(h, wallets[failedIndex]!.id)).toBe("75.00"); // only the BET moved this wallet
    expect(await balance(h, wallets[1 - failedIndex]!.id)).toBe("100.00"); // BET rolled back

    await Bun.sleep(h.config.PENDING_REF_LEASE_MS + 100);
    expect((await h.container.resolvePending.runRound()).claimed).toBe(0); // nothing left stuck
  });

  test("a transient error defers only that item, without spending a retry attempt", async () => {
    const { wallets, rollbacks } = await twoDueRollbacks();
    h.faults.throwAt(
      "pending:before-apply",
      () => new TransientInfrastructureError(TransientReason.ConnectionFailure, "simulated outage"),
      1,
    );

    const round = await h.container.resolvePending.runRound();
    expect(round.resolutions).toMatchObject({ RETRY_LATER: 1, PROCESSED: 1 });
    const deferred = (await Promise.all(rollbacks.map((rollback) => txRow(h, rollback)))).find(
      (row) => row?.status === "PENDING_REFERENCE",
    );
    expect(deferred?.reference_attempts).toBe(0);

    // The lease expires and a later round applies it.
    await waitFor(async () => {
      await h.container.resolvePending.runRound();
      const statuses = await Promise.all(rollbacks.map((rollback) => statusOf(h, rollback)));
      return statuses.every((status) => status === "PROCESSED");
    }, { description: "deferred item applied", timeoutMs: 10_000, intervalMs: 100 });
    for (const wallet of wallets) expect(await balance(h, wallet.id)).toBe("100.00");
  });
});
