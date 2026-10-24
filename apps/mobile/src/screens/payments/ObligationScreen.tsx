/**
 * SCR-C-34 Payments and obligations, one balance (SPK-PAY-005, SPK-PAY-006, SPK-PAY-007,
 * SPK-REG-003, SPK-AT-004, §4.9, §4.11, SPK-UX-004, SPK-UX-008; DEC-008, DEC-019, DEC-056,
 * DEC-073 and POL-016 are the API's configuration or pending decisions, never the app's).
 *
 * - `GET /v1/obligations/{id}`: amount, received, applied, left to pay and any overpayment, which
 *   stays visible (SPK-PAY-005), with the due date.
 * - `GET /v1/orders/{id}`: the order lines per participant, credits applied and the order's
 *   payment and fulfillment state ("Payment received. We are completing your registration." for
 *   `recovery_required`).
 * - `GET /v1/installment-plans/{id}`: every installment with its amount, due date (and the date
 *   it was moved from), state, failure reason and notice, plus the authorization and the notice
 *   and retry rules as the API states them. A failed installment reads "Payment attention needed";
 *   retrying it is a facility action (`POST /v1/installments/{id}/collect` is finance staff only).
 * - Pay: `POST /v1/obligations/{id}/payments` with a provider payment-method token and one
 *   idempotency key per intent. "Payment processing" and "Payment outcome being confirmed. Do not
 *   pay again." are never shown as success or failure (SPK-PAY-007): no answer means the outcome
 *   is unknown, "Check again" repeats the same intent with the same key, and the API refuses a
 *   second payment while one is unresolved (PAYMENT_OUTCOME_UNKNOWN). A receipt is shown only
 *   when the API returns one.
 *
 * The payment provider and its card entry are not selected (DEC-019, Technical lead/account
 * owners): release builds show that pending decision instead of a payment method; development
 * builds use the API's fake provider (features/money/dev).
 *
 * States: loading; empty: not applicable; ready; validation failure (the API's message, e.g. a
 * payment above the balance); permission restriction (not available; only the payer sees payment
 * details); stale version (state changed: reload); offline (cached with age, Pay disabled);
 * processing; success ("Payment received" with the receipt); partial completion: not permitted;
 * recovery required (unknown outcome: "Do not pay again").
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import { DevPaymentMethodPicker } from '../../features/money/dev';
import { formatDay, formatInstant, formatMoney } from '../../features/money/format';
import { useMe, useNameOf } from '../../features/money/people';
import { param } from '../../features/money/routes';
import { SecondaryRead } from '../../features/money/SecondaryRead';
import {
  installmentPlanStatus,
  installmentStatus,
  obligationStatus,
  paymentIsUnresolved,
  paymentStatus,
  type InstallmentPlan,
  type Obligation,
  type PaymentAttempt,
  type PaymentOutcome,
  type Receipt,
} from '../../features/money/status';
import { Body, ButtonRow, Caption, Field, Section } from '../../features/money/ui';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { StateView } from '../../ui/StateView';
import { StatusBadge, type StatusBadgeProps } from '../../ui/StatusBadge';

type Order = Schema<'Order'>;
type PayBody = Schema<'PayObligationRequest'>;

const ORDER_PAYMENT: Record<Order['paymentStatus'], Pick<StatusBadgeProps, 'tone' | 'label'>> = {
  awaiting_payment: { tone: 'warning', label: 'Payment needs your action' },
  paid: { tone: 'success', label: 'Paid' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

/** journeys.md: Checkout `recovery_required` and `compensated` wording on the order (§4.11). */
const ORDER_FULFILLMENT: Record<
  Order['fulfillmentStatus'],
  Pick<StatusBadgeProps, 'tone' | 'label'>
> = {
  pending: { tone: 'pending', label: 'Registration being completed' },
  fulfilled: { tone: 'success', label: 'Registration complete' },
  recovery_required: {
    tone: 'warning',
    label: 'Payment received. We are completing your registration.',
  },
  compensated: { tone: 'neutral', label: 'Payment returned. Registration was not completed.' },
  canceled: { tone: 'neutral', label: 'Canceled' },
};

function Totals({ obligation }: { obligation: Obligation }) {
  const now = useNow();
  const t = obligation.totals;
  return (
    <Section title={obligation.description}>
      <StatusBadge {...obligationStatus(obligation, now)} testID="obligation-status" />
      <Field label="Amount" value={formatMoney(t.amountMinor, t.currency)} />
      <Field label="Received" value={formatMoney(t.receivedMinor, t.currency)} />
      <Field label="Applied to this balance" value={formatMoney(t.allocatedMinor, t.currency)} />
      <Field label="Left to pay" value={formatMoney(t.remainingMinor, t.currency)} />
      {t.excessMinor > 0 ? (
        <>
          <Field label="Paid beyond the balance" value={formatMoney(t.excessMinor, t.currency)} />
          <Caption>
            The extra is not lost: the facility holds it under its overpayment policy.
          </Caption>
        </>
      ) : null}
      <Field label="Due" value={formatDay(obligation.dueAt)} />
    </Section>
  );
}

