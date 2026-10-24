/**
 * Freshness helpers shared by both clients (spec §4.15 "Show cached-data age prominently";
 * SPK-UX-008 stale and offline states; SCR-C-40, SCR-W-10).
 */

/** "just now", "4 minutes ago", "2 hours ago", "3 days ago": always a phrase, never colour. */
export function formatAge(from: Date | number, now: Date | number): string {
  const ms = Math.max(0, toMs(now) - toMs(from));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function toMs(value: Date | number): number {
  return typeof value === 'number' ? value : value.getTime();
}

/**
 * Whether data received at `receivedAt` is older than `thresholdMs`. The threshold is a client
 * display setting, not a policy: the staff offline roster age (proposed two hours, §4.15) is
 * DEC-033 and must come from configuration when that screen is built.
 */
export function isStale(
  receivedAt: Date | number,
  now: Date | number,
  thresholdMs: number,
): boolean {
  return toMs(now) - toMs(receivedAt) > thresholdMs;
}

/** Operation statuses after which polling `GET /v1/operations/{id}` stops (§4.8, §4.12). */
export const TERMINAL_OPERATION_STATUSES = [
  'succeeded',
  'failed',
  'recovery_required',
  'compensated',
] as const;

export function isTerminalOperationStatus(status: string): boolean {
  return (TERMINAL_OPERATION_STATUSES as readonly string[]).includes(status);
}

/** Stable TanStack Query key for a GET: path template, path parameters and query. */
export function apiQueryKey(
  path: string,
  options?: { path?: object; query?: object },
): readonly unknown[] {
  return ['api', path, options?.path ?? null, options?.query ?? null] as const;
}
