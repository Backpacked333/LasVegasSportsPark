/**
 * Paying for a registration (`POST /v1/registration-checkouts`; Review & pay 1f row 7: "same
 * behavior as Pay sheet 2b"; SPK-REG-005, SPK-REG-006, SPK-PAY-007, SPK-AT-028, §4.9, §4.11).
 * Money is never optimistic: the button waits for the API, one idempotency key per intent through
 * `useApiCommand`, and an answer that may have taken effect is never a failure:
 *
 * - no definite answer (`mayHaveTakenEffect`: no answer, the same key still running, any 5xx, a
 *   success whose answer could not be read): "Payment outcome being confirmed. Do not pay again.",
 *   paying blocked, the quote remembered on the device (so a restart leads back here) and asked
 *   again with the same key when the app returns to the foreground, when the connection comes back
 *   and on "Check now"; the API keeps one checkout per quote, so asking again never charges twice;
 * - committed with its answer lost (IDEMPOTENCY_OUTCOME_UNAVAILABLE): the failure is shown and the
 *   price is read again (it names the checkout);
 * - a re-check refused before it ran (payments paused during a restore): only the check did not
 *   run, "Do not pay again" stays;
 * - any other answer is definite: the remembered quote is forgotten.
 *
 * Extracted from the checkout screen this flow replaces; the rules are unchanged.
 */
import { ApiError, type Schema } from '@sportspark/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RESPONSE_UNREADABLE_CODE,
  mayHaveTakenEffect,
  refusedAfterNoAnswer,
  tookEffectOutcomeLost,
} from '../../api/command-outcome';
import { useApiCommand } from '../../api/useApiCommand';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { MY_BASKETS_KEY, MY_CHECKOUTS_KEY } from '../registration/in-progress';
import { useRegistrationProgress } from '../registration/progress';

type Checkout = Schema<'Checkout'>;
export type CheckoutBody = Schema<'CreateCheckoutRequest'>;

export const UNKNOWN_OUTCOME_LABEL = 'Payment outcome being confirmed. Do not pay again.';
export const UNKNOWN_OUTCOME_BODY =
  'We did not get an answer about this payment. Do not pay again. When the app is back online or opened again, it asks with the same request, which can never charge you twice.';
/** RESPONSE_UNREADABLE: the service answered success, but its answer could not be read. */
export const UNREADABLE_OUTCOME_BODY =
  'The service answered about this payment, but its answer could not be read. Do not pay again. When the app is back online or opened again, it asks with the same request, which can never charge you twice.';

/** Conflict sub-codes the checkout coordinator sends in `details.code`. */
export function conflictCode(error: ApiError | null): string | null {
  if (error?.code !== 'RESOURCE_CONFLICT') return null;
  const details = error.details as { code?: unknown } | undefined;
  return typeof details?.code === 'string' ? details.code : null;
}

/** The place went (or the held place lapsed) while paying: nothing was charged. */
export function placeLost(error: ApiError | null): boolean {
  return error?.code === 'CAPACITY_UNAVAILABLE' || conflictCode(error) === 'HOLD_EXPIRED';
}

export interface PaymentFailure {
  error: ApiError;
  retry: () => void;
}

export function useRegistrationPayment(input: {
  quoteId: string | null;
  onCheckout: (checkout: Checkout) => void;
  /** The price was committed elsewhere: read it again. */
  onReread: () => void;
}) {
  const { services } = useApp();
  const { reachable } = useConnectivity();
  const { update } = useRegistrationProgress();
  const checkout = useApiCommand('post', '/registration-checkouts', {
    invalidate: [MY_CHECKOUTS_KEY, MY_BASKETS_KEY],
  });
  const [failure, setFailure] = useState<PaymentFailure | null>(null);
  const [unknownOutcome, setUnknownOutcome] = useState<CheckoutBody | null>(null);
  const [unanswered, setUnanswered] = useState(0);
  const [unreadable, setUnreadable] = useState(false);
  const { onCheckout, onReread, quoteId } = input;

  const pay = useCallback(
    async (body: CheckoutBody) => {
      setFailure(null);
      await update({ pendingCheckoutQuoteId: body.quoteId });
      try {
        const result = await checkout.submit({ body });
        setUnknownOutcome(null);
        await update({ pendingCheckoutQuoteId: null });
        onCheckout(result);
      } catch (error) {
        const apiError = error as ApiError;
        if (mayHaveTakenEffect(apiError)) {
          setUnknownOutcome(body);
          setUnreadable(apiError.code === RESPONSE_UNREADABLE_CODE);
          setUnanswered((n) => n + 1);
        } else if (tookEffectOutcomeLost(apiError)) {
          setUnknownOutcome(null);
          setFailure({ error: apiError, retry: () => void pay(body) });
          onReread();
        } else if (refusedAfterNoAnswer(apiError)) {
          setUnknownOutcome(body);
          setFailure({ error: apiError, retry: () => void pay(body) });
        } else {
          setUnknownOutcome(null);
          if (ApiError.is(error)) await update({ pendingCheckoutQuoteId: null });
          setFailure({ error: apiError, retry: () => void pay(body) });
        }
      }
    },
    [checkout, update, onCheckout, onReread],
  );

  // Re-send the checkout whose answer never arrived, with the same key, on return to the app or
  // when the connection comes back (SPK-UX-001 foreground refresh).
  const pendingRef = useRef(unknownOutcome);
  const payRef = useRef(pay);
  useEffect(() => {
    pendingRef.current = unknownOutcome;
    payRef.current = pay;
  });
  useEffect(
    () =>
      services.appState.subscribe((active) => {
        if (active && pendingRef.current) void payRef.current(pendingRef.current);
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
      void payRef.current(pendingRef.current);
    }
  }, [reachable]);

  // A new price starts clean, unless a payment for the old one is still unanswered.
  useEffect(() => {
    if (pendingRef.current) return;
    setFailure(null);
  }, [quoteId]);

  return {
    pay,
    processing: checkout.isProcessing,
    failure,
    clearFailure: () => setFailure(null),
    unknownOutcome,
    unanswered,
    unreadable,
    outcomeLost: failure !== null && tookEffectOutcomeLost(failure.error),
    checkRefused: failure !== null && refusedAfterNoAnswer(failure.error),
  };
}
