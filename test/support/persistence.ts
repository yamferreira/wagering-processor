import type { MikroORM } from "@mikro-orm/postgresql";
import { systemClock } from "../../src/application/ports/system";
import { initOrm } from "../../src/infrastructure/persistence/orm";
import { MikroOrmTransactionRunner, type TransactionRunnerOptions } from "../../src/infrastructure/persistence/transaction-runner";
import { createTestDatabase, type TestDatabase } from "./db";

export interface PersistenceHarness {
  db: TestDatabase;
  orm: MikroORM;
  runner: MikroOrmTransactionRunner;
  close(): Promise<void>;
}

export async function createPersistenceHarness(
  options: Partial<TransactionRunnerOptions> = {},
  poolMax = 20,
): Promise<PersistenceHarness> {
  const db = await createTestDatabase();
  const orm = await initOrm(db.appUrl, poolMax);
  const runner = new MikroOrmTransactionRunner(orm, systemClock, {
    lockTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    maxRetries: 3,
    ...options,
  });
  return {
    db,
    orm,
    runner,
    async close() {
      await orm.close(true);
      await db.drop();
    },
  };
}
