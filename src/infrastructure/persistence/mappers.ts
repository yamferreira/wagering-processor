import { LedgerDirection, WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money/money";
import { type FailureCode, isFailureCode } from "../../domain/wager/failure-code";
import { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager/kinds";
import { WagerTransaction } from "../../domain/wager/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./schemas";

/** NUMERIC(20,2) always comes back with exactly two decimals; Money.from re-validates it. */
const money = (amount: string, currency: string): Money => Money.from({ amount: String(amount), currency: currency.trim() });

const nullable = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

function asEnum<T extends string>(values: Record<string, T>, value: string, label: string): T {
  if (!(Object.values(values) as string[]).includes(value)) throw new Error(`Unknown ${label} in database: ${value}`);
  return value as T;
}

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency.trim(),
      balance: money(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },
  toRecord(wallet: Wallet): WalletRecord {
    const record = new WalletRecord();
    record.id = wallet.id;
    record.playerId = wallet.playerId;
    record.currency = wallet.currency;
    record.balance = wallet.balance.amount;
    record.version = wallet.version;
    record.createdAt = wallet.createdAt;
    record.updatedAt = wallet.updatedAt;
    return record;
  },
};

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const failureCode = record.failureCode;
    if (failureCode !== null && !isFailureCode(failureCode)) throw new Error(`Unknown failure code in database: ${failureCode}`);
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash.trim(),
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: nullable(record.roundId),
      gameId: nullable(record.gameId),
      kind: asEnum(WagerTransactionKind, record.kind, "kind"),
      money: money(record.amount, record.currency),
      referenceExternalTransactionId: nullable(record.referenceExternalTransactionId),
      createdAt: record.createdAt,
      status: asEnum(WagerTransactionStatus, record.status, "status"),
      referenceTransactionId: nullable(record.referenceTransactionId),
      failureCode: (failureCode ?? undefined) as FailureCode | undefined,
      processedAt: nullable(record.processedAt),
      resultingBalance:
        record.resultingBalance !== null && record.resultingBalanceCurrency !== null
          ? money(record.resultingBalance, record.resultingBalanceCurrency)
          : undefined,
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: nullable(record.nextReferenceAttemptAt),
    });
  },
  toRecord(tx: WagerTransaction, updatedAt: Date): WagerTransactionRecord {
    const record = new WagerTransactionRecord();
    record.id = tx.id;
    record.providerId = tx.providerId;
    record.externalTransactionId = tx.externalTransactionId;
    record.idempotencyKey = tx.idempotencyKey;
    record.payloadHash = tx.payloadHash;
    record.walletId = tx.walletId;
    record.playerId = tx.playerId;
    record.roundId = tx.roundId ?? null;
    record.gameId = tx.gameId ?? null;
    record.kind = tx.kind;
    record.amount = tx.money.amount;
    record.currency = tx.money.currency;
    record.referenceExternalTransactionId = tx.referenceExternalTransactionId ?? null;
    Object.assign(record, WagerTransactionMapper.mutableFields(tx, updatedAt));
    record.createdAt = tx.createdAt;
    return record;
  },
  /** Columns that may change after insert (the trigger rejects changes to anything else). */
  mutableFields(tx: WagerTransaction, updatedAt: Date) {
    return {
      referenceTransactionId: tx.referenceTransactionId ?? null,
      status: tx.status,
      failureCode: tx.failureCode ?? null,
      resultingBalance: tx.resultingBalance?.amount ?? null,
      resultingBalanceCurrency: tx.resultingBalance?.currency ?? null,
      referenceAttempts: tx.referenceAttempts,
      nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
      processedAt: tx.processedAt ?? null,
      updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    const currency = record.currency.trim();
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: asEnum(LedgerDirection, record.direction, "direction"),
      money: money(record.amount, currency),
      balanceBefore: money(record.balanceBefore, currency),
      balanceAfter: money(record.balanceAfter, currency),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },
  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    const record = new LedgerEntryRecord();
    record.id = entry.id;
    record.walletId = entry.walletId;
    record.currency = entry.money.currency;
    record.transactionId = entry.transactionId;
    record.direction = entry.direction;
    record.amount = entry.money.amount;
    record.balanceBefore = entry.balanceBefore.amount;
    record.balanceAfter = entry.balanceAfter.amount;
    record.walletVersion = entry.walletVersion;
    record.createdAt = entry.createdAt;
    return record;
  },
};

export const OutboxMapper = {
  toDomain(record: OutboxRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: nullable(record.nextAttemptAt),
      publishedAt: nullable(record.publishedAt),
      lastError: nullable(record.lastError),
    });
  },
  toRecord(message: OutboxMessage): OutboxRecord {
    const record = new OutboxRecord();
    record.id = message.id;
    record.aggregateId = message.aggregateId;
    record.eventType = message.eventType;
    record.payload = { ...message.payload };
    record.occurredAt = message.occurredAt;
    record.attempts = message.attempts;
    record.nextAttemptAt = message.nextAttemptAt ?? null;
    record.publishedAt = message.publishedAt ?? null;
    record.lastError = message.lastError ?? null;
    return record;
  },
};

export const InboxMapper = {
  toDomain(record: InboxRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash.trim(),
      receivedAt: record.receivedAt,
      processedAt: nullable(record.processedAt),
    });
  },
  toRecord(message: InboxMessage): InboxRecord {
    const record = new InboxRecord();
    record.consumerName = message.consumerName;
    record.messageId = message.messageId;
    record.payloadHash = message.payloadHash;
    record.receivedAt = message.receivedAt;
    record.processedAt = message.processedAt ?? null;
    return record;
  },
};
