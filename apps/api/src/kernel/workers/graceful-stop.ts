/** How a bounded worker stop ended (R3-OPERATIONS-10). */
export interface GracefulStopOutcome {
  /** The work in flight finished within the budget. */
  drained: boolean;
  /** `closed`: the application and its database closed; `timed_out`: the budget ran out first. */
  close: 'closed' | 'timed_out' | 'failed';
  error?: unknown;
}

export interface GracefulStopLogger {
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Stops a worker within one budget (R3-OPERATIONS-10, recovery runbook §4 "stop workers
 * cleanly"): waits for the work in flight (`drain`), then closes the application (`close`: module
 * shutdown hooks, then the database pool) with what is left of the budget, and resolves either way
 * so the caller can exit. The close is bounded too: ending the database pool waits for every
 * checked-out connection, so a handler or job still inside its transaction would otherwise keep
 * the process alive past the timeout until the host kills it. What is cut off is retried once its
 * lease lapses, and the database rolls back a transaction the exit leaves open.
 */
export async function stopWithinBudget(options: {
  drain: () => Promise<unknown>;
  close: () => Promise<void>;
  timeoutMs: number;
  logger: GracefulStopLogger;
  /** Milliseconds now; injectable for tests. */
  now?: () => number;
}): Promise<GracefulStopOutcome> {
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.timeoutMs;
  const drained = await raceDeadline(
    options.drain().then(
      () => true,
      () => true,
    ),
    deadline - now(),
  );
  if (!drained) {
    options.logger.warn(
      `work still in flight after ${options.timeoutMs} ms; its claims are retried once their leases lapse (OUTBOX_LOCK_LEASE_SECONDS, PERIODIC_JOBS_LEASE_SECONDS)`,
    );
  }
  let failure: unknown;
  const closing = options.close().then(
    () => 'closed' as const,
    (error: unknown) => {
      failure = error;
      return 'failed' as const;
    },
  );
  const close = (await raceDeadline(closing, Math.max(0, deadline - now()))) ?? 'timed_out';
  if (close === 'timed_out') {
    options.logger.warn(
      `closing the application did not finish within WORKER_SHUTDOWN_TIMEOUT_MS (${options.timeoutMs} ms): exiting with database connections still open; their transactions roll back and their claims are retried once the leases lapse`,
    );
  } else if (close === 'failed') {
    options.logger.error(`closing the application failed: ${String(failure)}`);
  }
  return {
    drained: drained === true,
    close,
    ...(close === 'failed' ? { error: failure } : {}),
  };
}

/** `work`'s value, or undefined when `ms` elapses first. */
async function raceDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
  });
  try {
    return await Promise.race([work, elapsed]);
  } finally {
    clearTimeout(timer);
  }
}
