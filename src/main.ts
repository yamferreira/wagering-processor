import "reflect-metadata";
import { startRuntime } from "./infrastructure/app/runtime";
import { loadConfig } from "./infrastructure/config/config";

/**
 * Process entry point: `bun run start` runs the roles listed in ROLES (default: all).
 *
 * Graceful shutdown on SIGTERM/SIGINT (containers, terminals). When the process was spawned
 * with an IPC channel, a `{ type: "shutdown" }` message triggers the same path: on Windows,
 * Bun delivers `kill("SIGTERM")` to a child as an immediate termination, so the test harness
 * uses IPC there (see docs/ARCHITECTURE.md §9).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = await startRuntime(config);
  const log = runtime.container.logger;

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    // Hard deadline: a stuck dependency must never keep a terminating process alive.
    setTimeout(() => process.exit(1), Math.max(config.SHUTDOWN_GRACE_MS, config.SQS_WAIT_TIME_S * 1_000) + 10_000).unref();
    try {
      await runtime.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("message", (message: unknown) => {
    if ((message as { type?: string })?.type === "shutdown") void shutdown("IPC");
  });
  process.send?.({ type: "ready", roles: runtime.roles, port: runtime.port });
}

await main();
