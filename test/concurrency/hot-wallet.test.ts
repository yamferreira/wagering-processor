import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SubmitWagerCommand } from "../../src/application/use-cases/submit-wager-transaction";
import { assertLedgerInvariant } from "../support/invariants";
import { CTX, createUseCaseHarness, type UseCaseHarness, wagerCommand } from "../support/use-cases";

// Real PostgreSQL: explicit timeout per file (Bun ignores bunfig/preload beyond the first file).
setDefaultTimeout(120_000);

/**
 * Hot wallet: 200 mixed operations (BET, WIN, LOSS, REFUND, ROLLBACK) fired at ONE wallet at the same
 * time, through a 30-connection pool. References frequently arrive before what they reference
 * (PENDING_REFERENCE) and are woken up / retried by the worker. At the end: invariant, balance ≥ 0,
 * and the balance equals what the terminal transactions say it should be.
 */
describe("hot wallet", () => {
  let h: UseCaseHarness;

  beforeAll(async () => {
    h = await createUseCaseHarness({}, 30);
  });
  afterAll(async () => {
    await h.close();
  });

  const amount = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

  test("200 concurrent mixed operations keep balance == ledger and balance >= 0", async () => {
    const wallet = await h.createWallet.execute(
      { playerId: `hot-${crypto.randomUUID()}`, initialBalance: { amount: "500.00", currency: "BRL" } },
      CTX,
    );
    let seed = 42;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;

    const commands: SubmitWagerCommand[] = [];
    const bets: SubmitWagerCommand[] = [];
    for (let i = 0; i < 100; i++) {
      const bet = wagerCommand(wallet, { roundId: `r-${i}`, money: { amount: amount(100 + Math.floor(random() * 1_900)), currency: "BRL" } });
      bets.push(bet);
      commands.push(bet);
    }
    const ref = (kind: string, target: SubmitWagerCommand, money = target.money.amount) =>
      wagerCommand(wallet, {
        kind,
        roundId: target.roundId,
        referenceExternalTransactionId: target.externalTransactionId,
        money: { amount: money, currency: "BRL" },
      });
    for (let i = 0; i < 40; i++) commands.push(ref("WIN", bets[i]!, amount(50 + Math.floor(random() * 3_000))));
    for (let i = 40; i < 60; i++) commands.push(ref("LOSS", bets[i]!, "0.00"));
    for (let i = 60; i < 80; i++) commands.push(ref("REFUND", bets[i]!));
    for (let i = 80; i < 100; i++) commands.push(ref("ROLLBACK", bets[i]!));
    // 20 contested reversals: a second REFUND/ROLLBACK for BETs that already get one (A4).
    for (let i = 60; i < 80; i++) commands.push(ref("ROLLBACK", bets[i]!));
    expect(commands).toHaveLength(220);
    commands.sort(() => random() - 0.5);

    const startedAt = performance.now();
    const results = await Promise.allSettled(commands.map((command) => h.submit.execute(command, CTX)));
    const elapsed = performance.now() - startedAt;
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toEqual([]); // no 5xx-equivalent: every operation got a definite answer

    // Let the worker resolve whatever arrived before its reference.
    for (let round = 0; round < 200; round++) {
      const [row] = await h.db.sql`SELECT COUNT(*)::int AS n FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`;
      if (row.n === 0) break;
      await h.resolvePending.runRound();
      await Bun.sleep(25);
    }

    const [summary] = await h.db.sql`
      SELECT w.balance::text AS balance,
             (w.balance >= 0) AS non_negative,
             (SELECT COUNT(*)::int FROM wager_transactions t WHERE t.wallet_id = w.id AND t.status = 'PENDING_REFERENCE') AS pending,
             (SELECT COUNT(*)::int FROM wager_transactions t WHERE t.wallet_id = w.id AND t.status = 'FAILED') AS failed,
             (SELECT COUNT(*)::int FROM wager_transactions t
               WHERE t.wallet_id = w.id AND t.status = 'PROCESSED' AND t.kind <> 'LOSS') AS movements,
             (SELECT COUNT(*)::int FROM wallet_ledger_entries l WHERE l.wallet_id = w.id) AS entries,
             (SELECT COALESCE(MAX(n), 0)::int FROM (
                SELECT COUNT(*) AS n FROM wager_transactions t
                 WHERE t.wallet_id = w.id AND t.kind IN ('REFUND', 'ROLLBACK') AND t.status = 'PROCESSED'
                 GROUP BY t.reference_transaction_id) reversals) AS max_reversals_per_reference
        FROM wallets w WHERE w.id = ${wallet.id}`;
    expect(summary.non_negative).toBe(true);
    expect(summary.pending).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.entries).toBe(summary.movements); // one ledger entry per balance-moving transaction
    expect(summary.max_reversals_per_reference).toBe(1);

    // Balance recomputed from the transactions themselves (independently of the ledger).
    const [expected] = await h.db.sql`
      SELECT (SUM(CASE
                WHEN t.kind IN ('OPENING', 'WIN', 'REFUND') THEN t.amount
                WHEN t.kind = 'BET' THEN -t.amount
                WHEN t.kind = 'ROLLBACK' AND r.kind = 'BET' THEN t.amount
                WHEN t.kind = 'ROLLBACK' THEN -t.amount
                ELSE 0 END))::text AS balance
        FROM wager_transactions t
        LEFT JOIN wager_transactions r ON r.id = t.reference_transaction_id
       WHERE t.wallet_id = ${wallet.id} AND t.status = 'PROCESSED'`;
    expect(summary.balance).toBe(expected.balance);
    await assertLedgerInvariant(h.db.sql, [wallet.id]);
    console.log(
      `[hot-wallet] ${commands.length} ops in ${elapsed.toFixed(0)} ms; final balance ${summary.balance}; ${summary.entries - 1} movements`,
    );
  });
});
