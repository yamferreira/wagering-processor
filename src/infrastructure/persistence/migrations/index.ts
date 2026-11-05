import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261105000000_initial } from "./Migration20261105000000_initial";

/** Explicit, ordered list (no filesystem globbing, works the same under Bun and in tests). */
export const MIGRATIONS: MigrationObject[] = [
  { name: "Migration20261105000000_initial", class: Migration20261105000000_initial },
];
