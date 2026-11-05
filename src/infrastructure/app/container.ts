import type { MikroORM } from "@mikro-orm/postgresql";
import { type FaultInjector, noFaults } from "../../application/ports/fault-injector";
import type { ProviderIdentityPort } from "../../application/ports/provider-identity.port";
import { type Clock, type IdGenerator, systemClock } from "../../application/ports/system";
import type { TransactionRunner } from "../../application/ports/transaction-runner";
import { CreateWallet } from "../../application/use-cases/create-wallet";
import { GetWagerTransaction, GetWallet, GetWalletLedger } from "../../application/use-cases/queries";
import { ReconcileWallet, type ReconciliationObserver } from "../../application/use-cases/reconcile-wallet";
import { SubmitWagerTransaction } from "../../application/use-cases/submit-wager-transaction";
import { ReferenceRetryPolicy } from "../../domain/wager/reference-retry-policy";
import { NoopProviderIdentity } from "../auth/noop-provider-identity";
import type { AppConfig } from "../config/config";
import { uuidV7Generator } from "../ids/uuidv7";
import { initOrm } from "../persistence/orm";
import { MikroOrmTransactionRunner } from "../persistence/transaction-runner";

export interface HealthCheck {
  name: string;
  check(): Promise<void>;
}

/** Composition root: every use case and adapter, wired once per process. */
export interface Container {
  config: AppConfig;
  runner: TransactionRunner;
  ids: IdGenerator;
  clock: Clock;
  identities: ProviderIdentityPort;
  createWallet: CreateWallet;
  submit: SubmitWagerTransaction;
  getWallet: GetWallet;
  getLedger: GetWalletLedger;
  getTransaction: GetWagerTransaction;
  reconcile: ReconcileWallet;
  readiness: HealthCheck[];
  close(): Promise<void>;
}

export interface ContainerOverrides {
  orm?: MikroORM;
  faults?: FaultInjector;
  clock?: Clock;
  identities?: ProviderIdentityPort;
  reconciliationObserver?: ReconciliationObserver;
}

export async function buildContainer(config: AppConfig, overrides: ContainerOverrides = {}): Promise<Container> {
  const ownsOrm = !overrides.orm;
  const orm = overrides.orm ?? (await initOrm(config.DATABASE_URL, config.DB_POOL_MAX));
  const clock = overrides.clock ?? systemClock;
  const ids = uuidV7Generator;
  const runner = new MikroOrmTransactionRunner(orm, clock, {
    lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
    statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
    maxRetries: config.DB_TX_MAX_RETRIES,
  });
  const retryPolicy = ReferenceRetryPolicy.of({
    maxAttempts: config.PENDING_REF_MAX_ATTEMPTS,
    baseDelayMs: config.PENDING_REF_BASE_MS,
    maxDelayMs: config.PENDING_REF_CAP_MS,
  });
  const supportedCurrencies = config.SUPPORTED_CURRENCIES;

  return {
    config,
    runner,
    ids,
    clock,
    identities: overrides.identities ?? new NoopProviderIdentity(),
    createWallet: new CreateWallet({ runner, ids, clock, supportedCurrencies }),
    submit: new SubmitWagerTransaction({
      runner,
      ids,
      clock,
      faults: overrides.faults ?? noFaults,
      retryPolicy,
      supportedCurrencies,
    }),
    getWallet: new GetWallet(runner),
    getLedger: new GetWalletLedger(runner),
    getTransaction: new GetWagerTransaction(runner),
    reconcile: new ReconcileWallet(runner, overrides.reconciliationObserver),
    readiness: [
      {
        name: "postgres",
        check: async () => {
          await orm.em.fork().execute("SELECT 1");
        },
      },
    ],
    async close() {
      if (ownsOrm) await orm.close(true);
    },
  };
}
