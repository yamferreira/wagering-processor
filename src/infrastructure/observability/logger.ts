import pino, { type Logger as PinoLogger } from "pino";
import type { LogFields, Logger } from "../../application/ports/logger";

/** pino adapter for the Logger port: one JSON object per line on stdout. */
export function createLogger(options: { level: string; base?: LogFields }): Logger {
  const root = pino({
    level: options.level,
    base: { service: "wagering-processor", pid: process.pid, ...options.base },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
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
