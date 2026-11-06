import type { RequestContext } from "../../src/application/use-cases/context";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import { GetWagerTransaction, GetWallet, GetWalletLedger } from "../../src/application/use-cases/queries";
import { ReconcileWallet, type ReconciliationReport } from "../../src/application/use-cases/reconcile-wallet";
import { ResolvePendingReference } from "../../src/application/use-cases/resolve-pending-reference";
import { type SubmitWagerCommand, SubmitWagerTransaction } from "../../src/application/use-cases/submit-wager-transaction";
import { systemClock } from "../../src/application/ports/system";
import { ReferenceRetryPolicy } from "../../src/domain/wager/reference-retry-policy";
import { uuidV7Generator } from "../../src/infrastructure/ids/uuidv7";
import type { TransactionRunnerOptions } from "../../src/infrastructure/persistence/transaction-runner";
import { ScriptedFaults } from "./faults";
import { createPersistenceHarness, type PersistenceHarness } from "./persistence";

export interface UseCaseHarness extends PersistenceHarness {
  faults: ScriptedFaults;
  divergences: ReconciliationReport[];
  createWallet: CreateWallet;
  submit: SubmitWagerTransaction;
  getWallet: GetWallet;
  getLedger: GetWalletLedger;
  getTransaction: GetWagerTransaction;
  reconcile: ReconcileWallet;
  resolvePending: ResolvePendingReference;
}

export const CTX: RequestContext = { correlationId: "test-correlation", channel: "HTTP" };

export async function createUseCaseHarness(
  options: Partial<TransactionRunnerOptions> = {},
  poolMax = 20,
): Promise<UseCaseHarness> {
  const persistence = await createPersistenceHarness(options, poolMax);
  const faults = new ScriptedFaults();
  const divergences: ReconciliationReport[] = [];
  const supportedCurrencies = ["BRL", "USD", "EUR"];
  const deps = { runner: persistence.runner, ids: uuidV7Generator, clock: systemClock };
  const retryPolicy = ReferenceRetryPolicy.of({ maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 });
  return {
    ...persistence,
    faults,
    divergences,
    createWallet: new CreateWallet({ ...deps, supportedCurrencies }),
    submit: new SubmitWagerTransaction({
      ...deps,
      faults,
      supportedCurrencies,
      retryPolicy,
    }),
    resolvePending: new ResolvePendingReference({ ...deps, retryPolicy, faults, batchSize: 50, leaseMs: 5_000 }),
    getWallet: new GetWallet(persistence.runner),
    getLedger: new GetWalletLedger(persistence.runner),
    getTransaction: new GetWagerTransaction(persistence.runner),
    reconcile: new ReconcileWallet(persistence.runner, { onDivergence: (report) => divergences.push(report) }),
  };
}

let externalSequence = 0;

/** A valid BET command for the wallet; override any field. */
export function wagerCommand(
  wallet: { id: string; playerId: string },
  overrides: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  externalSequence += 1;
  const providerId = overrides.providerId ?? "provider-a";
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${Date.now()}-${externalSequence}`;
  return {
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...overrides,
  };
}