function OrderSection({ order }: { order: Order }) {
  const nameOf = useNameOf();
  return (
    <Section title="Order">
      <StatusBadge {...ORDER_PAYMENT[order.paymentStatus]} />
      <StatusBadge {...ORDER_FULFILLMENT[order.fulfillmentStatus]} testID="order-fulfillment" />
      <View accessibilityRole="list">
        {order.lines.map((line) => (
          <ListRow
            key={line.id}
            title={line.description}
            detail={`${nameOf(line.participantPersonId)}. ${formatMoney(line.totalMinor, line.currency)}`}
          />
        ))}
      </View>
      <Field label="Order total" value={formatMoney(order.totalMinor, order.currency)} />
      {order.creditsAppliedMinor > 0 ? (
        <Field
          label="Credits applied"
          value={formatMoney(order.creditsAppliedMinor, order.currency)}
        />
      ) : null}
      <Field label="Due at checkout" value={formatMoney(order.dueNowMinor, order.currency)} />
      {order.paidAt ? <Field label="Paid" value={formatInstant(order.paidAt)} /> : null}
    </Section>
  );
}

/**
 * Who authorized the recurring charges, as recorded (SPK-PAY-006): "You" only when it was the
 * signed-in person; another known person by name; otherwise just the date (a staff-assisted
 * registration, or an unrecorded authorizer).
 */
export function authorizationText(
  plan: Pick<InstallmentPlan, 'authorization'>,
  selfId: string | null,
  nameOf: (personId: string) => string,
): string {
  const at = formatInstant(plan.authorization.authorizedAt);
  const by = plan.authorization.authorizedByPersonId;
  if (by && selfId && by === selfId) return `You authorized these installments on ${at}`;
  if (by) {
    const name = nameOf(by);
    if (name !== 'Participant' && name !== 'Loading name…') {
      return `${name} authorized these installments on ${at}`;
    }
  }
  return `Authorized on ${at}`;
}

function InstallmentsSection({ plan }: { plan: InstallmentPlan }) {
  const me = useMe();
  const selfId = me.data?.person?.id ?? null;
  const nameOf = useNameOf();
  const failed = plan.installments.some((i) => i.status === 'failed');
  return (
    <Section title="Installments" testID="installments">
      <StatusBadge {...installmentPlanStatus(plan)} />
      <Field label="Plan total" value={formatMoney(plan.totalMinor, plan.currency)} />
      <Field label="Still to pay" value={formatMoney(plan.outstandingMinor, plan.currency)} />
      <Field label="Authorization" value={authorizationText(plan, selfId, nameOf)} />
      <Field
        label="Reminders"
        value={`Sent ${plan.noticePolicy.daysBefore} ${plan.noticePolicy.daysBefore === 1 ? 'day' : 'days'} before each due date`}
      />
      <Field
        label="If a payment fails"
        value={`Tried up to ${plan.retryPolicy.maxAttempts} times, ${plan.retryPolicy.retryIntervalHours} hours apart`}
      />
      <Caption>
        Installments do not change your enrollment: it stays confirmed while they are paid.
      </Caption>
      <View accessibilityRole="list">
        {[...plan.installments]
          .sort((a, b) => a.sequence - b.sequence)
          .map((installment) => {
            const details = [
              `Due ${formatDay(installment.dueAt)}`,
              installment.extensionCount > 0
                ? `moved from ${formatDay(installment.originalDueAt)}`
                : null,
              installment.paidAt ? `paid ${formatInstant(installment.paidAt)}` : null,
              installment.lastFailureReason
                ? `last attempt: ${installment.lastFailureReason}`
                : null,
              installment.noticeSentAt
                ? `reminder sent ${formatDay(installment.noticeSentAt)}`
                : null,
            ].filter(Boolean);
            return (
              <ListRow
                key={installment.id}
                title={`Installment ${installment.sequence}: ${formatMoney(installment.amountMinor, installment.currency)}`}
                detail={details.join(', ')}
                status={installmentStatus(installment)}
                testID={`installment-${installment.sequence}`}
              />
            );
          })}
      </View>
      {failed ? (
        <Body>
          Payment attention needed: contact the facility. Retrying a failed installment is done by
          the facility, not in the app.
        </Body>
      ) : null}
    </Section>
  );
}

