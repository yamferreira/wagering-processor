import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { TransientInfrastructureError } from "../../src/application/errors";
import { assertLedgerInvariant } from "../support/invariants";
import { CTX, createUseCaseHarness, type UseCaseHarness, wagerCommand } from "../support/use-cases";

// Real PostgreSQL: explicit timeout per file (Bun ignores bunfig/preload beyond the first file).
setDefaultTimeout(120_000);

/** §13: "wallets distintas processadas em paralelo" — and proof that the lock is per wallet row. */
describe("distinct wallets in parallel", () => {
  let h: UseCaseHarness;

  beforeAll(async () => {
    h = await createUseCaseHarness({ lockTimeoutMs: 1_000 }, 40);
  });
  afterAll(async () => {
    await h.close();
  });

  test("50 wallets × 20 operations, all at once: every wallet consistent and exact", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        h.createWallet.execute({ playerId: `pw-${i}-${crypto.randomUUID()}`, initialBalance: { amount: "100.00", currency: "BRL" } }, CTX),
      ),
    );
    // Per wallet: 15 BETs of 5.00 (75.00) and 5 WINs of 2.00 referencing the first 5 BETs (+10.00).
    const commands = wallets.flatMap((wallet) => {
      const bets = Array.from({ length: 15 }, (_, i) =>
        wagerCommand(wallet, { roundId: `r-${i}`, money: { amount: "5.00", currency: "BRL" } }),
      );
      const wins = bets.slice(0, 5).map((bet) =>
        wagerCommand(wallet, {
          kind: "WIN",
          roundId: bet.roundId,
          referenceExternalTransactionId: bet.externalTransactionId,
          money: { amount: "2.00", currency: "BRL" },
        }),
      );
      return [...bets, ...wins];
    });
    expect(commands).toHaveLength(1_000);
    // Interleave wallets so the pool is not filled by operations queued on the same wallet lock.
    for (let i = commands.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [commands[i], commands[j]] = [commands[j]!, commands[i]!];
    }

    const startedAt = performance.now();
    const results = await Promise.allSettled(commands.map((command) => h.submit.execute(command, CTX)));
    const elapsed = performance.now() - startedAt;
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    for (let round = 0; round < 100; round++) {
      const [row] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`;
      if (row.n === 0) break;
      await h.resolvePending.runRound();
      await Bun.sleep(20);
    }

    const rows = await h.db.sql`
      SELECT w.id, w.balance::text AS balance, w.version,
             (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) AS entries
        FROM wallets w WHERE w.id IN ${h.db.sql(wallets.map((w) => w.id))}`;
    expect(rows).toHaveLength(50);
    for (const row of rows) {
      expect(row.balance).toBe("35.00"); // 100 − 75 + 10
      expect(row.entries).toBe(21); // OPENING + 15 + 5
      expect(row.version).toBe(21);
    }
    await assertLedgerInvariant(h.db.sql);
    console.log(`[parallel-wallets] 1000 ops over 50 wallets in ${elapsed.toFixed(0)} ms`);
  });

  test("the lock is per row: wallet X held → X times out, Y commits meanwhile (deterministic)", async () => {
    const [x, y] = await Promise.all(
      ["x", "y"].map((label) =>
        h.createWallet.execute({ playerId: `${label}-${crypto.randomUUID()}`, initialBalance: { amount: "10.00", currency: "BRL" } }, CTX),
      ),
    );
    const holder = await h.db.sql.reserve();
    await holder`BEGIN`;
    await holder`SELECT id FROM wallets WHERE id = ${x!.id} FOR UPDATE`;
    try {
      const onX = h.submit.execute(wagerCommand(x!, { money: { amount: "1.00", currency: "BRL" } }), CTX);
      const startedAt = performance.now();
      const onY = await h.submit.execute(wagerCommand(y!, { money: { amount: "1.00", currency: "BRL" } }), CTX);
      const yElapsed = performance.now() - startedAt;
      expect(onY.transaction.status).toBe("PROCESSED" as never);
      expect(yElapsed).toBeLessThan(900); // did not wait for X's lock (lock_timeout = 1 s)
      const error = await onX.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TransientInfrastructureError);
      expect((error as TransientInfrastructureError).reason).toBe("LOCK_TIMEOUT" as never);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    const [row] = await h.db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${x!.id}`;
    expect(row.balance).toBe("10.00");
    await assertLedgerInvariant(h.db.sql, [x!.id, y!.id]);
  });
});
