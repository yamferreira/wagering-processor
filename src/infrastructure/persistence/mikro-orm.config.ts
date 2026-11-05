import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, type Options } from "@mikro-orm/postgresql";
import { MIGRATIONS } from "./migrations";

export interface OrmConfigInput {
  clientUrl: string;
  poolMax?: number;
  entities?: Options["entities"];
  debug?: boolean;
}

export function createOrmConfig(input: OrmConfigInput): Options {
  return defineConfig({
    clientUrl: input.clientUrl,
    entities: input.entities ?? [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: input.poolMax ?? 20 },
    debug: input.debug ?? false,
    allowGlobalContext: false,
    migrations: {
      tableName: "mikro_orm_migrations",
      migrationsList: MIGRATIONS,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      snapshotOnMigrate: false,
      silent: true,
    },
  });
}
