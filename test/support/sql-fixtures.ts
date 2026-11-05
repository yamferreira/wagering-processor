import type { SQL } from "bun";

/** Raw-SQL fixtures that bypass the application, used to probe schema guarantees. */
export const HASH = "a".repeat(64);
export const uuid = (): string => crypto.randomUUID();

export interface TxRow {
  id?: string;
  provider_id?: string;
  external_transaction_id?: string;
  idempotency_key?: string;
  payload_hash?: string;
  wallet_id: string;
  player_id?: string;
  round_id?: string | null;
  game_id?: string | null;
  kind?: string;
  amount?: string;
  currency?: string;
  reference_external_transaction_id?: string | null;
  reference_transaction_id?: string | null;
  status?: string;
  failure_code?: string | null;
  resulting_balance?: string | null;
  resulting_balance_currency?: string | null;
  next_reference_attempt_at?: Date | null;
  processed_at?: Date | null;
}

export async function insertTx(sql: SQL, row: TxRow): Promise<string> {
  const id = row.id ?? uuid();
  const external = row.external_transaction_id ?? `ext-${id}`;
  const provider = row.provider_id ?? "provider-a";
  const status = row.status ?? "PROCESSED";
  const terminal = ["PROCESSED", "REJECTED", "FAILED"].includes(status);
  const resulting = row.resulting_balance === undefined ? (status === "PROCESSED" ? "0.00" : null) : row.resulting_balance;
  await sql`
    INSERT INTO wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
      round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
      status, failure_code, resulting_balance, resulting_balance_currency, reference_attempts,
      next_reference_attempt_at, created_at, processed_at, updated_at
    ) VALUES (
      ${id}, ${provider}, ${external}, ${row.idempotency_key ?? `${provider}:${external}`}, ${row.payload_hash ?? HASH},
      ${row.wallet_id}, ${row.player_id ?? "player-1"},
      ${row.round_id === undefined ? "round-1" : row.round_id}, ${row.game_id === undefined ? "game-1" : row.game_id},
      ${row.kind ?? "BET"}, ${row.amount ?? "10.00"}::numeric, ${row.currency ?? "BRL"},
      ${row.reference_external_transaction_id ?? null}, ${row.reference_transaction_id ?? null},
      ${status}, ${row.failure_code ?? null}, ${resulting}::numeric,
      ${row.resulting_balance_currency === undefined ? (resulting === null ? null : "BRL") : row.resulting_balance_currency},
      0, ${row.next_reference_attempt_at ?? null}, now(),
      ${row.processed_at === undefined ? (terminal ? new Date() : null) : row.processed_at}, now()
    )`;
  return id;
}

export interface LedgerRow {
  id?: string;
  wallet_id: string;
  currency?: string;
  transaction_id: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
  balance_before: string;
  balance_after: string;
  wallet_version: number;
}

export async function insertLedger(sql: SQL, row: LedgerRow): Promise<string> {
  const id = row.id ?? uuid();
  await sql`
    INSERT INTO wallet_ledger_entries (
      id, wallet_id, currency, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at
    ) VALUES (
      ${id}, ${row.wallet_id}, ${row.currency ?? "BRL"}, ${row.transaction_id}, ${row.direction},
      ${row.amount}::numeric, ${row.balance_before}::numeric, ${row.balance_after}::numeric, ${row.wallet_version}, now()
    )`;
  return id;
}

export interface SeededWallet {
  walletId: string;
  playerId: string;
  openingTxId: string | undefined;
}

/** Inserts a consistent wallet (with OPENING tx + ledger entry when balance > 0) in one transaction. */
export async function seedWallet(sql: SQL, opts: { balance?: string; playerId?: string; currency?: string } = {}): Promise<SeededWallet> {
  const walletId = uuid();
  const playerId = opts.playerId ?? `player-${walletId}`;
  const balance = opts.balance ?? "100.00";
  const currency = opts.currency ?? "BRL";
  let openingTxId: string | undefined;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${walletId}, ${playerId}, ${currency}, ${balance}::numeric, 1, now(), now())`;
    if (balance !== "0.00") {
      openingTxId = await insertTx(tx, {
        wallet_id: walletId,
        player_id: playerId,
        provider_id: "internal",
        external_transaction_id: `opening:${walletId}`,
        kind: "OPENING",
        round_id: null,
        game_id: null,
        amount: balance,
        currency,
        resulting_balance: balance,
        resulting_balance_currency: currency,
      });
      await insertLedger(tx, {
        wallet_id: walletId,
        currency,
        transaction_id: openingTxId,
        direction: "CREDIT",
        amount: balance,
        balance_before: "0.00",
        balance_after: balance,
        wallet_version: 1,
      });
    }
  });
  return { walletId, playerId, openingTxId };
}

/** Applies a processed BET consistently (tx + ledger + wallet update) in one transaction. */
export async function seedBet(
  sql: SQL,
  wallet: SeededWallet,
  opts: { amount: string; before: string; after: string; version: number; externalId?: string },
): Promise<string> {
  let betId = "";
  await sql.begin(async (tx) => {
    betId = await insertTx(tx, {
      wallet_id: wallet.walletId,
      player_id: wallet.playerId,
      kind: "BET",
      amount: opts.amount,
      external_transaction_id: opts.externalId ?? `bet-${uuid()}`,
      resulting_balance: opts.after,
    });
    await insertLedger(tx, {
      wallet_id: wallet.walletId,
      transaction_id: betId,
      direction: "DEBIT",
      amount: opts.amount,
      balance_before: opts.before,
      balance_after: opts.after,
      wallet_version: opts.version,
    });
    await tx`UPDATE wallets SET balance = ${opts.after}::numeric, version = ${opts.version}, updated_at = now()
              WHERE id = ${wallet.walletId}`;
  });
  return betId;
}
