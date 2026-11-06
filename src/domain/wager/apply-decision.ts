import type { WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { Wallet } from "../wallet/wallet";
import type { Decision } from "./decide";
import { FailureCode } from "./failure-code";
import { WagerTransactionStatus as Status } from "./kinds";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";
import type { WagerTransaction } from "./wager-transaction";

export interface ApplyDecisionContext {
  /** Id for the ledger entry, used only when the decision moves the balance. */
  ledgerEntryId: string;
  at: Date;
  retryPolicy: ReferenceRetryPolicy;
}

export type ApplyOutcome =
  | { status: Status.Processed; ledgerEntry: WalletLedgerEntry | undefined }
  | { status: Status.Rejected; code: FailureCode }
  | { status: Status.PendingReference; nextAttemptAt: Date };

/**
 * Applies a decision to the aggregates: the only place where a wager transaction moves the
 * wallet balance. Balance, ledger entry and transaction status change together.
 */
export function applyDecision(
  tx: WagerTransaction,
  wallet: Wallet,
  decision: Decision,
  ctx: ApplyDecisionContext,
): ApplyOutcome {
  switch (decision.type) {
    case "APPLY": {
      const ledgerEntry = wallet.move(decision.direction, {
        ledgerEntryId: ctx.ledgerEntryId,
        transactionId: tx.id,
        money: tx.money,
        at: ctx.at,
      });
      tx.markProcessed({
        referenceTransactionId: decision.reference?.id,
        resultingBalance: wallet.balance,
        at: ctx.at,
      });
      return { status: Status.Processed, ledgerEntry };
    }
    case "RECORD_ONLY":
      tx.markProcessed({
        referenceTransactionId: decision.reference?.id,
        resultingBalance: wallet.balance,
        at: ctx.at,
      });
      return { status: Status.Processed, ledgerEntry: undefined };
    case "REJECT":
      tx.reject(decision.code, ctx.at, wallet.balance);
      return { status: Status.Rejected, code: decision.code };
    case "PENDING_REFERENCE": {
      if (decision.waitingFor === "REFERENCE_IN_FLIGHT") {
        // The reference exists and has its own finite budget: wait for it without spending ours.
        // Its terminal transition wakes this one up (A28); the cap-delayed re-check is a safety net.
        const nextAttemptAt = new Date(ctx.at.getTime() + ctx.retryPolicy.maxDelayMs);
        tx.markPendingReference(nextAttemptAt, { spendAttempt: false });
        return { status: Status.PendingReference, nextAttemptAt };
      }
      const isRetry = tx.status === Status.PendingReference;
      const retryNumber = isRetry ? tx.referenceAttempts + 1 : 0;
      if (isRetry && ctx.retryPolicy.isExhausted(retryNumber)) {
        tx.reject(FailureCode.ReferenceNotFound, ctx.at, wallet.balance);
        return { status: Status.Rejected, code: FailureCode.ReferenceNotFound };
      }
      const nextAttemptAt = ctx.retryPolicy.nextAttemptAt(retryNumber, ctx.at);
      tx.markPendingReference(nextAttemptAt);
      return { status: Status.PendingReference, nextAttemptAt };
    }
  }
}
