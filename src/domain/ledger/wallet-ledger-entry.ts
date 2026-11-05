import { InvariantViolationError } from "../errors";
import type { Money } from "../money/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version right after this movement (1 for the opening credit). */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Immutable ledger line. There are no mutators: immutability is structural
 * (readonly fields + Object.freeze), and the database forbids UPDATE/DELETE as well.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Validates the arithmetic `balanceBefore ± money === balanceAfter` and the entry invariants. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (!props.id || !props.walletId || !props.transactionId) {
      throw new InvariantViolationError("Ledger entry requires id, walletId and transactionId");
    }
    if (props.direction !== LedgerDirection.Debit && props.direction !== LedgerDirection.Credit) {
      throw new InvariantViolationError(`Unknown ledger direction: ${String(props.direction)}`);
    }
    if (!money.isPositive()) {
      throw new InvariantViolationError("Ledger entry amount must be positive");
    }
    if (!balanceBefore.hasCurrency(money.currency) || !balanceAfter.hasCurrency(money.currency)) {
      throw new InvariantViolationError("Ledger entry amounts must share a single currency");
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvariantViolationError("Ledger entry balances must not be negative");
    }
    if (!Number.isSafeInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvariantViolationError("Ledger entry walletVersion must be a positive integer");
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `Unbalanced ledger entry: ${balanceBefore} ${props.direction} ${money} != ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Rebuilds an already persisted entry; does not revalidate. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      new Date(state.createdAt.getTime()),
    );
  }

  /** Signed effect of this entry on the balance (credit positive, debit negative). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  isBalanced(): boolean {
    return this.balanceBefore.add(this.signedAmount()).equals(this.balanceAfter);
  }
}
