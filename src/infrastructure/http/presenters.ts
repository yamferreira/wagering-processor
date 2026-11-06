import type { ReconciliationReport } from "../../application/use-cases/reconcile-wallet";
import type { SubmitResult } from "../../application/use-cases/submit-wager-transaction";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import type { MoneyProps } from "../../domain/money/money";
import { FAILURE_CODE_CATALOG, FailureCode } from "../../domain/wager/failure-code";
import { WagerTransactionStatus as Status } from "../../domain/wager/kinds";
import type { WagerTransaction } from "../../domain/wager/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";

export const presentWallet = (wallet: Wallet) => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

export const presentLedgerEntry = (entry: WalletLedgerEntry) => ({
  id: entry.id,
  transactionId: entry.transactionId,
  direction: entry.direction,
  money: entry.money.toJSON(),
  balanceBefore: entry.balanceBefore.toJSON(),
  balanceAfter: entry.balanceAfter.toJSON(),
  walletVersion: entry.walletVersion,
  createdAt: entry.createdAt.toISOString(),
});

export const presentTransaction = (tx: WagerTransaction) => ({
  transactionId: tx.id,
  providerId: tx.providerId,
  externalTransactionId: tx.externalTransactionId,
  walletId: tx.walletId,
  playerId: tx.playerId,
  roundId: tx.roundId ?? null,
  gameId: tx.gameId ?? null,
  kind: tx.kind,
  money: tx.money.toJSON(),
  referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
  referenceTransactionId: tx.referenceTransactionId ?? null,
  status: tx.status,
  failureCode: tx.failureCode ?? null,
  balance: tx.resultingBalance?.toJSON() ?? null,
  createdAt: tx.createdAt.toISOString(),
  processedAt: tx.processedAt?.toISOString() ?? null,
});

export const presentReconciliation = (report: ReconciliationReport) => ({
  walletId: report.walletId,
  storedBalance: report.storedBalance.toJSON(),
  calculatedBalance: report.calculatedBalance.toJSON(),
  difference: report.difference.toJSON(),
  consistent: report.consistent,
  checkedEntries: report.checkedEntries,
  details: report.details,
});

export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * Submission outcome → HTTP (docs/ARCHITECTURE.md §8.2, A11): 201 new PROCESSED, 200 replayed PROCESSED,
 * 202 PENDING_REFERENCE, 422 REJECTED (with failureCode), 500 FAILED. A replay keeps the
 * original status code; `idempotentReplay` tells them apart.
 */
export function presentSubmitResult(result: SubmitResult): HttpResponse {
  const { transaction: tx, replay } = result;
  const balance: MoneyProps | null = tx.resultingBalance?.toJSON() ?? null;
  switch (tx.status) {
    case Status.Processed:
      return {
        status: replay ? 200 : 201,
        body: { transactionId: tx.id, status: tx.status, balance, idempotentReplay: replay },
      };
    case Status.PendingReference:
      return {
        status: 202,
        body: { transactionId: tx.id, status: tx.status, balance: null, idempotentReplay: replay },
      };
    case Status.Rejected: {
      const code = tx.failureCode!;
      return {
        status: 422,
        body: {
          error: {
            code,
            failureCode: code,
            message: FAILURE_CODE_CATALOG[code].description,
            providerAction: FAILURE_CODE_CATALOG[code].providerAction,
            transactionId: tx.id,
            status: tx.status,
            balance,
            idempotentReplay: replay,
          },
        },
      };
    }
    default:
      return { status: 500, body: failedTransactionBody(tx.id, tx.failureCode ?? FailureCode.InternalInvariantViolation, replay) };
  }
}

/**
 * Body of a transaction recorded as FAILED (A16). The first response and every replay use it, so they
 * differ only in `idempotentReplay`.
 */
export function failedTransactionBody(transactionId: string, failureCode: FailureCode, replay: boolean) {
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "The transaction failed permanently and was recorded as FAILED",
      transactionId,
      status: Status.Failed,
      failureCode,
      idempotentReplay: replay,
    },
  };
}
