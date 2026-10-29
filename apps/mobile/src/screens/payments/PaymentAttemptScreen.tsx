/**
 * SCR-C-34 one payment attempt (SPK-PAY-007, SPK-PAY-008, SPK-UX-004, SPK-UX-008, §4.10, §4.11).
 * Reads `GET /v1/payments/{id}` (the payer or the people who pay for them; anyone else gets the
 * protected NOT_FOUND, shown as "not available" without implying the payment exists):
 *
 * - the state in the journeys.md words: "Payment processing" and "Payment outcome being confirmed.
 *   Do not pay again." are never success or failure; "Check again" reads the attempt again and
 *   never pays; a step the provider asks for is the pending decision DEC-019;
 * - what it paid for, with links to the balance, the order, the team contribution or the
 *   registration outcome;
 * - its refunds (SPK-PAY-008), each with its own state; an unknown refund outcome is never
 *   "Refunded". What can still be refunded is a finance figure and is not shown to customers.
 *
 * Route: `/payments/attempt/{paymentId}` (opaque id only, §4.14).
 *
 * States: loading; ready; error with code and "Try again"; not available; stale version (the
 * attempt changed: "Check again" and refetch on focus); offline (cached with age); processing;
 * success ("Payment received"); recovery required (unknown: "Do not pay again").
 */
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant, formatMoney } from '../../features/money/format';
import {
  PAYMENT_PURPOSE_LABELS,
  refundStatus,
  type PaymentDetail,
} from '../../features/money/payment-lists';
import { useNameOf } from '../../features/money/people';
import { moneyRoutes, param } from '../../features/money/routes';
import { paymentIsUnresolved, paymentStatus } from '../../features/money/status';
import { Body, ButtonRow, Caption, Field, Section } from '../../features/money/ui';
import { registrationRoutes } from '../../features/registration/routes';
import { teamRoutes } from '../../features/teams/routes';
import { useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { NotFoundScreen } from '../not-found/NotFoundScreen';

/** What a settled payment can change: balances, contributions, orders and the account lists. */
export const PAYMENT_SETTLED_KEYS: readonly (readonly unknown[])[] = [
  ['api', '/obligations'],
  ['api', '/obligations/{id}'],
  ['api', '/orders/{id}'],
  ['api', '/contribution-requests/{id}'],
  ['api', '/me/payments'],
  ['api', '/me/receipts'],
  ['api', '/me/orders'],
  ['api', '/me/contribution-requests'],
  ['api', '/me/registration-checkouts'],
];

function PaidFor({ payment }: { payment: PaymentDetail }) {
  const router = useRouter();
  const links: { label: string; href: string }[] = [];
  if (payment.obligationId)
    links.push({ label: 'Open the balance', href: moneyRoutes.obligation(payment.obligationId) });
  if (payment.orderId)
    links.push({ label: 'Open the order', href: moneyRoutes.order(payment.orderId) });
  if (payment.contributionRequestId)
    links.push({
      label: 'Open the contribution',
      href: teamRoutes.contribution(payment.contributionRequestId),
    });
  if (payment.checkoutId)
    links.push({
      label: 'Open the registration',
      href: registrationRoutes.outcome(payment.checkoutId),
    });
  if (links.length === 0) return null;
  return (
    <Section title="What it paid for">
      <ButtonRow>
        {links.map((link) => (
          <Button
            key={link.href}
            label={link.label}
            variant="secondary"
            onPress={() => router.push(link.href)}
          />
        ))}
      </ButtonRow>
    </Section>
  );
}

function Refunds({ payment }: { payment: PaymentDetail }) {
  if (payment.refunds.length === 0) return null;
  return (
    <Section title="Refunds" testID="payment-refunds">
      <View accessibilityRole="list">
        {payment.refunds.map((refund) => (
          <ListRow
            key={refund.id}
            title={`Refund of ${formatMoney(refund.amountMinor, refund.currency)}`}
            detail={`Requested ${formatInstant(refund.requestedAt)}`}
            status={refundStatus(refund.status)}
            testID={`refund-${refund.id}`}
          />
        ))}
      </View>
      {payment.refunds.some((r) => r.status === 'unknown') ? (
        <Caption>
          The outcome of a refund being confirmed is checked by the facility with the payment
          provider. It is shown here once it is known.
        </Caption>
      ) : null}
    </Section>
  );
}

function PaymentDetailView({
  payment,
  onCheck,
  checking,
}: {
  payment: PaymentDetail;
  onCheck: () => void;
  checking: boolean;
}) {
  const nameOf = useNameOf();
  const { reachable } = useConnectivity();
  const unresolved = paymentIsUnresolved(payment.status);
  return (
    <View>
      <Section title={PAYMENT_PURPOSE_LABELS[payment.purpose]} testID="payment-detail">
        <StatusBadge {...paymentStatus(payment.status)} testID="payment-status" />
        <Field label="Amount" value={formatMoney(payment.amountMinor, payment.currency)} />
        <Field label="Payer" value={nameOf(payment.payerPersonId)} />
        <Field label="Started" value={formatInstant(payment.createdAt)} />
        {payment.resolvedAt ? (
          <Field label="Outcome recorded" value={formatInstant(payment.resolvedAt)} />
        ) : null}
        {payment.status === 'unknown' ? (
          <Body>
            We have not had a final answer from the payment provider. Do not pay again: the facility
            confirms the outcome
            {payment.unknownSince ? ` (waiting since ${formatInstant(payment.unknownSince)})` : ''}.
          </Body>
        ) : null}
        {payment.status === 'processing' ? (
          <Body>The provider is still working on this payment. Do not pay again.</Body>
        ) : null}
        {payment.status === 'failed' && payment.failureReason ? (
          <Body>{`${payment.failureReason}. Nothing was charged.`}</Body>
        ) : null}
        {payment.status === 'action_required' || payment.status === 'created' ? (
          <StateView
            variant="pending-decision"
            subject="Completing the payment provider’s step in the app"
            decisions={['DEC-019']}
            owner="Technical lead/account owners"
          />
        ) : null}
        {unresolved ? (
          <ButtonRow>
            <Button
              label="Check again"
              variant="secondary"
              onPress={onCheck}
              busy={checking}
              disabled={reachable === false}
              accessibilityHint="Reads the payment's current state; it never pays again"
            />
          </ButtonRow>
        ) : null}
      </Section>
      <Refunds payment={payment} />
      <PaidFor payment={payment} />
    </View>
  );
}

export function PaymentAttemptScreen({ paymentId }: { paymentId: string }) {
  const payment = useApiQuery({
    path: '/payments/{id}',
    request: { path: { id: paymentId } },
    staleTime: 0,
  });
  const queryClient = useQueryClient();
  const status = payment.data?.status;
  const previous = useRef(status);
  // An attempt that settles while it is open here (processing or unknown to an outcome) changes
  // the balance, the contribution and the account lists: read them again.
  useEffect(() => {
    const before = previous.current;
    previous.current = status;
    if (!before || !status || !paymentIsUnresolved(before) || paymentIsUnresolved(status)) return;
    for (const queryKey of PAYMENT_SETTLED_KEYS) void queryClient.invalidateQueries({ queryKey });
  }, [status, queryClient]);
  return (
    <Screen>
      <RequireSession what="this payment">
        <QueryBoundary
          query={payment}
          label="the payment"
          empty={{ title: 'Not available', description: '' }}
        >
          {(data) => (
            <PaymentDetailView
              payment={data}
              onCheck={() => void payment.refetch()}
              checking={payment.fetchStatus === 'fetching'}
            />
          )}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/payments/attempt/[paymentId].tsx. */
export function PaymentAttemptRoute() {
  const id = param(useLocalSearchParams<{ paymentId: string }>().paymentId);
  return (
    <>
      <Stack.Screen options={{ title: 'Payment' }} />
      {id ? <PaymentAttemptScreen paymentId={id} /> : <NotFoundScreen />}
    </>
  );
}
