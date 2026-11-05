import { describe, expect, test } from "bun:test";
import {
  FAILURE_CODE_CATALOG,
  FailureCode,
  isFailureCode,
  ProviderAction,
} from "../../../src/domain/wager/failure-code";

describe("FailureCode taxonomy", () => {
  test("codes are stable public strings", () => {
    expect((Object.values(FailureCode) as string[]).sort()).toEqual([
      "CURRENCY_MISMATCH",
      "INSUFFICIENT_FUNDS",
      "INTERNAL_INVARIANT_VIOLATION",
      "REFERENCE_ALREADY_REVERSED",
      "REFERENCE_AMOUNT_MISMATCH",
      "REFERENCE_KIND_NOT_ALLOWED",
      "REFERENCE_MISMATCH",
      "REFERENCE_NOT_FOUND",
      "REFERENCE_NOT_PROCESSED",
      "REVERSAL_INSUFFICIENT_FUNDS",
      "WALLET_PLAYER_MISMATCH",
    ]);
  });

  test("every code has complete metadata", () => {
    const actions = new Set<string>(Object.values(ProviderAction));
    for (const code of Object.values(FailureCode)) {
      const info = FAILURE_CODE_CATALOG[code];
      expect(info).toBeDefined();
      expect(actions.has(info.providerAction)).toBe(true);
      expect(info.description.length).toBeGreaterThan(10);
    }
  });

  test("insufficient funds on a bet and on a reversal are operationally different", () => {
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.ReversalInsufficientFunds);
    expect(FAILURE_CODE_CATALOG[FailureCode.InsufficientFunds].providerAction).not.toBe(
      FAILURE_CODE_CATALOG[FailureCode.ReversalInsufficientFunds].providerAction,
    );
  });

  test("isFailureCode guards unknown values", () => {
    expect(isFailureCode("INSUFFICIENT_FUNDS")).toBe(true);
    expect(isFailureCode("insufficient_funds")).toBe(false);
    expect(isFailureCode(42)).toBe(false);
  });
});
