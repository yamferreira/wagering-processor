import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Container } from "../app/container";
import { AppModule } from "./app.module";
import { mapError, MalformedJsonError } from "./error-mapping";
import { ErrorFilter } from "./filters/error.filter";
import { correlationMiddleware } from "./request-context";

export interface HttpAppOptions {
  onUnexpectedError?: (error: unknown) => void;
}

/** Builds the Nest application (not listening yet). */
export async function createHttpApp(container: Container, options: HttpAppOptions = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(container), { bodyParser: false, logger: false });
  const server = app.getHttpAdapter().getInstance() as express.Express;
  server.disable("x-powered-by");
  app.use(correlationMiddleware);
  app.use(express.json({ limit: "64kb", strict: true, type: ["application/json", "application/*+json"] }));
  // Body-parser errors happen before routing; give them the same error contract.
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!error) return next();
    const type = (error as { type?: string }).type;
    const mapped =
      type === "entity.parse.failed"
        ? mapError(new MalformedJsonError())
        : type === "entity.too.large"
          ? { status: 413, body: { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" } } }
          : mapError(error);
    res.status(mapped.status).json(mapped.body);
  });
  app.useGlobalFilters(new ErrorFilter(options.onUnexpectedError));
  app.enableShutdownHooks();
  return app;
}
