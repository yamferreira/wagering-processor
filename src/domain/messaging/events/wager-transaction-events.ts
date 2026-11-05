import { InvariantViolationError } from "../../errors";
import type { MoneyProps } from "../../money/money";
import type { FailureCode } from "../../wager/failure-code";
import { type WagerTransactionKind, WagerTransactionStatus } from "../../wager/kinds";
import type { WagerTransaction } from "../../wager/wager-transaction";
import { type EventContext, IntegrationEvent } from "../integration-event";

interface WagerTransactionEventBase {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
}

function baseData(tx: WagerTransaction): WagerTransactionEventBase {
  return {
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
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvariantViolationError(`Cannot emit ${expected} event for transaction in ${tx.status}`);
  }
}

export interface WagerTransactionProcessedData extends WagerTransactionEventBase {
  referenceTransactionId: string | null;
  resultingBalance: MoneyProps;
  processedAt: string;
}

/** Any applied transaction, including LOSS (which does not move the balance). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  static readonly TYPE = "WagerTransactionProcessed";
  readonly eventType = WagerTransactionProcessed.TYPE;
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    if (!tx.resultingBalance || !tx.processedAt) {
      throw new InvariantViolationError("Processed transaction without resulting balance");
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        referenceTransactionId: tx.referenceTransactionId ?? null,
        resultingBalance: tx.resultingBalance.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends WagerTransactionEventBase {
  failureCode: FailureCode;
  observedBalance: MoneyProps | null;
  rejectedAt: string;
}

/** Business-rule rejection (terminal). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  static readonly TYPE = "WagerTransactionRejected";
  readonly eventType = WagerTransactionRejected.TYPE;
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    if (!tx.failureCode || !tx.processedAt) {
      throw new InvariantViolationError("Rejected transaction without failure code");
    }
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        failureCode: tx.failureCode,
        observedBalance: tx.resultingBalance?.toJSON() ?? null,
        rejectedAt: tx.processedAt.toISOString(),
      },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventBase {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

/** Referenced transaction is missing; the transaction waits for it (§7.1). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  static readonly TYPE = "WagerTransactionPendingReference";
  readonly eventType = WagerTransactionPendingReference.TYPE;
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    if (!tx.referenceExternalTransactionId || !tx.nextReferenceAttemptAt) {
      throw new InvariantViolationError("Pending reference transaction without reference or schedule");
    }
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...baseData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextAttemptAt: tx.nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}
