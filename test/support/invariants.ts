import { expect } from "bun:test";
import type { SQL } from "bun";

export interface LedgerDivergence {
  wallet_id: string;
  balance: string;
  version: number;
  ledger_sum: string;
  last_balance_after: string | null;
  last_version: number | null;
}

/**
 * Final invariant of every test (§13 of the challenge): for every wallet,
 * balance == Σ CREDIT − Σ DEBIT == balance_after of the latest entry, and the
 * wallet version matches the latest entry version. Comparison happens in SQL (NUMERIC),
 * never in JavaScript numbers.
 */
export async function findLedgerDivergences(sql: SQL, walletIds?: string[]): Promise<LedgerDivergence[]> {
  const filter = walletIds && walletIds.length > 0 ? sql`WHERE w.id IN ${sql(walletIds)}` : sql``;
  return await sql`
    WITH sums AS (
      SELECT w.id AS wallet_id,
             w.balance,
             w.version,
             COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0) AS ledger_sum,
             MAX(l.wallet_version) AS last_version
        FROM wallets w
        LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
        ${filter}
       GROUP BY w.id, w.balance, w.version
    )
    SELECT s.wallet_id,
           s.balance::text AS balance,
           s.version,
           s.ledger_sum::text AS ledger_sum,
           last.balance_after::text AS last_balance_after,
           s.last_version
      FROM sums s
      LEFT JOIN wallet_ledger_entries last
        ON last.wallet_id = s.wallet_id AND last.wallet_version = s.last_version
     WHERE s.balance <> s.ledger_sum
        OR s.balance < 0
        OR (s.last_version IS NOT NULL AND (last.balance_after <> s.balance OR s.last_version <> s.version))
        OR (s.last_version IS NULL AND (s.balance <> 0 OR s.version <> 1))`;
}

export async function assertLedgerInvariant(sql: SQL, walletIds?: string[]): Promise<void> {
  const divergences = await findLedgerDivergences(sql, walletIds);
  expect(divergences).toEqual([]);
}
