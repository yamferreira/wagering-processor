/**
 * Deterministic PRNG for tests, in bigint (64-bit LCG, Knuth MMIX constants), so random MONEY is drawn
 * without ever touching `number` arithmetic (no float for money, not even in tests). `chance()` returns a plain
 * probability for non-money decisions (which operation, shuffle order).
 */
const MASK = (1n << 64n) - 1n;

export class SeededRandom {
  private state: bigint;

  constructor(seed: bigint) {
    this.state = seed & MASK;
  }

  private next(): bigint {
    this.state = (this.state * 6364136223846793005n + 1442695040888963407n) & MASK;
    return this.state >> 11n; // 53 well-mixed high bits
  }

  /** Uniform bigint in [0, bound). */
  below(bound: bigint): bigint {
    return this.next() % bound;
  }

  /** Probability in [0, 1) for non-monetary choices. */
  chance(): number {
    return Number(this.next()) / 2 ** 53;
  }
}
