import "reflect-metadata";
import { buildContainer } from "./infrastructure/app/container";
import { loadConfig } from "./infrastructure/config/config";
import { createHttpApp } from "./infrastructure/http/http-app";

/** Process entry point: API (workers are added in the day-2 tasks, see docs/PLAN.md). */
async function main(): Promise<void> {
  const config = loadConfig();
  const container = await buildContainer(config);
  const app = await createHttpApp(container, {
    onUnexpectedError: (error) => console.error(JSON.stringify({ level: "error", msg: "unexpected error", error: String(error) })),
  });
  await app.listen(config.PORT);
  console.log(JSON.stringify({ level: "info", msg: "http listening", port: config.PORT }));

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ level: "info", msg: "shutting down", signal }));
    await app.close();
    await container.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

await main();
