/**
 * ENR-03 (SPK-REG-010, §4.9, §4.11): a cancellation or transfer commits a refund, credit or charge
 * only as the customer accepted it. The client sends the previewed consequence back as
 * `acceptedConsequence`; the API recomputes it in the command's transaction and refuses with
 * RESOURCE_CONFLICT `CONSEQUENCE_ACCEPTANCE_REQUIRED` or `CONSEQUENCE_CHANGED` (with the current
 * consequence) when it differs, so nothing is committed on a stale preview. The client never
 * computes or adjusts the consequence; refund and credit rules are pending DEC-009.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatMoney, shortRef } from './format';
import { CONSEQUENCE_KIND } from './labels';
import { PENDING } from './pending';

export type Consequence = NonNullable<Schema<'FinancialConsequence'>>;
export type AcceptedConsequence = Schema<'AcceptedConsequence'>;

/** The previewed consequence exactly as the API stated it, to send back as accepted. */
export function acceptedOf(consequence: Consequence): AcceptedConsequence {
  return {
    kind: consequence.kind,
    amountMinor: consequence.amountMinor,
    currency: consequence.currency,
  };
}

/** Whether the customer must accept the consequence before the command is sent. */
export function needsAcceptance(consequence: Consequence | null | undefined): boolean {
  return !consequence || consequence.kind !== 'none';
}

function isConsequence(value: unknown): value is Consequence {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === 'string' && typeof v.explanation === 'string';
}

/** The API's refusal of a stale or unaccepted consequence, with the current one when it says. */
export function consequenceConflictOf(error: ApiError | null | undefined): {
  code: 'CONSEQUENCE_ACCEPTANCE_REQUIRED' | 'CONSEQUENCE_CHANGED';
  current: Consequence | null;
} | null {
  if (!error || error.code !== 'RESOURCE_CONFLICT') return null;
  const details = error.details as Record<string, unknown> | null | undefined;
  const code = details?.['code'];
  if (code !== 'CONSEQUENCE_ACCEPTANCE_REQUIRED' && code !== 'CONSEQUENCE_CHANGED') return null;
  const current = details?.['consequence'];
  return { code, current: isConsequence(current) ? current : null };
}

export function ConsequenceView({ consequence }: { consequence: Consequence | null }) {
  if (!consequence) {
    return <StatusBadge tone="pending" label="Financial consequence not stated" />;
  }
  return (
    <div className="row-text" role="group" aria-label="Financial consequence">
      <span>
        <StatusBadge {...CONSEQUENCE_KIND[consequence.kind]} />{' '}
        {consequence.amountMinor !== null
          ? formatMoney(consequence.amountMinor, consequence.currency)
          : null}
      </span>
      <span>{consequence.explanation}</span>
      <span className="caption">
        Policy {consequence.policyVersionId ? shortRef(consequence.policyVersionId) : 'none'}. Rules
        pending {PENDING.refundsCreditsCash.ids[0]} (owner: {PENDING.refundsCreditsCash.owner}).
      </span>
    </div>
  );
}

/**
 * The refusal shown in place of a generic error: what changed, the current consequence, and
 * "Preview again" to re-read it before the customer accepts again. Nothing was committed.
 */
export function ConsequenceConflict({
  conflict,
  error,
  onPreviewAgain,
}: {
  conflict: NonNullable<ReturnType<typeof consequenceConflictOf>>;
  error: ApiError;
  onPreviewAgain: () => void;
}) {
  return (
    <section className="state" aria-live="polite" data-testid="state-stale">
      <StatusBadge
        tone="warning"
        label={
          conflict.code === 'CONSEQUENCE_CHANGED'
            ? 'The financial consequence changed'
            : 'The financial consequence needs the customer’s acceptance'
        }
      />
      <p>
        {conflict.code === 'CONSEQUENCE_CHANGED'
          ? 'It changed since it was previewed. Nothing was committed: review the current consequence with the customer and accept it again.'
          : 'Nothing was committed: review the consequence with the customer and accept it first.'}
      </p>
      {conflict.current ? <ConsequenceView consequence={conflict.current} /> : null}
      <p className="caption">
        Error code: {error.code} ({conflict.code})
        {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
      </p>
      <Button onClick={onPreviewAgain}>Preview again</Button>
    </section>
  );
}
