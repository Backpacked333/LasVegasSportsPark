/**
 * Reads the `details` of the §4.10 error contract for the schedule and facilities commands, as the
 * API sends them (apps/api/src/modules/scheduling and facilities services, kernel validation pipe):
 *
 * - VALIDATION_FAILED: an array of `{ path, message, code }` from request validation, or an object
 *   (`{ path }`, `{ obligations }` for unmet fixture obligations, `{ changeSequence }`, and
 *   `{ code: 'dst_resolution_required', nonexistentLocalDates, ambiguousLocalDates, options }`
 *   from a series edit whose new local start time falls in a daylight-saving gap or overlap).
 * - RESOURCE_CONFLICT: `{ issues: ValidationIssue[], conflictingEventIds }` from publication.
 * - ACCESS_DENIED: `{ action }`, the permission the principal lacks (staff see which one, §4.10).
 * - ELIGIBILITY_FAILED: `{ code: 'inspection_required', latestInspection }` from release.
 * - STALE_REVISION: `{ expectedRevision, currentRevision }`.
 */
import type { ApiError, Schema } from '@sportspark/api-client';

type ValidationIssue = Schema<'ValidationIssue'>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface FieldIssue {
  path: string;
  message: string;
}

/** Field-level messages of a VALIDATION_FAILED answer (SPK-UX-008 validation failure). */
export function fieldIssues(error: ApiError | null): FieldIssue[] {
  if (!error || error.code !== 'VALIDATION_FAILED') return [];
  const details = error.details;
  if (Array.isArray(details)) {
    return details
      .map((d) => asRecord(d))
      .filter((d): d is Record<string, unknown> => d !== null && typeof d.message === 'string')
      .map((d) => ({ path: typeof d.path === 'string' ? d.path : '', message: String(d.message) }));
  }
  const record = asRecord(details);
  if (record && typeof record.path === 'string') {
    return [{ path: record.path, message: error.message }];
  }
  return [];
}

export type NonexistentPolicy = 'shift_forward' | 'skip';
export type AmbiguousPolicy = 'first' | 'second';

/** What a series edit refused with `dst_resolution_required` needs the user to choose. */
export interface DstResolutionRequired {
  /** Local dates (YYYY-MM-DD) on which the new local start time does not exist (clocks go forward). */
  nonexistentLocalDates: string[];
  /** Local dates on which the new local start time happens twice (clocks go back). */
  ambiguousLocalDates: string[];
  nonexistentOptions: NonexistentPolicy[];
  ambiguousOptions: AmbiguousPolicy[];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * SPK-SCHED-008 (R3-TRACE-A-08): a series edit, its preview included, whose new local start time
 * does not exist or happens twice on some in-scope date is refused with VALIDATION_FAILED and
 * `details.code: 'dst_resolution_required'`; the user chooses a policy per axis from
 * `details.options` and the edit is sent again with `changes.nonexistentPolicy` /
 * `changes.ambiguousPolicy`. Null for any other answer.
 */
export function dstResolutionRequired(error: ApiError | null): DstResolutionRequired | null {
  if (!error || error.code !== 'VALIDATION_FAILED') return null;
  const details = asRecord(error.details);
  if (!details || details.code !== 'dst_resolution_required') return null;
  const options = asRecord(details.options);
  return {
    nonexistentLocalDates: strings(details.nonexistentLocalDates),
    ambiguousLocalDates: strings(details.ambiguousLocalDates),
    nonexistentOptions: strings(options?.nonexistentPolicy).filter(
      (o): o is NonexistentPolicy => o === 'shift_forward' || o === 'skip',
    ),
    ambiguousOptions: strings(options?.ambiguousPolicy).filter(
      (o): o is AmbiguousPolicy => o === 'first' || o === 'second',
    ),
  };
}

/** The permission named by ACCESS_DENIED, e.g. `facilities.release_to_service`. */
export function missingPermission(error: ApiError | null): string | null {
  if (!error || error.code !== 'ACCESS_DENIED') return null;
  const action = asRecord(error.details)?.action;
  return typeof action === 'string' ? action : null;
}

/** Conflicts listed by a RESOURCE_CONFLICT answer to publication. */
export function conflictIssues(error: ApiError | null): ValidationIssue[] {
  if (!error || error.code !== 'RESOURCE_CONFLICT') return [];
  const issues = asRecord(error.details)?.issues;
  return Array.isArray(issues) ? (issues as ValidationIssue[]) : [];
}

export function conflictingEventIds(error: ApiError | null): string[] {
  if (!error || error.code !== 'RESOURCE_CONFLICT') return [];
  const ids = asRecord(error.details)?.conflictingEventIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export interface Obligation {
  code: string;
  message: string;
  owner: string | null;
  deadline: string | null;
}

/** Blocking fixture obligations returned when publication refuses an incomplete group (SPK-FIX-002). */
export function blockingObligations(error: ApiError | null): Obligation[] {
  if (!error || error.code !== 'VALIDATION_FAILED') return [];
  const list = asRecord(error.details)?.obligations;
  if (!Array.isArray(list)) return [];
  return list
    .map((o) => asRecord(o))
    .filter((o): o is Record<string, unknown> => o !== null)
    .map((o) => ({
      code: String(o.code ?? 'obligation'),
      message: String(o.message ?? ''),
      owner: typeof o.owner === 'string' ? o.owner : null,
      deadline: typeof o.deadline === 'string' ? o.deadline : null,
    }));
}

/** Why the release gate refused (R4-OPS-MODULES-03): the API's `details.cause`. */
export type InspectionCause =
  'not_inspected' | 'inspection_failed' | 'work_in_progress' | 'inspection_predates_current_work';

const INSPECTION_CAUSES: readonly InspectionCause[] = [
  'not_inspected',
  'inspection_failed',
  'work_in_progress',
  'inspection_predates_current_work',
];

/** ELIGIBILITY_FAILED with `inspection_required` (SPK-FAC-004 release gate). */
export function inspectionRequired(error: ApiError | null): {
  latestOutcome: string | null;
  inspectedAt: string | null;
  cause: InspectionCause | null;
  inspectionRequiredAfter: string | null;
} | null {
  if (!error || error.code !== 'ELIGIBILITY_FAILED') return null;
  const details = asRecord(error.details);
  if (details?.code !== 'inspection_required') return null;
  const latest = asRecord(details.latestInspection);
  const cause = INSPECTION_CAUSES.find((c) => c === details.cause) ?? null;
  return {
    latestOutcome: typeof latest?.outcome === 'string' ? latest.outcome : null,
    inspectedAt: typeof latest?.inspectedAt === 'string' ? latest.inspectedAt : null,
    cause,
    inspectionRequiredAfter:
      typeof details.inspectionRequiredAfter === 'string' ? details.inspectionRequiredAfter : null,
  };
}

/**
 * ELIGIBILITY_FAILED `restriction_release_required` from `PATCH /assets/{id}` (R4-OPS-MODULES-05):
 * an operating restriction names the asset, so only its release returns it to service.
 */
export function restrictionReleaseRequired(
  error: ApiError | null,
): { restrictionIds: string[] } | null {
  if (!error || error.code !== 'ELIGIBILITY_FAILED') return null;
  const details = asRecord(error.details);
  if (details?.code !== 'restriction_release_required') return null;
  const ids = Array.isArray(details.restrictionIds)
    ? details.restrictionIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { restrictionIds: ids };
}
