import { type ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { mapError } from "../error-mapping";

/** Global filter: every error leaves the API as `{ "error": { "code", "message", ... } }`. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(private readonly onUnexpected: (error: unknown) => void = () => {}) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapped = mapError(exception);
    if (mapped.status >= 500 && mapped.status !== 503) this.onUnexpected(exception);
    for (const [name, value] of Object.entries(mapped.headers ?? {})) response.setHeader(name, value);
    response.status(mapped.status).json(mapped.body);
  }
}
