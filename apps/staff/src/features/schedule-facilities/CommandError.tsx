/**
 * How a failed command is shown on the schedule and facilities screens (SPK-UX-008, §4.10):
 *
 * - ACCESS_DENIED: "Not available to you", naming the missing permission (staff see which one);
 *   protected NOT_FOUND: "not available" without implying the record exists.
 * - No definite answer (`mayHaveTakenEffect`: a timeout, the connection dropped while the request
 *   was out, the same key still running, a 5xx): the change may have been made; "Try again"
 *   repeats the same intent with the same idempotency key, so it can never apply twice (§4.9).
 *   Commands cannot be sent while offline, so a network failure here happened in flight and is
 *   never reported as "not sent". IDEMPOTENCY_OUTCOME_UNAVAILABLE and a legacy-authority refusal
 *   use the shared views of `ui/CommandOutcome.tsx`.
 * - Validation failure: the field messages the API returned; the user's input stays in the form.
 * - Anything else: code, safe message, correlation reference and the API's recovery action
 *   (`Reload` for STALE_REVISION and INVALID_TRANSITION).
 */
import type { ApiError } from '@sportspark/api-client';
import { sharedCommandOutcome } from '../../ui/CommandOutcome';
import { StateView } from '../../ui/StateView';
import { fieldIssues, missingPermission } from './error-details';

export interface CommandErrorProps {
  error: ApiError;
  /** Repeat the same intent (same key). */
  onRetry?: () => void;
  /** Reload the current record (stale version, invalid transition). */
  onReload?: () => void;
  /** What the user was doing, e.g. "Publishing the draft". */
  action?: string;
}

export function CommandError({ error, onRetry, onReload, action }: CommandErrorProps) {
  if (error.isPermissionRestriction) {
    const permission = missingPermission(error);
    return (
      <StateView
        variant="unavailable"
        title="Not available to you"
        description={`${action ? `${action} is not available to you. ` : ''}Your role does not include ${
          permission ? `the permission ${permission}` : 'this action'
        }. Ask an administrator if you need it.`}
      />
    );
  }
  if (error.isNotFound) {
    return (
      <StateView
        variant="unavailable"
        description="This record is not available. It may have been removed, or it is outside your facility scope."
        actionLabel={onReload ? 'Reload' : undefined}
        onAction={onReload}
      />
    );
  }
  const shared = sharedCommandOutcome(error, { onRetry, onReload });
  if (shared) return shared;
  const fields = fieldIssues(error);
  return (
    <div>
      {fields.length > 0 ? (
        <ul className="field-issues" aria-label="Problems to correct">
          {fields.map((f, i) => (
            <li key={`${f.path}-${i}`} className="error-text">
              {f.path ? `${f.path}: ` : ''}
              {f.message}
            </li>
          ))}
        </ul>
      ) : null}
      <StateView variant="error" error={error} onRetry={onRetry} onAction={onReload} />
    </div>
  );
}
