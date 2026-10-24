/**
 * SCR-S-36 checkout recovery (§4.11, SPK-PAY-007, SPK-PAY-008, SPK-AT-006): a checkout whose
 * money was received but whose fulfillment did not complete stays `recovery_required` with what is
 * known (payment, receipt, failure, the API's proposed plan and exception) until finance either
 * retries fulfillment (`POST /v1/registration-checkouts/{id}/recover`) or compensates it with a
 * refund or a credit (`.../compensate`); both need a reason and carry an idempotency key per
 * intent. A checkout that holds no live payment can be aborted. Compensation rules are pending
 * DEC-009 (owner Finance).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration-finance/CommandError';
import { Facts, SelectField, TextArea } from '../../features/registration-finance/fields';
import {
  formatInstant,
  formatMoney,
  humanize,
  shortRef,
} from '../../features/registration-finance/format';
import { CHECKOUT_STATUS, PAYMENT_STATUS } from '../../features/registration-finance/labels';
import { PersonName } from '../../features/registration-finance/names';
import { OfflineCaption, useOnline } from '../../features/registration-finance/offline';
import { PENDING } from '../../features/registration-finance/pending';
import { FINANCE_LINKS, SectionNav } from '../../features/registration-finance/SectionNav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type Checkout = Schema<'Checkout'>;
const CHECKOUT_KEY = ['api', '/registration-checkouts/{id}'] as const;

function RecoveryActions({ checkout }: { checkout: Checkout }) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'refund' | 'credit' | ''>(
    checkout.recovery?.plan === 'refund' || checkout.recovery?.plan === 'credit'
      ? checkout.recovery.plan
      : '',
  );
  const [reasonError, setReasonError] = useState<string | null>(null);
  const recover = useApiCommand('post', '/registration-checkouts/{id}/recover', {
    invalidate: [CHECKOUT_KEY, ['api', '/exceptions']],
  });
  const compensate = useApiCommand('post', '/registration-checkouts/{id}/compensate', {
    invalidate: [CHECKOUT_KEY, ['api', '/exceptions']],
  });
  const abort = useApiCommand('post', '/registration-checkouts/{id}/abort', {
    invalidate: [CHECKOUT_KEY],
  });
  const [last, setLast] = useState<'recover' | 'compensate' | 'abort' | null>(null);
  const active =
    last === 'recover'
      ? recover
      : last === 'compensate'
        ? compensate
        : last === 'abort'
          ? abort
          : null;
  const needReason = () => {
    if (!reason.trim()) {
      setReasonError('A reason is required and is audited.');
      return false;
    }
    setReasonError(null);
    return true;
  };
  const reload = () => {
    active?.reset();
    void queryClient.invalidateQueries({ queryKey: CHECKOUT_KEY });
  };
  const busy = recover.isProcessing || compensate.isProcessing || abort.isProcessing;
  const recoverable = checkout.status === 'recovery_required';
  const abortable = checkout.status === 'prepared' || checkout.status === 'awaiting_payment';
  if (!recoverable && !abortable) return null;
  return (
    <section className="rf-panel" aria-labelledby="recovery-actions-title">
      <h3 id="recovery-actions-title">
        {recoverable ? 'Resolve the recovery' : 'Abort the checkout'}
      </h3>
      <TextArea label="Reason" required value={reason} onChange={setReason} error={reasonError} />
      {recoverable ? (
        <>
          <div className="rf-actions">
            <Button
              busy={recover.isProcessing}
              disabled={!online || busy}
              onClick={() => {
                if (!needReason()) return;
                setLast('recover');
                recover
                  .submit({
                    path: { id: checkout.id },
                    body: { reason: reason.trim(), expectedRevision: checkout.revision },
                  })
                  .catch(() => undefined);
              }}
            >
              Retry fulfillment
            </Button>
          </div>
          <SelectField
            label="Compensate with"
            value={method}
            placeholder="Choose refund or credit"
            onChange={(v) => setMethod(v as 'refund' | 'credit' | '')}
            options={[
              { value: 'refund', label: 'Refund to the original payment' },
              { value: 'credit', label: 'Credit to the payer' },
            ]}
          />
          <p className="caption">
            Compensation rules are pending {PENDING.refundsCreditsCash.ids[0]} (owner:{' '}
            {PENDING.refundsCreditsCash.owner}). A refund reserves the amount before it runs.
          </p>
          <div className="rf-actions">
            <Button
              variant="secondary"
              busy={compensate.isProcessing}
              disabled={!online || busy || method === ''}
              onClick={() => {
                if (!needReason() || method === '') return;
                setLast('compensate');
                compensate
                  .submit({
                    path: { id: checkout.id },
                    body: { method, reason: reason.trim(), expectedRevision: checkout.revision },
                  })
                  .catch(() => undefined);
              }}
            >
              Compensate the checkout
            </Button>
          </div>
        </>
      ) : (
        <div className="rf-actions">
          <Button
            variant="secondary"
            busy={abort.isProcessing}
            disabled={!online || busy}
            onClick={() => {
              if (!needReason()) return;
              setLast('abort');
              abort
                .submit({
                  path: { id: checkout.id },
                  body: { reason: reason.trim(), expectedRevision: checkout.revision },
                })
                .catch(() => undefined);
            }}
          >
            Abort the checkout
          </Button>
        </div>
      )}
      <OfflineCaption action="resolving the checkout" />
      {active?.status === 'success' && active.data ? (
        <p role="status">Checkout now {CHECKOUT_STATUS[active.data.status].label}.</p>
      ) : null}
      <CommandError error={active?.error} onReload={reload} currency={checkout.payment?.currency} />
    </section>
  );
}

export function CheckoutRecoveryScreen() {
  const { checkoutId = '' } = useParams();
  const checkout = useApiQuery({
    path: '/registration-checkouts/{id}',
    request: { path: { id: checkoutId } },
  });
  return (
    <section aria-labelledby="checkout-title">
      <h2 id="checkout-title">Checkout {shortRef(checkoutId)}</h2>
      <SectionNav label="Finance" links={FINANCE_LINKS} />
      <QueryBoundary
        query={checkout}
        label="the checkout"
        empty={{ title: '', description: '' }}
        unavailableOffline={['recovering or compensating']}
      >
        {(data) => (
          <>
            <p>
              <StatusBadge {...CHECKOUT_STATUS[data.status]} />
            </p>
            <Facts
              label="Checkout"
              items={[
                ['Payer', <PersonName key="payer" id={data.payerPersonId} fallback="Payer" />],
                ['Payment kind', humanize(data.paymentKind)],
                [
                  'Payment',
                  data.payment ? (
                    <Link to={`/finance/payments/${data.payment.id}`}>
                      {PAYMENT_STATUS[data.payment.status].label},{' '}
                      {formatMoney(data.payment.amountMinor, data.payment.currency)}
                    </Link>
                  ) : (
                    'None'
                  ),
                ],
                [
                  'Receipt',
                  data.receipt
                    ? `${formatMoney(data.receipt.amountMinor, data.receipt.currency)} received ${formatInstant(data.receipt.receivedAt)}`
                    : 'No money received',
                ],
                [
                  'Enrollments',
                  data.enrollmentIds.length === 0 ? 'None yet' : String(data.enrollmentIds.length),
                ],
                ['Next action', data.nextAction ? humanize(data.nextAction) : 'None'],
              ]}
            />
            {data.recovery ? (
              <section className="rf-panel" aria-labelledby="recovery-title">
                <h3 id="recovery-title">What is known</h3>
                <p>{data.recovery.message}</p>
                <Facts
                  label="Recovery"
                  items={[
                    ['Reason', humanize(data.recovery.reasonCode)],
                    ['Proposed plan', humanize(data.recovery.plan)],
                    ['Owner', 'Finance operator queue'],
                    [
                      'Refund',
                      data.recovery.refundAttemptId ? (
                        <Link to={`/finance/refunds/${data.recovery.refundAttemptId}`}>
                          Open the refund
                        </Link>
                      ) : (
                        'None'
                      ),
                    ],
                    [
                      'Credit',
                      data.recovery.creditId ? (
                        <Link to={`/finance/credits/${data.recovery.creditId}`}>
                          Open the credit
                        </Link>
                      ) : (
                        'None'
                      ),
                    ],
                  ]}
                />
              </section>
            ) : null}
            {data.failure ? <p className="caption">Failure code: {data.failure.code}</p> : null}
            <RecoveryActions checkout={data} />
          </>
        )}
      </QueryBoundary>
    </section>
  );
}
