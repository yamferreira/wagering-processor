import { AsyncLocalStorage } from "node:async_hooks";
import type { LogFields } from "../../application/ports/logger";

/**
 * Identifiers of the unit of work in progress (an HTTP request, an SQS message, a worker item),
 * propagated through async calls so every log line carries them without threading a logger
 * through the use cases: correlationId, messageId, transactionId, walletId, providerId.
 */
const storage = new AsyncLocalStorage<LogFields>();

export function withLogContext<T>(fields: LogFields, work: () => T): T {
  const parent = storage.getStore();
  return storage.run({ ...parent, ...defined(fields) }, work);
}

/** Adds identifiers learned along the way (e.g. the transactionId once it exists). */
export function enrichLogContext(fields: LogFields): void {
  const store = storage.getStore();
  if (store) Object.assign(store, defined(fields));
}

export function currentLogContext(): LogFields {
  return storage.getStore() ?? {};
}

function defined(fields: LogFields): LogFields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}
