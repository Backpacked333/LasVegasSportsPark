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
 * - `liveAttempt` (FIN-01): a payment toward this balance that is still on its way or whose
 *   outcome is unknown, wherever it was started (another device, the front desk, an earlier visit),
 *   is shown with "Do not pay again" and paying is blocked until the API no longer reports it;
 *   "Check again" reads the balance again and "Open the payment" shows the attempt when the
 *   account's own payments list it (another payer's attempt says it may be someone else's).
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
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import { DevPaymentMethodPicker } from '../../features/money/dev';
import { formatDay, formatInstant, formatMoney } from '../../features/money/format';
import {
  liveAttemptStatus,
  liveAttemptText,
  type LiveAttempt,
} from '../../features/money/payment-lists';
import { PAYMENT_EFFECT_KEYS } from '../../features/money/payment-effects';
import { moneyRoutes, param } from '../../features/money/routes';
import { SecondaryRead } from '../../features/money/SecondaryRead';
import {
  obligationStatus,
  paymentIsUnresolved,
  paymentStatus,
  type Obligation,
  type PaymentAttempt,
  type PaymentOutcome,
  type Receipt,
} from '../../features/money/status';
import { Body, ButtonRow, Caption, Field, Section } from '../../features/money/ui';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { InstallmentsSection, OrderSection } from './OrderSections';

type PayBody = Schema<'PayObligationRequest'>;

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
      {attempt.status === 'processing' || attempt.status === 'created' ? (
        <Body>The provider is still working on this payment. Do not pay again.</Body>
      ) : null}
      {attempt.status === 'failed' && attempt.failureReason ? (
        <Body>{attempt.failureReason}. Nothing was charged; you can try another payment.</Body>
      ) : null}
      {attempt.status === 'action_required' ? (
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

/**
 * A payment toward this balance that the API reports as still on its way or unknown (FIN-01),
 * wherever it was started. Paying again is blocked while it shows (SPK-PAY-007).
 */
function LiveAttemptSection({
  live,
  onCheck,
  checking,
}: {
  live: LiveAttempt;
  onCheck: () => void;
  checking: boolean;
}) {
  const router = useRouter();
  const { reachable } = useConnectivity();
  // FIN-01: for an individual balance the API also reports the payment of someone else who pays
  // for it (a co-guardian), which this account may not open (`GET /payments/{id}` needs `pay`
  // over its payer). "Open the payment" is offered only for an attempt the account's own payments
  // list; LiveAttempt names no payer and no "readable" flag (reported).
  const mine = useApiQuery({
    path: '/me/payments',
    request: { query: { status: live.status, limit: 50 } },
  });
  const openable = mine.data?.items.some((attempt) => attempt.id === live.id) === true;
  return (
    <Section title="A payment is on its way" testID="live-attempt">
      <StatusBadge {...liveAttemptStatus(live)} testID="live-attempt-status" />
      <Body>{liveAttemptText(live)}</Body>
      {mine.data !== undefined && !openable ? (
        <Caption>
          It may have been started by someone else who pays for this balance. It is shown here so
          the balance is not paid twice.
        </Caption>
      ) : null}
      {live.status === 'action_required' ? (
        <StateView
          variant="pending-decision"
          subject="Completing the payment provider’s step in the app"
          decisions={['DEC-019']}
          owner="Technical lead/account owners"
        />
      ) : null}
      <ButtonRow>
        <Button
          label="Check again"
          variant="secondary"
          onPress={onCheck}
          busy={checking}
          disabled={reachable === false}
          accessibilityHint="Reads this balance again; it never pays"
        />
        {openable ? (
          <Button
            label="Open the payment"
            variant="secondary"
            onPress={() => router.push(moneyRoutes.payment(live.id))}
          />
        ) : null}
      </ButtonRow>
    </Section>
  );
}

function ObligationDetail({
  obligation,
  onCheck,
  checking,
}: {
  obligation: Obligation;
  /** Reads the balance again (its `liveAttempt` with it). */
  onCheck: () => void;
  checking: boolean;
}) {
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
  // The API's live attempt for this balance; the one paid from this screen is shown by its result.
  const live = obligation.liveAttempt ?? null;
  const liveElsewhere = live !== null && live.id !== attempt?.id ? live : null;
  const blocked = (attempt !== null && paymentIsUnresolved(attempt.status)) || live !== null;
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
      {liveElsewhere ? (
        <LiveAttemptSection live={liveElsewhere} onCheck={onCheck} checking={checking} />
      ) : null}
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
          {(data) => (
            <ObligationDetail
              obligation={data}
              onCheck={() => void obligation.refetch()}
              checking={obligation.fetchStatus === 'fetching'}
            />
          )}
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
