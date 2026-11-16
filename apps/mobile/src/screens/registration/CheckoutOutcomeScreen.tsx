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
 * When "Check again" of a new payment that got no answer is refused before running
 * (`refusedAfterNoAnswer`: payments paused while the service recovers from a restore, SPK-AT-028),
 * the screen stays "Checking your new payment" and shows "Check not run" with the API's message:
 * the earlier payment may still have gone through (R4-CLIENTS-A11Y-COPY-01).
 *
 * Once the API reports the checkout completed (PA-11, ADR-008): the success illustration above the
 * exact status phrase ("Registration complete"), "See it in Calendar" (/schedule), and a success
 * haptic, played once; the screen and the announced status say the same, so the haptic is never
 * the only feedback (SPK-UX-009).
 *
 * A checkout of another account is answered NOT_FOUND and reads "not available". Offline, the last
 * known status is shown with its age. The checkout's status and the payment's are announced to
 * screen readers when they appear and whenever a re-read changes them (`ui/announce`, SPK-UX-009).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { illustrations } from '../../artwork/manifest';
import { pendingMessage } from '../../copy/pending';
import {
  mayHaveTakenEffect,
  refusedAfterNoAnswer,
  tookEffectOutcomeLost,
} from '../../api/command-outcome';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../ui/CommandError';
import { DevPaymentMethodPicker } from '../../features/registration/dev';
import { formatInstant, formatMoney } from '../../features/registration/format';
import { useKnownFacilityZone } from '../../features/today/known-zone';
import { useParticipantNames } from '../../features/registration/participants';
import { MY_BASKETS_KEY, MY_CHECKOUTS_KEY } from '../../features/registration/in-progress';
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
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveRegion, sentences } from '../../ui/announce';
import { Artwork } from '../../ui/Artwork';
import { Button } from '../../ui/Button';
import { FieldValue } from '../../ui/Field';
import { useHaptics } from '../../ui/PressableScale';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { RefusedBeforeRunning } from '../../ui/RefusedBeforeRunning';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { Section } from '../../ui/Section';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

type Checkout = Schema<'Checkout'>;

/** How often an in-flight checkout is re-read (a display refresh, not a policy). */
export const OUTCOME_POLL_MS = 5_000;

const TERMINAL: readonly Checkout['status'][] = ['completed', 'compensated', 'aborted'];

function RetryPayment({
  checkout,
  confirming,
  onUnknown,
}: {
  checkout: Checkout;
  /** The last retry got no definite answer: offer only "Check again" with the same request. */
  confirming: boolean;
  onUnknown: () => void;
}) {
  const styles = useStyles();
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
      const apiError = error as ApiError;
      // No definite answer (`mayHaveTakenEffect`, any 5xx included), or an earlier attempt under
      // this key committed with its answer lost (IDEMPOTENCY_OUTCOME_UNAVAILABLE): never shown as
      // a failure, the new attempt may be processing or already captured (SPK-PAY-007). The
      // checkout is read until the API reports it; no other method is offered meanwhile.
      if (mayHaveTakenEffect(apiError) || tookEffectOutcomeLost(apiError)) {
        onUnknown();
        return;
      }
      setFailure(apiError);
    }
  };
  if (confirming) {
    return (
      <View>
        <View style={styles.actions}>
          <Button
            label="Check again"
            variant="secondary"
            onPress={() => void submit()}
            disabled={reachable === false}
            busy={retry.isProcessing}
            accessibilityHint="Asks about the same payment again; it is never charged twice"
          />
        </View>
        {/* SPK-AT-028: the check did not run; the earlier payment may still go through. */}
        {failure && refusedAfterNoAnswer(failure) ? (
          <RefusedBeforeRunning error={failure} priorUnknown payment testID="retry-check-refused" />
        ) : null}
      </View>
    );
  }
  if (!DevPaymentMethodPicker) {
    return (
      <StateView
        variant="pending-decision"
        subject="Paying again in the app"
        message={pendingMessage('DEC-019')}
        decisions={['DEC-019']}
        owner="Technical lead/account owners"
      />
    );
  }
  return (
    <View>
      <DevPaymentMethodPicker value={token} onChange={setToken} />
      <View style={styles.actions}>
        <Button
          label="Try this payment method"
          onPress={() => void submit()}
          disabled={!token || reachable === false}
          busy={retry.isProcessing}
        />
      </View>
      <CommandError wording="registration" error={failure} onRetry={() => void submit()} />
    </View>
  );
}

