/**
 * How a registration or finance command's failure is shown (SPK-UX-008, §4.9, §4.10). The words
 * follow the API's code and `nextAction`; the client never guesses an outcome:
 *
 * - permission restriction: ACCESS_DENIED is "not available to you", naming the permission the API
 *   reported (`details.action`) so staff see what is missing; a protected NOT_FOUND only says the
 *   record is not available and never implies that it exists (§4.10, §4.14);
 * - stale version (STALE_REVISION, INVALID_TRANSITION): "Reload" fetches the current record and
 *   the form keeps what was typed;
 * - no answer (timeout, lost connection): the outcome may be unknown; "Try again" resends the same
 *   intent with the same idempotency key, so the effect is never applied twice;
 * - recovery required: PAYMENT_OUTCOME_UNKNOWN says not to take payment again and links to the
 *   attempt to reconcile (SPK-PAY-007); REFUND_PENDING says the reserved amount stays held until
 *   the refund is reconciled (SPK-PAY-008, SPK-AT-007);
 * - validation: every field message, or the publication problem report (SPK-CAT-004);
 * - anything else: code, safe message, correlation reference and the API's recovery action.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import { Link } from 'react-router';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatMoney, humanize } from './format';
import { severityBadge } from './labels';

export interface FieldIssue {
  path: string;
  message: string;
}

export interface PublicationProblem {
  code: string;
  field: string;
  message: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Field messages of a VALIDATION_FAILED answer (`details: [{ path, message }]`). */
export function fieldIssuesOf(error: ApiError | null | undefined): FieldIssue[] {
  if (!error || error.code !== 'VALIDATION_FAILED' || !Array.isArray(error.details)) return [];
  return (error.details as unknown[]).flatMap((item) => {
    const r = record(item);
    return r && typeof r.path === 'string' && typeof r.message === 'string'
      ? [{ path: r.path, message: r.message }]
      : [];
  });
}

/** The first field message for each path, for inline field errors. */
export function fieldErrorsOf(error: ApiError | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of fieldIssuesOf(error))
    if (!(issue.path in out)) out[issue.path] = issue.message;
  return out;
}

/** The SPK-CAT-004 publication report (`details.problems`) of a refused publication. */
export function publicationProblemsOf(error: ApiError | null | undefined): PublicationProblem[] {
  if (!error || error.code !== 'VALIDATION_FAILED') return [];
  const problems = record(error.details)?.problems;
  if (!Array.isArray(problems)) return [];
  return problems.flatMap((item) => {
    const r = record(item);
    return r &&
      typeof r.code === 'string' &&
      typeof r.field === 'string' &&
      typeof r.message === 'string'
      ? [{ code: r.code, field: r.field, message: r.message }]
      : [];
  });
}

interface EligibilityReason {
  code: string;
  severity: string;
  message: string;
  requiredAction?: string;
}

function reasonsOf(error: ApiError): EligibilityReason[] {
  const reasons = record(error.details)?.reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.flatMap((item) => {
    const r = record(item);
    return r && typeof r.code === 'string' && typeof r.message === 'string'
      ? [
          {
            code: r.code,
            severity: typeof r.severity === 'string' ? r.severity : 'unknown',
            message: r.message,
            requiredAction: typeof r.requiredAction === 'string' ? r.requiredAction : undefined,
          },
        ]
      : [];
  });
}

function detailString(error: ApiError, key: string): string | null {
  const value = record(error.details)?.[key];
  return typeof value === 'string' ? value : null;
}

function detailNumber(error: ApiError, key: string): number | null {
  const value = record(error.details)?.[key];
  return typeof value === 'number' ? value : null;
}

export interface CommandErrorProps {
  error: ApiError | null | undefined;
  /** Resend the same intent (same idempotency key). */
  onRetry?: () => void;
  /** Reload the current record (stale version, capacity changed). */
  onReload?: () => void;
  /** QUOTE_EXPIRED: ask for a new quote. */
  onRequote?: () => void;
  /** Currency for amounts the API reports in `details` (refundable, reserved). */
  currency?: string | null;
}

