import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../domain/messaging/outbox-message";
import type { Money } from "../../domain/money/money";
import type { WagerTransactionStatus } from "../../domain/wager/kinds";
import type { WagerTransaction } from "../../domain/wager/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

export interface WalletRepository {
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | null>;
  /** `SELECT … FOR UPDATE` on the wallet row only (no global lock). Must run inside a transaction. */
  lockById(id: string): Promise<Wallet | null>;
  /** `UPDATE … WHERE id = ? AND version = ?`; throws ConcurrencyConflictError when 0 rows match. */
  saveMovement(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  /** wallet_version of the last returned entry when there may be more pages. */
  nextAfterVersion: number | undefined;
}

export interface LedgerSummary {
  credits: Money;
  debits: Money;
  entryCount: number;
  last: WalletLedgerEntry | undefined;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Ascending by wallet_version, strictly after `afterVersion`. */
  page(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface WagerTransactionRepository {
  insert(tx: WagerTransaction): Promise<void>;
  /** Persists a status change; `expectedStatus` guards against concurrent transitions. */
  update(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void>;
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** True when a PROCESSED REFUND/ROLLBACK references `transactionId`. */
  isReversed(transactionId: string): Promise<boolean>;
}

export interface OutboxLag {
  pending: number;
  /** occurred_at of the oldest unpublished message. */
  oldestPendingAt: Date | undefined;
}

export interface OutboxRepository {
  insert(messages: readonly OutboxMessage[]): Promise<void>;
  /**
   * Due, unpublished messages, oldest first, locked with `FOR UPDATE SKIP LOCKED`: concurrent
   * publishers never claim the same row while the claiming transaction is open.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persists published_at / attempts / next_attempt_at / last_error after a publish attempt. */
  saveDeliveryState(messages: readonly OutboxMessage[]): Promise<void>;
  lag(): Promise<OutboxLag>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  /** Insert; throws UniqueViolationError if (consumerName, messageId) already exists. */
  insert(message: InboxMessage): Promise<void>;
}

/** Repositories bound to one unit of work (one SQL transaction, or a plain read context). */
export interface Repositories {
  wallets: WalletRepository;
  ledger: LedgerRepository;
  transactions: WagerTransactionRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}
