/**
 * Payment attempts as the API lists them for finance readers (`GET /v1/payments`, FIN-02,
 * SPK-PAY-007): by state, purpose, payer, order or obligation, newest first, in keyset pages with
 * "Load more". Every state is shown as text with a glyph; `unknown` says how long it has been
 * unknown and that nobody pays again until it is reconciled from provider evidence. A viewer
 * without the finance read sees "not available". Used by SCR-S-36 (the attempts list), SCR-S-35
 * (an order, an obligation) and SCR-S-25 (the basket's order).
 */
import { formatAge, type Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { useNow } from '../../providers/AppProviders';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatInstant, formatMoney, humanize, shortRef } from './format';
import { PAYMENT_STATUS } from './labels';
import { PersonName } from './names';

type Attempt = Schema<'PaymentAttempt'>;

export interface PaymentFilter {
  status?: Schema<'PaymentAttemptStatus'>;
  purpose?: Schema<'PaymentAttemptPurpose'>;
  payerPersonId?: string;
  orderId?: string;
  obligationId?: string;
}

function AttemptRow({ attempt, showPayer }: { attempt: Attempt; showPayer: boolean }) {
  const now = useNow();
  return (
    <li>
      <div className="row-text">
        <Link className="row-title" to={`/finance/payments/${attempt.id}`}>
          {formatMoney(attempt.amountMinor, attempt.currency)} · {humanize(attempt.purpose)} ·
          attempt {shortRef(attempt.id)}
        </Link>
        <span className="caption">
          {showPayer ? (
            <>
              Payer <PersonName id={attempt.payerPersonId} fallback="Payer" /> ·{' '}
            </>
          ) : null}
          {attempt.provider} · created {formatInstant(attempt.createdAt, 'UTC')}
          {attempt.evidenceSource ? ` · evidence ${humanize(attempt.evidenceSource)}` : ''}
        </span>
        {attempt.status === 'unknown' ? (
          <span>
            Unknown since {formatInstant(attempt.unknownSince, 'UTC')}
            {attempt.unknownSince ? ` (${formatAge(new Date(attempt.unknownSince), now)})` : ''}:
            reconcile before anything else; do not take payment again. Owner: finance operator
            queue.
          </span>
        ) : null}
        {attempt.checkoutId ? (
          <Link to={`/finance/checkouts/${attempt.checkoutId}`}>Open the checkout</Link>
        ) : null}
      </div>
      <StatusBadge {...PAYMENT_STATUS[attempt.status]} />
    </li>
  );
}

export function PaymentAttemptList({
  filter,
  label = 'Payment attempts',
  showPayer = true,
}: {
  filter: PaymentFilter;
  label?: string;
  showPayer?: boolean;
}) {
  const payments = useApiPages({
    path: '/payments',
    request: { query: { limit: 50, ...filter } },
  });
  return (
    <>
      <QueryBoundary
        query={payments}
        label={label.toLowerCase()}
        isEmpty={(items) => items.length === 0}
        empty={{
          title: filter.status === 'unknown' ? 'No unknown outcomes' : 'No payment attempts',
          description:
            filter.status === 'unknown'
              ? 'No payment attempt has an unknown outcome.'
              : 'No payment attempt matches.',
        }}
        unavailableOffline={['reconciling']}
      >
        {(items) => (
          <>
            {items.some((a) => a.status === 'unknown') ? (
              <p data-testid="state-recovery">
                <StatusBadge tone="warning" label="Recovery required: payment outcome unknown" /> Do
                not take payment again: reconcile the attempt from provider evidence first
                (SPK-PAY-007).
              </p>
            ) : null}
            <ul className="list" aria-label={label}>
              {items.map((a) => (
                <AttemptRow key={a.id} attempt={a} showPayer={showPayer} />
              ))}
            </ul>
          </>
        )}
      </QueryBoundary>
      <LoadMore pages={payments} label={label.toLowerCase()} />
    </>
  );
}
