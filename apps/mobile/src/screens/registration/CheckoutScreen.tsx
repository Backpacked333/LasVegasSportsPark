/**
 * SCR-C-14 Checkout and payment, the Pay step of registering (PA-11, ADR-008) (SPK-REG-005, SPK-REG-006, SPK-REG-007, SPK-PAY-007, §4.9, §4.11;
 * SPK-AT-005 final-place contention, SPK-AT-006 payment after hold expiry; journeys A5a, A5b).
 *
 * 1. Hold: `POST /v1/baskets/{id}/hold` acquires the server-owned holds; the expiry is the server's
 *    and the countdown is informational. Losing the final place reads CAPACITY_UNAVAILABLE with
 *    the waitlist as the permitted alternative; nothing is charged.
 * 2. Pay: `POST /v1/registration-checkouts` for the stored quote. Card details never enter the
 *    app: a payment method comes from the approved provider's own flow, which is not selected
 *    (DEC-019, Technical lead/account owners), so release builds say "Paying in the app isn't
 *    available yet. Pay at the front desk for now. Your spots are held until <hold expiry>." (the
 *    basket's server-owned hold expiry, formatted as everywhere else), with DEC-019 and its owner
 *    in the "Details for support" fold; development builds use the API's fake provider. A quote with nothing due is confirmed
 *    without a payment.
 * 3. The answer, whatever it is, hands off to the checkout outcome (SCR-C-15), which shows success
 *    only when the API confirms it.
 *
 * Payment uncertainty (SPK-PAY-007): when the request gets no definite answer (`mayHaveTakenEffect`:
 * timeout, connection lost, app backgrounded, the same key still running, any 5xx, a success status
 * whose answer could not be read), the outcome is unknown, never "failed", and the remembered
 * quote that leads back here is kept. The screen says "Do not pay again" and asks again with the
 * same idempotency key (§4.9) when the app returns to the foreground or the connection comes back,
 * or when the customer taps "Check now"; the API also keeps one checkout per quote, so asking
 * again can never charge twice. "Payment outcome being confirmed" is announced to screen readers
 * with "Check now" each time a check gets no answer (`ui/announce`, SPK-UX-009). When asking again
 * finds that the first attempt committed but its answer was lost (IDEMPOTENCY_OUTCOME_UNAVAILABLE),
 * the checkout exists: it reads "This may already have been done", the price and basket are read
 * again (the price then names the checkout, which this screen opens), and paying is not offered.
 *
 * Payments paused while the service recovers from a restore (SPK-AT-028: `refusedBeforeRunning`,
 * a 503 the guard answers before the idempotency key is read):
 * - on the first attempt it is a definite answer: nothing ran, so it reads "Not done" with the
 *   API's message, never "Do not pay again", and nothing is left to look for later;
 * - on a re-check of a checkout that got no answer (`refusedAfterNoAnswer`) only the check did not
 *   run, and the earlier attempt may have created the checkout and taken the payment: "Do not pay
 *   again", the remembered quote and the blocked Pay stay, and the refusal reads "Check not run"
 *   with the API's message beside "Check now" (R4-CLIENTS-A11Y-COPY-01).
 *
 * Approval before payment (SPK-REG-007, DEC-028 pending): a basket awaiting approval cannot be
 * paid. States: loading; ready (hold active); validation failure; permission restriction (payer
 * may not pay for a line: not available); stale (hold expired or released, price expired: get a
 * new price); offline (payment cannot start); processing ("Payment processing"); recovery required
 * ("Payment outcome being confirmed. Do not pay again.").
 */
import { ApiError, type Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { pendingMessage } from '../../copy/pending';
import {
  RESPONSE_UNREADABLE_CODE,
  mayHaveTakenEffect,
  refusedAfterNoAnswer,
  tookEffectOutcomeLost,
} from '../../api/command-outcome';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import { DevPaymentMethodPicker } from '../../features/registration/dev';
import { ExpiryNotice } from '../../features/registration/ExpiryNotice';
import { formatInstant, formatMoney } from '../../features/registration/format';
import { JoinWaitlistButton } from '../../features/registration/JoinWaitlist';
import { useParticipantNames } from '../../features/registration/participants';
import {
  checkoutOf,
  MY_BASKETS_KEY,
  MY_CHECKOUTS_KEY,
  useMyCheckouts,
} from '../../features/registration/in-progress';
import { useRegistrationProgress } from '../../features/registration/progress';
import { param, registrationRoutes } from '../../features/registration/routes';
import { basketStatus, holdStatus, quoteStatus } from '../../features/registration/status';
import { RegistrationSteps } from '../../features/registration/steps';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LiveRegion, sentences } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { ChoiceCard } from '../../ui/ChoiceList';
import { FieldValue } from '../../ui/Field';
import { InfoCard } from '../../ui/InfoCard';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { RefusedBeforeRunning } from '../../ui/RefusedBeforeRunning';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StatusBadge } from '../../ui/StatusBadge';
import { SupportDetails } from '../../ui/SupportDetails';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';
import { quoteIsUsable } from './QuoteReviewScreen';

