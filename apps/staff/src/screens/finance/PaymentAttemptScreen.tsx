/**
 * SCR-S-36 one payment attempt (SPK-PAY-007, §4.11, SPK-AT-006): its state including `unknown`,
 * amount, provider reference, evidence source, how long it has been unknown, and links to its
 * checkout or obligation. "Reconcile from provider evidence" (`POST /v1/payments/{id}/reconcile`,
 * idempotency key per intent) asks the provider for its authoritative record; the
 * PaymentAttemptMachine lets `unknown` become only `succeeded`, `failed` or `canceled`. Nothing
 * here retries a payment. A result that is still unresolved stays a recovery-required state with
 * its age and owner. The attempt's detail (FIN-02) carries what can still be refunded and its
 * earlier refunds (SCR-S-37). Provider events are listed by provider in the events view (K-08);
 * the API does not tie an event to one attempt. The provider itself is pending DEC-019.
 */
import { formatAge } from '@sportspark/api-client';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { Facts } from '../../features/registration-finance/fields';
import { formatInstant, formatMoney, humanize } from '../../features/registration-finance/format';
import {
  PAYMENT_STATUS,
  REFUND_STATUS,
  paymentUnresolved,
} from '../../features/registration-finance/labels';
import { PersonName } from '../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

const PAYMENT_KEY = ['api', '/payments/{id}'] as const;

export function PaymentAttemptScreen() {
  const { paymentId = '' } = useParams();
  const online = useOnline();
  const now = useNow();
  const payment = useApiQuery({ path: '/payments/{id}', request: { path: { id: paymentId } } });
  const reconcile = useApiCommand('post', '/payments/{id}/reconcile', {
    invalidate: [PAYMENT_KEY, ['api', '/exceptions']],
  });
  return (
    <section aria-labelledby="payment-title">
      <h2 id="payment-title">Payment attempt</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <QueryBoundary
        query={payment}
        label="the payment attempt"
        empty={{ title: '', description: '' }}
        unavailableOffline={['reconciling']}
      >
        {(data) => {
          // The published schema marks PaymentAttempt nullable; a null body is "not available".
          if (!data) return <StateView variant="unavailable" />;
          const unresolved = paymentUnresolved(data.status);
          return (
            <>
              <p>
                <StatusBadge {...PAYMENT_STATUS[data.status]} />
              </p>
              <Facts
                label="Payment attempt"
                items={[
                  ['Amount', formatMoney(data.amountMinor, data.currency)],
                  ['Purpose', humanize(data.purpose)],
                  ['Payer', <PersonName key="payer" id={data.payerPersonId} fallback="Payer" />],
                  ['Provider', data.provider],
                  ['Provider reference', data.providerReference ?? 'None recorded'],
                  [
                    'Evidence',
                    data.evidenceSource
                      ? humanize(data.evidenceSource)
                      : 'No provider evidence yet',
                  ],
                  [
                    'Unknown since',
                    data.unknownSince
                      ? `${formatInstant(data.unknownSince)} (${formatAge(new Date(data.unknownSince), now)})`
                      : 'Not unknown',
                  ],
                  ['Resolved', formatInstant(data.resolvedAt)],
                  ['Failure reason', data.failureReason ?? 'None'],
                ]}
              />
              <nav aria-label="Related records" className="rf-actions">
                {data.checkoutId ? (
                  <Link to={`/finance/checkouts/${data.checkoutId}`}>Checkout</Link>
                ) : null}
                {data.obligationId ? (
                  <Link to={`/finance/obligations/${data.obligationId}`}>Obligation</Link>
                ) : null}
                {data.status === 'succeeded' ? (
                  <Link to={`/finance/payments/${data.id}/refunds`}>
                    Refund this payment (SCR-S-37)
                  </Link>
                ) : null}
              </nav>
              {unresolved ? (
                <section className="rf-panel" aria-labelledby="reconcile-title">
                  <h3 id="reconcile-title">Reconcile</h3>
                  {data.status === 'unknown' ? (
                    <p>
                      Recovery required: the outcome is unknown. Owner: finance operator queue. Do
                      not charge the customer again until this resolves.
                    </p>
                  ) : (
                    <p>
                      This attempt has no final outcome yet. Reconciliation asks the provider for
                      its record.
                    </p>
                  )}
                  <Button
                    busy={reconcile.isProcessing}
                    disabled={!online}
                    onClick={() => {
                      reconcile.submit({ path: { id: data.id } }).catch(() => undefined);
                    }}
                  >
                    Reconcile from provider evidence
                  </Button>
                  <OfflineCaption action="reconciling" />
                  {reconcile.isProcessing ? (
                    <p role="status">Reconciling with the provider…</p>
                  ) : null}
                </section>
              ) : null}
              {reconcile.data ? (
                <p role="status">
                  {paymentUnresolved(reconcile.data.status)
                    ? `Still unresolved (${PAYMENT_STATUS[reconcile.data.status].label}): the provider gave no authoritative evidence yet. It stays in the finance operator queue.`
                    : `Resolved: ${PAYMENT_STATUS[reconcile.data.status].label}.`}
                </p>
              ) : null}
              <CommandError
                error={reconcile.error}
                onRetry={() => reconcile.submit({ path: { id: data.id } }).catch(() => undefined)}
              />
              <section className="rf-panel" aria-labelledby="payment-refunds-title">
                <h3 id="payment-refunds-title">Refunds of this payment</h3>
                <p>
                  Still refundable: {formatMoney(data.refundableMinor, data.currency)} (captured
                  minus refunded minus reserved by pending refunds).
                </p>
                {data.refunds.length === 0 ? (
                  <p className="caption">No refund has been requested for this payment.</p>
                ) : (
                  <ul className="list" aria-label="Refunds of this payment">
                    {data.refunds.map((r) => (
                      <li key={r.id}>
                        <Link to={`/finance/refunds/${r.id}`}>
                          {formatMoney(r.amountMinor, r.currency)} requested{' '}
                          {formatInstant(r.requestedAt, 'UTC')}
                        </Link>
                        <StatusBadge {...REFUND_STATUS[r.status]} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="rf-panel" aria-labelledby="payment-events-title">
                <h3 id="payment-events-title">Provider events</h3>
                <p className="caption">
                  The API does not tie a provider event to one attempt; the events of this provider
                  show their signature verification and processing state.
                </p>
                <Link
                  to={`/finance/payments?view=events&provider=${encodeURIComponent(data.provider)}`}
                >
                  Provider events from {data.provider}
                </Link>
              </section>
              <StateView
                variant="pending-decision"
                subject="Evidence from a selected payment processor"
                decisions={PENDING.paymentProvider.ids}
                owner={PENDING.paymentProvider.owner}
              />
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
