/**
 * How a failed command is shown on the schedule and facilities screens (SPK-UX-008, §4.10):
 *
 * - ACCESS_DENIED: "Not available to you", naming the missing permission (staff see which one);
 *   protected NOT_FOUND: "not available" without implying the record exists.
 * - No answer (timeout): the change may have been made; "Try again" repeats the same intent with
 *   the same idempotency key, so it can never apply twice (§4.9).
 * - Validation failure: the field messages the API returned; the user's input stays in the form.
 * - Anything else: code, safe message, correlation reference and the API's recovery action
 *   (`Reload` for STALE_REVISION and INVALID_TRANSITION).
 */
import type { ApiError } from '@sportspark/api-client';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
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
  if (error.kind === 'timeout') {
    return (
      <section className="state" aria-live="polite" data-testid="state-outcome-unknown">
        <StatusBadge tone="warning" label="Outcome unknown" />
        <p>
          No answer arrived in time, so the change may or may not have been made. Trying again sends
          the same request, which the service will not apply twice.
        </p>
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      </section>
    );
  }
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
