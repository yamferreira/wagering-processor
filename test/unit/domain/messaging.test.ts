import { describe, expect, test } from "bun:test";
import { InvariantViolationError } from "../../../src/domain/errors";
import { LedgerDirection } from "../../../src/domain/ledger/wallet-ledger-entry";
import { WalletBalanceChanged } from "../../../src/domain/messaging/events/wallet-balance-changed";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../../src/domain/messaging/events/wager-transaction-events";
import { InboxMessage } from "../../../src/domain/messaging/inbox-message";
import { IntegrationEvent } from "../../../src/domain/messaging/integration-event";
import { OutboxMessage } from "../../../src/domain/messaging/outbox-message";
import { ExponentialBackoff } from "../../../src/domain/shared/exponential-backoff";
import { FailureCode } from "../../../src/domain/wager/failure-code";
import { WagerTransactionKind as Kind } from "../../../src/domain/wager/kinds";
import { brl, buildTx, buildWallet, nextId, T0 } from "../../support/builders";

const ctx = (overrides = {}) => ({
  eventId: nextId("evt"),
  correlationId: "corr-1",
  causationId: "msg-1",
  occurredAt: T0,
  ...overrides,
});

function walletBalanceChanged() {
  const wallet = buildWallet("100.00");
  const entry = wallet.debit({ ledgerEntryId: nextId("e"), transactionId: "tx-1", money: brl("25.00"), at: T0 });
  return WalletBalanceChanged.from(wallet, entry, ctx());
}

describe("IntegrationEvent envelope", () => {
  test("WalletBalanceChanged serializes the §11 envelope with MoneyProps strings", () => {
    const event = walletBalanceChanged();
    const json = event.toJSON();
    expect(Object.keys(json).sort()).toEqual(
      ["aggregateId", "causationId", "correlationId", "data", "eventId", "eventType", "occurredAt", "version"].sort(),
    );
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe("2026-11-05T12:00:00.000Z");
    expect(json.data).toEqual({
      walletId: event.aggregateId,
      transactionId: "tx-1",
      direction: LedgerDirection.Debit,
      money: { amount: "25.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "75.00", currency: "BRL" },
      walletVersion: 2,
    });
    expect(typeof json.data.money.amount).toBe("string");
  });

  test("eventType and version are fixed by the subclass, and data is frozen plain JSON", () => {
    const event = walletBalanceChanged();
    expect(event).toBeInstanceOf(IntegrationEvent);
    expect(WalletBalanceChanged.TYPE).toBe(event.eventType);
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event.toJSON());
  });

  test("causationId is omitted when absent", () => {
    const wallet = buildWallet("100.00");
    const entry = wallet.credit({ ledgerEntryId: nextId("e"), transactionId: "tx-1", money: brl("1.00"), at: T0 });
    const event = WalletBalanceChanged.from(wallet, entry, { eventId: "e", correlationId: "c", occurredAt: T0 });
    expect("causationId" in event.toJSON()).toBe(false);
  });

  test("WagerTransactionProcessed (including LOSS)", () => {
    const tx = buildTx({ kind: Kind.Loss, money: brl("0.00") });
    tx.markProcessed({ referenceTransactionId: undefined, resultingBalance: brl("100.00"), at: T0 });
    const json = WagerTransactionProcessed.from(tx, ctx()).toJSON();
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.aggregateId).toBe(tx.id);
    expect(json.data).toMatchObject({
      transactionId: tx.id,
      kind: "LOSS",
      money: { amount: "0.00", currency: "BRL" },
      resultingBalance: { amount: "100.00", currency: "BRL" },
      referenceTransactionId: null,
      processedAt: T0.toISOString(),
    });
  });

  test("WagerTransactionRejected carries the failure code", () => {
    const tx = buildTx();
    tx.reject(FailureCode.InsufficientFunds, T0, brl("10.00"));
    const json = WagerTransactionRejected.from(tx, ctx()).toJSON();
    expect(json.eventType).toBe("WagerTransactionRejected");
    expect(json.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(json.data.observedBalance).toEqual({ amount: "10.00", currency: "BRL" });
  });

  test("WagerTransactionPendingReference carries the missing reference and the schedule", () => {
    const tx = buildTx({ kind: Kind.Refund, referenceExternalTransactionId: "bet-404" });
    tx.markPendingReference(new Date(T0.getTime() + 2000));
    const json = WagerTransactionPendingReference.from(tx, ctx()).toJSON();
    expect(json.eventType).toBe("WagerTransactionPendingReference");
    expect(json.data.referenceExternalTransactionId).toBe("bet-404");
    expect(json.data.nextAttemptAt).toBe("2026-11-05T12:00:02.000Z");
  });

  test("events refuse transactions in the wrong status", () => {
    const pending = buildTx();
    expect(() => WagerTransactionProcessed.from(pending, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionRejected.from(pending, ctx())).toThrow(InvariantViolationError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx())).toThrow(InvariantViolationError);
  });
});

