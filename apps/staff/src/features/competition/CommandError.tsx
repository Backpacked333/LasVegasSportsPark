/**
 * How a competition command's failure is shown (SPK-UX-008, §4.9, §4.10):
 *
 * - permission restriction: ACCESS_DENIED says the action is not available to this account, with
 *   the API's message so staff see which permission is missing; a protected NOT_FOUND only says the
 *   record is not available and never implies that it exists;
 * - stale version (STALE_REVISION, INVALID_TRANSITION): "Reload" fetches the current record; the
 *   form keeps what was typed;
 * - no connection or no response: the outcome may be unknown, and "Try again" resends the same
 *   intent with the same idempotency key, so the effect is never applied twice;
 * - validation and eligibility: the code, the API's message, and each field message or reason;
 * - anything else: code, safe message, correlation reference and the API's recovery action.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { ISSUE_SEVERITY, humanizeCode } from './labels';

interface FieldIssue {
  path: string;
  message: string;
}

/** Field messages of a VALIDATION_FAILED answer (`details: [{ path, message }]`), by path. */
export function fieldErrorsOf(error: ApiError | null | undefined): Record<string, string> {
  if (!error || error.code !== 'VALIDATION_FAILED' || !Array.isArray(error.details)) return {};
  const out: Record<string, string> = {};
  for (const item of error.details as unknown[]) {
    if (item && typeof item === 'object') {
      const { path, message } = item as Partial<FieldIssue>;
      if (typeof path === 'string' && typeof message === 'string' && !(path in out)) {
        out[path] = message;
      }
    }
  }
  return out;
}

export interface ReasonDetail {
  code: string;
  severity: 'blocking' | 'warning' | 'info' | 'unknown';
  message: string;
  responsibleRole?: string;
  requiredAction?: string;
}

/** Explainable reasons carried by ELIGIBILITY_FAILED (`details.reasons`), when present. */
export function reasonsOf(error: ApiError | null | undefined): ReasonDetail[] {
  if (!error || !error.details || typeof error.details !== 'object') return [];
  const reasons = (error.details as { reasons?: unknown }).reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.filter(
    (r): r is ReasonDetail =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as ReasonDetail).code === 'string' &&
      typeof (r as ReasonDetail).message === 'string' &&
      (r as ReasonDetail).severity in ISSUE_SEVERITY,
  );
}

export function ReasonList({
  reasons,
  label,
}: {
  reasons: readonly ReasonDetail[];
  label: string;
}) {
  if (reasons.length === 0) return null;
  return (
    <ul className="list" aria-label={label}>
      {reasons.map((reason, index) => {
        const badge = ISSUE_SEVERITY[reason.severity];
        return (
          <li key={`${reason.code}-${index}`}>
            <div className="row-text">
              <StatusBadge tone={badge.tone} label={badge.label} />
              <span>{reason.message}</span>
              <span className="caption">Code: {humanizeCode(reason.code)}</span>
              {reason.responsibleRole ? (
                <span className="caption">
                  Resolved by: {humanizeCode(reason.responsibleRole)}
                  {reason.requiredAction ? `. Required action: ${reason.requiredAction}` : ''}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
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
          description={`Your account is not permitted to do this here. ${error.message}`}
        />
      );
    }
    return <StateView variant="unavailable" />;
  }
  if (error.isStale) {
    return (
      <section className="state" aria-live="polite" data-testid="state-stale">
        <StatusBadge tone="warning" label="This record changed" />
        <p>
          Someone else changed this record since it was loaded. Reload to see the current version;
          what you typed is kept.
        </p>
        <p className="caption">
          Error code: {error.code}
          {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
        </p>
        {onReload ? <Button onClick={onReload}>Reload</Button> : null}
      </section>
    );
  }
  if (error.isOffline) {
    return (
      <section className="state" aria-live="polite" data-testid="state-outcome-unknown">
        {/* Commands are not sent while offline (CommandButton), so a network failure here
            happened in flight: the outcome is unknown, never "not sent" (§4.9). */}
        <StatusBadge tone="warning" label="Outcome not known yet" />
        <p>
          {error.kind === 'timeout'
            ? 'No answer arrived in time, so the change may or may not have been made. Trying again is safe: it cannot be applied twice.'
            : 'The connection was lost before an answer arrived; the change may or may not have been made. Trying again is safe: it cannot be applied twice.'}
        </p>
        <p className="caption">Error code: {error.code}</p>
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      </section>
    );
  }
  if (error.code === 'VALIDATION_FAILED' || error.code === 'ELIGIBILITY_FAILED') {
    const fields = Object.entries(fieldErrorsOf(error));
    const reasons = reasonsOf(error);
    return (
      <section className="state" aria-live="polite" data-testid="state-validation">
        <StatusBadge
          tone="danger"
          label={error.code === 'ELIGIBILITY_FAILED' ? 'Not eligible' : 'Check your entries'}
        />
        <p>{error.message}</p>
        {fields.length > 0 ? (
          <ul aria-label="Field problems">
            {fields.map(([path, message]) => (
              <li key={path}>
                {path ? `${path}: ` : ''}
                {message}
              </li>
            ))}
          </ul>
        ) : null}
        <ReasonList reasons={reasons} label="Eligibility reasons" />
        <p className="caption">
          Error code: {error.code}
          {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
        </p>
      </section>
    );
  }
  return <StateView variant="error" error={error} onRetry={onRetry} onAction={onReload} />;
}
