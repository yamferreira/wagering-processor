import { InvariantViolationError, ValidationError } from "../errors";
import { LedgerDirection, WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import { Money } from "../money/money";
import { CurrencyMismatchError } from "../money/money.errors";
import { InsufficientFundsError } from "./wallet.errors";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Required when initialBalance > 0: ids for the internal OPENING transaction and its ledger entry. */
  opening?: { transactionId: string; ledgerEntryId: string };
}

export interface OpenedWallet {
  wallet: Wallet;
  /** CREDIT entry for the opening balance; absent when the wallet opens with zero. */
  openingEntry?: WalletLedgerEntry;
}

export interface MovementProps {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export const INITIAL_WALLET_VERSION = 1;

/**
 * Aggregate root. The only way to change the balance is debit/credit, which produce the
 * matching ledger entry in the same step, so balance and ledger cannot diverge.
 * `version` starts at 1 and increments only when the balance changes.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (!props.id) throw new ValidationError("Wallet id is required", "id");
    if (!props.playerId) throw new ValidationError("playerId is required", "playerId");
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new ValidationError("initialBalance must not be negative", "initialBalance");
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      INITIAL_WALLET_VERSION,
      new Date(at.getTime()),
      new Date(at.getTime()),
    );
    if (initialBalance.isZero()) {
      return { wallet };
    }
    if (!props.opening) {
      throw new InvariantViolationError("A positive opening balance requires an OPENING transaction");
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: INITIAL_WALLET_VERSION,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state; does not revalidate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** True when a debit of `money` keeps the balance non-negative. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this._balance, props.money);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  /** Applies a movement in the given direction (used when the direction is decided by the rules). */
  move(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    return direction === LedgerDirection.Debit ? this.debit(props) : this.credit(props);
  }

  snapshot(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: new Date(this.createdAt.getTime()),
      updatedAt: new Date(this._updatedAt.getTime()),
    };
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(props.money) : balanceBefore.subtract(props.money);
    // Build the entry first: if it is invalid, nothing in the aggregate changes.
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: props.at,
    });
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(props.at.getTime());
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new ValidationError("Movement amount must be positive", "money");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (!money.hasCurrency(this.currency)) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
