import type { IdGenerator } from "../../application/ports/system";

/** UUIDv7 from the Bun runtime: time-ordered, so primary-key inserts stay index-friendly. */
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
