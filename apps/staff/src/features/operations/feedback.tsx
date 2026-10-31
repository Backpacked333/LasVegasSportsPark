/**
 * Command outcomes for the operations screens (SPK-UX-008, §4.9, §4.10):
 *
 * - ACCESS_DENIED and PARTICIPANT_AUTHORITY_REQUIRED: "Not available" with the API's safe message,
 *   so staff see which permission is missing; never retried.
 * - NOT_FOUND: "Not available" without implying that the record exists (§4.10, §4.14).
 * - No definite answer (`mayHaveTakenEffect`: a timeout, a connection lost after sending, the same
 *   key still running, a 5xx): "Outcome not known yet", never "Something went wrong"; "Try again"
 *   resends the same intent with the same idempotency key, so nothing is recorded twice. A changed
 *   input would be a new key, so the view says not to make it again as a new request.
 * - IDEMPOTENCY_OUTCOME_UNAVAILABLE, IDEMPOTENCY_SECRET_WITHHELD and a legacy-authority refusal:
 *   the shared views of `ui/CommandOutcome.tsx`.
 * - Anything else: the error code, safe message, correlation reference and the API's next action.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { sharedCommandOutcome } from '../../ui/CommandOutcome';
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
  const shared = sharedCommandOutcome(error, { onRetry, onReload });
  if (shared) return <div role="alert">{shared}</div>;
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
