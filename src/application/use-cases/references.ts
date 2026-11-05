import type { ReferenceLookup } from "../../domain/wager/decide";
import type { WagerTransaction } from "../../domain/wager/wager-transaction";
import type { Repositories } from "../ports/repositories";

/** Resolves (providerId, referenceExternalTransactionId) for decide(); call while holding the wallet lock. */
export async function resolveReference(repos: Repositories, tx: WagerTransaction): Promise<ReferenceLookup> {
  const reference = await repos.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
  if (!reference) return { found: false };
  return { found: true, reference, alreadyReversed: await repos.transactions.isReversed(reference.id) };
}

/** A28: once a transaction is terminal, the ones waiting for it are retried right away (same SQL transaction). */
export async function wakeDependentsOf(repos: Repositories, tx: WagerTransaction, now: Date): Promise<number> {
  if (!tx.isTerminal()) return 0;
  return repos.transactions.wakeDependents(tx.providerId, tx.externalTransactionId, now);
}
