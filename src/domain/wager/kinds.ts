export enum WagerTransactionKind {
  /** Internal: opening credit of a wallet. Never accepted from the API or the queue. */
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  /** Accepted, not yet applied (initial in-memory state; never committed, A15). */
  Pending = "PENDING",
  /** Waiting for the referenced transaction. */
  PendingReference = "PENDING_REFERENCE",
  /** Applied (terminal). */
  Processed = "PROCESSED",
  /** Business rule violation (terminal). */
  Rejected = "REJECTED",
  /** Permanent infrastructure/internal error (terminal, auditable). */
  Failed = "FAILED",
}

/** Kinds that external providers may submit (everything except OPENING). */
export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = Object.freeze([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Reserved provider id used for internal transactions (OPENING). Rejected at the edges (A8). */
export const INTERNAL_PROVIDER_ID = "internal";

/**
 * Valid state transitions (§6.3 of the challenge). PENDING_REFERENCE → PENDING_REFERENCE is a reschedule.
 * Terminal states have no outgoing transitions.
 */
export const VALID_TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> =
  Object.freeze({
    [WagerTransactionStatus.Pending]: [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
      WagerTransactionStatus.PendingReference,
    ],
    [WagerTransactionStatus.PendingReference]: [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
      WagerTransactionStatus.PendingReference,
    ],
    [WagerTransactionStatus.Processed]: [],
    [WagerTransactionStatus.Rejected]: [],
    [WagerTransactionStatus.Failed]: [],
  });