const UNKNOWN_OUTCOME_LABEL = 'Payment outcome being confirmed. Do not pay again.';
const UNKNOWN_OUTCOME_BODY =
  'We did not get an answer about this payment. Do not pay again. When the app is back online or opened again, it asks with the same request, which can never charge you twice.';
/** RESPONSE_UNREADABLE: the service answered success, but its answer could not be read. */
const UNREADABLE_OUTCOME_BODY =
  'The service answered about this payment, but its answer could not be read. Do not pay again. When the app is back online or opened again, it asks with the same request, which can never charge you twice.';

/** DEC-019: what a release build says instead of a payment form (PA-11, `src/copy/pending.ts`). */
export function payAtDeskMessage(holdExpiresAt: string | null): string {
  return [
    "Paying in the app isn't available yet.",
    pendingMessage('DEC-019'),
    holdExpiresAt ? `Your spots are held until ${formatInstant(holdExpiresAt)}.` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

type Quote = Schema<'Quote'>;
type Basket = Schema<'Basket'>;
type CheckoutBody = Schema<'CreateCheckoutRequest'>;

interface Failure {
  error: ApiError;
  retry: () => void;
}

/** Conflict sub-codes the checkout coordinator sends in `details.code`. */
function conflictCode(error: ApiError | null): string | null {
  if (error?.code !== 'RESOURCE_CONFLICT') return null;
  const details = error.details as { code?: unknown } | undefined;
  return typeof details?.code === 'string' ? details.code : null;
}

/**
 * Re-sends the checkout whose answer never arrived, with the same idempotency key, when the app
 * comes back to the foreground or the connection returns (SPK-UX-001 foreground refresh).
 */
function useResumeUnknownOutcome(
  pending: CheckoutBody | null,
  resume: (body: CheckoutBody) => void,
) {
  const { services } = useApp();
  const { reachable } = useConnectivity();
  const pendingRef = useRef(pending);
  const resumeRef = useRef(resume);
  useEffect(() => {
    pendingRef.current = pending;
    resumeRef.current = resume;
  });
  useEffect(
    () =>
      services.appState.subscribe((active) => {
        if (active && pendingRef.current) resumeRef.current(pendingRef.current);
      }),
    [services.appState],
  );
  const wasOffline = useRef(reachable === false);
  useEffect(() => {
    if (reachable === false) {
      wasOffline.current = true;
      return;
    }
    if (reachable === true && wasOffline.current && pendingRef.current) {
      wasOffline.current = false;
      resumeRef.current(pendingRef.current);
    }
  }, [reachable]);
}

function CheckoutContent({
  quote,
  basket,
  refetch,
}: {
  quote: Quote;
  basket: Basket;
  refetch: () => void;
}) {
  const styles = useStyles();
  const router = useRouter();
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const { update } = useRegistrationProgress();
  const names = useParticipantNames(basket.lines.map((l) => l.participantPersonId));
  const started =
    quote.status === 'consumed' ||
    basket.status === 'checking_out' ||
    basket.status === 'fulfilled';
  // The checkout already started for this price, as the API names or lists it (SPK-UX-001).
  const myCheckouts = useMyCheckouts(started && quote.consumedByCheckoutId === null);
  const existingCheckoutId =
    quote.consumedByCheckoutId ?? checkoutOf(myCheckouts.data, { quoteId: quote.id })?.id ?? null;
  const hold = useApiCommand('post', '/baskets/{id}/hold', {
    invalidate: [['api', '/baskets/{id}'], MY_BASKETS_KEY],
  });
  const checkout = useApiCommand('post', '/registration-checkouts', {
    invalidate: [MY_CHECKOUTS_KEY, MY_BASKETS_KEY],
  });
  const requote = useApiCommand('post', '/registration-quotes');
  const [token, setToken] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** The checkout request whose outcome is unknown; resent with the same key, never re-paid. */
  const [unknownOutcome, setUnknownOutcome] = useState<CheckoutBody | null>(null);
  /** How many times asking got no definite answer: each one is announced (SPK-UX-009). */
  const [unanswered, setUnanswered] = useState(0);
  /** The last unanswered check was answered success, but the answer could not be read. */
  const [unreadable, setUnreadable] = useState(false);

  const pay = useCallback(
    async (body: CheckoutBody) => {
      setFailure(null);
      // Saved before sending: if the app is closed before the answer arrives, the basket and the
      // "In progress" card lead back here, and re-posting this quote returns the existing
      // checkout. Once the API answers, its own list holds the checkout.
      await update({ pendingCheckoutQuoteId: quote.id });
      try {
        const result = await checkout.submit({ body });
        setUnknownOutcome(null);
        await update({ pendingCheckoutQuoteId: null });
        router.replace(registrationRoutes.outcome(result.id));
      } catch (error) {
        const apiError = error as ApiError;
        if (mayHaveTakenEffect(apiError)) {
          // No definite answer (a lost connection or timeout, the same key still running, any
          // 5xx, a success whose answer could not be read, PAYMENT_OUTCOME_UNKNOWN): the checkout
          // may exist and its payment may be on its way, so it is never a failure, the remembered
          // quote is kept and it is asked again under the same key (SPK-PAY-007).
          setUnknownOutcome(body);
          setUnreadable(apiError.code === RESPONSE_UNREADABLE_CODE);
          setUnanswered((n) => n + 1);
        } else if (tookEffectOutcomeLost(apiError)) {
          // An earlier attempt under this key committed and its answer was lost: the checkout
          // exists. The price is read again (it reads "consumed" and names the checkout) and
          // paying is not offered; the remembered quote still leads back here.
          setUnknownOutcome(null);
          setFailure({ error: apiError, retry: () => void pay(body) });
          refetch();
        } else if (refusedAfterNoAnswer(apiError)) {
          // The re-check of a checkout that got no answer was refused before it ran (payments
          // paused during a restore, SPK-AT-028). That proves only that this check did not run:
          // the earlier attempt under this key may have created the checkout and taken the
          // payment. The outcome stays unknown, the remembered quote is kept and paying stays
          // blocked (SPK-PAY-007); "Check now" asks again with the same key.
          setUnknownOutcome(body);
          setFailure({ error: apiError, retry: () => void pay(body) });
        } else {
          setUnknownOutcome(null);
          // A definite answer (a 4xx refusal, or a refusal before running such as payments paused
          // during a restore) created no checkout: nothing is left to look for later. Every
          // answer that may have created one took a branch above (the shared predicates).
          if (ApiError.is(error)) await update({ pendingCheckoutQuoteId: null });
          setFailure({ error: apiError, retry: () => void pay(body) });
        }
      }
    },
    [checkout, update, quote.id, router, refetch],
  );
  useResumeUnknownOutcome(unknownOutcome, (body) => void pay(body));

  const holdPlaces = async () => {
    setFailure(null);
    try {
      await hold.submit({ path: { id: basket.id }, body: { expectedRevision: basket.revision } });
    } catch (error) {
      setFailure({ error: error as ApiError, retry: () => void holdPlaces() });
    }
  };
  const newPrice = async () => {
    setFailure(null);
    try {
      const next = await requote.submit({
        body: {
          basketId: quote.basketId,
          discountCodes: quote.discounts.map((d) => d.code).filter((c): c is string => c !== null),
          creditIds: quote.appliedCredits.map((c) => c.creditId),
        },
      });
      router.replace(registrationRoutes.checkout(next.id));
    } catch (error) {
      setFailure({ error: error as ApiError, retry: () => void newPrice() });
    }
  };

  const m = (v: number) => formatMoney(v, quote.currency);
  const usable = quoteIsUsable(quote, now);
  const held = basket.status === 'held';
  const ended = basket.status === 'expired' || basket.status === 'released';
  const dueNow = quote.dueNowMinor;
  const installments = quote.paymentPlan === 'installments';
  const conflict = conflictCode(failure?.error ?? null);
  const capacityLost =
    failure?.error.code === 'CAPACITY_UNAVAILABLE' || conflict === 'HOLD_EXPIRED';
  // A command of this screen committed with its answer lost: nothing is offered to pay until the
  // price and basket read again show where it stands (the failure's "Reload").
  const outcomeLost = failure !== null && tookEffectOutcomeLost(failure.error);
  // The re-check of an unanswered checkout was refused before it ran: shown with "Check now".
  const checkRefused = failure !== null && refusedAfterNoAnswer(failure.error);
  const body: CheckoutBody =
    dueNow === 0
      ? { quoteId: quote.id, authorizeFutureInstallments: false }
      : {
          quoteId: quote.id,
          payment: { method: 'provider', paymentMethodToken: token ?? '' },
          authorizeFutureInstallments: installments && authorized,
        };
  const canPay =
    usable &&
    held &&
    !basket.approvalPending &&
    !offline &&
    unknownOutcome === null &&
    !outcomeLost &&
    (dueNow === 0 || token !== null) &&
    (!installments || authorized);

  if (started) {
    return (
      <View>
        <RegistrationSteps step="Pay" />
        <Section title="Checkout started">
          <Text variant="body">
            A checkout already exists for this price. It is never charged twice.
          </Text>
          {existingCheckoutId ? (
            <Button
              label="See your payment and registration"
              onPress={() => router.replace(registrationRoutes.outcome(existingCheckoutId))}
            />
          ) : (
            <Button
              label="Check this checkout again"
              onPress={() => void pay({ quoteId: quote.id, authorizeFutureInstallments: false })}
              disabled={offline}
            />
          )}
        </Section>
      </View>
    );
  }

  return (
    <View>
      <RegistrationSteps step="Pay" />
      <Section title="Checkout">
        <FieldValue
          layout="inline"
          label="Due now"
          value={m(dueNow)}
          emphasis
          testID="checkout-due-now"
        />
        {quote.futureObligations.map((f) => (
          <FieldValue
            layout="inline"
            key={f.sequence}
            label={`Later payment ${f.sequence}`}
            value={m(f.amountMinor)}
          />
        ))}
        <StatusBadge {...quoteStatus(quote, now)} />
        <StatusBadge {...basketStatus(basket, now)} testID="checkout-basket-status" />
      </Section>
      {held && basket.holdExpiresAt ? (
        <ExpiryNotice
          expiresAt={basket.holdExpiresAt}
          status={holdStatus(basket.holdExpiresAt, now)}
          explanation="The facility's system lets your saved spots go at this time; the countdown is a guide. If a payment finishes after that, its outcome is still recorded and confirmed or returned."
          onLapsed={refetch}
          testID="checkout-hold"
        />
      ) : null}

      {unknownOutcome ? (
        <Section title="Payment">
          {/* SPK-UX-009, NA-A01: announced with its next action, again after each unanswered check. */}
          <LiveRegion
            announcement={sentences(
              UNKNOWN_OUTCOME_LABEL,
              unreadable ? UNREADABLE_OUTCOME_BODY : UNKNOWN_OUTCOME_BODY,
              'Check now',
            )}
            occurrence={unanswered}
            testID="checkout-outcome-unknown-live"
          >
            <StatusBadge
              tone="warning"
              label={UNKNOWN_OUTCOME_LABEL}
              testID="checkout-outcome-unknown"
            />
            <Text variant="body">
              {unreadable ? UNREADABLE_OUTCOME_BODY : UNKNOWN_OUTCOME_BODY}
            </Text>
            <Button
              label="Check now"
              onPress={() => void pay(unknownOutcome)}
              busy={checkout.isProcessing}
              disabled={offline}
            />
          </LiveRegion>
          {checkRefused && failure ? (
            <RefusedBeforeRunning
              error={failure.error}
              priorUnknown
              payment
              testID="checkout-check-refused"
            />
          ) : null}
        </Section>
      ) : null}

      {basket.approvalPending ? (
        <Section title="Awaiting approval">
          <StatusBadge tone="pending" label="Awaiting approval" />
          <Text variant="body">Staff must approve a line before you can pay.</Text>
        </Section>
      ) : null}

      {!usable && unknownOutcome === null ? (
        <Section title="Price expired">
          <StatusBadge tone="warning" label="Price expired. Get a new price." />
          <Button
            label="Get a new price"
            onPress={() => void newPrice()}
            busy={requote.isProcessing}
            disabled={offline}
          />
        </Section>
      ) : null}

      {ended ? (
        <Section title="Your held place was released">
          <Text variant="body">
            Nothing was charged. Go back to your cart to start again or join a waitlist.
          </Text>
          <Button
            label="Back to your cart"
            onPress={() => router.push(registrationRoutes.basket(basket.id))}
          />
        </Section>
      ) : null}

      {usable && basket.status === 'open' && !basket.approvalPending && unknownOutcome === null ? (
        <Section title="Save your spots">
          <Text variant="body">
            Your spots are saved for a short time while you pay. Saving a spot is not a
            confirmation.
          </Text>
          <Button
            label="Save my spots"
            onPress={() => void holdPlaces()}
            busy={hold.isProcessing}
            disabled={offline}
          />
        </Section>
      ) : null}

      {usable && held && !basket.approvalPending && unknownOutcome === null ? (
        dueNow === 0 ? (
          <Section title="Nothing to pay now">
            <Text variant="body">Nothing is due now.</Text>
          </Section>
        ) : DevPaymentMethodPicker ? (
          <DevPaymentMethodPicker value={token} onChange={setToken} />
        ) : (
          // DEC-019 (PA-11): what to do instead, in words; the decision is in the fold.
          <InfoCard
            tone="info"
            icon="storefront"
            message={payAtDeskMessage(basket.holdExpiresAt)}
            style={styles.card}
            testID="checkout-pay-at-desk"
          >
            <SupportDetails decisions={['DEC-019']} owner="Technical lead/account owners" />
          </InfoCard>
        )
      ) : null}

      {installments && usable && held ? (
        <Section title="Future payments">
          <ChoiceCard
            option={{
              value: 'authorize',
              label: 'I authorize the future payments listed on my price',
            }}
            mode="multiple"
            checked={authorized}
            onPress={() => setAuthorized((v) => !v)}
            accessibilityLabel="I authorize the future payments listed on my price"
            testID="authorize-installments"
          />
        </Section>
      ) : null}

      <CommandError
        error={checkRefused ? null : (failure?.error ?? null)}
        onRetry={failure?.retry}
        onReload={() => {
          setFailure(null);
          refetch();
        }}
        onRequote={() => void newPrice()}
        onCompleteForms={() => router.push(registrationRoutes.basketForms(basket.id))}
      />
      {conflict === 'QUOTE_STALE' ? (
        <View style={styles.actions}>
          <Button label="Get a new price" onPress={() => void newPrice()} disabled={offline} />
        </View>
      ) : null}
      {capacityLost ? (
        <Section title="No place available">
          <Text variant="body">Nothing was charged. You can join the waitlist instead.</Text>
          {basket.lines.map((line) => (
            <JoinWaitlistButton
              key={line.id}
              line={line}
              participantName={names(line.participantPersonId)}
              disabled={offline}
            />
          ))}
        </Section>
      ) : null}

      {usable && held && unknownOutcome === null && !outcomeLost ? (
        <View style={styles.actions}>
          <Button
            label={dueNow === 0 ? 'Confirm registration' : `Pay ${m(dueNow)}`}
            onPress={() => void pay(body)}
            disabled={!canPay}
            busy={checkout.isProcessing}
            size="lg"
            block
          />
          {offline ? (
            <Text variant="caption" tone="muted">
              Payment cannot start without a connection.
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function CheckoutScreen({ quoteId }: { quoteId: string }) {
  const { session } = useApp();
  const quote = useApiQuery({
    path: '/registration-quotes/{id}',
    request: { path: { id: quoteId } },
    enabled: session.status === 'signed_in',
  });
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: quote.data?.basketId ?? '' } },
    enabled: quote.data !== undefined,
  });
  const both = {
    data: quote.data && basket.data ? { quote: quote.data, basket: basket.data } : undefined,
    error: quote.error ?? basket.error,
    fetchStatus:
      quote.fetchStatus === 'idle' && basket.fetchStatus === 'idle'
        ? ('idle' as const)
        : quote.fetchStatus === 'paused' || basket.fetchStatus === 'paused'
          ? ('paused' as const)
          : ('fetching' as const),
    updatedAt: basket.updatedAt ?? quote.updatedAt,
    refetch: () => {
      void quote.refetch();
      void basket.refetch();
    },
  };
  return (
    <Screen>
      <RequireSession what="checkout">
        <QueryBoundary
          query={both}
          label="checkout"
          empty={{ title: 'No checkout', description: '' }}
          unavailableOffline={['Holding places', 'Payment']}
        >
          {({ quote: q, basket: b }) => (
            <CheckoutContent key={q.id} quote={q} basket={b} refetch={both.refetch} />
          )}
        </QueryBoundary>
      </RequireSession>
    </Screen>
  );
}

/** Route component for app/registration/checkout/[quoteId].tsx. */
export function CheckoutRoute() {
  const quoteId = param(useLocalSearchParams<{ quoteId: string }>().quoteId) ?? '';
  return (
    <>
      <Stack.Screen options={{ title: 'Checkout' }} />
      <CheckoutScreen quoteId={quoteId} />
    </>
  );
}

const useStyles = makeStyles(() => ({
  card: { marginHorizontal: layout.gutter, marginTop: spacing.lg },
  actions: { gap: spacing.sm, paddingHorizontal: layout.gutter, paddingVertical: spacing.lg },
}));
