import { IsolationLevel } from "@mikro-orm/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { Repositories } from "../../application/ports/repositories";
import type { Clock } from "../../application/ports/system";
import type { TransactionOptions, TransactionRunner } from "../../application/ports/transaction-runner";
import { isRetryableInPlace, translateDbError } from "./db-errors";
import { createRepositories } from "./repositories/mikro-orm-repositories";

export interface TransactionRunnerOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  /** Bounded in-place retries for deadlock / serialization failure / version conflict. */
  maxRetries: number;
}

export interface TransactionRunnerHooks {
  onRetry?(reason: string, attempt: number): void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `em.transactional()` on a fresh fork per unit of work (READ COMMITTED by default).
 * Timeouts are set with `set_config(..., true)` so they apply to this transaction only.
 */
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
    private readonly options: TransactionRunnerOptions,
    private readonly hooks: TransactionRunnerHooks = {},
  ) {}

  async run<T>(work: (repos: Repositories) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(
          async (em) => {
            await em.execute("SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)", [
              `${this.options.lockTimeoutMs}ms`,
              `${this.options.statementTimeoutMs}ms`,
            ]);
            return work(createRepositories(em, this.clock));
          },
          {
            isolationLevel:
              options.isolation === "REPEATABLE_READ" ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
            readOnly: options.readOnly ?? false,
          },
        );
      } catch (error) {
        const translated = translateDbError(error);
        if (isRetryableInPlace(translated) && attempt < this.options.maxRetries) {
          this.hooks.onRetry?.((translated as { reason: string }).reason, attempt + 1);
          await sleep(5 * 2 ** attempt + Math.floor(Math.random() * 10));
          continue;
        }
        throw translated;
      }
    }
  }

  async read<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await work(createRepositories(this.orm.em.fork(), this.clock));
    } catch (error) {
      throw translateDbError(error);
    }
  }
}
