import type { Money } from "../../domain/money/money";
import { NotFoundError } from "../errors";
import type { TransactionRunner } from "../ports/transaction-runner";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
  /** Extra checks beyond the sum: latest entry matches the materialized balance and version. */
  details: {
    latestEntryBalanceMatches: boolean;
    latestEntryVersionMatches: boolean;
  };
}

/** Receives divergences: they are never corrected silently (§9), only logged and counted. */
export interface ReconciliationObserver {
  onDivergence(report: ReconciliationReport): void;
}

/**
 * Recomputes the balance from the ledger and compares it with the materialized balance, in a
 * read-only REPEATABLE READ snapshot (consistent view, no lock on a hot wallet, A19).
 */
export class ReconcileWallet {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly observer: ReconciliationObserver = { onDivergence: () => {} },
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.runner.run(
      async (repos) => {
        const wallet = await repos.wallets.findById(walletId);
        if (!wallet) throw new NotFoundError("WALLET", walletId);
        const summary = await repos.ledger.summarize(walletId, wallet.currency);
        const calculatedBalance = summary.credits.subtract(summary.debits);
        const storedBalance = wallet.balance;
        const latestEntryBalanceMatches = summary.last
          ? summary.last.balanceAfter.equals(storedBalance)
          : storedBalance.isZero();
        const latestEntryVersionMatches = summary.last ? summary.last.walletVersion === wallet.version : wallet.version === 1;
        return {
          walletId,
          storedBalance,
          calculatedBalance,
          difference: storedBalance.subtract(calculatedBalance),
          consistent: storedBalance.equals(calculatedBalance) && latestEntryBalanceMatches && latestEntryVersionMatches,
          checkedEntries: summary.entryCount,
          details: { latestEntryBalanceMatches, latestEntryVersionMatches },
        };
      },
      { isolation: "REPEATABLE_READ", readOnly: true },
    );
    if (!report.consistent) this.observer.onDivergence(report);
    return report;
  }
}