function OutcomeContent({ checkout }: { checkout: Checkout }) {
  const zone = useKnownFacilityZone().zone;
  const styles = useStyles();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { progress, update } = useRegistrationProgress();
  /** A payment retry got no definite answer; cleared when the API reports a new attempt. */
  const [retryUnknown, setRetryUnknown] = useState(false);
  const paymentId = checkout.payment?.id ?? null;
  useEffect(() => {
    setRetryUnknown(false);
  }, [paymentId]);
  useEffect(() => {
    if (!retryUnknown) return undefined;
    // Re-read the checkout until the API reports the new attempt (polling is off for a failed one).
    const reread = () =>
      void queryClient.invalidateQueries({ queryKey: ['api', '/registration-checkouts/{id}'] });
    reread();
    const timer = setInterval(reread, OUTCOME_POLL_MS);
    return () => clearInterval(timer);
  }, [retryUnknown, queryClient]);
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
  // PA-11, ADR-008: a success haptic once the API reports the registration complete (once per
  // checkout); the screen shows it and the status is announced, so it is never the only sign.
  const haptics = useHaptics();
  const celebrated = useRef<string | null>(null);
  useEffect(() => {
    if (!completed || celebrated.current === checkout.id) return;
    celebrated.current = checkout.id;
    haptics.success();
  }, [completed, checkout.id, haptics]);

  // The API has this checkout, so its list finds it from now on: the device no longer needs to
  // remember the request for its quote. Only this checkout's quote is forgotten, never another
  // checkout whose answer is still missing.
  useEffect(() => {
    if (progress.pendingCheckoutQuoteId === checkout.quoteId) {
      void update({ pendingCheckoutQuoteId: null });
    }
  }, [update, progress.pendingCheckoutQuoteId, checkout.quoteId]);
  // A finished checkout leaves "In progress" (SPK-UX-001): the lists are read again.
  useEffect(() => {
    if (!terminal && checkout.status !== 'recovery_required') return;
    void queryClient.invalidateQueries({ queryKey: MY_CHECKOUTS_KEY });
    void queryClient.invalidateQueries({ queryKey: MY_BASKETS_KEY });
  }, [terminal, checkout.status, queryClient]);

  const status = checkoutStatus(checkout);
  const payment = checkout.payment;
  const paymentBadge = payment
    ? retryUnknown
      ? { tone: 'warning' as const, label: 'Payment outcome being confirmed. Do not pay again.' }
      : paymentStatus(payment)
    : null;
  const paymentExplanation =
    payment?.status === 'unknown'
      ? 'Do not pay again. The payment provider has not confirmed this payment yet; it is being checked. You will not be charged twice.'
      : payment?.status === 'failed' && payment.failureReason && !retryUnknown
        ? payment.failureReason
        : null;
  return (
    <View>
      {completed ? (
        <Artwork
          source={illustrations.success}
          aspectRatio={1}
          contentFit="contain"
          style={styles.art}
          testID="outcome-success-art"
        />
      ) : null}
      <Section title="Registration and payment">
        {/* SPK-UX-009, NA-A01: every change of the checkout's status (re-read while it runs) is
            announced, and so is the payment's below. */}
        <LiveRegion announcement={status.label}>
          <StatusBadge {...status} testID="outcome-status" />
        </LiveRegion>
        {operation.data ? (
          <View
            accessible
            accessibilityLabel={`Request status: ${operationLabel(operation.data).label}`}
          >
            <Text variant="caption" tone="muted">
              Request status
            </Text>
            <StatusBadge {...operationLabel(operation.data)} />
          </View>
        ) : null}
      </Section>

      {payment && paymentBadge ? (
        <Section title="Payment">
          <LiveRegion announcement={sentences(paymentBadge.label, paymentExplanation)}>
            <StatusBadge {...paymentBadge} testID="outcome-payment" />
            <FieldValue
              layout="inline"
              label="Amount"
              value={formatMoney(payment.amountMinor, payment.currency)}
            />
            {paymentExplanation ? <Text variant="body">{paymentExplanation}</Text> : null}
          </LiveRegion>
          {payment.status === 'action_required' ? (
            DevPaymentMethodPicker ? (
              <Text variant="body">
                The development payment provider finishes this step by itself; this screen updates
                when it does.
              </Text>
            ) : (
              <StateView
                variant="pending-decision"
                subject="Completing the payment provider's step in the app"
                message={pendingMessage('DEC-019')}
                decisions={['DEC-019']}
                owner="Technical lead/account owners"
              />
            )
          ) : null}
        </Section>
      ) : checkout.paymentKind === 'none' ? (
        <Section title="Payment">
          <Text variant="body">Nothing was due, so no payment was taken.</Text>
        </Section>
      ) : null}

      {checkout.nextAction === 'retry_payment' && payment && payment.status !== 'succeeded' ? (
        <Section title={retryUnknown ? 'Checking your new payment' : 'Pay with another method'}>
          <Text variant="body">
            {retryUnknown
              ? 'No answer came back for your new payment. It may still go through, so do not pay again: this screen checks it.'
              : 'The payment did not go through. Your spots stay saved only for a short time.'}
          </Text>
          <RetryPayment
            checkout={checkout}
            confirming={retryUnknown}
            onUnknown={() => setRetryUnknown(true)}
          />
        </Section>
      ) : null}

      {checkout.receipt ? (
        <Section title="Receipt">
          <FieldValue
            layout="inline"
            label="Received"
            value={formatMoney(checkout.receipt.amountMinor, checkout.receipt.currency)}
          />
          <FieldValue
            layout="inline"
            label="On"
            value={formatInstant(checkout.receipt.receivedAt, zone)}
          />
          {checkout.receipt.excessMinor > 0 ? (
            <FieldValue
              layout="inline"
              label="More than was owed"
              value={formatMoney(checkout.receipt.excessMinor, checkout.receipt.currency)}
            />
          ) : null}
        </Section>
      ) : null}

      {checkout.status === 'recovery_required' ? (
        <Section title="What happens next">
          <Text variant="body">
            Your payment was received but your registration is not finished yet. Staff are
            completing it. Do not pay again.
          </Text>
          {checkout.recovery ? (
            <Text variant="caption" tone="muted">
              {checkout.recovery.message}
            </Text>
          ) : null}
        </Section>
      ) : null}
      {checkout.status === 'compensated' ? (
        <Section title="What happens next">
          <Text variant="body">
            {checkout.recovery?.plan === 'credit'
              ? 'Your payment was returned to you as a credit on your account.'
              : 'Your payment is being returned to you.'}
          </Text>
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
              : outcomeLineStatus(checkout, retryUnknown);
            return (
              <View
                key={line.id}
                style={styles.line}
                accessible
                accessibilityLabel={[
                  `${name}: ${offeringName}`,
                  lineStatus.label,
                  ...line.addons.map((addon) => addon.name),
                  ...(line.uniform ? [`${line.uniform.name}, size ${line.uniform.size}`] : []),
                ].join('. ')}
                testID={`outcome-line-${line.id}`}
              >
                <Text variant="headline">{`${name}: ${offeringName}`}</Text>
                <StatusBadge {...lineStatus} />
                {/* SPK-PAY-014, SPK-REG-012: what was bought with the place. */}
                {line.addons.map((addon) => (
                  <Text key={addon.addonId} variant="caption" tone="muted">
                    {addon.selection === 'per_session'
                      ? `${addon.name} × ${addon.quantity === 1 ? '1 day' : `${addon.quantity} days`}`
                      : addon.name}
                  </Text>
                ))}
                {line.uniform ? (
                  <Text variant="caption" tone="muted">
                    {`${line.uniform.name}, size ${line.uniform.size}`}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      </Section>

      <View style={styles.actions}>
        {completed ? (
          <Button
            label="See it in Calendar"
            onPress={() => router.push('/schedule')}
            icon="calendar_today"
            size="lg"
            block
          />
        ) : null}
        {terminal ? (
          <Button
            label="Explore more activities"
            variant="secondary"
            onPress={() => router.push(registrationRoutes.discover())}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * A line's words before the checkout completed, consistent with the badges above it (SPK-UX-004,
 * SPK-UX-010, journeys.md section 3).
 */
export function outcomeLineStatus(
  checkout: Pick<Checkout, 'status' | 'payment'>,
  retryUnknown = false,
): { tone: 'pending' | 'neutral' | 'warning'; label: string } {
  if (checkout.status === 'compensated' || checkout.status === 'aborted') {
    return { tone: 'neutral', label: 'Not registered' };
  }
  if (checkout.status === 'recovery_required') {
    return { tone: 'warning', label: 'Payment received. Registration being completed.' };
  }
  if (checkout.status === 'finalizing') return { tone: 'pending', label: 'Payment processing' };
  const payment = checkout.payment?.status;
  if (!retryUnknown && (payment === 'failed' || payment === 'canceled')) {
    return { tone: 'neutral', label: 'Not registered yet' };
  }
  return { tone: 'pending', label: 'Waiting for the payment outcome' };
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

const useStyles = makeStyles(({ colors }) => ({
  line: {
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  art: {
    alignSelf: 'center',
    width: '50%',
    maxWidth: 200,
    marginTop: spacing.lg,
    backgroundColor: 'transparent',
  },
  actions: { gap: spacing.sm, paddingHorizontal: layout.gutter, paddingVertical: spacing.lg },
}));
