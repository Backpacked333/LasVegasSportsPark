/**
 * SCR-C-15 Checkout outcome (§4.8 `GET /v1/operations/{id}`, §4.11, SPK-UX-004, SPK-PAY-007,
 * SPK-AT-006 payment after hold expiry, SPK-AT-023 interrupted work; journey A5b). Reads the
 * durable checkout (`GET /v1/registration-checkouts/{id}`), its operation, and per line the
 * enrollment and placement, and says exactly what is known:
 *
 * - "Payment processing" while the provider or the finalizer is still working (re-read every few
 *   seconds and on return to the app);
 * - "Payment outcome being confirmed. Do not pay again." for an unknown outcome;
 * - "Payment failed" with a new payment method only when the API's `nextAction` is
 *   `retry_payment`;
 * - per line "Confirmed in <offering>" or "Confirmed in <offering>. Awaiting placement." only when
 *   the API reports the checkout completed and the enrollment confirmed;
 * - "Payment received. We are completing your registration." (recovery required) and "Payment
 *   returned. Registration was not completed." (compensated).
 *
 * A checkout of another account is answered NOT_FOUND and reads "not available". Offline, the last
 * known status is shown with its age.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import { DevPaymentMethodPicker } from '../../features/registration/dev';
import { formatInstant, formatMoney } from '../../features/registration/format';
import { useParticipantNames } from '../../features/registration/participants';
import { useRegistrationProgress } from '../../features/registration/progress';
import { useApiRecords } from '../../features/registration/queries';
import { param, registrationRoutes } from '../../features/registration/routes';
import {
  checkoutInFlight,
  checkoutStatus,
  enrollmentStatus,
  operationLabel,
  paymentStatus,
} from '../../features/registration/status';
import { Body, ButtonRow, Detail, Section } from '../../features/registration/ui';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';

type Checkout = Schema<'Checkout'>;

/** How often an in-flight checkout is re-read (a display refresh, not a policy). */
export const OUTCOME_POLL_MS = 5_000;

const TERMINAL: readonly Checkout['status'][] = ['completed', 'compensated', 'aborted'];

