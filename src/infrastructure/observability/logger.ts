import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import type { LogFields, Logger } from "../../application/ports/logger";
import { DomainError } from "../../domain/errors";
import { currentLogContext } from "./log-context";

/**
 * Keys that may hold financial values or full payloads (§12: "sem dados sensíveis ou payloads
 * financeiros completos"). Censored at any of the first three nesting levels, as a safety net:
 * the code logs identifiers and outcomes only.
 */
const SENSITIVE_KEYS = [
  "amount",
  "balance",
  "money",
  "initialBalance",
  "resultingBalance",
  "storedBalance",
  "calculatedBalance",
  "difference",
  "balanceBefore",
  "balanceAfter",
  "payload",
  "body",
  "data",
];
export const REDACTED_PATHS = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);
export const REDACTED = "[redacted]";

export interface LoggerOptions {
  level: string;
  base?: LogFields;
  /** Where lines go (stdout by default); tests pass a capturing stream. */
  destination?: DestinationStream;
}

/**
 * pino adapter for the Logger port: one JSON object per line, ISO timestamps, the identifiers of
 * the current unit of work merged into every line (AsyncLocalStorage), sensitive keys redacted.
 */
export function createLogger(options: LoggerOptions): Logger {
  const root = pino(
    {
      level: options.level,
      base: { service: "wagering-processor", pid: process.pid, ...options.base },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      mixin: () => currentLogContext(),
      redact: { paths: REDACTED_PATHS, censor: REDACTED },
    },
    options.destination,
  );
  return wrap(root);
}

function wrap(instance: PinoLogger): Logger {
  return {
    debug: (fields, message) => instance.debug(fields, message),
    info: (fields, message) => instance.info(fields, message),
    warn: (fields, message) => instance.warn(fields, message),
    error: (fields, message) => instance.error(fields, message),
    child: (fields) => wrap(instance.child(fields)),
  };
}

/**
 * Error fields safe to log. Domain errors are described by name and code only: their messages
 * can quote balances or the rejected input (e.g. InsufficientFundsError). Infrastructure errors
 * (driver, SDK, network) keep their message, which carries no financial data.
 */
export function errorFields(error: unknown): LogFields {
  if (error instanceof DomainError) return { errorName: error.name, errorCode: error.code };
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      errorName: error.name,
      ...(typeof code === "string" ? { errorCode: code } : {}),
      errorMessage: error.message.slice(0, 300),
    };
  }
  return { errorMessage: String(error).slice(0, 300) };
}
