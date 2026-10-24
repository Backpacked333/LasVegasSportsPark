/**
 * How a fixture's readiness is presented (SPK-READY-001 to SPK-READY-004, SCR-S-10). The API
 * derives readiness on every read; the dashboard never edits it and never shows unknown evidence
 * as ready:
 *
 * - any unknown check or unknown-severity issue makes "ready" read as "Unknown or stale evidence";
 * - an evaluation older than the configured stale threshold (pending DEC-032/DEC-033; unset by
 *   default), or one shown while offline or after a failed refresh, reads as unknown too: the
 *   last evaluation time is shown and "Re-evaluate" asks the API again;
 * - an evaluation that could not be made at all is "unknown", never "ready" (recovery state).
 *
 * Blocking and warning answers are never softened, whatever their age.
 */
import type { Schema } from '@sportspark/api-client';

type Readiness = Schema<'FixtureReadiness'>;
type ReadinessStatus = Schema<'ReadinessStatus'>;

export interface EffectiveReadiness {
  status: ReadinessStatus;
  /** Why the API's "ready" is shown as unknown, when it is. */
  downgradeReason: string | null;
}

export function effectiveReadiness(
  readiness: Readiness,
  context: { now: Date; staleThresholdMs: number | null; offline: boolean; refreshFailed: boolean },
): EffectiveReadiness {
  const hasUnknown =
    readiness.checks.some((c) => c.status === 'unknown') ||
    readiness.issues.some((i) => i.severity === 'unknown');
  if (readiness.status !== 'ready') {
    return { status: readiness.status, downgradeReason: null };
  }
  if (hasUnknown) {
    return {
      status: 'unknown',
      downgradeReason: 'Some evidence is unknown, so this fixture is not shown as ready.',
    };
  }
  if (context.offline || context.refreshFailed) {
    return {
      status: 'unknown',
      downgradeReason:
        'You are offline or the latest evaluation could not be fetched, so readiness cannot be confirmed.',
    };
  }
  const evaluatedAt = new Date(readiness.evaluatedAt).getTime();
  if (
    context.staleThresholdMs !== null &&
    Number.isFinite(evaluatedAt) &&
    context.now.getTime() - evaluatedAt > context.staleThresholdMs
  ) {
    return {
      status: 'unknown',
      downgradeReason: 'The last evaluation is older than the stale threshold. Re-evaluate.',
    };
  }
  return { status: 'ready', downgradeReason: null };
}

const SEVERITY_ORDER = { blocking: 0, unknown: 1, warning: 2, info: 3 } as const;

/** Blocking first, then unknown evidence, warnings, then informational issues. */
export function orderIssues<T extends { severity: keyof typeof SEVERITY_ORDER }>(
  issues: readonly T[],
): T[] {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
