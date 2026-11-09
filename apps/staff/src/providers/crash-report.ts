/**
 * Where an unexpected client failure is reported (§5.11 observability, SPK-UX-006). No vendor is
 * chosen (DEC-021 covers monitoring): the browser adapter writes to the console, tests use the
 * memory adapter, and a hosted crash reporter plugs in here later. A report carries the error and
 * where it happened, never form contents or records (§4.14: no child data in logs).
 */
import { ApiError } from '@sportspark/api-client';

export type CrashSource = 'render' | 'window_error' | 'unhandled_rejection';

export interface CrashReport {
  source: CrashSource;
  message: string;
  /** The API correlation id when the failure was an API answer (§4.10). */
  correlationId: string | null;
  /** The route path where it happened (no query string, which can carry search terms). */
  path: string | null;
  at: Date;
}

export interface CrashReporter {
  capture(report: CrashReport): void;
}

export const consoleCrashReporter: CrashReporter = {
  capture: (report) => {
    console.error(
      `[crash] ${report.source} at ${report.path ?? 'unknown'}: ${report.message}` +
        (report.correlationId ? ` (correlation ${report.correlationId})` : ''),
    );
  },
};

export class MemoryCrashReporter implements CrashReporter {
  readonly reports: CrashReport[] = [];
  capture(report: CrashReport): void {
    this.reports.push(report);
  }
}

export function describeFailure(error: unknown): { message: string; correlationId: string | null } {
  if (error instanceof ApiError)
    return { message: `${error.code}: ${error.message}`, correlationId: error.correlationId };
  if (error instanceof Error) return { message: error.message, correlationId: null };
  return { message: String(error), correlationId: null };
}

/**
 * Reports failures nothing else caught: script errors and promise rejections no code handled.
 * Returns the function that removes the listeners.
 */
export function installGlobalCrashHandlers(
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'location'>,
  reporter: CrashReporter,
  now: () => Date,
): () => void {
  const onError = (event: ErrorEvent) => {
    reporter.capture({
      source: 'window_error',
      ...describeFailure(event.error ?? event.message),
      path: target.location.pathname,
      at: now(),
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reporter.capture({
      source: 'unhandled_rejection',
      ...describeFailure(event.reason),
      path: target.location.pathname,
      at: now(),
    });
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
