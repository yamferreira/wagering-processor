import type { FaultInjector } from "../../src/application/ports/fault-injector";
import type { Logger } from "../../src/application/ports/logger";
import type { Wallet } from "../../src/domain/wallet/wallet";
import type { AppConfig } from "../../src/infrastructure/config/config";
import { loadConfig } from "../../src/infrastructure/config/config";
import { type Runtime, startRuntime } from "../../src/infrastructure/app/runtime";
import { buildContainer, type Container } from "../../src/infrastructure/app/container";
import { silentLogger } from "../../src/application/ports/logger";
import { initOrm } from "../../src/infrastructure/persistence/orm";
import type { MikroORM } from "@mikro-orm/postgresql";
import { createTestDatabase, type TestDatabase } from "./db";
import { ScriptedFaults } from "./faults";
import { createTestQueues, type TestQueues } from "./sqs";
import { CTX } from "./use-cases";
import type { SubmitWagerCommand } from "../../src/application/use-cases/submit-wager-transaction";

export interface MessagingHarness {
  db: TestDatabase;
  queues: TestQueues;
  config: AppConfig;
  orm: MikroORM;
  faults: ScriptedFaults;
  /** Fixture container (no roles running): wallets, queries, direct use-case calls. */
  container: Container;
  runtimes: Runtime[];
  /** Starts one more in-process instance (same DB and queues). */
  start(overrides?: Partial<AppConfig>, options?: { faults?: FaultInjector; logger?: Logger }): Promise<Runtime>;
  openWallet(balance?: string, playerId?: string): Promise<Wallet>;
  close(): Promise<void>;
}

/**
 * Real PostgreSQL (fresh database) + real LocalStack queues (unique per harness) + one or more
 * in-process runtimes. Timings are shortened (long polling 1 s, retry backoff 1 s) so the
 * suites stay fast; the logic is the production one.
 */
export async function createMessagingHarness(
  options: { config?: Partial<AppConfig>; queues?: { redriveMaxReceives?: number; visibilityTimeoutSeconds?: number }; label?: string } = {},
): Promise<MessagingHarness> {
  const db = await createTestDatabase();
  const queues = await createTestQueues({ label: options.label ?? "msg", ...options.queues });
  const config = loadConfig(process.env, {
    DATABASE_URL: db.url,
    DB_POOL_MAX: 20,
    PORT: 0,
    SQS_INPUT_QUEUE: queues.topology.input,
    SQS_DLQ: queues.topology.dlq,
    SQS_EVENTS_QUEUE: queues.topology.events,
    SQS_WAIT_TIME_S: 1,
    SQS_RETRY_BASE_S: 1,
    SQS_RETRY_CAP_S: 1,
    SQS_MAX_RECEIVES: 5,
    PENDING_REF_MAX_ATTEMPTS: 3,
    PENDING_REF_BASE_MS: 50,
    PENDING_REF_CAP_MS: 200,
    OUTBOX_POLL_MS: 50,
    PENDING_REF_POLL_MS: 50,
    LOG_LEVEL: (process.env.TEST_LOG_LEVEL as AppConfig["LOG_LEVEL"]) ?? "silent",
    ROLES: ["consumer"],
    FAULTS: "",
    ...options.config,
  });
  const orm = await initOrm(db.url, 5);
  const faults = new ScriptedFaults();
  const runtimes: Runtime[] = [];
  const container = await buildContainer(config, { orm, faults, logger: silentLogger });

  const harness: MessagingHarness = {
    db,
    queues,
    config,
    orm,
    faults,
    container,
    runtimes,
    async start(overrides = {}, startOptions = {}) {
      const runtime = await startRuntime(
        { ...config, ...overrides },
        { faults: startOptions.faults ?? faults, ...(startOptions.logger ? { logger: startOptions.logger } : {}) },
      );
      runtimes.push(runtime);
      return runtime;
    },
    async openWallet(balance = "100.00", playerId = `player-${crypto.randomUUID()}`) {
      return container.createWallet.execute({ playerId, initialBalance: { amount: balance, currency: "BRL" } }, CTX);
    },
    async close() {
      for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined);
      await container.close();
      await orm.close(true);
      await queues.destroy();
      await db.drop();
    },
  };
  return harness;
}

let messageSequence = 0;

/** §10 envelope for a wager command (messageId defaults to a fresh one). */
export function wagerEnvelope(command: SubmitWagerCommand, overrides: { messageId?: string; correlationId?: string } = {}) {
  messageSequence += 1;
  const { idempotencyKey, ...rest } = command;
  return {
    messageId: overrides.messageId ?? `msg-${Date.now()}-${messageSequence}-${crypto.randomUUID().slice(0, 8)}`,
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    ...(overrides.correlationId ? { correlationId: overrides.correlationId } : {}),
    data: { ...rest, idempotencyKey },
  };
}

/** Sends an envelope to the input queue; groupId defaults to the walletId (A26). */
export async function sendEnvelope(
  queues: TestQueues,
  envelope: ReturnType<typeof wagerEnvelope> | Record<string, unknown>,
  options: { groupId?: string; deduplicationId?: string; raw?: string } = {},
): Promise<void> {
  const data = (envelope as { data?: { walletId?: string } }).data;
  await queues.input.send({
    body: options.raw ?? JSON.stringify(envelope),
    groupId: options.groupId ?? data?.walletId ?? "group",
    deduplicationId: options.deduplicationId ?? crypto.randomUUID(),
  });
}
