import type { SQL } from "bun";

/**
 * How many transactions of these wallets went through PENDING_REFERENCE (their reference arrived
 * later). Concurrency tests that claim to cover "ROLLBACK/REFUND entregue antes da referência"
 * assert this is > 0, so a lucky interleaving cannot make them pass without exercising that path.
 */
export async function pendingReferenceCount(sql: SQL, walletIds: string[]): Promise<number> {
  const [row] = await sql`
    SELECT COUNT(*)::int AS n
      FROM outbox_messages o
      JOIN wager_transactions t ON t.id::text = o.aggregate_id
     WHERE o.event_type = 'WagerTransactionPendingReference' AND t.wallet_id IN ${sql(walletIds)}`;
  return row.n;
}
