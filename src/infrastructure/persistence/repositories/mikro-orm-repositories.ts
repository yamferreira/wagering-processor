import { LockMode } from "@mikro-orm/core";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ConcurrencyConflictError } from "../../../application/errors";
import type {
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  Repositories,
  WagerTransactionRepository,
  WalletRepository,
} from "../../../application/ports/repositories";
import type { Clock } from "../../../application/ports/system";
import type { WalletLedgerEntry } from "../../../domain/ledger/wallet-ledger-entry";
import type { InboxMessage } from "../../../domain/messaging/inbox-message";
import type { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { Money } from "../../../domain/money/money";
import type { WagerTransactionStatus } from "../../../domain/wager/kinds";
import type { WagerTransaction } from "../../../domain/wager/wager-transaction";
import type { Wallet } from "../../../domain/wallet/wallet";
import { InboxMapper, LedgerEntryMapper, OutboxMapper, WagerTransactionMapper, WalletMapper } from "../mappers";
import { InboxRecord, LedgerEntryRecord, OutboxRecord, WagerTransactionRecord, WalletRecord } from "../schemas";

/**
 * Repositories use native inserts/updates (no implicit flush) so the SQL issued inside a
 * transaction is explicit and ordered: transaction → ledger entry → wallet → outbox.
 */
class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
  }

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return record ? WalletMapper.toDomain(record) : null;
  }

  async lockById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? WalletMapper.toDomain(record) : null;
  }

  async saveMovement(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Wallet ${wallet.id} is no longer at version ${expectedVersion}`);
    }
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: "asc" }, limit: limit + 1, disableIdentityMap: true },
    );
    const hasMore = records.length > limit;
    const entries = records.slice(0, limit).map(LedgerEntryMapper.toDomain);
    return { entries, nextAfterVersion: hasMore ? entries.at(-1)?.walletVersion : undefined };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<{ credits: string; debits: string; entry_count: string }[]>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)::numeric(20,2)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0)::numeric(20,2)::text  AS debits,
              COUNT(*)::text AS entry_count
         FROM wallet_ledger_entries WHERE wallet_id = ?`,
      [walletId],
    );
    const last = await this.em.findOne(
      LedgerEntryRecord,
      { walletId },
      { orderBy: { walletVersion: "desc" }, disableIdentityMap: true },
    );
    return {
      credits: Money.from({ amount: row?.credits ?? "0.00", currency }),
      debits: Money.from({ amount: row?.debits ?? "0.00", currency }),
      entryCount: Number.parseInt(row?.entry_count ?? "0", 10),
      last: last ? LedgerEntryMapper.toDomain(last) : undefined,
    };
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: Clock,
  ) {}

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(tx, this.clock.now()));
  }

  async update(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: tx.id, status: expectedStatus },
      WagerTransactionMapper.mutableFields(tx, this.clock.now()),
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(`Transaction ${tx.id} is no longer in status ${expectedStatus}`);
    }
  }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.findOne({ id });
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    return this.findOne({ idempotencyKey: key });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async isReversed(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: transactionId,
      kind: { $in: ["REFUND", "ROLLBACK"] },
      status: "PROCESSED",
    });
    return count > 0;
  }

  private async findOne(where: Partial<WagerTransactionRecord>): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(WagerTransactionRecord, where, { disableIdentityMap: true });
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxRecord, messages.map(OutboxMapper.toRecord));
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const record = await this.em.findOne(InboxRecord, { consumerName, messageId }, { disableIdentityMap: true });
    return record ? InboxMapper.toDomain(record) : null;
  }

  async insert(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxRecord, InboxMapper.toRecord(message));
  }
}

export function createRepositories(em: EntityManager, clock: Clock): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em, clock),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}
