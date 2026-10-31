/**
 * What a staff command's failure says about its effect, shown the same way on every screen
 * (§4.9, §4.14, SPK-PAY-007, SPK-UX-008). Every command failure view of the dashboard
 * (`ui/CommandFeedback`, the area `CommandError`s and `feedback.tsx` files) renders these first,
 * deciding with the shared predicates of `@sportspark/api-client` (`outcome.ts`) only:
 *
 * - `OutcomeUnknown` (`mayHaveTakenEffect`): no definite answer. A lost connection is one of them:
 *   commands are not sent while the dashboard is offline, so a network failure happened after the
 *   request left, and the client cannot tell whether the API committed it. Never "nothing
 *   changed" and never "something went wrong": "Try again" resends the same request with the same
 *   idempotency key, which the API answers with the stored outcome or runs once.
 * - `OutcomeLost` (IDEMPOTENCY_OUTCOME_UNAVAILABLE): the command committed under this key but its
 *   answer was lost. "Reload" reads the record again; the command hooks keep the key, so an
 *   unchanged resubmission gets the same answer instead of running a second time.
 * - `SecretWithheldNotice` (IDEMPOTENCY_SECRET_WITHHELD): the record was created, but its one-time
 *   secret was only in the answer that never arrived. It is shown as created; the way on is to
 *   revoke it and issue a new one.
 * - `LegacyAuthorityNotice` (ACCESS_DENIED `LEGACY_AUTHORITY`, K-11, §5.6): the legacy system is
 *   still the system of record for this record category; no permission would allow the write
 *   here, so it is never shown as "not available to you".
 */
import {
  mayHaveTakenEffect,
  recoveryActionFor,
  secretWithheldOf,
  tookEffectOutcomeLost,
  type ApiError,
} from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { StatusBadge } from './StatusBadge';

function Reference({ error }: { error: ApiError }) {
  return (
    <p className="caption">
      Error code: {error.code}
      {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
    </p>
  );
}

/** Why no definite answer arrived, in words (the effect may or may not have been applied). */
export function noAnswerReason(error: ApiError): string {
  if (error.kind === 'timeout') return 'No answer arrived in time';
  if (error.kind === 'network') return 'The connection was lost before an answer arrived';
  if (error.code === 'IDEMPOTENCY_IN_PROGRESS') return 'The same request is still being processed';
  if (error.code === 'PAYMENT_OUTCOME_UNKNOWN') return 'The outcome of a payment is not known yet';
  if (error.code === 'INTEGRATION_UNAVAILABLE') return 'A provider this depends on did not answer';
  return 'The service failed while it handled this request';
}

export function OutcomeUnknown({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const recovery = recoveryActionFor(error);
  return (
    <section className="state" aria-live="polite" data-testid="state-outcome-unknown">
      <StatusBadge tone="warning" label="Outcome not known yet" />
      <p>
        {noAnswerReason(error)}, so this may already have taken effect. Do not make it again as a
        new request.{' '}
        {recovery.retry
          ? 'Try again sends the same request with the same key, so it is never applied twice.'
          : recovery.label}
      </p>
      <Reference error={error} />
      {recovery.retry && onRetry ? <Button onClick={onRetry}>Try again</Button> : null}
    </section>
  );
}

export function OutcomeLost({
  error,
  onReload,
  reloadLabel = 'Reload',
}: {
  error: ApiError;
  /** Read the record or list again. */
  onReload?: () => void;
  reloadLabel?: string;
}) {
  return (
    <section className="state" aria-live="polite" data-testid="state-outcome-lost">
      <StatusBadge tone="warning" label="This may already have been done" />
      <p>
        An earlier attempt of this request was recorded, but its answer was lost, so it is not run
        again. Reload and check the current state before you decide; sending it again changes
        nothing.
      </p>
      <Reference error={error} />
      {onReload ? <Button onClick={onReload}>{reloadLabel}</Button> : null}
    </section>
  );
}

export function SecretWithheldNotice({
  error,
  secret,
  where,
  children,
}: {
  error: ApiError;
  /** The one-time secret, e.g. "download link" or "invitation code". */
  secret: string;
  /** Where the created record is listed, e.g. "under Exports made on this page". */
  where: string;
  /** Actions on the created record (revoke it, start a new one). */
  children?: ReactNode;
}) {
  return (
    <section className="state" aria-live="polite" data-testid="state-secret-withheld">
      <StatusBadge tone="warning" label={`Created, but the ${secret} cannot be shown again`} />
      <p>
        The first attempt succeeded, and its {secret} was only in the answer that never arrived
        (§4.14). It is listed {where}. Revoke it, then create a new one; creating again before that
        leaves the first one active.
      </p>
      <Reference error={error} />
      {children}
    </section>
  );
}

export function LegacyAuthorityNotice({ error }: { error: ApiError }) {
  const details = error.details as { recordCategory?: unknown } | null | undefined;
  const category =
    details && typeof details === 'object' && typeof details.recordCategory === 'string'
      ? details.recordCategory.replace(/_/g, ' ')
      : null;
  return (
    <section className="state" aria-live="polite" data-testid="state-legacy-authority">
      <StatusBadge tone="neutral" label="Make this change in the system of record" />
      <p>
        {error.message} During the migration the legacy system is still the system of record for{' '}
        {category ? `${category} records` : 'these records'}, so nothing was changed here. Make the
        change in the legacy system; no permission or role would allow it here.
      </p>
      <Reference error={error} />
    </section>
  );
}

/**
 * The shared outcome view of a command failure, or null when the error is none of these. Call it
 * before any code-specific wording; a PAYMENT_OUTCOME_UNKNOWN view of its own (finance) goes first.
 */
export function sharedCommandOutcome(
  error: ApiError,
  actions: { onRetry?: () => void; onReload?: () => void },
): ReactNode | null {
  if (error.isLegacyAuthority) return <LegacyAuthorityNotice error={error} />;
  if (tookEffectOutcomeLost(error))
    return <OutcomeLost error={error} onReload={actions.onReload} />;
  if (secretWithheldOf(error)) {
    return (
      <SecretWithheldNotice error={error} secret="one-time link" where="with the records it made" />
    );
  }
  if (mayHaveTakenEffect(error)) return <OutcomeUnknown error={error} onRetry={actions.onRetry} />;
  return null;
}
