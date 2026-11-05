import { DomainError } from "../errors";
import type { Money } from "../money/money";

/** Guard raised by Wallet.debit; the business path checks the balance first (see decide()). */
export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(`Insufficient funds: balance ${balance}, requested ${requested}`);
  }
}
