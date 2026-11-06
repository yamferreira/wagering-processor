import { describe, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

/**
 * Without PostgreSQL/LocalStack the integration suites must stop at once with one actionable message,
 * not a wall of connection errors. A nested `bun test` runs with both endpoints pointing to closed ports.
 */
describe("test infrastructure preflight", () => {
  test("unreachable PostgreSQL and LocalStack: the run fails fast with one clear message", async () => {
    const closed = "127.0.0.1:9"; // discard port: nothing listens there
    const startedAt = performance.now();
    const proc = Bun.spawn(["bun", "test", "test/integration/schema/migrations.test.ts", "test/integration/messaging/sqs.test.ts"], {
      cwd: new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      env: {
        ...process.env,
        DATABASE_URL: `postgres://wagering_app:wagering_app@${closed}/wagering`,
        MIGRATION_DATABASE_URL: `postgres://wagering:wagering@${closed}/wagering`,
        SQS_ENDPOINT: `http://${closed}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const output = stdout + stderr;
    const elapsed = performance.now() - startedAt;

    expect(code).not.toBe(0);
    expect(output).toContain("docker compose up -d --wait");
    expect(output).toContain("PostgreSQL");
    expect(output).toContain("LocalStack");
    expect(output.split("docker compose up -d --wait").length - 1).toBe(1); // once, not per test
    expect(elapsed).toBeLessThan(20_000);
  });
});
