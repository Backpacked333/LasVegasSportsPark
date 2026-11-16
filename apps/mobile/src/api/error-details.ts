/**
 * Readers of an API error's `details` (§4.11 error envelope), shared by every failure view: the
 * eligibility reasons of ELIGIBILITY_FAILED (SPK-READY-003, SPK-CAP-004), the field issues of the
 * API's request validation (VALIDATION_FAILED), and the rule code a refusal names in
 * `details.code` (CMP-13). Each reader accepts whatever the API sent and keeps only what is well
 * formed, so a failure view never breaks on an unexpected body (SPK-UX-008).
 *
 * Moved here from the teams feature folder (ADR-008, Phase 3 of the customer app redesign).
 */
import type { ApiError, Schema } from '@sportspark/api-client';

/** One eligibility or readiness reason, as a failure view shows it. */
export type EligibilityReason = Pick<
  Schema<'EligibilityReason'>,
  'code' | 'severity' | 'message' | 'responsibleRole' | 'requiredAction'
>;

const SEVERITIES = ['blocking', 'warning', 'info', 'unknown'] as const;

function isReason(value: unknown): value is EligibilityReason {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string';
}

/**
 * `details.reasons` of an ELIGIBILITY_FAILED answer, when the API sent them. An unknown severity
 * reads as `unknown`, a missing responsible role as the league manager, a missing action as "".
 */
export function eligibilityReasonsOf(error: ApiError): EligibilityReason[] {
  const details = error.details as { reasons?: unknown } | undefined;
  if (!details || !Array.isArray(details.reasons)) return [];
  return details.reasons.filter(isReason).map((r) => ({
    code: r.code,
    severity: (SEVERITIES as readonly unknown[]).includes(r.severity) ? r.severity : 'unknown',
    message: r.message,
    responsibleRole: typeof r.responsibleRole === 'string' ? r.responsibleRole : 'league_manager',
    requiredAction: typeof r.requiredAction === 'string' ? r.requiredAction : '',
  }));
}

/** Field issues of a VALIDATION_FAILED answer from the API's request validation ("path: message"). */
export function fieldIssuesOf(error: ApiError): string[] {
  if (!Array.isArray(error.details)) return [];
  return error.details
    .filter(
      (d): d is { path: string; message: string } =>
        !!d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string',
    )
    .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message));
}

/**
 * The rule code of a refusal whose `details` is an object with a `code` (for example the handover
 * rules ROLE_NOT_HELD or CAPTAIN_MUST_BE_ADULT under VALIDATION_FAILED, CMP-13), or null. Only an
 * identifier-like code is returned, so the view never shows arbitrary text as a code.
 */
export function detailCodeOf(error: ApiError): string | null {
  const details = error.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : null;
}
