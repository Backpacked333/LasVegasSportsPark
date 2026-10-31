/**
 * SCR-S-37 refund a payment (SPK-PAY-008, SPK-AT-007, POL-009, POL-010): reserve the refundable
 * amount before execution (`POST /v1/payments/{id}/refunds` with an amount in minor units and a
 * reason; idempotency key per intent). The API refuses an amount over the refundable figure
 * (RESOURCE_CONFLICT with the available amount) and answers REFUND_PENDING when a concurrent
 * refund already reserves the funds; an `unknown` result keeps its reservation until reconciled.
 * Partial refunds are permitted by amount and show what remains refundable.
 *
 * The payment's detail (FIN-02) states what is still refundable, and its earlier refunds are
 * listed (`GET /v1/refunds?paymentAttemptId=`, keyset pages) with their state and reservation.
 * Refund eligibility and amounts are pending DEC-009 (owner Finance): staff enter the amount; no
 * policy is computed here.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError, fieldErrorsOf } from '../../features/registration-finance/CommandError';
import { Facts, TextArea, TextField } from '../../features/registration-finance/fields';
import { RefundList } from '../../features/registration-finance/RefundList';
import { formatMoney, parseMoneyInput } from '../../features/registration-finance/format';
import { PAYMENT_STATUS } from '../../features/registration-finance/labels';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { RefundView } from '../../features/registration-finance/RefundView';
import {
  LockedNote,
  outcomePending,
  useSameRequest,
} from '../../features/registration-finance/sameRequest';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

function RequestRefund({ paymentId, currency }: { paymentId: string; currency: string }) {
  const online = useOnline();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const refund = useApiCommand('post', '/payments/{id}/refunds', {
    invalidate: [['api', '/payments/{id}']],
  });
  const server = fieldErrorsOf(refund.error);
  const same = useSameRequest(refund.submit);
  const locked = outcomePending(refund.error);
  const submit = () => {
    const errors: Record<string, string> = {};
    const minor = parseMoneyInput(amount, currency);
    if (minor === null)
      errors.amountMinor = `Enter a positive amount in ${currency}, for example 25.00.`;
    if (!reason.trim()) errors.reason = 'A reason is required and is audited.';
    setLocal(errors);
    if (minor === null || Object.keys(errors).length > 0) return;
    same
      .send({ path: { id: paymentId }, body: { amountMinor: minor, reason: reason.trim() } })
      // A new refund needs a new amount: clear it so a second click never repeats one silently.
      .then(() => setAmount(''))
      .catch(() => undefined);
  };
  return (
    <section className="rf-panel" aria-labelledby="request-refund-title">
      <h3 id="request-refund-title">Request a refund</h3>
      <p className="caption">
        The amount is reserved before the refund runs; a concurrent request cannot reserve the same
        funds. Refund eligibility and amounts are pending {PENDING.refundsCreditsCash.ids[0]}{' '}
        (owner: {PENDING.refundsCreditsCash.owner}).
      </p>
      <form
        noValidate
        aria-label="Request a refund"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="rf-plain" disabled={locked}>
          <div className="rf-grid">
            <TextField
              label={`Refund amount (${currency})`}
              inputMode="decimal"
              required
              value={amount}
              onChange={setAmount}
              error={local.amountMinor ?? server.amountMinor}
            />
          </div>
          <TextArea
            label="Reason for the refund"
            required
            value={reason}
            onChange={setReason}
            error={local.reason ?? server.reason}
          />
          <div className="rf-actions">
            <Button type="submit" busy={refund.isProcessing} disabled={!online || locked}>
              Reserve and request the refund
            </Button>
          </div>
        </fieldset>
        <OfflineCaption action="requesting a refund" />
        {refund.isProcessing ? (
          <p role="status">Reserving the amount and requesting the refund…</p>
        ) : null}
      </form>
      <LockedNote
        error={refund.error}
        onNewRequest={() => {
          refund.reset();
          same.forget();
        }}
      />
      <CommandError error={refund.error} currency={currency} onRetry={same.retry} />
      {refund.data ? (
        <div aria-live="polite">
          <p role="status">
            Refund {refund.data.status === 'succeeded' ? 'completed' : 'recorded'}:{' '}
            {formatMoney(refund.data.refundable.availableMinor, refund.data.refundable.currency)}{' '}
            still refundable.
          </p>
          <RefundView refund={refund.data} showPaymentLink={false} />
          <Link to={`/finance/refunds/${refund.data.id}`}>Open this refund</Link>
        </div>
      ) : null}
    </section>
  );
}

export function RefundsScreen() {
  const { paymentId = '' } = useParams();
  const payment = useApiQuery({ path: '/payments/{id}', request: { path: { id: paymentId } } });
  return (
    <section aria-labelledby="refunds-title">
      <h2 id="refunds-title">Refund a payment</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <QueryBoundary
        query={payment}
        label="the payment attempt"
        empty={{ title: '', description: '' }}
        unavailableOffline={['requesting a refund']}
      >
        {(data) =>
          !data ? (
            <StateView variant="unavailable" />
          ) : (
            <>
              <p>
                <StatusBadge {...PAYMENT_STATUS[data.status]} />
              </p>
              <Facts
                label="Payment"
                items={[
                  ['Amount', formatMoney(data.amountMinor, data.currency)],
                  ['Still refundable', formatMoney(data.refundableMinor, data.currency)],
                  ['Provider reference', data.providerReference ?? 'None recorded'],
                ]}
              />
              <Link to={`/finance/payments/${data.id}`}>Open the payment attempt</Link>
              {data.status === 'succeeded' ? (
                <RequestRefund paymentId={data.id} currency={data.currency} />
              ) : (
                <StateView
                  variant="empty"
                  title="Nothing to refund"
                  description={`Only a succeeded payment can be refunded; this attempt is ${PAYMENT_STATUS[data.status].label}.`}
                />
              )}
              {/* §4.10: listed only for a payment the viewer may read, so an unavailable payment
                  never shows "no refund", which would imply that it exists. */}
              <section className="rf-panel" aria-labelledby="earlier-refunds-title">
                <h3 id="earlier-refunds-title">Earlier refunds</h3>
                <RefundList
                  filter={{ paymentAttemptId: data.id }}
                  label="Earlier refunds of this payment"
                  emptyDescription="No refund has been requested for this payment."
                />
              </section>
            </>
          )
        }
      </QueryBoundary>
    </section>
  );
}
