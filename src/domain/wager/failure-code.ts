/**
 * Stable, machine-readable rejection/failure codes (§7.2 of the challenge).
 * Values are part of the public contract: never rename, only add.
 */
export enum FailureCode {
  /** BET larger than the available balance. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** A reversal (ROLLBACK of WIN/REFUND) would make the balance negative. */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** `playerId` in the payload is not the owner of `walletId`. */
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  /** Referenced transaction never arrived within the PENDING_REFERENCE retry budget. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** Reference belongs to another provider/player/wallet/currency/round (see `details.field`). */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** Reference kind is not allowed for this operation (e.g. REFUND of a WIN, ROLLBACK of a LOSS). */
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  /** Reference exists but ended REJECTED/FAILED, so there is nothing to settle or reverse. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** REFUND/ROLLBACK amount differs from the referenced amount (partial reversal is out of scope). */
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  /** Reference was already reversed (by REFUND or ROLLBACK). */
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  /** A credit would take the balance beyond the largest representable value (NUMERIC(20,2)). */
  BalanceLimitExceeded = "BALANCE_LIMIT_EXCEEDED",
  /** Permanent internal error after the payload was accepted (status FAILED, A16). */
  InternalInvariantViolation = "INTERNAL_INVARIANT_VIOLATION",
}

/**
 * What the provider should do after receiving the code. Every code is terminal for its
 * idempotency key (a resubmission must use a new key); transient infrastructure errors are not
 * failure codes — they are HTTP 503 / SQS retries and are safe to resend with the same key.
 */
export enum ProviderAction {
  /** Correct the payload (or the sending order) and resubmit with a new idempotency key. */
  FixPayload = "FIX_PAYLOAD",
  /** Final business outcome: do not resend. */
  GiveUp = "GIVE_UP",
  /** Needs manual/operational handling on the operator side. */
  ContactOperator = "CONTACT_OPERATOR",
}

export interface FailureCodeInfo {
  readonly providerAction: ProviderAction;
  readonly description: string;
}

export const FAILURE_CODE_CATALOG: Readonly<Record<FailureCode, FailureCodeInfo>> = Object.freeze({
  [FailureCode.InsufficientFunds]: {
    providerAction: ProviderAction.GiveUp,
    description: "Bet amount exceeds the wallet balance.",
  },
  [FailureCode.ReversalInsufficientFunds]: {
    providerAction: ProviderAction.ContactOperator,
    description: "Reversal would make the wallet balance negative; kept auditable for manual handling.",
  },
  [FailureCode.CurrencyMismatch]: {
    providerAction: ProviderAction.FixPayload,
    description: "Operation currency differs from the wallet currency.",
  },
  [FailureCode.WalletPlayerMismatch]: {
    providerAction: ProviderAction.FixPayload,
    description: "The wallet does not belong to the given player.",
  },
  [FailureCode.ReferenceNotFound]: {
    providerAction: ProviderAction.FixPayload,
    description: "Referenced transaction was not received within the retry budget; send it first, then resubmit.",
  },
  [FailureCode.ReferenceMismatch]: {
    providerAction: ProviderAction.FixPayload,
    description: "Reference belongs to a different provider, player, wallet, currency or round.",
  },
  [FailureCode.ReferenceKindNotAllowed]: {
    providerAction: ProviderAction.FixPayload,
    description: "Referenced transaction kind cannot be settled or reversed by this operation.",
  },
  [FailureCode.ReferenceNotProcessed]: {
    providerAction: ProviderAction.GiveUp,
    description: "Referenced transaction was rejected or failed; there is nothing to settle or reverse.",
  },
  [FailureCode.ReferenceAmountMismatch]: {
    providerAction: ProviderAction.FixPayload,
    description: "Reversal amount must equal the referenced amount (partial reversal is not supported).",
  },
  [FailureCode.ReferenceAlreadyReversed]: {
    providerAction: ProviderAction.GiveUp,
    description: "Referenced transaction was already reversed.",
  },
  [FailureCode.BalanceLimitExceeded]: {
    providerAction: ProviderAction.ContactOperator,
    description: "Credit would exceed the largest balance the wallet can hold (999999999999999999.99).",
  },
  [FailureCode.InternalInvariantViolation]: {
    providerAction: ProviderAction.ContactOperator,
    description: "Permanent internal error after the request was accepted; recorded as FAILED.",
  },
});

const FAILURE_CODES: ReadonlySet<string> = new Set(Object.values(FailureCode));

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value);
}
