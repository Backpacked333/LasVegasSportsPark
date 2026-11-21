/**
 * Review & pay with everything around it (redesign handoff 1f, 4e, 2e "offer ends during
 * payment"; SPK-REG-005, SPK-REG-008, SPK-PAY-007, SPK-AT-005, SPK-AT-006): prepares the cart
 * (`useRegisterBasket`), pays (`useRegistrationPayment`, then the outcome screen, Done 1g), and
 * when a place went:
 *
 * - from the flow or a cart: the last-place sheet (4e) with the free weeks re-priced
 *   (`POST /v1/discounts/evaluate`) and one tap to join the waitlist (`POST /v1/waitlist-entries`
 *   with what the line chose, `waitlistChoicesOf`);
 * - from a waitlist offer: "This offer ended before payment." Nothing was charged.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { PAY_METHODS } from '../../../features/money/PaySheet';
import type { DesiredLine } from '../../../features/register/basket-plan';
import { lastPlaceModel, type LastPlaceChoice } from '../../../features/register/last-place';
import { useRegisterBasket } from '../../../features/register/useRegisterBasket';
import {
  placeLost,
  useRegistrationPayment,
} from '../../../features/register/useRegistrationPayment';
import { previewLines, useDiscountPreview } from '../../../features/registration/CampWeeks';
import { formatMoney } from '../../../features/registration/format';
import {
  basketCheckoutOf,
  MY_WAITLIST_KEY,
  useMyCheckouts,
  useRecoveryCheckouts,
} from '../../../features/registration/in-progress';
import { useRegistrationProgress } from '../../../features/registration/progress';
import { waitlistChoicesOf } from '../../../features/registration/JoinWaitlist';
import { registrationRoutes } from '../../../features/registration/routes';
import { InfoCard } from '../../../ui/InfoCard';
import { Button } from '../../../ui/Button';
import { LiveRegion, sentences } from '../../../ui/announce';
import { layout, makeStyles, spacing } from '../../../ui/theme';
import { LastPlaceSheet } from './LastPlaceSheet';
import { ReviewStep } from './ReviewStep';

type Offering = Schema<'Offering'>;
type OfferingUniform = Schema<'OfferingUniform'>;

export const OFFER_ENDED_BEFORE_PAYMENT = 'This offer ended before payment.';

export interface ReviewControllerProps {
  basketId: string | null;
  /** The lines the flow wants; null for a cart opened from elsewhere. */
  desired: readonly DesiredLine[] | null;
  /** Lines cannot be made yet (a required uniform size is missing). */
  waiting: boolean;
  offering: Offering | null;
  subtitle: string;
  heldFor: string;
  weekNameOf: (offeringId: string) => string | null;
  nameOf: (personId: string) => string;
  peopleIds: readonly string[];
  codes: readonly string[];
  onCodes: (codes: string[]) => void;
  uniform: OfferingUniform | null;
  sizes: Readonly<Record<string, string>>;
  onSize: (personId: string, size: string) => void;
  onBasket: (basketId: string) => void;
  /** A waitlist offer's end, when paying for an offered place. */
  offerEndsAt?: string | null;
  /** Keep only these weeks (4e "Book Week 2 only"). */
  onKeepWeeks?: (weekIds: string[]) => void;
  /** Back to choosing (4e "Start over", or "Edit"). */
  onStartOver?: () => void;
  onBack: () => void;
  onEdit?: () => void;
  /** Called with the checkout before the outcome screen opens (the flow drops its draft). */
  onPaid?: () => void;
}

