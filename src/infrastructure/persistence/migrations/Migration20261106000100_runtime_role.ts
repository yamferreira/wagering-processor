import { Migration } from "@mikro-orm/migrations";

/**
 * Least-privilege runtime role (independent review of T27): the service connects as `wagering_app`,
 * which owns nothing and is not a superuser, so it can neither bypass the schema guarantees
 * (ALTER TABLE … DISABLE TRIGGER, SET session_replication_role = replica, DROP) nor rewrite the
 * ledger: it gets SELECT/INSERT only on wallet_ledger_entries and no DELETE/TRUNCATE anywhere.
 * Migrations keep running as the schema owner (MIGRATION_DATABASE_URL).
 *
 * The role is created here when missing, with a development password, so `docker compose up` +
 * `migration:up` is enough locally. In production the role (and its secret) is provisioned out of
 * band and this migration only grants. Roles are cluster-wide, so `down` revokes the grants of this
 * database and keeps the role (other databases on the cluster may use it).
 */
export class Migration20261106000100_runtime_role extends Migration {
  override name = "Migration20261106000100_runtime_role";

  override up(): void {
    this.addSql(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wagering_app') THEN
          CREATE ROLE wagering_app LOGIN PASSWORD 'wagering_app'
            NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      EXCEPTION WHEN duplicate_object THEN
        NULL; -- created concurrently by another database's migration
      END $$`);
    this.addSql("GRANT USAGE ON SCHEMA public TO wagering_app");
    this.addSql("GRANT SELECT, INSERT, UPDATE ON wallets, wager_transactions, outbox_messages, inbox_messages TO wagering_app");
    this.addSql("GRANT SELECT, INSERT ON wallet_ledger_entries TO wagering_app");
  }

  override down(): void {
    this.addSql("REVOKE ALL ON wallets, wager_transactions, wallet_ledger_entries, outbox_messages, inbox_messages FROM wagering_app");
    this.addSql("REVOKE USAGE ON SCHEMA public FROM wagering_app");
  }
}
