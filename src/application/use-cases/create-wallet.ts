import { ValidationError } from "../../domain/errors";
import { Money, type MoneyProps } from "../../domain/money/money";
import { WagerTransaction } from "../../domain/wager/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { UniqueViolationError, WalletAlreadyExistsError } from "../errors";
import { openingPayloadHash } from "../idempotency/payload-hash";
import { type Metrics, noMetrics } from "../ports/metrics";
import type { Clock, IdGenerator } from "../ports/system";
import type { TransactionRunner } from "../ports/transaction-runner";
import { eventContextFactory, type RequestContext } from "./context";
import { outcomeEvents } from "./outcome-events";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletDeps {
  runner: TransactionRunner;
  ids: IdGenerator;
  clock: Clock;
  supportedCurrencies: readonly string[];
  metrics?: Metrics;
}

/**
 * Opens a wallet. A positive initial balance creates the internal OPENING transaction and its
 * CREDIT ledger entry in the same SQL transaction (§9). Duplicate player + currency → conflict.
 */
export class CreateWallet {
  constructor(private readonly deps: CreateWalletDeps) {}

  async execute(command: CreateWalletCommand, ctx: RequestContext): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    assertSupportedCurrency(initialBalance.currency, this.deps.supportedCurrencies);
    const { ids, clock } = this.deps;
    const walletId = ids.next();
    const openingTxId = ids.next();
    const ledgerEntryId = ids.next();
    const nextEventContext = eventContextFactory(ctx, ids, clock);

    try {
      const wallet = await this.deps.runner.run(async (repos) => {
        const at = clock.now();
        const { wallet, openingEntry } = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          at,
          opening: { transactionId: openingTxId, ledgerEntryId },
        });
        await repos.wallets.insert(wallet);
        if (openingEntry) {
          const opening = WagerTransaction.createOpening({
            id: openingTxId,
            walletId,
            playerId: wallet.playerId,
            money: initialBalance,
            payloadHash: openingPayloadHash({ walletId, playerId: wallet.playerId, money: initialBalance.toJSON() }),
            at,
          });
          await repos.transactions.insert(opening);
          await repos.ledger.insert(openingEntry);
          await repos.outbox.insert(outcomeEvents(opening, wallet, openingEntry, nextEventContext));
        }
        return wallet;
      });
      if (initialBalance.isPositive()) (this.deps.metrics ?? noMetrics).transactionRecorded("OPENING", "PROCESSED", ctx.channel);
      return wallet;
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "wallets_player_currency_uq") {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}

export function assertSupportedCurrency(currency: string, supported: readonly string[]): void {
  if (!supported.includes(currency)) {
    throw new ValidationError(`Currency ${currency} is not supported (supported: ${supported.join(", ")})`, "currency");
  }
}
