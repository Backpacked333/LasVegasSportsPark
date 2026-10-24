/**
 * Reads the `details` of the §4.10 error contract for the schedule and facilities commands, as the
 * API sends them (apps/api/src/modules/scheduling and facilities services, kernel validation pipe):
 *
 * - VALIDATION_FAILED: an array of `{ path, message, code }` from request validation, or an object
 *   (`{ path }`, `{ obligations }` for unmet fixture obligations, `{ changeSequence }`).
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

/** ELIGIBILITY_FAILED with `inspection_required` (SPK-FAC-004 release gate). */
export function inspectionRequired(
  error: ApiError | null,
): { latestOutcome: string | null; inspectedAt: string | null } | null {
  if (!error || error.code !== 'ELIGIBILITY_FAILED') return null;
  const details = asRecord(error.details);
  if (details?.code !== 'inspection_required') return null;
  const latest = asRecord(details.latestInspection);
  return {
    latestOutcome: typeof latest?.outcome === 'string' ? latest.outcome : null,
    inspectedAt: typeof latest?.inspectedAt === 'string' ? latest.inspectedAt : null,
  };
}
