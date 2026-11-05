import { DomainError } from "../errors";
import type { WagerTransaction } from "./wager-transaction";

export enum IdempotencyConflictReason {
  /** Same Idempotency-Key, different business payload. */
  PayloadMismatch = "IDEMPOTENCY_KEY_REUSED",
  /** Same (providerId, externalTransactionId) submitted under a different Idempotency-Key (A13). */
  ExternalTransactionReused = "EXTERNAL_TRANSACTION_CONFLICT",
}

export type IdempotencyVerdict =
  | { type: "REPLAY"; transaction: WagerTransaction }
  | { type: "CONFLICT"; reason: IdempotencyConflictReason; transaction: WagerTransaction };

export interface IncomingRequestIdentity {
  idempotencyKey: string;
  payloadHash: string;
}

/**
 * Decides what to do when a submission collides with an existing transaction
 * (found by idempotency key or by provider + external id). The key is the source of truth:
 * same key + same hash → replay; same key + different hash → conflict, never replay.
 */
export function evaluateIdempotency(existing: WagerTransaction, incoming: IncomingRequestIdentity): IdempotencyVerdict {
  if (existing.idempotencyKey !== incoming.idempotencyKey) {
    return { type: "CONFLICT", reason: IdempotencyConflictReason.ExternalTransactionReused, transaction: existing };
  }
  if (!existing.matchesPayload(incoming.payloadHash)) {
    return { type: "CONFLICT", reason: IdempotencyConflictReason.PayloadMismatch, transaction: existing };
  }
  return { type: "REPLAY", transaction: existing };
}

export class IdempotencyConflictError extends DomainError {
  readonly code: IdempotencyConflictReason;

  constructor(
    readonly reason: IdempotencyConflictReason,
    readonly existingTransactionId: string,
  ) {
    super(
      reason === IdempotencyConflictReason.PayloadMismatch
        ? "Idempotency-Key was already used with a different payload"
        : "This providerId + externalTransactionId was already submitted with a different Idempotency-Key",
    );
    this.code = reason;
  }
}