describe("OutboxMessage", () => {
  test("enqueue uses the eventId as id and is due immediately", () => {
    const event = walletBalanceChanged();
    const message = OutboxMessage.enqueue(event);
    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe(event.aggregateId);
    expect(message.eventType).toBe("WalletBalanceChanged");
    expect(message.payload).toEqual(event.toJSON() as unknown as Record<string, unknown>);
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(T0)).toBe(true);
    expect(message.isDue(new Date(T0.getTime() - 1))).toBe(false);
  });

  test("scheduleRetry applies exponential backoff with injected jitter", () => {
    const message = OutboxMessage.enqueue(walletBalanceChanged());
    const noJitter = () => 0;
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      message.scheduleRetry(T0, "sqs unavailable", noJitter);
      delays.push(message.nextAttemptAt!.getTime() - T0.getTime());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(message.attempts).toBe(8);
    expect(message.lastError).toBe("sqs unavailable");
    expect(message.isDue(new Date(T0.getTime() + 59_999))).toBe(false);
    expect(message.isDue(new Date(T0.getTime() + 60_000))).toBe(true);

    message.scheduleRetry(T0, undefined, () => 0.999);
    expect(message.nextAttemptAt!.getTime() - T0.getTime()).toBe(Math.round(60000 * (1 - 0.2 * 0.999)));
  });

  test("markPublished is idempotent and stops being due", () => {
    const message = OutboxMessage.enqueue(walletBalanceChanged());
    const first = new Date(T0.getTime() + 10);
    message.markPublished(first);
    message.markPublished(new Date(T0.getTime() + 20));
    expect(message.publishedAt?.toISOString()).toBe(first.toISOString());
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(T0.getTime() + 1_000_000))).toBe(false);
  });

  test("rehydrate preserves state", () => {
    const message = OutboxMessage.enqueue(walletBalanceChanged());
    message.scheduleRetry(T0, "boom", () => 0);
    expect(OutboxMessage.rehydrate(message.snapshot()).snapshot()).toEqual(message.snapshot());
  });
});

describe("InboxMessage", () => {
  test("receive, match payload and mark processed once", () => {
    const inbox = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-transactions",
      payloadHash: "h1",
      receivedAt: T0,
    });
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.matchesPayload("h1")).toBe(true);
    expect(inbox.matchesPayload("h2")).toBe(false);
    inbox.markProcessed(T0);
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(T0)).toThrow(InvariantViolationError);
  });

  test("requires identifiers", () => {
    expect(() => InboxMessage.receive({ messageId: "", consumerName: "c", payloadHash: "h", receivedAt: T0 })).toThrow();
  });
});

describe("ExponentialBackoff", () => {
  test("validates configuration", () => {
    expect(() => ExponentialBackoff.of({ baseDelayMs: 0, maxDelayMs: 1, jitterRatio: 0 })).toThrow();
    expect(() => ExponentialBackoff.of({ baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 1 })).toThrow();
  });
});
