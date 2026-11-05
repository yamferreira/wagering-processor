import { loadConfig } from "../src/infrastructure/config/config";
import { type MigrationDirection, runMigrations } from "../src/infrastructure/persistence/migrate";

const direction = (process.argv[2] ?? "up") as MigrationDirection;
if (direction !== "up" && direction !== "down") {
  console.error("usage: bun run scripts/migrate.ts <up|down> [--all]");
  process.exit(2);
}
const config = loadConfig();
const executed = await runMigrations(config.DATABASE_URL, direction, { toZero: process.argv.includes("--all") });
console.log(
  executed.length === 0
    ? `migration:${direction} — nothing to do`
    : `migration:${direction} — ${executed.map((m) => m.name).join(", ")}`,
);