function RetryPayment({ checkout }: { checkout: Checkout }) {
  const { reachable } = useConnectivity();
  const [token, setToken] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const retry = useApiCommand('post', '/registration-checkouts/{id}/payments', {
    invalidate: [['api', '/registration-checkouts/{id}']],
  });
  const submit = async () => {
    if (!token) return;
    setFailure(null);
    try {
      await retry.submit({ path: { id: checkout.id }, body: { paymentMethodToken: token } });
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  if (!DevPaymentMethodPicker) {
    return (
      <StateView
        variant="pending-decision"
        subject="Paying again in the app"
        decisions={['DEC-019']}
        owner="Technical lead/account owners"
      />
    );
  }
  return (
    <View>
      <DevPaymentMethodPicker value={token} onChange={setToken} />
      <ButtonRow>
        <Button
          label="Try this payment method"
          onPress={() => void submit()}
          disabled={!token || reachable === false}
          busy={retry.isProcessing}
        />
      </ButtonRow>
      <CommandError error={failure} onRetry={() => void submit()} />
    </View>
  );
}

function OutcomeContent({ checkout }: { checkout: Checkout }) {
  const router = useRouter();
  const { update } = useRegistrationProgress();
  const operation = useApiQuery({
    path: '/operations/{id}',
    request: { path: { id: checkout.operationId } },
  });
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: checkout.basketId } },
  });
  const lines = basket.data?.lines ?? [];
  const names = useParticipantNames(lines.map((l) => l.participantPersonId));
  const offerings = useApiRecords(
    '/offerings/{id}',
    lines.map((l) => l.offeringId),
  );
  const completed = checkout.status === 'completed';
  const enrollments = useApiRecords('/enrollments/{id}', checkout.enrollmentIds, completed);
  const placementIds = Object.values(enrollments)
    .map((e) => e.data?.placementRequestId)
    .filter((id): id is string => typeof id === 'string');
  const placements = useApiRecords('/placement-requests/{id}', placementIds, completed);
  const terminal = TERMINAL.includes(checkout.status);

  // A finished checkout is no longer "in progress" on this device (the record stays in the API).
  useEffect(() => {
    if (terminal) void update({ basketId: null, quoteId: null, checkoutId: null });
  }, [terminal, update]);

  const status = checkoutStatus(checkout);
  const payment = checkout.payment;
  return (
    <View>
      <Section title="Registration and payment">
        <StatusBadge {...status} testID="outcome-status" />
        {operation.data ? (
          <View
            accessible
            accessibilityLabel={`Request status: ${operationLabel(operation.data).label}`}
          >
            <Body muted>Request status</Body>
            <StatusBadge {...operationLabel(operation.data)} />
          </View>
        ) : null}
      </Section>

      {payment ? (
        <Section title="Payment">
          <StatusBadge {...paymentStatus(payment)} testID="outcome-payment" />
          <Detail label="Amount" value={formatMoney(payment.amountMinor, payment.currency)} />
          {payment.status === 'unknown' ? (
            <Body>
              Do not pay again. The payment provider has not confirmed this payment yet; it is being
              checked. You will not be charged twice.
            </Body>
          ) : null}
          {payment.status === 'action_required' ? (
            DevPaymentMethodPicker ? (
              <Body>
                The development payment provider finishes this step by itself; this screen updates
                when it does.
              </Body>
            ) : (
              <StateView
                variant="pending-decision"
                subject="Completing the payment provider's step in the app"
                decisions={['DEC-019']}
                owner="Technical lead/account owners"
              />
            )
          ) : null}
          {payment.failureReason && payment.status === 'failed' ? (
            <Body>{payment.failureReason}</Body>
          ) : null}
        </Section>
      ) : checkout.paymentKind === 'none' ? (
        <Section title="Payment">
          <Body>Nothing was due, so no payment was taken.</Body>
        </Section>
      ) : null}

      {checkout.nextAction === 'retry_payment' && payment && payment.status !== 'succeeded' ? (
        <Section title="Pay with another method">
          <Body>
            The payment did not go through. Your places stay held only until the hold ends.
          </Body>
          <RetryPayment checkout={checkout} />
        </Section>
      ) : null}

      {checkout.receipt ? (
        <Section title="Receipt">
          <Detail
            label="Received"
            value={formatMoney(checkout.receipt.amountMinor, checkout.receipt.currency)}
          />
          <Detail label="On" value={formatInstant(checkout.receipt.receivedAt)} />
          {checkout.receipt.excessMinor > 0 ? (
            <Detail
              label="More than was owed"
              value={formatMoney(checkout.receipt.excessMinor, checkout.receipt.currency)}
            />
          ) : null}
        </Section>
      ) : null}

      {checkout.status === 'recovery_required' ? (
        <Section title="What happens next">
          <Body>
            Your payment was received but your registration is not finished yet. Staff are
            completing it. Do not pay again.
          </Body>
          {checkout.recovery ? <Body muted>{checkout.recovery.message}</Body> : null}
        </Section>
      ) : null}
      {checkout.status === 'compensated' ? (
        <Section title="What happens next">
          <Body>
            {checkout.recovery?.plan === 'credit'
              ? 'Your payment was returned to you as a credit on your account.'
              : 'Your payment is being returned to you.'}
          </Body>
        </Section>
      ) : null}

      <Section title="Each registration">
        <View accessibilityRole="list">
          {lines.map((line) => {
            const offeringName = offerings[line.offeringId]?.data?.name ?? 'Activity';
            const name = names(line.participantPersonId);
            const enrollment = line.enrollmentId ? enrollments[line.enrollmentId]?.data : undefined;
            const placementId = enrollment?.placementRequestId;
            const placement = placementId ? (placements[placementId]?.data ?? null) : null;
            const lineStatus = completed
              ? enrollment
                ? enrollmentStatus(enrollment, offeringName, placement)
                : { tone: 'pending' as const, label: 'Checking this registration' }
              : checkout.status === 'compensated' || checkout.status === 'aborted'
                ? { tone: 'neutral' as const, label: 'Not registered' }
                : { tone: 'pending' as const, label: 'Waiting for the payment outcome' };
            return (
              <View
                key={line.id}
                style={styles.line}
                accessible
                accessibilityLabel={`${name}: ${offeringName}. ${lineStatus.label}`}
                testID={`outcome-line-${line.id}`}
              >
                <Body>{`${name}: ${offeringName}`}</Body>
                <StatusBadge {...lineStatus} />
              </View>
            );
          })}
        </View>
      </Section>

      <ButtonRow>
        {completed ? (
          <Button label="See your schedule" onPress={() => router.push('/schedule')} />
        ) : null}
        {terminal ? (
          <Button
            label="Discover more activities"
            variant="secondary"
            onPress={() => router.push(registrationRoutes.discover())}
          />
        ) : null}
      </ButtonRow>
    </View>
  );
}

export function CheckoutOutcomeScreen({ checkoutId }: { checkoutId: string }) {
  const { session } = useApp();
  const [polling, setPolling] = useState(true);
  const checkout = useApiQuery({
    path: '/registration-checkouts/{id}',
    request: { path: { id: checkoutId } },
    enabled: session.status === 'signed_in',
    refetchInterval: polling ? OUTCOME_POLL_MS : false,
  });
  useEffect(() => {
    if (checkout.data) setPolling(checkoutInFlight(checkout.data));
  }, [checkout.data]);
  return (
    <Screen>
      <RequireSession what="your registration">
        <QueryBoundary
          query={checkout}
          label="your registration"
          empty={{ title: 'Not available', description: '' }}
          unavailableOffline={['Paying again']}
        >
          {(c) => <OutcomeContent checkout={c} />}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/outcome/[checkoutId].tsx. */
export function CheckoutOutcomeRoute() {
  const checkoutId = param(useLocalSearchParams<{ checkoutId: string }>().checkoutId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Your registration' }} />
      <CheckoutOutcomeScreen checkoutId={checkoutId} />
    </>
  );
}

const styles = StyleSheet.create({
  line: {
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
