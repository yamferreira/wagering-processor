import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { runMigrations } from "../../../src/infrastructure/persistence/migrate";
import { createEmptyDatabase, type TestDatabase } from "../../support/db";

// Real PostgreSQL/LocalStack: Bun applies bunfig/preload timeouts to the first file only, so set it per file.
setDefaultTimeout(60_000);

const ALL_MIGRATIONS = [
  "Migration20261105000000_initial",
  "Migration20261106000000_ledger_matches_transaction",
  "Migration20261106000100_runtime_role",
];
const APP_TABLES = ["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"];

async function appTables(db: TestDatabase): Promise<string[]> {
  const rows: { tablename: string }[] = await db.sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'mikro_orm_migrations'
    ORDER BY tablename`;
  return rows.map((r) => r.tablename);
}

async function appFunctions(db: TestDatabase): Promise<string[]> {
  const rows: { proname: string }[] = await db.sql`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' ORDER BY p.proname`;
  return rows.map((r) => r.proname);
}

// Schema-only (no wallet is ever created here), so the ledger invariant does not apply to this file.
/** Privileges of the runtime role, as "table:PRIVILEGE" (the ledger never gets UPDATE/DELETE/TRUNCATE). */
const RUNTIME_GRANTS = [
  ...["inbox_messages", "outbox_messages", "wager_transactions"].flatMap((t) => [`${t}:INSERT`, `${t}:SELECT`, `${t}:UPDATE`]),
  "wallet_ledger_entries:INSERT",
  "wallet_ledger_entries:SELECT",
  "wallets:INSERT",
  "wallets:SELECT",
  "wallets:UPDATE",
];

async function runtimeGrants(db: TestDatabase): Promise<string[]> {
  const rows: { grant: string }[] = await db.sql`
    SELECT table_name || ':' || privilege_type AS grant FROM information_schema.role_table_grants
     WHERE grantee = 'wagering_app' AND table_schema = 'public' ORDER BY 1`;
  return rows.map((r) => r.grant);
}

describe("migrations are versioned and reversible", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createEmptyDatabase();
  });

  afterAll(async () => {
    await db.drop();
  });

  test("up → down → up runs cleanly and leaves the full schema", async () => {
    const firstUp = await runMigrations(db.url, "up");
    expect(firstUp.map((m) => m.name)).toEqual(ALL_MIGRATIONS);
    expect(await appTables(db)).toEqual(APP_TABLES);

    expect(await runtimeGrants(db)).toEqual(RUNTIME_GRANTS);

    // One step down reverts only the latest migration (the runtime role's grants).
    const oneDown = await runMigrations(db.url, "down");
    expect(oneDown.map((m) => m.name)).toEqual(["Migration20261106000100_runtime_role"]);
    expect(await runtimeGrants(db)).toEqual([]);
    expect(await appFunctions(db)).toContain("ledger_check_transaction");
    expect(await appTables(db)).toEqual(APP_TABLES);

    const down = await runMigrations(db.url, "down", { toZero: true });
    expect(down.map((m) => m.name)).toEqual([
      "Migration20261106000000_ledger_matches_transaction",
      "Migration20261105000000_initial",
    ]);
    expect(await appTables(db)).toEqual([]);
    expect(await appFunctions(db)).toEqual([]);

    const secondUp = await runMigrations(db.url, "up");
    expect(secondUp).toHaveLength(ALL_MIGRATIONS.length);
    expect(await appFunctions(db)).toContain("ledger_check_transaction");
    expect(await runtimeGrants(db)).toEqual(RUNTIME_GRANTS);
    expect(await appTables(db)).toEqual(APP_TABLES);

    const noop = await runMigrations(db.url, "up");
    expect(noop).toHaveLength(0);
  });
});
