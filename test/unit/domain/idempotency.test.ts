import { describe, expect, test } from "bun:test";
import {
  evaluateIdempotency,
  IdempotencyConflictError,
  IdempotencyConflictReason,
} from "../../../src/domain/wager/idempotency";
import { processedTx } from "../../support/builders";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("evaluateIdempotency", () => {
  const existing = processedTx({ idempotencyKey: "provider-a:tx-1", payloadHash: HASH_A });

  test("same key + same payload → replay of the original transaction", () => {
    expect(evaluateIdempotency(existing, { idempotencyKey: "provider-a:tx-1", payloadHash: HASH_A })).toEqual({
      type: "REPLAY",
      transaction: existing,
    });
  });

  test("same key + divergent payload → conflict, never replay", () => {
    const verdict = evaluateIdempotency(existing, { idempotencyKey: "provider-a:tx-1", payloadHash: HASH_B });
    expect(verdict.type).toBe("CONFLICT");
    if (verdict.type === "CONFLICT") expect(verdict.reason).toBe(IdempotencyConflictReason.PayloadMismatch);
  });

  test("same external id under another key → conflict (A13)", () => {
    const verdict = evaluateIdempotency(existing, { idempotencyKey: "another-key", payloadHash: HASH_A });
    expect(verdict.type).toBe("CONFLICT");
    if (verdict.type === "CONFLICT") expect(verdict.reason).toBe(IdempotencyConflictReason.ExternalTransactionReused);
  });

  test("conflict error exposes a stable code", () => {
    const error = new IdempotencyConflictError(IdempotencyConflictReason.PayloadMismatch, existing.id);
    expect(error.code).toBe(IdempotencyConflictReason.PayloadMismatch);
    expect(error.existingTransactionId).toBe(existing.id);
  });
});
