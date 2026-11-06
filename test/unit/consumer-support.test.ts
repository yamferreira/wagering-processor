import { describe, expect, test } from "bun:test";
import { ApplicationError, NotFoundError, TransientInfrastructureError, TransientReason } from "../../src/application/errors";
import { InjectedFaultError } from "../../src/application/ports/fault-injector";
import { MessageIdConflictError } from "../../src/application/use-cases/handle-wager-message";
import { InternalProcessingError } from "../../src/application/use-cases/submit-wager-transaction";
import { ValidationError } from "../../src/domain/errors";
import { IdempotencyConflictError } from "../../src/domain/wager/idempotency";
import { EnvFaultInjector } from "../../src/infrastructure/faults/env-fault-injector";
import { InvalidEnvelopeError, parseWagerEnvelope } from "../../src/infrastructure/messaging/consumers/envelope.schema";
import { classifyConsumerError } from "../../src/infrastructure/messaging/consumers/error-classifier";

const validEnvelope = {
  messageId: "msg-123",
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
};

describe("parseWagerEnvelope (§10)", () => {
  test("accepts the §10 example and maps it to the shared submit command", () => {
    const message = parseWagerEnvelope(JSON.stringify(validEnvelope));
    expect(message.messageId).toBe("msg-123");
    expect(message.command.idempotencyKey).toBe("provider-a:transaction-123");
    expect(message.command.money).toEqual({ amount: "25.00", currency: "BRL" });
    expect(message.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the hash is independent of key order but changes with the payload", () => {
    const reordered = { data: validEnvelope.data, occurredAt: validEnvelope.occurredAt, type: validEnvelope.type, messageId: "msg-123" };
    expect(parseWagerEnvelope(JSON.stringify(reordered)).payloadHash).toBe(parseWagerEnvelope(JSON.stringify(validEnvelope)).payloadHash);
    const changed = { ...validEnvelope, data: { ...validEnvelope.data, money: { amount: "26.00", currency: "BRL" } } };
    expect(parseWagerEnvelope(JSON.stringify(changed)).payloadHash).not.toBe(parseWagerEnvelope(JSON.stringify(validEnvelope)).payloadHash);
  });

  test.each([
    ["not JSON", "{oops"],
    ["wrong type", JSON.stringify({ ...validEnvelope, type: "Something" })],
    ["unknown field", JSON.stringify({ ...validEnvelope, extra: 1 })],
    ["missing idempotencyKey", JSON.stringify({ ...validEnvelope, data: { ...validEnvelope.data, idempotencyKey: undefined } })],
    // audit-money: allow — proves a numeric amount in the envelope goes to the DLQ
    ["numeric amount", JSON.stringify({ ...validEnvelope, data: { ...validEnvelope.data, money: { amount: 25, currency: "BRL" } } })],
    ["bad occurredAt", JSON.stringify({ ...validEnvelope, occurredAt: "yesterday" })],
  ])("rejects %s as InvalidEnvelopeError", (_label, body) => {
    expect(() => parseWagerEnvelope(body)).toThrow(InvalidEnvelopeError);
  });
});

describe("classifyConsumerError (A27)", () => {
  test.each([
    ["transient infrastructure", new TransientInfrastructureError(TransientReason.LockTimeout, "x"), "RETRY", "LOCK_TIMEOUT"],
    ["unknown error", new Error("boom"), "RETRY", "UNCLASSIFIED"],
    ["simulated crash", new InjectedFaultError("consumer:after-inbox-insert"), "ABANDON", "INJECTED_FAULT"],
    ["invalid envelope", new InvalidEnvelopeError("bad"), "DLQ", "INVALID_ENVELOPE"],
    ["validation", new ValidationError("bad", "kind"), "DLQ", "VALIDATION_ERROR"],
    ["idempotency conflict", new IdempotencyConflictError("IDEMPOTENCY_KEY_REUSED" as never, "tx"), "DLQ", "IDEMPOTENCY_KEY_REUSED"],
    ["messageId conflict", new MessageIdConflictError("m"), "DLQ", "MESSAGE_ID_CONFLICT"],
    ["FAILED (A16)", new InternalProcessingError("tx"), "DLQ", "INTERNAL_ERROR"],
  ] as [string, Error, string, string][])("%s → %s", (_label, error, action, code) => {
    const classified = classifyConsumerError(error);
    expect(classified.action).toBe(action as never);
    expect(classified.code).toBe(code);
  });

  test("NotFoundError is an ApplicationError (handled before classification as terminal business)", () => {
    expect(new NotFoundError("WALLET", "w")).toBeInstanceOf(ApplicationError);
  });
});

describe("EnvFaultInjector (FAULTS env)", () => {
  test("parses points that contain colons, actions and repetition counts", async () => {
    const faults = new EnvFaultInjector("consumer:after-inbox-insert=throw*1, outbox:after-claim-before-publish=transient");
    expect(faults.size).toBe(2);
    await expect(faults.checkpoint("consumer:after-inbox-insert")).rejects.toBeInstanceOf(InjectedFaultError);
    await faults.checkpoint("consumer:after-inbox-insert"); // exhausted after 1
    await expect(faults.checkpoint("outbox:after-claim-before-publish")).rejects.toBeInstanceOf(TransientInfrastructureError);
    await expect(faults.checkpoint("outbox:after-claim-before-publish")).rejects.toBeInstanceOf(TransientInfrastructureError);
    await faults.checkpoint("submit:after-commit"); // not configured: no-op
  });

  test("delay action waits", async () => {
    const faults = new EnvFaultInjector("submit:after-commit=delay:50*1");
    const started = performance.now();
    await faults.checkpoint("submit:after-commit");
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });

  test("rejects malformed specs", () => {
    expect(() => new EnvFaultInjector("nonsense")).toThrow();
    expect(() => new EnvFaultInjector("submit:after-commit=explode")).toThrow();
  });
});
