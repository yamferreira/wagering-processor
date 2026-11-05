import { expect, test } from "bun:test";

test("toolchain runs bigint arithmetic exactly", () => {
  expect(10n + 20n).toBe(30n);
});
