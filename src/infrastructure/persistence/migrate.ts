import { MikroORM } from "@mikro-orm/postgresql";
import { createOrmConfig } from "./mikro-orm.config";

export type MigrationDirection = "up" | "down";

/** Runs migrations programmatically (the MikroORM CLI is not needed under Bun). */
export async function runMigrations(clientUrl: string, direction: MigrationDirection, options: { toZero?: boolean } = {}) {
  const orm = await MikroORM.init(createOrmConfig({ clientUrl, poolMax: 2 }));
  try {
    if (direction === "up") return await orm.migrator.up();
    return await orm.migrator.down(options.toZero ? { to: 0 } : undefined);
  } finally {
    await orm.close(true);
  }
}
