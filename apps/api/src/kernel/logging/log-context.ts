import { AsyncLocalStorage } from 'node:async_hooks';

/** What every log line written while serving a request carries (§4.10 correlation reference). */
export interface LogContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Runs `fn` (and everything it awaits or schedules) with `context` as the current log context. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The log context of the request being served, if any. */
export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}
