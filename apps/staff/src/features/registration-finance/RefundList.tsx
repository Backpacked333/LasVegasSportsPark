/**
 * Refunds as the API lists them for finance readers (`GET /v1/refunds`, FIN-02, SPK-PAY-008): by
 * payment or by state, newest first, in keyset pages with "Load more". Each shows its state and
 * its reservation as text; an `unknown` refund keeps its reservation until reconciled
 * (SPK-AT-007). Used by SCR-S-37 (a payment's earlier refunds, refunds by state).
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApiPages } from '../../api/useApiPages';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatInstant, formatMoney, humanize, shortRef } from './format';
import { REFUND_STATUS, RESERVATION_STATUS } from './labels';

export function RefundList({
  filter,
  label,
  emptyDescription,
}: {
  filter: { paymentAttemptId?: string; status?: Schema<'RefundStatus'> };
  label: string;
  emptyDescription: string;
}) {
  const refunds = useApiPages({
    path: '/refunds',
    request: { query: { limit: 50, ...filter } },
  });
  return (
    <>
      <QueryBoundary
        query={refunds}
        label={label.toLowerCase()}
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No refunds', description: emptyDescription }}
        unavailableOffline={['reconciling a refund']}
      >
        {(items) => (
          <ul className="list" aria-label={label}>
            {items.map((r) => (
              <li key={r.id}>
                <div className="row-text">
                  <Link className="row-title" to={`/finance/refunds/${r.id}`}>
                    {formatMoney(r.amountMinor, r.currency)} · {humanize(r.purpose)} · refund{' '}
                    {shortRef(r.id)}
                  </Link>
                  <span className="caption">
                    Requested {formatInstant(r.createdAt, 'UTC')} · {r.reason}
                  </span>
                  {r.status === 'unknown' ? (
                    <span>
                      Recovery required: the result is unknown; the reserved amount stays held until
                      it is reconciled.
                    </span>
                  ) : null}
                  {!filter.paymentAttemptId ? (
                    <Link to={`/finance/payments/${r.paymentAttemptId}`}>
                      Open the payment attempt
                    </Link>
                  ) : null}
                </div>
                <span>
                  <StatusBadge {...REFUND_STATUS[r.status]} />{' '}
                  <StatusBadge {...RESERVATION_STATUS[r.reservationStatus]} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={refunds} label={label.toLowerCase()} />
    </>
  );
}
