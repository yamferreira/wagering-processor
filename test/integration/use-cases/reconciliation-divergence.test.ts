import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Runtime } from "../../../src/infrastructure/app/runtime";
import { createLogger } from "../../../src/infrastructure/observability/logger";
import { assertLedgerInvariant } from "../../support/invariants";
import { createMessagingHarness, type MessagingHarness } from "../../support/messaging";
import { wagerCommand } from "../../support/use-cases";

// Real PostgreSQL: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

/**
 * §9: "Divergências não são corrigidas silenciosamente: devem ser logadas, contabilizadas em
 * métrica e sinalizadas na resposta." The schema makes a divergence impossible through the
 * application, so the test corrupts a balance as the database superuser with the guard trigger
 * disabled — the only way it could happen (manual intervention, bug in a migration, …).
 * The corrupted wallets violate the ledger invariant ON PURPOSE; it is asserted for the consistent one.
 */
describe("reconciliation divergence", () => {
  let h: MessagingHarness;
  let runtime: Runtime;
  let base: string;
  const lines: Record<string, any>[] = [];

  beforeAll(async () => {
    h = await createMessagingHarness({ label: "reconciliation" });
    const logger = createLogger({
      level: "info",
      destination: { write: (chunk: string) => void chunk.split("\n").filter(Boolean).forEach((l) => lines.push(JSON.parse(l))) },
    });
    runtime = await h.start({ ROLES: ["api"] }, { logger });
    base = `http://127.0.0.1:${runtime.port}`;
  });
  afterAll(async () => {
    await h.close();
  });

  const reconcile = async (walletId: string) => {
    const response = await fetch(`${base}/wallets/${walletId}/reconciliation`, { method: "POST" });
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, any>;
  };
  const divergenceCounter = async () => {
    const text = await (await fetch(`${base}/metrics`)).text();
    return Number(/^reconciliation_divergences_total (\S+)$/m.exec(text)?.[1]);
  };

  test("a consistent wallet reports consistent: true and no divergence is counted", async () => {
    const wallet = await h.openWallet("100.00");
    await h.container.submit.execute(wagerCommand(wallet, { money: { amount: "30.00", currency: "BRL" } }), {
      correlationId: "c",
      channel: "HTTP",
    });
    const report = await reconcile(wallet.id);
    expect(report).toMatchObject({
      consistent: true,
      storedBalance: { amount: "70.00", currency: "BRL" },
      calculatedBalance: { amount: "70.00", currency: "BRL" },
      difference: { amount: "0.00", currency: "BRL" },
      checkedEntries: 2,
    });
    expect(await divergenceCounter()).toBe(0);
    await assertLedgerInvariant(h.db.sql, [wallet.id]);
  });

  test("a corrupted balance → consistent: false with the difference, an error log, the counter, and no correction", async () => {
    const wallet = await h.openWallet("100.00");
    await h.db.sql.begin(async (tx) => {
      await tx`ALTER TABLE wallets DISABLE TRIGGER wallet_check_ledger`;
      await tx`UPDATE wallets SET balance = balance + 5.00 WHERE id = ${wallet.id}`;
      await tx`ALTER TABLE wallets ENABLE TRIGGER wallet_check_ledger`;
    });

    const report = await reconcile(wallet.id);
    expect(report).toMatchObject({
      walletId: wallet.id,
      consistent: false,
      storedBalance: { amount: "105.00", currency: "BRL" },
      calculatedBalance: { amount: "100.00", currency: "BRL" },
      difference: { amount: "5.00", currency: "BRL" },
      checkedEntries: 1,
      details: { latestEntryBalanceMatches: false, latestEntryVersionMatches: true },
    });

    const logged = lines.find((l) => l.level === "error" && l.walletId === wallet.id && /divergence/.test(l.msg));
    expect(logged).toMatchObject({ component: "reconciliation", ledgerSumMatches: false, latestEntryBalanceMatches: false });
    expect(JSON.stringify(logged)).not.toContain("105.00"); // identifiers only, no amounts
    expect(await divergenceCounter()).toBe(1);

    // Not corrected: the stored balance is still the corrupted one, and asking again reports it again.
    const [row] = await h.db.sql`SELECT balance::text AS balance FROM wallets WHERE id = ${wallet.id}`;
    expect(row.balance).toBe("105.00");
    expect((await reconcile(wallet.id)).consistent).toBe(false);
    expect(await divergenceCounter()).toBe(2);
  });

  test("a negative difference (balance below the ledger) is reported with its sign", async () => {
    const wallet = await h.openWallet("100.00");
    await h.db.sql.begin(async (tx) => {
      await tx`ALTER TABLE wallets DISABLE TRIGGER wallet_check_ledger`;
      await tx`UPDATE wallets SET balance = balance - 0.01 WHERE id = ${wallet.id}`;
      await tx`ALTER TABLE wallets ENABLE TRIGGER wallet_check_ledger`;
    });
    const report = await reconcile(wallet.id);
    expect(report.consistent).toBe(false);
    expect(report.difference).toEqual({ amount: "-0.01", currency: "BRL" });
  });
});
