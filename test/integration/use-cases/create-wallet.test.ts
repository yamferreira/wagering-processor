import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { WalletAlreadyExistsError } from "../../../src/application/errors";
import { ValidationError } from "../../../src/domain/errors";
import { InvalidMoneyError } from "../../../src/domain/money/money.errors";
import { assertLedgerInvariant } from "../../support/invariants";
import { countRows, ledgerRows, outboxEventTypes, transactionRows, walletRow } from "../../support/inspect";
import { createUseCaseHarness, CTX, type UseCaseHarness } from "../../support/use-cases";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

let h: UseCaseHarness;
const player = () => `player-${Bun.randomUUIDv7()}`;

beforeAll(async () => {
  h = await createUseCaseHarness();
});

afterEach(async () => {
  await assertLedgerInvariant(h.db.sql);
});

afterAll(async () => {
  await h.close();
});

describe("CreateWallet", () => {
  test("positive initial balance → OPENING transaction + CREDIT entry + events in one SQL transaction", async () => {
    const wallet = await h.createWallet.execute(
      { playerId: player(), initialBalance: { amount: "1000.00", currency: "BRL" } },
      CTX,
    );
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(await walletRow(h.db.sql, wallet.id)).toEqual({ balance: "1000.00", version: 1 });

    const txs = await transactionRows(h.db.sql, wallet.id);
    expect(txs).toEqual([expect.objectContaining({ kind: "OPENING", status: "PROCESSED", amount: "1000.00" })]);
    const ledger = await ledgerRows(h.db.sql, wallet.id);
    expect(ledger).toEqual([
      expect.objectContaining({ wallet_version: 1, direction: "CREDIT", amount: "1000.00", balance_after: "1000.00" }),
    ]);
    expect(ledger[0]?.transaction_id).toBe(txs[0]!.id);
    expect(await outboxEventTypes(h.db.sql, [wallet.id, txs[0]!.id])).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
  });

  test("zero initial balance → no OPENING, no ledger, no events", async () => {
    const wallet = await h.createWallet.execute({ playerId: player(), initialBalance: { amount: "0.00", currency: "BRL" } }, CTX);
    expect(await walletRow(h.db.sql, wallet.id)).toEqual({ balance: "0.00", version: 1 });
    expect(await transactionRows(h.db.sql, wallet.id)).toEqual([]);
    expect(await ledgerRows(h.db.sql, wallet.id)).toEqual([]);
    expect(await outboxEventTypes(h.db.sql, [wallet.id])).toEqual([]);
  });

  test("duplicate player + currency → WalletAlreadyExistsError; another currency is fine", async () => {
    const playerId = player();
    await h.createWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "BRL" } }, CTX);
    const error = await h.createWallet
      .execute({ playerId, initialBalance: { amount: "20.00", currency: "BRL" } }, CTX)
      .catch((e) => e);
    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect(await countRows(h.db.sql, "wallets", `player_id = '${playerId}'`)).toBe(1);
    await h.createWallet.execute({ playerId, initialBalance: { amount: "5.00", currency: "USD" } }, CTX);
    expect(await countRows(h.db.sql, "wallets", `player_id = '${playerId}'`)).toBe(2);
  });

  test("concurrent duplicates: exactly one wallet is created", async () => {
    const playerId = player();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        h.createWallet.execute({ playerId, initialBalance: { amount: "50.00", currency: "BRL" } }, CTX),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.every((r) => r.reason instanceof WalletAlreadyExistsError)).toBe(true);
    expect(await countRows(h.db.sql, "wallets", `player_id = '${playerId}'`)).toBe(1);
  });

  test("invalid input is rejected before touching the database", async () => {
    const playerId = player();
    expect(
      await h.createWallet.execute({ playerId, initialBalance: { amount: "10", currency: "BRL" } }, CTX).catch((e) => e),
    ).toBeInstanceOf(InvalidMoneyError);
    expect(
      await h.createWallet.execute({ playerId, initialBalance: { amount: "10.00", currency: "JPY" } }, CTX).catch((e) => e),
    ).toBeInstanceOf(ValidationError);
    expect(await countRows(h.db.sql, "wallets", `player_id = '${playerId}'`)).toBe(0);
  });
});
