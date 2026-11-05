import { EntitySchema } from "@mikro-orm/core";

/**
 * Persistence records: plain classes mapped with EntitySchema (no decorators, no domain logic).
 * Mappers translate them to/from domain aggregates. Money columns are NUMERIC(20,2) read and
 * written as decimal strings, never as JavaScript numbers.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string | null;
  gameId!: string | null;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  resultingBalance!: string | null;
  resultingBalanceCurrency!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
  processedAt!: Date | null;
  updatedAt!: Date;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  currency!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
  lastError!: string | null;
}

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

const money = { type: "decimal", precision: 20, scale: 2 } as const;
const timestamp = { type: "datetime", columnType: "timestamptz" } as const;

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id" },
    currency: { type: "string", columnType: "char(3)" },
    balance: { ...money },
    version: { type: "integer" },
    createdAt: { ...timestamp, fieldName: "created_at" },
    updatedAt: { ...timestamp, fieldName: "updated_at" },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id" },
    externalTransactionId: { type: "string", fieldName: "external_transaction_id" },
    idempotencyKey: { type: "string", fieldName: "idempotency_key" },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", fieldName: "player_id" },
    roundId: { type: "string", fieldName: "round_id", nullable: true },
    gameId: { type: "string", fieldName: "game_id", nullable: true },
    kind: { type: "string" },
    amount: { ...money },
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: { type: "string", fieldName: "reference_external_transaction_id", nullable: true },
    referenceTransactionId: { type: "uuid", fieldName: "reference_transaction_id", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", fieldName: "failure_code", nullable: true },
    resultingBalance: { ...money, fieldName: "resulting_balance", nullable: true },
    resultingBalanceCurrency: { type: "string", fieldName: "resulting_balance_currency", nullable: true },
    referenceAttempts: { type: "integer", fieldName: "reference_attempts" },
    nextReferenceAttemptAt: { ...timestamp, fieldName: "next_reference_attempt_at", nullable: true },
    createdAt: { ...timestamp, fieldName: "created_at" },
    processedAt: { ...timestamp, fieldName: "processed_at", nullable: true },
    updatedAt: { ...timestamp, fieldName: "updated_at" },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    currency: { type: "string", columnType: "char(3)" },
    transactionId: { type: "uuid", fieldName: "transaction_id" },
    direction: { type: "string" },
    amount: { ...money },
    balanceBefore: { ...money, fieldName: "balance_before" },
    balanceAfter: { ...money, fieldName: "balance_after" },
    walletVersion: { type: "integer", fieldName: "wallet_version" },
    createdAt: { ...timestamp, fieldName: "created_at" },
  },
});

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id" },
    eventType: { type: "string", fieldName: "event_type" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: { ...timestamp, fieldName: "occurred_at" },
    attempts: { type: "integer" },
    nextAttemptAt: { ...timestamp, fieldName: "next_attempt_at", nullable: true },
    publishedAt: { ...timestamp, fieldName: "published_at", nullable: true },
    lastError: { type: "text", fieldName: "last_error", nullable: true },
  },
});

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", fieldName: "consumer_name", primary: true },
    messageId: { type: "string", fieldName: "message_id", primary: true },
    payloadHash: { type: "string", fieldName: "payload_hash" },
    receivedAt: { ...timestamp, fieldName: "received_at" },
    processedAt: { ...timestamp, fieldName: "processed_at", nullable: true },
  },
});

export const ENTITY_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, OutboxSchema, InboxSchema];
