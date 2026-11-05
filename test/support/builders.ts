import { Money } from "../../src/domain/money/money";
import { Wallet } from "../../src/domain/wallet/wallet";
import { WagerTransactionKind } from "../../src/domain/wager/kinds";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
} from "../../src/domain/wager/wager-transaction";

export const T0 = new Date("2026-11-05T12:00:00.000Z");

let sequence = 0;
export function nextId(prefix = "id"): string {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });
export const usd = (amount: string): Money => Money.from({ amount, currency: "USD" });

export function buildWallet(amount = "100.00", overrides: { id?: string; playerId?: string } = {}): Wallet {
  return Wallet.open({
    id: overrides.id ?? nextId("wallet"),
    playerId: overrides.playerId ?? "player-1",
    initialBalance: brl(amount),
    at: T0,
    opening: { transactionId: nextId("opening"), ledgerEntryId: nextId("entry") },
  }).wallet;
}

export function txProps(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  const providerId = overrides.providerId ?? "provider-a";
  return {
    id: nextId("tx"),
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    payloadHash: "a".repeat(64),
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Bet,
    money: brl("25.00"),
    createdAt: T0,
    ...overrides,
  };
}

export function buildTx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create(txProps(overrides));
}

/** A transaction already applied, as it would be read back from the database. */
export function processedTx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const tx = buildTx(overrides);
  tx.markProcessed({ referenceTransactionId: undefined, resultingBalance: brl("0.00"), at: T0 });
  return tx;
}
