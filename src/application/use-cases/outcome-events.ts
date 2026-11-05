import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { WalletBalanceChanged } from "../../domain/messaging/events/wallet-balance-changed";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../domain/messaging/events/wager-transaction-events";
import type { EventContext } from "../../domain/messaging/integration-event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { WagerTransactionStatus as Status } from "../../domain/wager/kinds";
import type { WagerTransaction } from "../../domain/wager/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

/**
 * Integration events for the state a transaction reached (§11 minimum events).
 * WalletBalanceChanged only when a ledger entry exists, i.e. when the balance changed.
 */
export function outcomeEvents(
  tx: WagerTransaction,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry | undefined,
  nextContext: () => EventContext,
): OutboxMessage[] {
  const messages: OutboxMessage[] = [];
  switch (tx.status) {
    case Status.Processed:
      messages.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, nextContext())));
      if (ledgerEntry) messages.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, nextContext())));
      break;
    case Status.Rejected:
      messages.push(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, nextContext())));
      break;
    case Status.PendingReference:
      messages.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, nextContext())));
      break;
    default:
      break;
  }
  return messages;
}
