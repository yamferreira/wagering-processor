import type { LedgerDirection, WalletLedgerEntry } from "../../ledger/wallet-ledger-entry";
import type { MoneyProps } from "../../money/money";
import type { Wallet } from "../../wallet/wallet";
import { type EventContext, IntegrationEvent } from "../integration-event";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Emitted only when the balance actually changes (one per ledger entry). */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  static readonly TYPE = "WalletBalanceChanged";
  readonly eventType = WalletBalanceChanged.TYPE;
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
