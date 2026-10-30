/**
 * FIN-01 (SPK-PAY-007, §4.7 invariant 5): the payment still on its way for an obligation or a
 * checkout, as the API reports it (`liveAttempt`). A payment that is created or processing is
 * waited for; `action_required` waits for the payer; `unknown` is never shown as paid or failed:
 * it is reconciled from provider evidence before anything else, and nobody pays again meanwhile.
 * Money records carry no facility, so the time is shown in UTC and named, as in the attempt list.
 */
import { formatAge, type Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useNow } from '../../providers/AppProviders';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatInstant, formatMoney } from './format';
import { PAYMENT_STATUS } from './labels';

export function LiveAttemptNotice({
  attempt,
}: {
  attempt: Schema<'LiveAttempt'> | null | undefined;
}) {
  const now = useNow();
  if (!attempt) return null;
  return (
    <span className="row-text" role="group" aria-label="Payment on its way">
      <span>
        <StatusBadge {...PAYMENT_STATUS[attempt.status]} />{' '}
        {formatMoney(attempt.amountMinor, attempt.currency)}
      </span>
      <span className="caption">
        {attempt.status === 'unknown'
          ? `Outcome unknown since ${formatInstant(attempt.unknownSince, 'UTC')}${
              attempt.unknownSince ? ` (${formatAge(new Date(attempt.unknownSince), now)})` : ''
            }: do not take payment again until it is reconciled.`
          : attempt.status === 'action_required'
            ? 'Waiting for the payer to complete the provider’s step; do not take payment again.'
            : 'On its way; do not take payment again while it is processing.'}{' '}
        <Link to={`/finance/payments/${attempt.id}`}>Open the payment attempt</Link>
      </span>
    </span>
  );
}
