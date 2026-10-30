/**
 * A refused or unanswered Package G command (SCR-S-51 to SCR-S-54; SPK-UX-008, §4.9, §4.10):
 * `CommandError` (not available, outcome unknown with "Try again" on the same idempotency key,
 * the code and reference, field messages, "Reload" for a stale version, "turned off" for
 * CAPABILITY_DISABLED), plus what these commands add:
 *
 * - No answer (a timeout, or the connection lost while the request was in flight; these commands
 *   are not sent while offline, so a network failure here happened after sending): "Outcome not
 *   known yet", never a failure, with "Try again" resending the same intent with the same
 *   idempotency key and body, so it is never applied twice (§4.9, SPK-PAY-007).
 * - RESOURCE_CONFLICT: the API's `details.code` in words when one is known, the conflicting
 *   occurrences it lists, and a "Reload" that reads the record again (a booking whose slot was
 *   taken before approval stays requested; nothing was written).
 * - ELIGIBILITY_FAILED: each reason the API gave, never a client verdict.
 */
import type { ApiError } from '@sportspark/api-client';
import { CommandError } from '../../../ui/CommandFeedback';
import { Button } from '../../../ui/Button';
import { StatusBadge } from '../../../ui/StatusBadge';
import { formatInstant } from './format';

/** Wording for the `details.code` values these commands answer RESOURCE_CONFLICT with. */
export const CONFLICT_WORDS: Readonly<Record<string, string>> = {
  BOOKING_TERMS_REQUIRED: 'This offering has no approved booking terms, so it cannot be booked.',
  BOOKING_DEFINITION_INVALID: 'What this offering reserves cannot be read, so nothing was booked.',
  EQUIPMENT_UNAVAILABLE: 'Equipment this booking needs is not available.',
  BASKET_NOT_EMPTY: 'A booking is paid in a basket of its own.',
  CHECKOUT_IN_PROGRESS:
    'A checkout of this booking is in progress and a payment may be on its way, so nothing was canceled. Reload to see how the checkout ended.',
  CONSEQUENCE_ACCEPTANCE_REQUIRED:
    'The customer must accept the financial consequence before the cancellation is committed.',
  CONSEQUENCE_CHANGED:
    'The financial consequence changed since it was previewed. Preview it again and confirm the customer accepts it.',
  SUSPENSION_OVERLAP: 'The membership is already suspended in that period.',
  REDEMPTION_ALREADY_REVERSED: 'This redemption was already reversed; its credit is back.',
  PACKAGE_CREDITS_EXHAUSTED: 'This package has no credit left (another booking may have used it).',
  PACKAGE_NOT_REDEEMABLE: 'This package can no longer be redeemed.',
  MEMBERSHIP_NOT_ACTIVE: 'This membership is not active.',
  MEMBERSHIP_BENEFIT_UNKNOWN:
    'What this membership includes cannot be read, so nothing was booked.',
  MEMBERSHIP_INCLUDES_NO_SESSIONS: 'This membership includes no sessions.',
  MEMBERSHIP_SESSIONS_USED: 'The membership has used every session it includes for this period.',
  OUTSIDE_MEMBERSHIP_TERM: 'The session is outside the membership term.',
  MEMBERSHIP_SUSPENDED: 'The membership is suspended at that time.',
};

interface ConflictItem {
  occurrenceStart?: unknown;
  resourceId?: unknown;
}

function detailsOf(error: ApiError): Record<string, unknown> {
  return error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? (error.details as Record<string, unknown>)
    : {};
}

/** The API's `details.code`, when it sent one. */
export function detailCode(error: ApiError | null | undefined): string | null {
  if (!error) return null;
  const code = detailsOf(error).code;
  return typeof code === 'string' ? code : null;
}

/**
 * The field a VALIDATION_FAILED answer names: the request validator's `[{ path, message }]` list
 * (first entry) or a service's `{ path }` object. Null for any other answer.
 */
export function validationPath(error: ApiError | null | undefined): string | null {
  if (!error || error.code !== 'VALIDATION_FAILED') return null;
  if (Array.isArray(error.details)) {
    const first = error.details[0] as { path?: unknown } | undefined;
    return typeof first?.path === 'string' ? first.path : null;
  }
  const path = detailsOf(error).path;
  return typeof path === 'string' ? path : null;
}

function conflictsOf(error: ApiError): { start: string | null; resourceId: string | null }[] {
  const list = detailsOf(error).conflicts;
  if (!Array.isArray(list)) return [];
  return (list as ConflictItem[]).map((c) => ({
    start: typeof c?.occurrenceStart === 'string' ? c.occurrenceStart : null,
    resourceId: typeof c?.resourceId === 'string' ? c.resourceId : null,
  }));
}

function reasonsOf(error: ApiError): string[] {
  const list = detailsOf(error).reasons;
  if (!Array.isArray(list)) return [];
  return list
    .map((r) =>
      r && typeof r === 'object' && typeof (r as { message?: unknown }).message === 'string'
        ? (r as { message: string }).message
        : null,
    )
    .filter((m): m is string => m !== null);
}

export function CommandProblem({
  error,
  onRetry,
  onReload,
  reloadLabel = 'Reload',
  timeZone,
  resourceLabel,
}: {
  error: ApiError | null | undefined;
  /** Resend the same intent (same idempotency key) after no answer. */
  onRetry?: () => void;
  /** Read the record again (stale version or conflict). */
  onReload?: () => void;
  reloadLabel?: string;
  /** Zone the conflicting occurrences are shown in. */
  timeZone?: string | null;
  /** Names a conflicting resource id. */
  resourceLabel?: (resourceId: string) => string;
}) {
  if (!error) return null;
  if (error.isOffline) {
    return (
      <div data-testid="command-problem">
        <section className="state" aria-live="polite" data-testid="state-outcome-unknown">
          <StatusBadge tone="warning" label="Outcome not known yet" />
          <p>
            {error.kind === 'timeout'
              ? 'No answer arrived in time, so this may or may not have been applied.'
              : 'The connection was lost before an answer arrived, so this may or may not have been applied.'}{' '}
            Trying again sends the same request and is never applied twice.
          </p>
          <p className="caption">Error code: {error.code}</p>
          {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
        </section>
      </div>
    );
  }
  const code = detailCode(error);
  const conflict = error.code === 'RESOURCE_CONFLICT';
  const conflicts = conflict ? conflictsOf(error) : [];
  const reasons = error.code === 'ELIGIBILITY_FAILED' ? reasonsOf(error) : [];
  return (
    <div data-testid="command-problem">
      <CommandError error={error} onRetry={onRetry} onReload={onReload} />
      {code && CONFLICT_WORDS[code] && CONFLICT_WORDS[code] !== error.message ? (
        <p>{CONFLICT_WORDS[code]}</p>
      ) : null}
      {conflicts.length > 0 ? (
        <ul aria-label="Conflicting times" className="caption">
          {conflicts.map((c, index) => (
            <li key={index}>
              {c.start ? formatInstant(c.start, timeZone) : 'An occurrence'}
              {c.resourceId
                ? `: ${resourceLabel ? resourceLabel(c.resourceId) : `resource ${c.resourceId.slice(0, 8)}`} is not free`
                : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {reasons.length > 0 ? (
        <ul aria-label="Eligibility reasons">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
      {conflict && onReload ? (
        <Button variant="secondary" onClick={onReload}>
          {reloadLabel}
        </Button>
      ) : null}
    </div>
  );
}
