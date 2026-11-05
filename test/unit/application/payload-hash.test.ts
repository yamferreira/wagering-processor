import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../../../src/application/idempotency/canonical-json";
import {
  messagePayloadHash,
  openingPayloadHash,
  type WagerBusinessFields,
  wagerPayloadHash,
} from "../../../src/application/idempotency/payload-hash";

/** The example request of CHALLENGE §9. */
const challengeExample: WagerBusinessFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
};

describe("canonicalJson", () => {
  test("sorts keys recursively and removes whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });

  test("omits undefined properties", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("escapes strings like JSON", () => {
    expect(canonicalJson({ s: 'quote " and \\ and ünicode' })).toBe('{"s":"quote \\" and \\\\ and ünicode"}');
  });

  test.each([
    ["bigint", { a: 1n }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["function", { a: () => 1 }],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});

describe("wagerPayloadHash", () => {
  test("is SHA-256 hex of the canonical JSON (fixed vector locks the algorithm)", () => {
    // Expected value computed independently: printf '%s' '<canonical json>' | sha256sum
    expect(wagerPayloadHash(challengeExample)).toBe("629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344");
  });

  test("does not depend on key order", () => {
    const reordered = Object.fromEntries(Object.entries(challengeExample).reverse()) as unknown as WagerBusinessFields;
    reordered.money = { currency: "BRL", amount: "25.00" };
    expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(challengeExample));
  });

  test("ignores transport metadata and unknown properties", () => {
    const withTransport = {
      ...challengeExample,
      idempotencyKey: "provider-a:transaction-123",
      messageId: "msg-123",
      occurredAt: "2026-07-29T15:00:00.000Z",
      correlationId: "abc",
    } as WagerBusinessFields;
    expect(wagerPayloadHash(withTransport)).toBe(wagerPayloadHash(challengeExample));
  });

  test("an absent reference and an undefined reference hash the same", () => {
    expect(wagerPayloadHash({ ...challengeExample, referenceExternalTransactionId: undefined })).toBe(
      wagerPayloadHash(challengeExample),
    );
  });

  test.each([
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: "other-player" }],
    ["walletId", { walletId: "other-wallet" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "other-game" }],
    ["kind", { kind: "WIN" }],
    ["amount", { money: { amount: "25.01", currency: "BRL" } }],
    ["currency", { money: { amount: "25.00", currency: "USD" } }],
    ["reference", { referenceExternalTransactionId: "bet-1" }],
  ])("changing %s changes the hash", (_field, change) => {
    expect(wagerPayloadHash({ ...challengeExample, ...change })).not.toBe(wagerPayloadHash(challengeExample));
  });

  test("opening and message hashes are deterministic hex digests", () => {
    const opening = openingPayloadHash({ walletId: "w", playerId: "p", money: { amount: "1.00", currency: "BRL" } });
    expect(opening).toMatch(/^[0-9a-f]{64}$/);
    expect(messagePayloadHash({ b: 1, a: 2 })).toBe(messagePayloadHash({ a: 2, b: 1 }));
  });
});
