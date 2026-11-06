import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261105000000_initial } from "./Migration20261105000000_initial";
import { Migration20261106000000_ledger_matches_transaction } from "./Migration20261106000000_ledger_matches_transaction";
import { Migration20261106000100_runtime_role } from "./Migration20261106000100_runtime_role";

/** Explicit, ordered list (no filesystem globbing, works the same under Bun and in tests). */
export const MIGRATIONS: MigrationObject[] = [
  { name: "Migration20261105000000_initial", class: Migration20261105000000_initial },
  { name: "Migration20261106000000_ledger_matches_transaction", class: Migration20261106000000_ledger_matches_transaction },
  { name: "Migration20261106000100_runtime_role", class: Migration20261106000100_runtime_role },
];
