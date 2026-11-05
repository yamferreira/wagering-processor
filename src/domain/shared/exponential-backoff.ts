import { ValidationError } from "../errors";

export interface ExponentialBackoffProps {
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the delay that may be randomly removed (0 = deterministic, 0.2 = up to -20%). */
  jitterRatio: number;
}

/** Source of randomness in [0, 1); injected so the schedule is deterministic in tests. */
export type RandomSource = () => number;

/** delay(n) = min(base · 2ⁿ, cap) · (1 − jitterRatio · random()). */
export class ExponentialBackoff {
  private constructor(private readonly props: ExponentialBackoffProps) {
    Object.freeze(this);
  }

  static of(props: ExponentialBackoffProps): ExponentialBackoff {
    if (!Number.isSafeInteger(props.baseDelayMs) || props.baseDelayMs < 1) {
      throw new ValidationError("baseDelayMs must be a positive integer", "baseDelayMs");
    }
    if (!Number.isSafeInteger(props.maxDelayMs) || props.maxDelayMs < props.baseDelayMs) {
      throw new ValidationError("maxDelayMs must be an integer >= baseDelayMs", "maxDelayMs");
    }
    if (!(props.jitterRatio >= 0 && props.jitterRatio < 1)) {
      throw new ValidationError("jitterRatio must be in [0, 1)", "jitterRatio");
    }
    return new ExponentialBackoff({ ...props });
  }

  delayMs(attempt: number, random: RandomSource = Math.random): number {
    const capped = Math.min(this.props.baseDelayMs * 2 ** Math.min(Math.max(attempt, 0), 30), this.props.maxDelayMs);
    return Math.max(1, Math.round(capped * (1 - this.props.jitterRatio * random())));
  }
}
