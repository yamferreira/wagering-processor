import { ValidationError } from "../errors";

export interface ReferenceRetryPolicyProps {
  /** Number of worker retries before rejecting with REFERENCE_NOT_FOUND. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Exponential backoff for PENDING_REFERENCE (§7.1 of the challenge; A28 in docs/ARCHITECTURE.md):
 * delay(n) = min(base · 2ⁿ, cap), where n = 0 is the first scheduling.
 */
export class ReferenceRetryPolicy {
  private constructor(
    public readonly maxAttempts: number,
    public readonly baseDelayMs: number,
    public readonly maxDelayMs: number,
  ) {
    Object.freeze(this);
  }

  static of(props: ReferenceRetryPolicyProps): ReferenceRetryPolicy {
    const { maxAttempts, baseDelayMs, maxDelayMs } = props;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new ValidationError("maxAttempts must be a positive integer", "maxAttempts");
    }
    if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1) {
      throw new ValidationError("baseDelayMs must be a positive integer", "baseDelayMs");
    }
    if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
      throw new ValidationError("maxDelayMs must be an integer >= baseDelayMs", "maxDelayMs");
    }
    return new ReferenceRetryPolicy(maxAttempts, baseDelayMs, maxDelayMs);
  }

  /** Default (A28): 10 retries, 2s base, 5 min cap (~18 min total). */
  static default(): ReferenceRetryPolicy {
    return ReferenceRetryPolicy.of({ maxAttempts: 10, baseDelayMs: 2_000, maxDelayMs: 300_000 });
  }

  delayMs(retryNumber: number): number {
    const exponential = this.baseDelayMs * 2 ** Math.min(retryNumber, 30);
    return Math.min(exponential, this.maxDelayMs);
  }

  nextAttemptAt(retryNumber: number, now: Date): Date {
    return new Date(now.getTime() + this.delayMs(retryNumber));
  }

  /** True when the given retry is the last one allowed; failing it exhausts the budget. */
  isExhausted(retryNumber: number): boolean {
    return retryNumber >= this.maxAttempts;
  }
}
