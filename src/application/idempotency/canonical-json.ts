/**
 * Canonical JSON (A14 in docs/ARCHITECTURE.md): object keys sorted recursively by UTF-16 code unit order,
 * no insignificant whitespace, `undefined` properties omitted, arrays keep their order.
 * Values that have no stable JSON form (bigint, functions, symbols, NaN, ±Infinity) are rejected.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item === undefined ? null : item, `${path}[${index}]`)).join(",")}]`;
      }
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Value of type ${typeof value} at ${path} has no canonical JSON form`);
  }
}
