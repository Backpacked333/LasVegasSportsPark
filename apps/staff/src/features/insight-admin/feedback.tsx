/**
 * Outcome and state presentation shared by SCR-S-43 to SCR-S-48 (SPK-UX-008, §4.9, §4.10):
 *
 * - permission restriction: ACCESS_DENIED is "Not available to you" with the API's safe message, so
 *   staff see which permission or scope is missing (inventory section 3); a protected NOT_FOUND is
 *   the plain "not available" and never implies the record exists (§4.10, §4.14);
 * - stale version (STALE_REVISION, INVALID_TRANSITION): "Reload" fetches the current record and the
 *   form keeps what was typed;
 * - no response: the outcome may be unknown and "Try again" resends the same intent with the same
 *   idempotency key, so it is never applied twice;
 * - validation: the code, the API's message and each field message the API sent;
 * - INTEGRATION_UNAVAILABLE: names the provider decision owner (§5.2, DEC-013);
 * - API gaps: a part of a screen the API cannot serve yet is "Not available yet", named, and kept
 *   apart from permission restrictions and from empty states.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { QueryBoundary, type QueryBoundaryProps } from '../../ui/QueryBoundary';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { DECISIONS } from './labels';

interface IssueDetail {
  path: string;
  message: string;
}

/** Field messages of a VALIDATION_FAILED answer (`details: [{ path, message }]`), by path. */
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

/** The machine-readable `details.code` some validation answers carry (e.g. `cost_inputs_required`). */
export function detailCodeOf(error: ApiError | null | undefined): string | null {
  const details = error?.details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const code = (details as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** Permission restriction for staff: says it is not available to them and why (§4.10 safe message). */
export function PermissionRestriction({
  error,
  description,
}: {
  error: ApiError;
  description?: string;
}) {
  if (error.isPermissionRestriction) {
    return (
      <StateView
        variant="unavailable"
        title="Not available to you"
        description={`${description ? `${description} ` : ''}${error.message}`}
      />
    );
  }
  return <StateView variant="unavailable" />;
}

export interface CommandErrorProps {
  error: ApiError | null | undefined;
  /** Resend the same intent (same idempotency key). */
  onRetry?: () => void;
  /** Reload the current record (stale version). */
  onReload?: () => void;
  /** Extra words for a permission restriction, e.g. that export is checked separately. */
  deniedDescription?: string;
}

export function CommandError({ error, onRetry, onReload, deniedDescription }: CommandErrorProps) {
  if (!error) return null;
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') {
    return <PermissionRestriction error={error} description={deniedDescription} />;
  }
  if (error.kind === 'timeout') {
    return (
      <section className="state" aria-live="polite" data-testid="state-outcome-unknown">
        <StatusBadge tone="warning" label="Outcome not known yet" />
        <p>
          No answer arrived, so this may already have been applied. Trying again sends the same
          request and is never applied twice.
        </p>
        <StateView variant="error" error={error} onRetry={onRetry} />
      </section>
    );
  }
  const fields = Object.entries(fieldErrorsOf(error));
  if (error.isStale && !onReload) {
    // No reload exists for this record here: the caller explains how to start again, so no
    // "Reload" label is printed that cannot be acted on (SPK-UX-008).
    return (
      <section className="state" aria-live="polite" data-testid="state-stale">
        <StatusBadge tone="warning" label="This record changed" />
        <p className="caption">
          Error code: {error.code}
          {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
        </p>
      </section>
    );
  }
  return (
    <div>
      <StateView
        variant="error"
        error={error}
        onRetry={onRetry}
        onAction={error.isStale ? onReload : undefined}
      />
      {error.code === 'INTEGRATION_UNAVAILABLE' ? (
        <p className="caption">
          A provider this depends on is unavailable. Owner: {DECISIONS.providers.owner} (
          {DECISIONS.providers.ids.join(', ')}).
        </p>
      ) : null}
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

/** A confirmed outcome naming the resulting state (journeys.md section 3 rule 4). */
export function CommandSuccess({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="status" className="ia-success">
      <StatusBadge tone="success" label={message} />
    </p>
  );
}

/** A part of a screen the API does not serve yet (reported as an API gap, not a permission). */
export function ApiGap({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="state ia-gap" aria-label={`${title}: not available yet`}>
      <StatusBadge tone="neutral" label="Not available yet" />
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  );
}

/** A value or behaviour that waits on an operator decision; names it and its owner, invents nothing. */
export function PendingNote({
  decisions,
  owner,
  children,
}: {
  decisions: readonly string[];
  owner: string;
  children: ReactNode;
}) {
  return (
    <div className="ia-pending" data-testid="pending-note">
      <StatusBadge tone="pending" label="Waiting on a decision" />
      <p className="caption">
        {children} Pending {decisions.join(', ')} (owner: {owner}).
      </p>
    </div>
  );
}

/**
 * QueryBoundary with the staff permission-restriction wording: ACCESS_DENIED shows the API's
 * message (which permission or scope is missing) instead of the generic "not available".
 */
export function InsightQueryBoundary<T>(
  props: QueryBoundaryProps<T> & { deniedDescription?: string },
) {
  const { deniedDescription, ...rest } = props;
  const error = rest.query.error;
  if (rest.query.data === undefined && error && error.isPermissionRestriction) {
    return <PermissionRestriction error={error} description={deniedDescription} />;
  }
  if (rest.query.data === undefined && error?.code === 'INTEGRATION_UNAVAILABLE') {
    return <CommandError error={error} onRetry={() => void rest.query.refetch()} />;
  }
  return <QueryBoundary {...rest} />;
}

/** Previous and next pages over an API cursor (§4.5): nothing is silently cut off. */
export function CursorPages({
  what,
  depth,
  nextCursor,
  onNext,
  onPrevious,
}: {
  what: string;
  depth: number;
  nextCursor: string | null;
  onNext: (cursor: string) => void;
  onPrevious: () => void;
}) {
  if (depth === 0 && !nextCursor) return null;
  return (
    <div className="ia-row-actions" role="group" aria-label={`Pages of ${what}`}>
      {depth > 0 ? (
        <Button variant="secondary" onClick={onPrevious}>
          Previous page
        </Button>
      ) : null}
      {nextCursor ? (
        <Button variant="secondary" onClick={() => onNext(nextCursor)}>
          Next page
        </Button>
      ) : null}
    </div>
  );
}
