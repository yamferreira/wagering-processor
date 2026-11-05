import { ValidationError } from "../../domain/errors";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { WagerTransaction } from "../../domain/wager/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import { NotFoundError } from "../errors";
import type { TransactionRunner } from "../ports/transaction-runner";
import { LEDGER_PAGE_DEFAULT, LEDGER_PAGE_MAX, LedgerCursor } from "./ledger-cursor";

export class GetWallet {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.runner.read((repos) => repos.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError("WALLET", walletId);
    return wallet;
  }
}

export interface LedgerQuery {
  walletId: string;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface LedgerResult {
  wallet: Wallet;
  entries: WalletLedgerEntry[];
  nextCursor: string | null;
}

export class GetWalletLedger {
  constructor(private readonly runner: TransactionRunner) {}

  async execute(query: LedgerQuery): Promise<LedgerResult> {
    const limit = query.limit ?? LEDGER_PAGE_DEFAULT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LEDGER_PAGE_MAX) {
      throw new ValidationError(`limit must be an integer between 1 and ${LEDGER_PAGE_MAX}`, "limit");
    }
    const afterVersion = LedgerCursor.decode(query.cursor);
    return this.runner.read(async (repos) => {
      const wallet = await repos.wallets.findById(query.walletId);
      if (!wallet) throw new NotFoundError("WALLET", query.walletId);
      const page = await repos.ledger.page(query.walletId, afterVersion, limit);
      return {
        wallet,
        entries: page.entries,
        nextCursor: page.nextAfterVersion === undefined ? null : LedgerCursor.encode(page.nextAfterVersion),
      };
    });
  }
}

export class GetWagerTransaction {
  constructor(private readonly runner: TransactionRunner) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const tx = await this.runner.read((repos) => repos.transactions.findById(transactionId));
    if (!tx) throw new NotFoundError("TRANSACTION", transactionId);
    return tx;
  }

  async byExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const tx = await this.runner.read((repos) => repos.transactions.findByExternalId(providerId, externalTransactionId));
    if (!tx) throw new NotFoundError("TRANSACTION", `${providerId}/${externalTransactionId}`);
    return tx;
  }
}
