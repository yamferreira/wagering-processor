import { InvalidTransactionStateError, InvariantViolationError, ValidationError } from "../errors";
import { LedgerDirection } from "../ledger/wallet-ledger-entry";
import type { Money } from "../money/money";
import { FailureCode } from "./failure-code";
import {
  INTERNAL_PROVIDER_ID,
  TERMINAL_STATUSES,
  VALID_TRANSITIONS,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./kinds";

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Provider-side id of the referenced transaction (not the internal id). */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  at: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string | undefined;
  gameId: string | undefined;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  resultingBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

export interface MarkProcessedProps {
  /** Internal id of the referenced transaction, when there is one. */
  referenceTransactionId: string | undefined;
  /** Wallet balance observed right after applying this transaction. */
  resultingBalance: Money;
  at: Date;
}

const KINDS_WITH_OPTIONAL_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
]);
const KINDS_REQUIRING_REFERENCE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

function opposite(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

function copyDate(date: Date | undefined): Date | undefined {
  return date ? new Date(date.getTime()) : undefined;
}

/**
 * A wagering operation and its explicit state machine (see VALID_TRANSITIONS).
 * PROCESSED / REJECTED / FAILED are terminal: transitioning out of them throws
 * InvalidTransactionStateError (a programming error, not a business path).
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultingBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind and the amount rules (A2, A8). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const required: (keyof CreateWagerTransactionProps)[] = [
      "id",
      "providerId",
      "externalTransactionId",
      "idempotencyKey",
      "payloadHash",
      "walletId",
      "playerId",
      "roundId",
      "gameId",
    ];
    for (const field of required) {
      const value = props[field];
      if (typeof value !== "string" || value.length === 0) {
        throw new ValidationError(`${field} is required`, field);
      }
    }
    if (props.kind === WagerTransactionKind.Opening) {
      throw new ValidationError("OPENING is internal and cannot be submitted", "kind");
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new ValidationError(`Unknown kind ${String(props.kind)}`, "kind");
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new ValidationError(`providerId "${INTERNAL_PROVIDER_ID}" is reserved`, "providerId");
    }

    const reference = props.referenceExternalTransactionId;
    if (reference !== undefined && reference.length === 0) {
      throw new ValidationError("referenceExternalTransactionId must not be empty", "referenceExternalTransactionId");
    }
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && reference === undefined) {
      throw new ValidationError(`${props.kind} requires referenceExternalTransactionId`, "referenceExternalTransactionId");
    }
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new ValidationError("BET cannot reference another transaction", "referenceExternalTransactionId");
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new ValidationError("A transaction cannot reference itself", "referenceExternalTransactionId");
    }

    if (props.money.isNegative()) {
      throw new ValidationError("money must not be negative", "money");
    }
    if (props.kind !== WagerTransactionKind.Loss && props.money.isZero()) {
      throw new ValidationError(`${props.kind} amount must be greater than zero`, "money");
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      new Date(props.createdAt.getTime()),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Internal OPENING transaction of a wallet (A17). Returned already PROCESSED. */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError("OPENING requires a positive amount");
    }
    const tx = new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      WagerTransaction.openingExternalId(props.walletId),
      WagerTransaction.openingIdempotencyKey(props.walletId),
      props.payloadHash,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      new Date(props.at.getTime()),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
    tx.markProcessed({ referenceTransactionId: undefined, resultingBalance: props.money, at: props.at });
    return tx;
  }

  static openingExternalId(walletId: string): string {
    return `opening:${walletId}`;
  }

  static openingIdempotencyKey(walletId: string): string {
    return `${INTERNAL_PROVIDER_ID}:opening:${walletId}`;
  }

  /** Rebuilds persisted state; does not revalidate transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      copyDate(state.processedAt),
      state.resultingBalance,
      state.referenceAttempts,
      copyDate(state.nextReferenceAttemptAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /** Balance observed when the transaction reached a terminal state (for idempotent replay). */
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  /** Number of PENDING_REFERENCE retries already performed by the worker. */
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transitions -------------------------------------------------------

  markProcessed(props: MarkProcessedProps): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = props.referenceTransactionId;
    this._resultingBalance = props.resultingBalance;
    this._processedAt = new Date(props.at.getTime());
    this._nextReferenceAttemptAt = undefined;
  }

  /**
   * First call (PENDING → PENDING_REFERENCE) schedules the first retry; later calls
   * (PENDING_REFERENCE → PENDING_REFERENCE) count one more attempt and reschedule.
   */
  markPendingReference(nextAttemptAt: Date): void {
    const wasPending = this._status === WagerTransactionStatus.PendingReference;
    this.transitionTo(WagerTransactionStatus.PendingReference);
    if (wasPending) this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = new Date(nextAttemptAt.getTime());
  }

  /** Business rejection. `observedBalance` is the wallet balance at decision time (when known). */
  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    if (code === FailureCode.InternalInvariantViolation) {
      throw new InvariantViolationError(`${code} is a failure, use fail()`);
    }
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._resultingBalance = observedBalance;
    this._processedAt = new Date(at.getTime());
    this._nextReferenceAttemptAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = new Date(at.getTime());
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- domain queries ----------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  /** True when the transaction carries a reference that must be resolved before applying it. */
  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  acceptsOptionalReference(): boolean {
    return KINDS_WITH_OPTIONAL_REFERENCE.has(this.kind);
  }

  isReversal(): boolean {
    return KINDS_REQUIRING_REFERENCE.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Ledger direction of this transaction. ROLLBACK is the inverse of its reference,
   * so the reference is mandatory for it. LOSS has no ledger effect.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError("ROLLBACK direction requires the referenced transaction");
        }
        if (
          reference.kind === WagerTransactionKind.Rollback ||
          reference.kind === WagerTransactionKind.Loss ||
          reference.kind === WagerTransactionKind.Opening
        ) {
          throw new InvariantViolationError(`ROLLBACK cannot reverse ${reference.kind}`);
        }
        return opposite(reference.ledgerDirectionFor());
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError("LOSS has no ledger effect");
    }
  }

  snapshot(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: new Date(this.createdAt.getTime()),
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: copyDate(this._processedAt),
      resultingBalance: this._resultingBalance,
      referenceAttempts: this._referenceAttempts,
      nextReferenceAttemptAt: copyDate(this._nextReferenceAttemptAt),
    };
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!VALID_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this._status, next);
    }
    this._status = next;
  }
}
