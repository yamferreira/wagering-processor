import { ValidationError } from "../../domain/errors";

/**
 * Opaque, stable ledger cursor (A20): base64url of `{"v": <wallet_version>}`.
 * wallet_version is unique and monotonic per wallet, so pages never skip or repeat entries
 * even while new entries are appended.
 */
export const LedgerCursor = {
  encode(afterVersion: number): string {
    return Buffer.from(JSON.stringify({ v: afterVersion }), "utf8").toString("base64url");
  },

  decode(cursor: string | undefined): number {
    if (cursor === undefined || cursor === "") return 0;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("not base64url");
      const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      const v = (parsed as { v?: unknown }).v;
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("bad version");
      return v;
    } catch {
      throw new ValidationError("cursor is invalid", "cursor");
    }
  },
};

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;
