/**
 * Where an unexpected failure in the customer app is reported (§5.11 observability, SPK-UX-006).
 * No vendor is chosen (DEC-021 covers monitoring): the device adapter writes to the console, tests
 * use the memory adapter, and a hosted crash reporter plugs in here later. A report carries the
 * error and where it happened, never form contents or records (§4.14: no child data in logs).
 */
import { ApiError } from '@sportspark/api-client';

export type CrashSource = 'render' | 'global';

export interface CrashReport {
  source: CrashSource;
  message: string;
  /** The API correlation id when the failure was an API answer (§4.10). */
  correlationId: string | null;
  /** True when React Native reported the error as fatal (the app would otherwise close). */
  fatal: boolean;
  at: Date;
}

export interface CrashReporter {
  capture(report: CrashReport): void;
}

export const consoleCrashReporter: CrashReporter = {
  capture: (report) => {
    console.error(
      `[crash] ${report.source}${report.fatal ? ' (fatal)' : ''}: ${report.message}` +
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
  if (error instanceof ApiError) {
    return { message: `${error.code}: ${error.message}`, correlationId: error.correlationId };
  }
  if (error instanceof Error) return { message: error.message, correlationId: null };
  return { message: String(error), correlationId: null };
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(handler: GlobalHandler): void;
}

/**
 * Reports errors nothing caught (React Native's global handler), then hands them to the handler
 * that was installed before, so development keeps its red screen. Returns the function that puts
 * the previous handler back.
 */
export function installGlobalCrashHandler(
  reporter: CrashReporter,
  now: () => Date,
  errorUtils: ErrorUtilsLike | undefined = (globalThis as { ErrorUtils?: ErrorUtilsLike })
    .ErrorUtils,
): () => void {
  if (!errorUtils) return () => undefined;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    reporter.capture({ source: 'global', ...describeFailure(error), fatal: !!isFatal, at: now() });
    previous(error, isFatal);
  });
  return () => errorUtils.setGlobalHandler(previous);
}
