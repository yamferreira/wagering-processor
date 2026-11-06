import { InvariantViolationError } from "../errors";
import { LedgerDirection } from "../ledger/wallet-ledger-entry";
import type { Wallet } from "../wallet/wallet";
import { FailureCode } from "./failure-code";
import { WagerTransactionKind as Kind, WagerTransactionStatus as Status } from "./kinds";
import type { WagerTransaction } from "./wager-transaction";

/**
 * Result of resolving `(providerId, referenceExternalTransactionId)`, prepared by the
 * use case while holding the wallet lock. Keeps decide() pure (no I/O).
 */
export type ReferenceLookup =
  | { found: false }
  | {
      found: true;
      reference: WagerTransaction;
      /** True when a PROCESSED REFUND/ROLLBACK already points to `reference`. */
      alreadyReversed: boolean;
    };

export type ReferenceMismatchField = "providerId" | "playerId" | "walletId" | "currency" | "roundId";

export type Decision =
  | { type: "APPLY"; direction: LedgerDirection; reference: WagerTransaction | undefined }
  | { type: "RECORD_ONLY"; reference: WagerTransaction | undefined }
  | { type: "REJECT"; code: FailureCode; details?: { field: ReferenceMismatchField } }
  | { type: "PENDING_REFERENCE"; waitingFor: PendingReason };

/**
 * Why a transaction waits (§7.1, A7). REFERENCE_MISSING: the reference was never received; each
 * retry spends the budget. REFERENCE_IN_FLIGHT: the reference exists but is itself still pending;
 * the dependent spends nothing and is woken up when the reference becomes terminal (A28).
 */
export type PendingReason = "REFERENCE_MISSING" | "REFERENCE_IN_FLIGHT";

const ALLOWED_REFERENCE_KINDS: Readonly<Partial<Record<Kind, readonly Kind[]>>> = Object.freeze({
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
});

const reject = (code: FailureCode, details?: { field: ReferenceMismatchField }): Decision =>
  details ? { type: "REJECT", code, details } : { type: "REJECT", code };

/**
 * Business rules of the challenge (§7) as a pure function. The caller must hold the wallet lock,
 * so `wallet` is the latest committed state and `lookup` cannot change underneath.
 */
export function decide(tx: WagerTransaction, wallet: Wallet, lookup: ReferenceLookup | undefined): Decision {
  if (tx.walletId !== wallet.id) {
    throw new InvariantViolationError(`Transaction ${tx.id} evaluated against wallet ${wallet.id}`);
  }
  if (tx.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);
  if (!tx.money.hasCurrency(wallet.currency)) return reject(FailureCode.CurrencyMismatch);

  let reference: WagerTransaction | undefined;
  if (tx.hasReference()) {
    if (!lookup) {
      throw new InvariantViolationError(`Transaction ${tx.id} has a reference but no lookup was provided`);
    }
    if (!lookup.found) return { type: "PENDING_REFERENCE", waitingFor: "REFERENCE_MISSING" };
    reference = lookup.reference;
    const referenceDecision = checkReference(tx, reference, lookup.alreadyReversed);
    if (referenceDecision) return referenceDecision;
  }

  if (!tx.affectsBalance()) return { type: "RECORD_ONLY", reference };

  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }
  return { type: "APPLY", direction, reference };
}

function checkReference(tx: WagerTransaction, reference: WagerTransaction, alreadyReversed: boolean): Decision | undefined {
  const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
  if (!allowed.includes(reference.kind)) return reject(FailureCode.ReferenceKindNotAllowed);

  const mismatch = mismatchedField(tx, reference);
  if (mismatch) return reject(FailureCode.ReferenceMismatch, { field: mismatch });

  // A7: a reference still in flight is waited for; one that ended badly cannot be settled.
  if (reference.status === Status.Pending || reference.status === Status.PendingReference) {
    return { type: "PENDING_REFERENCE", waitingFor: "REFERENCE_IN_FLIGHT" };
  }
  if (reference.status !== Status.Processed) return reject(FailureCode.ReferenceNotProcessed);

  if (tx.isReversal() && !tx.money.equals(reference.money)) return reject(FailureCode.ReferenceAmountMismatch);

  // A4: a reference is reversed at most once; A6: no WIN/LOSS on top of a reversed BET.
  if (alreadyReversed) return reject(FailureCode.ReferenceAlreadyReversed);
  return undefined;
}

function mismatchedField(tx: WagerTransaction, reference: WagerTransaction): ReferenceMismatchField | undefined {
  if (reference.providerId !== tx.providerId) return "providerId";
  if (reference.playerId !== tx.playerId) return "playerId";
  if (reference.walletId !== tx.walletId) return "walletId";
  if (!reference.money.hasCurrency(tx.money.currency)) return "currency";
  if (reference.roundId !== tx.roundId) return "roundId";
  return undefined;
}
