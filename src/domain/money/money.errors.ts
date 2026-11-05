import { DomainError } from "../errors";

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";

  constructor(reason: string) {
    super(`Invalid money: ${reason}`);
  }
}

export class InvalidCurrencyError extends DomainError {
  readonly code = "INVALID_CURRENCY";

  constructor(currency: unknown) {
    super(`Invalid currency: ${JSON.stringify(currency)} (expected ISO-4217, e.g. "BRL")`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class MoneyOverflowError extends DomainError {
  readonly code = "MONEY_OVERFLOW";

  constructor() {
    super("Money value exceeds the supported precision (NUMERIC(20,2))");
  }
}