function ReceiptView({ receipt }: { receipt: Receipt }) {
  return (
    <View testID="receipt">
      <Field
        label="Receipt"
        value={`${formatMoney(receipt.amountMinor, receipt.currency)} received ${formatInstant(receipt.receivedAt)}`}
      />
      <Field
        label="Applied to this balance"
        value={formatMoney(receipt.allocatedMinor, receipt.currency)}
      />
      {receipt.excessMinor > 0 ? (
        <Field
          label="Paid beyond the balance"
          value={formatMoney(receipt.excessMinor, receipt.currency)}
        />
      ) : null}
    </View>
  );
}

function PaymentResult({
  outcome,
  attempt,
  onCheck,
  checking,
}: {
  outcome: PaymentOutcome;
  attempt: PaymentAttempt;
  onCheck: () => void;
  checking: boolean;
}) {
  const status = paymentStatus(attempt.status);
  return (
    <Section title="Your payment" testID="payment-result">
      <StatusBadge {...status} testID="payment-status" />
      <Field label="Amount" value={formatMoney(attempt.amountMinor, attempt.currency)} />
      {attempt.status === 'unknown' ? (
        <Body>
          We have not had a final answer from the payment provider. Do not pay again: the facility
          confirms the outcome
          {attempt.unknownSince ? ` (waiting since ${formatInstant(attempt.unknownSince)})` : ''}.
        </Body>
      ) : null}
      {attempt.status === 'processing' ? (
        <Body>The provider is still working on this payment. Do not pay again.</Body>
      ) : null}
      {attempt.status === 'failed' && attempt.failureReason ? (
        <Body>{attempt.failureReason}. Nothing was charged; you can try another payment.</Body>
      ) : null}
      {attempt.status === 'action_required' || attempt.status === 'created' ? (
        <StateView
          variant="pending-decision"
          subject="Completing the payment provider’s step in the app"
          decisions={['DEC-019']}
          owner="Technical lead/account owners"
        />
      ) : null}
      {paymentIsUnresolved(attempt.status) ? (
        <ButtonRow>
          <Button label="Check again" variant="secondary" onPress={onCheck} busy={checking} />
        </ButtonRow>
      ) : null}
      {outcome.receipt && attempt.status === 'succeeded' ? (
        <ReceiptView receipt={outcome.receipt} />
      ) : null}
      {outcome.overpaymentCreditId ? (
        <Caption>The amount beyond the balance is held as a credit awaiting approval.</Caption>
      ) : null}
    </Section>
  );
}

/** Everything a payment on an obligation can change: balances, installments, orders, credits. */
const PAYMENT_EFFECT_KEYS: readonly (readonly unknown[])[] = [
  ['api', '/obligations'],
  ['api', '/obligations/{id}'],
  ['api', '/installment-plans/{id}'],
  ['api', '/orders/{id}'],
  ['api', '/credits'],
];

/** Answers after which the payment may still go through (SPK-PAY-007, §4.9). */
export function paymentMayHaveTakenEffect(error: ApiError): boolean {
  return (
    error.isOffline ||
    error.code === 'IDEMPOTENCY_IN_PROGRESS' ||
    error.code === 'INTERNAL_ERROR' ||
    (error.status ?? 0) >= 500
  );
}

