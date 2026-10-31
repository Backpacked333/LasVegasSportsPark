/**
 * How a staff command's outcome is shown (SPK-UX-008, §4.9, §4.10):
 *
 * - permission restriction: ACCESS_DENIED says it is not available to you, with the API's message so
 *   staff see which scope or permission is missing; a protected NOT_FOUND never says the record exists;
 * - stale version (STALE_REVISION, INVALID_TRANSITION): "Reload" fetches the current record and the
 *   form keeps what was typed;
 * - no connection or no response: the outcome may be unknown, and "Try again" resends the same
 *   intent with the same idempotency key, so it is never applied twice;
 * - validation: the code, the API's message and each field message;
 * - success: the resulting state in the machine's words, announced politely.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { StateView } from './StateView';
import { StatusBadge } from './StatusBadge';

interface IssueDetail {
  path: string;
  message: string;
}

/** Field messages from a VALIDATION_FAILED answer (`details: [{ path, message }]`), by path. */
export function fieldErrorsOf(error: ApiError | null | undefined): Record<string, string> {
  if (!error || error.code !== 'VALIDATION_FAILED' || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const item of error.details as unknown[]) {
    if (item && typeof item === 'object') {
      const { path, message } = item as Partial<IssueDetail>;
      if (typeof path === 'string' && typeof message === 'string' && !(path in out)) {
        out[path] = message;
      }
    }
  }
  return out;
}

export interface CommandErrorProps {
  error: ApiError | null | undefined;
  /** Resend the same intent (same idempotency key). */
  onRetry?: () => void;
  /** Reload the current record (stale version). */
  onReload?: () => void;
}

export function CommandError({ error, onRetry, onReload }: CommandErrorProps) {
  if (!error) return null;
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') {
    if (error.isPermissionRestriction) {
      return (
        <StateView
          variant="unavailable"
          title="Not available to you"
          description={`You are not permitted to do this here. ${error.message}`}
        />
      );
    }
    return <StateView variant="unavailable" />;
  }
  if (error.outcomeUnknown && error.kind === 'timeout') {
    return (
      <section className="state" aria-live="polite" data-testid="state-outcome-unknown">
        <StatusBadge tone="warning" label="Outcome not known yet" />
        <p>
          No answer arrived, so this may already have been applied. Trying again sends the same
          request and is never applied twice.
        </p>
        {onRetry ? <StateView variant="error" error={error} onRetry={onRetry} /> : null}
      </section>
    );
  }
  const fields = Object.entries(fieldErrorsOf(error));
  return (
    <div>
      <StateView
        variant="error"
        error={error}
        onRetry={onRetry}
        onAction={error.isStale ? onReload : undefined}
      />
      {fields.length > 0 ? (
        <ul className="caption" aria-label="Fields to correct">
          {fields.map(([path, message]) => (
            <li key={path}>
              {path || 'request'}: {message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A confirmed outcome, naming the resulting state (journeys.md section 3 rule 4). */
export function CommandSuccess({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="success-text">
      <StatusBadge tone="success" label={message} />
    </p>
  );
}
