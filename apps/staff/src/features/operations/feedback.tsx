/**
 * Command outcomes for the operations screens (SPK-UX-008, §4.9, §4.10):
 *
 * - ACCESS_DENIED and PARTICIPANT_AUTHORITY_REQUIRED: "Not available" with the API's safe message,
 *   so staff see which permission is missing; never retried.
 * - NOT_FOUND: "Not available" without implying that the record exists (§4.10, §4.14).
 * - No response (timeout): the outcome is unknown; "Try again" resends the same intent with the
 *   same idempotency key, so nothing is recorded twice.
 * - Anything else: the error code, safe message, correlation reference and the API's next action.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';

export function CommandError({
  error,
  onRetry,
  onReload,
  subject,
}: {
  error: ApiError;
  /** Resend the same intent (same key). */
  onRetry?: () => void;
  /** Reload the current record (STALE_REVISION, INVALID_TRANSITION). */
  onReload?: () => void;
  /** What the command was about, e.g. "This release". */
  subject?: string;
}) {
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') {
    return (
      <div role="alert" data-testid="command-unavailable">
        <StateView
          variant="unavailable"
          description={
            error.isNotFound
              ? `${subject ?? 'This'} is not available. Check the reference, or ask an administrator if you expected to see it.`
              : `${error.message} Ask an administrator if you need this permission.`
          }
        />
        <p className="caption">Error code: {error.code}</p>
      </div>
    );
  }
  if (error.outcomeUnknown) {
    return (
      <div role="alert" className="state" data-testid="command-unknown">
        <StatusBadge tone="warning" label="Outcome not known yet" />
        <p>
          No response arrived, so it is not known whether this was recorded. Try again sends the
          same request; it is never recorded twice.
        </p>
        <p className="caption">Error code: {error.code}</p>
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      </div>
    );
  }
  return (
    <div role="alert">
      <StateView variant="error" error={error} onRetry={onRetry} onAction={onReload} />
    </div>
  );
}

/** A confirmed outcome named in the journeys.md section 3 vocabulary, never a generic "done". */
export function CommandSuccess({
  label,
  tone = 'success',
  children,
}: {
  label: string;
  tone?: StatusTone;
  children?: ReactNode;
}) {
  return (
    <div className="ops-outcome" role="status" data-testid="command-success">
      <StatusBadge tone={tone} label={label} />
      {children}
    </div>
  );
}

/** A screen that needs a facility when the viewer works across several (§4.3). */
export function ChooseFacility({ purpose }: { purpose: string }) {
  return (
    <StateView
      variant="empty"
      title="Choose a facility"
      description={`Choose a facility in the header to ${purpose}.`}
    />
  );
}