function Reference({ error }: { error: ApiError }) {
  return (
    <p className="caption">
      Error code: {error.code}
      {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
    </p>
  );
}

export function CommandError({ error, onRetry, onReload, onRequote, currency }: CommandErrorProps) {
  if (!error) return null;
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') {
    if (error.isPermissionRestriction) {
      const action = detailString(error, 'action');
      return (
        <StateView
          variant="unavailable"
          title="Not available to you"
          description={
            action
              ? `Your account does not have the permission ${action} for this record. Ask an administrator if you need it.`
              : `Your account is not permitted to do this here. ${error.message}`
          }
        />
      );
    }
    return <StateView variant="unavailable" />;
  }
  if (error.isStale) {
    return (
      <section className="state" aria-live="polite" data-testid="state-stale">
        <StatusBadge tone="warning" label="This record changed since it was loaded" />
        <p>
          {error.message} What you entered is kept. Reload, check the current state, then decide
          again.
        </p>
        <Reference error={error} />
        {onReload ? <Button onClick={onReload}>Reload</Button> : null}
      </section>
    );
  }
  if (error.code === 'CAPACITY_UNAVAILABLE') {
    return (
      <section className="state" aria-live="polite" data-testid="state-stale">
        <StatusBadge tone="warning" label="Capacity changed or is not available" />
        <p>
          {error.message} Nothing was committed. Reload to see current capacity, then preview again.
        </p>
        <Reference error={error} />
        {onReload ? <Button onClick={onReload}>Reload</Button> : null}
      </section>
    );
  }
  if (error.code === 'PAYMENT_OUTCOME_UNKNOWN') {
    const attempt = detailString(error, 'paymentAttemptId');
    return (
      <section className="state" aria-live="polite" data-testid="state-recovery">
        <StatusBadge tone="warning" label="Recovery required: payment outcome unknown" />
        <p>
          The outcome of an earlier payment is not known yet. Do not take payment again: reconcile
          the attempt from the provider&apos;s evidence first (SPK-PAY-007).
        </p>
        <Reference error={error} />
        {attempt ? (
          <Link to={`/finance/payments/${attempt}`}>Open the payment attempt to reconcile it</Link>
        ) : (
          <Link to="/finance/payments">Open unknown payment outcomes</Link>
        )}
      </section>
    );
  }
  if (error.code === 'REFUND_PENDING') {
    const refund = detailString(error, 'refundAttemptId');
    const available = detailNumber(error, 'availableMinor');
    const reserved = detailNumber(error, 'reservedMinor');
    return (
      <section className="state" aria-live="polite" data-testid="state-recovery">
        <StatusBadge tone="warning" label="Recovery required: a refund is pending" />
        <p>
          A refund already reserves these funds. The reservation stays until that refund is
          reconciled, so the same money is never refunded twice (SPK-PAY-008).
        </p>
        {reserved !== null ? (
          <p>
            Reserved by pending refunds: {formatMoney(reserved, currency)}. Still available:{' '}
            {formatMoney(available, currency)}.
          </p>
        ) : null}
        <Reference error={error} />
        {refund ? <Link to={`/finance/refunds/${refund}`}>Open the pending refund</Link> : null}
      </section>
    );
  }
  if (error.code === 'QUOTE_EXPIRED') {
    return (
      <section className="state" aria-live="polite" data-testid="state-stale">
        <StatusBadge tone="warning" label="Quote expired" />
        <p>The price is no longer valid. Get a new quote; nothing was charged.</p>
        <Reference error={error} />
        {onRequote ? <Button onClick={onRequote}>Get a new price</Button> : null}
      </section>
    );
  }
  if (
    error.code === 'RESOURCE_CONFLICT' &&
    detailString(error, 'code') === 'REFUND_EXCEEDS_REFUNDABLE'
  ) {
    return (
      <section className="state" aria-live="polite" data-testid="state-validation">
        <StatusBadge tone="danger" label="The refund exceeds the refundable amount" />
        <p>
          Available to refund: {formatMoney(detailNumber(error, 'availableMinor'), currency)}.
          Captured: {formatMoney(detailNumber(error, 'capturedMinor'), currency)}. Already refunded:{' '}
          {formatMoney(detailNumber(error, 'refundedMinor'), currency)}.
        </p>
        <Reference error={error} />
      </section>
    );
  }
  if (error.isOffline) {
    return (
      <section className="state" aria-live="polite" data-testid="state-offline">
        <StatusBadge
          tone="warning"
          label={error.kind === 'timeout' ? 'No answer: the outcome is unknown' : 'No connection'}
        />
        <p>
          {error.kind === 'timeout'
            ? 'The service did not answer in time, so this may already have taken effect. Try again sends the same request with the same key, so it is never applied twice.'
            : 'The request did not reach the service. Nothing changed. What you entered is kept.'}
        </p>
        <Reference error={error} />
        {onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
      </section>
    );
  }
  const issues = fieldIssuesOf(error);
  const problems = publicationProblemsOf(error);
  const reasons = reasonsOf(error);
  if (issues.length > 0 || problems.length > 0 || reasons.length > 0) {
    return (
      <section className="state" aria-live="polite" data-testid="state-validation">
        <StatusBadge tone="danger" label={humanize(error.code)} />
        <p>{error.message} Nothing was changed. Correct the entries and submit again.</p>
        {issues.length > 0 ? (
          <ul aria-label="Field problems">
            {issues.map((issue, i) => (
              <li key={`${issue.path}-${i}`}>
                {issue.path ? `${issue.path}: ` : ''}
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {problems.length > 0 ? (
          <ul aria-label="Publication problems">
            {problems.map((problem, i) => (
              <li key={`${problem.code}-${i}`}>
                {problem.message} <span className="caption">({humanize(problem.code)})</span>
              </li>
            ))}
          </ul>
        ) : null}
        {reasons.length > 0 ? (
          <ul aria-label="Eligibility reasons">
            {reasons.map((reason, i) => (
              <li key={`${reason.code}-${i}`}>
                <StatusBadge {...severityBadge(reason.severity)} /> {reason.message}
                {reason.requiredAction
                  ? ` Required action: ${humanize(reason.requiredAction)}.`
                  : ''}
              </li>
            ))}
          </ul>
        ) : null}
        <Reference error={error} />
      </section>
    );
  }
  return <StateView variant="error" error={error} onRetry={onRetry} onAction={onReload} />;
}
