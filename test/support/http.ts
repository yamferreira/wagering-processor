import type { INestApplication } from "@nestjs/common";
import type { ProviderIdentityPort } from "../../src/application/ports/provider-identity.port";
import { buildContainer, type Container } from "../../src/infrastructure/app/container";
import { loadConfig } from "../../src/infrastructure/config/config";
import { createHttpApp } from "../../src/infrastructure/http/http-app";
import { createTestDatabase, type TestDatabase } from "./db";
import { ScriptedFaults } from "./faults";
import { initOrm } from "../../src/infrastructure/persistence/orm";
import type { MikroORM } from "@mikro-orm/postgresql";

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export interface HttpHarness {
  db: TestDatabase;
  orm: MikroORM;
  container: Container;
  app: INestApplication;
  baseUrl: string;
  faults: ScriptedFaults;
  request<T = any>(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string>; raw?: string }): Promise<ApiResponse<T>>;
  close(): Promise<void>;
}

export async function createHttpHarness(options: { identities?: ProviderIdentityPort } = {}): Promise<HttpHarness> {
  const db = await createTestDatabase();
  const config = loadConfig(process.env, {
    DATABASE_URL: db.url,
    PENDING_REF_MAX_ATTEMPTS: 3,
    PENDING_REF_BASE_MS: 50,
    PENDING_REF_CAP_MS: 200,
  });
  const orm = await initOrm(db.url, 20);
  const faults = new ScriptedFaults();
  const container = await buildContainer(config, {
    orm,
    faults,
    ...(options.identities ? { identities: options.identities } : {}),
  });
  const app = await createHttpApp(container);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    db,
    orm,
    container,
    app,
    baseUrl,
    faults,
    async request(method, path, { body, headers = {}, raw } = {}) {
      const init: RequestInit = { method, headers: { ...headers } };
      if (raw !== undefined || body !== undefined) {
        (init.headers as Record<string, string>)["content-type"] ??= "application/json";
        init.body = raw ?? JSON.stringify(body);
      }
      const response = await fetch(`${baseUrl}${path}`, init);
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers };
    },
    async close() {
      await app.close();
      await container.close();
      await orm.close(true);
      await db.drop();
    },
  };
}
