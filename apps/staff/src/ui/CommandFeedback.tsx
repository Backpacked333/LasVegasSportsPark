/**
 * How a staff command's outcome is shown (SPK-UX-008, §4.9, §4.10):
 *
 * - permission restriction: ACCESS_DENIED says it is not available to you, with the API's message so
 *   staff see which scope or permission is missing; a protected NOT_FOUND never says the record exists;
 * - stale version (STALE_REVISION, INVALID_TRANSITION): "Reload" fetches the current record and the
 *   form keeps what was typed;
 * - no definite answer (`mayHaveTakenEffect`: a timeout, a connection lost after sending, the same
 *   key still running, a 5xx): "Outcome not known yet", never "Something went wrong"; "Try again"
 *   resends the same intent with the same idempotency key, so it is never applied twice;
 * - IDEMPOTENCY_OUTCOME_UNAVAILABLE: "This may already have been done" with "Reload";
 *   IDEMPOTENCY_SECRET_WITHHELD: created, but its one-time secret cannot be shown again; a
 *   legacy-authority refusal: make the change in the system of record (`CommandOutcome.tsx`);
 * - validation: the code, the API's message and each field message;
 * - success: the resulting state in the machine's words, announced politely.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { sharedCommandOutcome } from './CommandOutcome';
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
  const shared = sharedCommandOutcome(error, { onRetry, onReload });
  if (shared) return shared;
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
