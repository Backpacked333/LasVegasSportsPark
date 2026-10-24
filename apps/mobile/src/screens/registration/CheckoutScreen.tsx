/**
 * SCR-C-14 Checkout and payment (SPK-REG-005, SPK-REG-006, SPK-REG-007, SPK-PAY-007, §4.9, §4.11;
 * SPK-AT-005 final-place contention, SPK-AT-006 payment after hold expiry; journeys A5a, A5b).
 *
 * 1. Hold: `POST /v1/baskets/{id}/hold` acquires the server-owned holds; the expiry is the server's
 *    and the countdown is informational. Losing the final place reads CAPACITY_UNAVAILABLE with
 *    the waitlist as the permitted alternative; nothing is charged.
 * 2. Pay: `POST /v1/registration-checkouts` for the stored quote. Card details never enter the
 *    app: a payment method comes from the approved provider's own flow, which is not selected
 *    (DEC-019, Technical lead/account owners), so release builds show that pending state;
 *    development builds use the API's fake provider. A quote with nothing due is confirmed
 *    without a payment.
 * 3. The answer, whatever it is, hands off to the checkout outcome (SCR-C-15), which shows success
 *    only when the API confirms it.
 *
 * Payment uncertainty (SPK-PAY-007): when the request gets no answer (timeout, connection lost,
 * app backgrounded), the outcome is unknown, never "failed". The screen says "Do not pay again"
 * and asks again with the same idempotency key (§4.9) when the app returns to the foreground or
 * the connection comes back, or when the customer taps "Check now"; the API also keeps one
 * checkout per quote, so asking again can never charge twice.
 *
 * Approval before payment (SPK-REG-007, DEC-028 pending): a basket awaiting approval cannot be
 * paid. States: loading; ready (hold active); validation failure; permission restriction (payer
 * may not pay for a line: not available); stale (hold expired or released, price expired: get a
 * new price); offline (payment cannot start); processing ("Payment processing"); recovery required
 * ("Payment outcome being confirmed. Do not pay again.").
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../features/registration/CommandError';
import { DevPaymentMethodPicker } from '../../features/registration/dev';
import { ExpiryNotice } from '../../features/registration/ExpiryNotice';
import { formatMoney } from '../../features/registration/format';
import { JoinWaitlistButton } from '../../features/registration/JoinWaitlist';
import { useParticipantNames } from '../../features/registration/participants';
import { useRegistrationProgress } from '../../features/registration/progress';
import { param, registrationRoutes } from '../../features/registration/routes';
import { basketStatus, holdStatus, quoteStatus } from '../../features/registration/status';
import { Body, ButtonRow, ChoiceRow, Detail, Section } from '../../features/registration/ui';
import { useApp, useConnectivity, useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { quoteIsUsable } from './QuoteReviewScreen';

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
  const router = useRouter();
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const { progress, update } = useRegistrationProgress();
  const names = useParticipantNames(basket.lines.map((l) => l.participantPersonId));
  const hold = useApiCommand('post', '/baskets/{id}/hold', {
    invalidate: [['api', '/baskets/{id}']],
  });
  const checkout = useApiCommand('post', '/registration-checkouts');
  const requote = useApiCommand('post', '/registration-quotes');
  const [token, setToken] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** The checkout request whose outcome is unknown; resent with the same key, never re-paid. */
  const [unknownOutcome, setUnknownOutcome] = useState<CheckoutBody | null>(null);

  const pay = useCallback(
    async (body: CheckoutBody) => {
      setFailure(null);
      // Saved before sending: if the app is closed before the answer arrives, the basket and the
      // resume card lead back here, and re-posting this quote returns the existing checkout.
      await update({ quoteId: quote.id, pendingCheckoutQuoteId: quote.id });
      try {
        const result = await checkout.submit({ body });
        setUnknownOutcome(null);
        await update({
          basketId: quote.basketId,
          quoteId: quote.id,
          checkoutId: result.id,
          pendingCheckoutQuoteId: null,
        });
        router.replace(registrationRoutes.outcome(result.id));
      } catch (error) {
        const apiError = error as ApiError;
        if (apiError.isOffline || apiError.code === 'IDEMPOTENCY_IN_PROGRESS') {
          setUnknownOutcome(body);
        } else {
          setUnknownOutcome(null);
          setFailure({ error: apiError, retry: () => void pay(body) });
        }
      }
    },
    [checkout, update, quote.basketId, quote.id, router],
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
      await update({ basketId: quote.basketId, quoteId: next.id });
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
    (dueNow === 0 || token !== null) &&
    (!installments || authorized);

  if (
    quote.status === 'consumed' ||
    basket.status === 'checking_out' ||
    basket.status === 'fulfilled'
  ) {
    return (
      <Section title="Checkout started">
        <Body>A checkout already exists for this price. It is never charged twice.</Body>
        {progress.checkoutId && progress.quoteId === quote.id ? (
          <Button
            label="See your payment and registration"
            onPress={() =>
              router.replace(registrationRoutes.outcome(progress.checkoutId as string))
            }
          />
        ) : (
          <Button
            label="Check this checkout again"
            onPress={() => void pay({ quoteId: quote.id, authorizeFutureInstallments: false })}
            disabled={offline}
          />
        )}
      </Section>
    );
  }

  return (
    <View>
      <Section title="Checkout">
        <Detail label="Due now" value={m(dueNow)} emphasis testID="checkout-due-now" />
        {quote.futureObligations.map((f) => (
          <Detail key={f.sequence} label={`Later payment ${f.sequence}`} value={m(f.amountMinor)} />
        ))}
        <StatusBadge {...quoteStatus(quote, now)} />
        <StatusBadge {...basketStatus(basket, now)} testID="checkout-basket-status" />
      </Section>
      {held && basket.holdExpiresAt ? (
        <ExpiryNotice
          expiresAt={basket.holdExpiresAt}
          status={holdStatus(basket.holdExpiresAt, now)}
          explanation="The facility's system releases held places at this time; the countdown is a guide. If a payment finishes after that, its outcome is still recorded and confirmed or returned."
          onLapsed={refetch}
          testID="checkout-hold"
        />
      ) : null}

      {unknownOutcome ? (
        <Section title="Payment">
          <StatusBadge
            tone="warning"
            label="Payment outcome being confirmed. Do not pay again."
            testID="checkout-outcome-unknown"
          />
          <Body>
            We did not get an answer about this payment. Do not pay again. When the app is back
            online or opened again, it asks with the same request, which can never charge you twice.
          </Body>
          <Button
            label="Check now"
            onPress={() => void pay(unknownOutcome)}
            busy={checkout.isProcessing}
            disabled={offline}
          />
        </Section>
      ) : null}

      {basket.approvalPending ? (
        <Section title="Awaiting approval">
          <StatusBadge tone="pending" label="Awaiting approval" />
          <Body>Staff must approve a line before you can pay.</Body>
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
          <Body>
            Nothing was charged. Go back to your basket to start again or join a waitlist.
          </Body>
          <Button
            label="Back to your basket"
            onPress={() => router.push(registrationRoutes.basket(basket.id))}
          />
        </Section>
      ) : null}

      {usable && basket.status === 'open' && !basket.approvalPending && unknownOutcome === null ? (
        <Section title="Hold your places">
          <Body>
            Your places are held for a short time while you pay. Holding a place is not a
            confirmation.
          </Body>
          <Button
            label="Hold my places"
            onPress={() => void holdPlaces()}
            busy={hold.isProcessing}
            disabled={offline}
          />
        </Section>
      ) : null}

      {usable && held && !basket.approvalPending && unknownOutcome === null ? (
        dueNow === 0 ? (
          <Section title="Nothing to pay now">
            <Body>Your quote has nothing due now.</Body>
          </Section>
        ) : DevPaymentMethodPicker ? (
          <DevPaymentMethodPicker value={token} onChange={setToken} />
        ) : (
          <View>
            <StateView
              variant="pending-decision"
              subject="Paying in the app"
              decisions={['DEC-019']}
              owner="Technical lead/account owners"
            />
            <Body muted>
              Card details never enter this app; payment happens in the payment provider's own form
              once a provider is chosen.
            </Body>
          </View>
        )
      ) : null}

      {installments && usable && held ? (
        <Section title="Future payments">
          <ChoiceRow
            label="I authorize the future payments listed on my price"
            checked={authorized}
            onToggle={() => setAuthorized((v) => !v)}
            testID="authorize-installments"
          />
        </Section>
      ) : null}

      <CommandError
        error={failure?.error ?? null}
        onRetry={failure?.retry}
        onReload={() => {
          setFailure(null);
          refetch();
        }}
        onRequote={() => void newPrice()}
        onCompleteForms={() => router.push(registrationRoutes.basketForms(basket.id))}
      />
      {conflict === 'QUOTE_STALE' ? (
        <ButtonRow>
          <Button label="Get a new price" onPress={() => void newPrice()} disabled={offline} />
        </ButtonRow>
      ) : null}
      {capacityLost ? (
        <Section title="No place available">
          <Body>Nothing was charged. You can join the waitlist instead.</Body>
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

      {usable && held && unknownOutcome === null ? (
        <ButtonRow>
          <Button
            label={dueNow === 0 ? 'Confirm registration' : `Pay ${m(dueNow)}`}
            onPress={() => void pay(body)}
            disabled={!canPay}
            busy={checkout.isProcessing}
          />
          {offline ? <Body muted>Payment cannot start without a connection.</Body> : null}
        </ButtonRow>
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