export function ReviewController(props: ReviewControllerProps) {
  const styles = useStyles();
  const router = useRouter();
  const prep = useRegisterBasket({
    basketId: props.basketId,
    desired: props.desired,
    // The API makes the signed-in customer the cart's owner.
    ownerPersonId: null,
    onBasket: props.onBasket,
  });
  const [method, setMethod] = useState<string | null>(PAY_METHODS[0]?.token ?? null);
  const [payAfterPrepare, setPayAfterPrepare] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinFailure, setJoinFailure] = useState<ApiError | null>(null);
  const codesRef = useRef(props.codes);
  codesRef.current = props.codes;
  const { onCodes, onPaid } = props;

  const runPrepare = useCallback(async () => {
    const result = await prep.prepare(codesRef.current);
    if (result.codes.length !== codesRef.current.length) onCodes(result.codes);
    if (result.status === 'place_lost') setLostOpen(true);
    return result.status;
  }, [prep, onCodes]);

  const payment = useRegistrationPayment({
    quoteId: prep.quote?.id ?? null,
    onCheckout: (checkout) => {
      onPaid?.();
      router.replace(registrationRoutes.outcome(checkout.id));
    },
    onReread: () => void runPrepare(),
  });

  // Prepare on entry and whenever the lines asked for change.
  const desiredKey = useMemo(
    () => (props.desired ? JSON.stringify(props.desired) : `basket:${props.basketId ?? ''}`),
    [props.desired, props.basketId],
  );
  useEffect(() => {
    if (props.waiting) return;
    void runPrepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the lines change
  }, [desiredKey, props.waiting]);

  // A code applied or removed: a new price for the cart as it is.
  const codesKey = props.codes.join(',');
  const firstCodes = useRef(true);
  useEffect(() => {
    if (firstCodes.current) {
      firstCodes.current = false;
      return;
    }
    void prep.reprice(props.codes).then((kept) => {
      if (kept && kept.length !== props.codes.length) onCodes(kept);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the codes change
  }, [codesKey]);

  const pay = useCallback(() => {
    const quote = prep.quote;
    if (!quote) return;
    void payment.pay(
      quote.dueNowMinor === 0
        ? { quoteId: quote.id, authorizeFutureInstallments: false }
        : {
            quoteId: quote.id,
            payment: { method: 'provider', paymentMethodToken: method ?? '' },
            authorizeFutureInstallments: false,
          },
    );
  }, [prep.quote, payment, method]);

  // 4e "Pay $116.00 and join the list": pay once the new price is ready.
  useEffect(() => {
    if (!payAfterPrepare || prep.status !== 'ready' || prep.basket?.status !== 'held') return;
    setPayAfterPrepare(false);
    pay();
  }, [payAfterPrepare, prep.status, prep.basket?.status, pay]);

  // The place went while paying (CAPACITY_UNAVAILABLE, or the hold lapsed): nothing was charged.
  const lostWhilePaying = placeLost(payment.failure?.error ?? null);
  useEffect(() => {
    if (lostWhilePaying && !props.offerEndsAt) setLostOpen(true);
  }, [lostWhilePaying, props.offerEndsAt]);

  const lines = useMemo(
    () => (prep.basket?.lines ?? []).filter((l) => l.outcome === 'pending' || l.outcome === 'held'),
    [prep.basket],
  );
  const lineOfferings = [...new Set(lines.map((l) => l.offeringId))];
  const lost = lostOpen && !props.offerEndsAt;
  const availability = useApiQuery({
    path: '/offering-availability',
    request: { query: { offeringIds: lineOfferings.join(',') } },
    enabled: lost && lineOfferings.length > 0,
  });
  // Read the places again each time the sheet opens: the counts changed while paying.
  const refetchAvailability = availability.refetch;
  useEffect(() => {
    if (lost) void refetchAvailability();
  }, [lost, refetchAvailability]);
  const fullIds = (availability.data?.items ?? [])
    .filter((a) => a.status === 'full' || (a.remaining !== null && a.remaining <= 0))
    .map((a) => a.offeringId);
  // Until the re-read answers, every line counts as possibly full (never a guess of a free week).
  const full = availability.data ? fullIds : lineOfferings;
  const free = lineOfferings.filter((id) => !full.includes(id));
  const persons = [...new Set(lines.map((l) => l.participantPersonId))];
  const currency = prep.quote?.currency ?? null;
  const freePreview = useDiscountPreview(
    currency,
    previewLines(free, persons),
    lost && free.length > 0,
  );
  const model = lost
    ? lastPlaceModel({
        full: full.map((id) => props.weekNameOf(id) ?? props.offering?.name ?? 'This activity'),
        free: free.map((id) => props.weekNameOf(id) ?? props.offering?.name ?? 'This activity'),
        freeTotal: freePreview.data
          ? formatMoney(freePreview.data.totalNetMinor, freePreview.data.currency)
          : null,
        discountsBefore: prep.quote?.discounts.map((d) => d.name) ?? [],
        discountsAfter:
          freePreview.data?.discounts
            .filter((d) => d.applied && d.amountMinor > 0)
            .map((d) => d.name) ?? [],
        camp: props.onKeepWeeks !== undefined && lineOfferings.length > 1,
      })
    : null;

  const join = useApiCommand('post', '/waitlist-entries', { invalidate: [MY_WAITLIST_KEY] });
  const joinFull = async (): Promise<string | null> => {
    let first: string | null = null;
    for (const line of lines.filter((l) => full.includes(l.offeringId))) {
      const entry = await join.submit({
        body: {
          offeringId: line.offeringId,
          participantPersonId: line.participantPersonId,
          intent: line.intent,
          preferences: {},
          ...waitlistChoicesOf(line),
        },
      });
      first ??= entry.id;
    }
    return first;
  };
  const choose = async (choice: LastPlaceChoice) => {
    setJoinFailure(null);
    if (choice === 'start_over') {
      setLostOpen(false);
      props.onStartOver?.();
      return;
    }
    setJoining(true);
    try {
      if (choice === 'wait') {
        const entryId = await joinFull();
        setLostOpen(false);
        if (entryId) router.replace(registrationRoutes.waitlist(entryId));
        return;
      }
      if (choice === 'book_and_wait') await joinFull();
      setLostOpen(false);
      payment.clearFailure();
      setPayAfterPrepare(true);
      props.onKeepWeeks?.(free);
    } catch (error) {
      setJoinFailure(error as ApiError);
    } finally {
      setJoining(false);
    }
  };

  // A payment for this cart already started (the app was closed mid-payment, or a link to an old
  // checkout): it is looked up, never started again (SPK-PAY-007, SPK-UX-001).
  const started = prep.status === 'started';
  const { progress } = useRegistrationProgress();
  const checkouts = useMyCheckouts(started);
  const recovery = useRecoveryCheckouts(started);
  const existing =
    started && prep.basket ? basketCheckoutOf(checkouts.data, recovery.data, prep.basket.id) : null;

  const offerEnded =
    props.offerEndsAt !== undefined &&
    props.offerEndsAt !== null &&
    (lostWhilePaying || prep.status === 'place_lost');

  return (
    <View style={styles.root}>
      <ReviewStep
        prep={prep}
        payment={payment}
        offering={props.offering}
        subtitle={props.subtitle}
        heldFor={props.heldFor}
        weekNameOf={props.weekNameOf}
        nameOf={props.nameOf}
        codes={props.codes}
        onCodes={props.onCodes}
        uniform={props.uniform}
        peopleIds={props.peopleIds}
        sizes={props.sizes}
        onSize={props.onSize}
        offerEndsAt={offerEnded ? null : props.offerEndsAt}
        onBack={props.onBack}
        onEdit={props.onEdit}
        onRetry={() => void runPrepare()}
        method={method}
        onMethod={setMethod}
        onPay={pay}
        notice={
          <>
            {started ? (
              <View style={styles.notice} testID="review-started">
                <InfoCard
                  tone="info"
                  title="A payment for this registration already started"
                  message="It is never charged twice. See where it stands."
                />
                {existing ? (
                  <Button
                    label="See your payment and registration"
                    onPress={() => router.replace(registrationRoutes.outcome(existing.id))}
                  />
                ) : progress.pendingCheckoutQuoteId ? (
                  <Button
                    label="Check this payment again"
                    busy={payment.processing}
                    onPress={() =>
                      void payment.pay({
                        quoteId: progress.pendingCheckoutQuoteId as string,
                        authorizeFutureInstallments: false,
                      })
                    }
                  />
                ) : null}
              </View>
            ) : null}
            {offerEnded ? (
              <View style={styles.notice}>
                <LiveRegion
                  announcement={sentences(OFFER_ENDED_BEFORE_PAYMENT, "You weren't charged.")}
                  occurrence="offer-ended"
                >
                  <InfoCard
                    tone="warning"
                    title={OFFER_ENDED_BEFORE_PAYMENT}
                    message="You weren't charged. The place has gone to the next family; you stay on the waitlist for later places."
                    testID="offer-ended-before-payment"
                  />
                </LiveRegion>
                <Button label="Done" variant="secondary" onPress={props.onBack} />
              </View>
            ) : null}
          </>
        }
      />
      <LastPlaceSheet
        open={lost && model !== null}
        model={model}
        busy={joining}
        onChoose={(choice) => void choose(choice)}
        onClose={() => setLostOpen(false)}
      />
      {joinFailure ? (
        <View style={styles.ended}>
          <InfoCard tone="danger" message="Joining the waitlist didn't save. Try again." />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  root: { flex: 1 },
  notice: { gap: spacing.sm },
  ended: {
    position: 'absolute',
    left: layout.gutter,
    right: layout.gutter,
    bottom: 140,
    gap: spacing.sm,
  },
}));
