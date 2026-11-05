/**
 * One refund as the API reports it (SPK-PAY-008, SPK-AT-007): its state, the reservation that
 * protects the funds, and the payment's refundable figures (captured, refunded, reserved,
 * available). An `unknown` refund keeps its reservation until authoritative reconciliation, and
 * partial refunds show what remains refundable.
 */
import type { Schema } from '@sportspark/api-client';
import { Link } from 'react-router';
import { StatusBadge } from '../../ui/StatusBadge';
import { Facts } from './fields';
import { formatInstant, formatMoney, humanize } from './format';
import { RESERVATION_STATUS, refundBadge } from './labels';

export function RefundView({
  refund,
  showPaymentLink = true,
}: {
  refund: Schema<'Refund'>;
  showPaymentLink?: boolean;
}) {
  const { refundable } = refund;
  return (
    <div role="group" aria-label="Refund">
      <p>
        <StatusBadge {...refundBadge(refund.status, refund.reversedAt)} />{' '}
        <StatusBadge {...RESERVATION_STATUS[refund.reservationStatus]} />
      </p>
      {refund.reversedAt ? (
        <p data-testid="refund-reversed">
          The provider reported this refund failed after it was recorded as made: no money was
          returned. Finance has booked the reversal; the amount is refundable again.
        </p>
      ) : null}
      {refund.status === 'unknown' ? (
        <p>
          Recovery required: the provider&apos;s result is unknown. The reserved amount stays held
          until the refund is reconciled, so the same funds are never refunded twice (SPK-AT-007).
        </p>
      ) : null}
      <Facts
        label="Refund details"
        items={[
          ['Amount', formatMoney(refund.amountMinor, refund.currency)],
          ['Purpose', humanize(refund.purpose)],
          ['Reason', refund.reason],
          ['Provider reference', refund.providerReference ?? 'None recorded'],
          ['Failure reason', refund.failureReason ?? 'None'],
          ['Unknown since', formatInstant(refund.unknownSince)],
          ['Resolved', formatInstant(refund.resolvedAt)],
          ...(refund.reversedAt ? ([['Reversed', formatInstant(refund.reversedAt)]] as const) : []),
          ['Requested', formatInstant(refund.createdAt)],
        ]}
      />
      <Facts
        label="Refundable amount of the payment"
        items={[
          ['Captured', formatMoney(refundable.capturedMinor, refundable.currency)],
          ['Refunded', formatMoney(refundable.refundedMinor, refundable.currency)],
          ...((refundable.reversedMinor ?? 0) > 0
            ? ([
                [
                  'Reversed after success (not returned)',
                  formatMoney(refundable.reversedMinor ?? 0, refundable.currency),
                ],
              ] as const)
            : []),
          [
            'Reserved by pending refunds',
            formatMoney(refundable.reservedMinor, refundable.currency),
          ],
          ['Still refundable', formatMoney(refundable.availableMinor, refundable.currency)],
        ]}
      />
      {showPaymentLink ? (
        <Link to={`/finance/payments/${refund.paymentAttemptId}`}>Open the payment attempt</Link>
      ) : null}
    </div>
  );
}