function PaySection({
  obligation,
  onOutcome,
  blocked,
}: {
  obligation: Obligation;
  onOutcome: (outcome: PaymentOutcome) => void;
  /** A payment from this screen is unresolved: another must not start (SPK-PAY-007). */
  blocked: boolean;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const pay = useApiCommand('post', '/obligations/{id}/payments', {
    invalidate: PAYMENT_EFFECT_KEYS,
  });
  const [token, setToken] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [sent, setSent] = useState<PayBody | null>(null);
  const t = obligation.totals;

  const submit = async (body: PayBody) => {
    setFailure(null);
    setSent(body);
    try {
      onOutcome((await pay.submit({ path: { id: obligation.id }, body })) as PaymentOutcome);
      setToken(null);
    } catch (error) {
      setFailure(error as ApiError);
    }
  };

  // No definite answer: no response, still running under this key, or a server failure. The
  // payment may still take effect, so it is never shown as a failure (SPK-PAY-007); "Check again"
  // re-sends the same request under the same key.
  const unknown = failure !== null && paymentMayHaveTakenEffect(failure);
  // The API refused because a payment for this balance is unresolved (SPK-PAY-007).
  const inProgressElsewhere = failure?.code === 'PAYMENT_OUTCOME_UNKNOWN';
  const disabled = !token || offline || blocked || unknown || inProgressElsewhere;

  return (
    <Section title="Pay this balance" testID="pay-section">
      {DevPaymentMethodPicker ? (
        <DevPaymentMethodPicker value={token} onChange={setToken} />
      ) : (
        <StateView
          variant="pending-decision"
          subject="Paying in the app"
          decisions={['DEC-019']}
          owner="Technical lead/account owners"
        />
      )}
      {offline ? <Caption>Needs a connection.</Caption> : null}
      {DevPaymentMethodPicker ? (
        <ButtonRow>
          <Button
            label={`Pay ${formatMoney(t.remainingMinor, t.currency)}`}
            onPress={() => token && void submit({ paymentMethodToken: token })}
            disabled={disabled}
            busy={pay.isProcessing}
            accessibilityHint="Pays the amount left on this balance"
          />
        </ButtonRow>
      ) : null}
      {unknown && sent ? (
        <View testID="payment-no-answer">
          <StatusBadge tone="warning" label="Payment outcome being confirmed. Do not pay again." />
          <Body>
            We did not get an answer, so the payment may have gone through. Checking again is safe:
            it asks about the same payment and cannot charge twice.
          </Body>
          <Caption>Error code: {failure?.code}</Caption>
          <ButtonRow>
            <Button
              label="Check again"
              onPress={() => void submit(sent)}
              busy={pay.isProcessing}
              disabled={offline}
            />
          </ButtonRow>
        </View>
      ) : inProgressElsewhere ? (
        <View testID="payment-in-progress">
          <StatusBadge tone="warning" label="Payment outcome being confirmed. Do not pay again." />
          <Body>{failure?.message}</Body>
          <Caption>
            Error code: {failure?.code}
            {failure?.correlationId ? `. Reference: ${failure.correlationId}` : ''}
          </Caption>
        </View>
      ) : failure ? (
        <CommandFailure
          error={failure}
          what="the payment"
          onRetry={() => sent && void submit(sent)}
        />
      ) : null}
    </Section>
  );
}

function ObligationDetail({ obligation }: { obligation: Obligation }) {
  const order = useApiQuery({
    path: '/orders/{id}',
    request: { path: { id: obligation.orderId ?? '' } },
    enabled: obligation.orderId !== null,
  });
  const planId = order.data?.installmentPlanId ?? null;
  const plan = useApiQuery({
    path: '/installment-plans/{id}',
    request: { path: { id: planId ?? '' } },
    enabled: planId !== null,
  });
  const [outcome, setOutcome] = useState<PaymentOutcome | null>(null);
  const unresolved = outcome !== null && paymentIsUnresolved(outcome.payment.status);
  const latest = useApiQuery({
    path: '/payments/{id}',
    request: { path: { id: outcome?.payment.id ?? '' } },
    enabled: unresolved,
    staleTime: 0,
  });
  const attempt: PaymentAttempt | null = latest.data ?? outcome?.payment ?? null;
  const blocked = attempt !== null && paymentIsUnresolved(attempt.status);
  const queryClient = useQueryClient();
  const latestStatus = latest.data?.status;
  // A re-read that settles the attempt (processing or unknown to succeeded or failed) changes the
  // balance, the installments, the order and credits: read them again.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!latestStatus || paymentIsUnresolved(latestStatus)) return;
    setRefreshing(true);
    void Promise.all(
      PAYMENT_EFFECT_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ).finally(() => setRefreshing(false));
  }, [latestStatus, queryClient]);
  return (
    <View>
      <Totals obligation={obligation} />
      {outcome && attempt ? (
        <PaymentResult
          outcome={outcome}
          attempt={attempt}
          onCheck={() => void latest.refetch()}
          checking={latest.fetchStatus === 'fetching'}
        />
      ) : null}
      {obligation.status === 'open' && obligation.totals.remainingMinor > 0 && !refreshing ? (
        <PaySection obligation={obligation} onOutcome={setOutcome} blocked={blocked} />
      ) : null}
      {obligation.orderId !== null ? (
        <SecondaryRead query={order} label="the order" title="Order">
          {(data) => <OrderSection order={data} />}
        </SecondaryRead>
      ) : null}
      {planId !== null ? (
        <SecondaryRead query={plan} label="the installments" title="Installments">
          {(data) => <InstallmentsSection plan={data} />}
        </SecondaryRead>
      ) : null}
    </View>
  );
}

export function ObligationScreen({ obligationId }: { obligationId: string }) {
  const obligation = useApiQuery({
    path: '/obligations/{id}',
    request: { path: { id: obligationId } },
  });
  return (
    <Screen>
      <RequireSession what="this balance">
        <QueryBoundary
          query={obligation}
          label="the balance"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['paying a balance']}
        >
          {(data) => <ObligationDetail obligation={data} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/payments/[obligationId].tsx. */
export function ObligationRoute() {
  const id = param(useLocalSearchParams<{ obligationId: string }>().obligationId);
  return (
    <>
      <Stack.Screen options={{ title: 'Balance' }} />
      {id ? <ObligationScreen obligationId={id} /> : <NotFoundScreen />}
    </>
  );
}
