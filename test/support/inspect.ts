import type { SQL } from "bun";

/** Read-only probes of persisted state (strings for money, never numbers). */
export async function walletRow(sql: SQL, walletId: string): Promise<{ balance: string; version: number } | undefined> {
  const [row] = await sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${walletId}`;
  return row;
}

export async function ledgerRows(sql: SQL, walletId: string) {
  return (await sql`
    SELECT wallet_version, direction, amount::text AS amount, balance_after::text AS balance_after, transaction_id
      FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY wallet_version`) as {
    wallet_version: number;
    direction: string;
    amount: string;
    balance_after: string;
    transaction_id: string;
  }[];
}

export async function transactionRows(sql: SQL, walletId: string) {
  return (await sql`
    SELECT id, kind, status, failure_code, amount::text AS amount
      FROM wager_transactions WHERE wallet_id = ${walletId} ORDER BY created_at, id`) as {
    id: string;
    kind: string;
    status: string;
    failure_code: string | null;
    amount: string;
  }[];
}

/** Event types in the outbox for the given aggregates, in insertion order. */
export async function outboxEventTypes(sql: SQL, aggregateIds: string[]): Promise<string[]> {
  if (aggregateIds.length === 0) return [];
  const rows: { event_type: string }[] = await sql`
    SELECT event_type FROM outbox_messages WHERE aggregate_id IN ${sql(aggregateIds)} ORDER BY id`;
  return rows.map((r) => r.event_type);
}

export async function countRows(sql: SQL, table: string, where = "TRUE"): Promise<number> {
  const [row] = await sql.unsafe(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`);
  return row.n;
}
