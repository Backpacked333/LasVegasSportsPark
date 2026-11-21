/**
 * Review & pay's preparation (redesign handoff 1f; INTERACTIONS "1e–1g" rows 5 to 7; SPK-REG-004,
 * SPK-REG-005, SPK-REG-009, SPK-PAY-001, SPK-AT-005, §4.9): the registration's own cart is
 * brought to the lines the parent chose, its places are held ("Maya's place is held for 14:52"
 * comes first on Review), and a binding price is asked for:
 *
 * 1. `GET /v1/baskets/{id}` of the flow's cart, or `POST /v1/baskets` (all or nothing, DEC-026)
 *    when it has none or the old one is finished;
 * 2. lines nobody wants any more are removed and missing ones added (`basket-plan.ts`); a held
 *    cart is let go of first (`POST .../release`);
 * 3. `POST /v1/baskets/{id}/hold` (the server's expiry is the timer). MISSING_ACKNOWLEDGMENT: a
 *    form is to be signed first (the price is still shown); CAPACITY_UNAVAILABLE: the last place
 *    went (4e, nothing charged);
 * 4. `POST /v1/registration-quotes` with the codes applied. An unknown code is answered inline
 *    ("That code isn't valid for this activity.") and the price without it stays.
 *
 * Every command goes through `useApiCommand` (one idempotency key per input) with the cart's
 * `expectedRevision`. A cart opened from elsewhere (the household cart, a waitlist offer) has no
 * lines to plan: only steps 3 and 4 run.
 */
import { ApiError, type Schema } from '@sportspark/api-client';
import { useCallback, useRef, useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApi } from '../../providers/AppProviders';
import { MY_BASKETS_KEY } from '../registration/in-progress';
import { planChanges, type DesiredLine } from './basket-plan';

type Basket = Schema<'Basket'>;
type Quote = Schema<'Quote'>;

export type PrepareStatus =
  | 'idle'
  | 'working'
  | 'ready'
  | 'needs_forms'
  | 'place_lost'
  /** A payment for this cart already started (checking out, or done): never priced or paid again. */
  | 'started'
  | 'failed';

/** Why a held cart is let go of: the parent changed their choices on Review. */
export const CHANGE_REASON = 'The customer changed their choices before paying.';

export const INVALID_CODE_MESSAGE = "That code isn't valid for this activity.";

function unknownCodesOf(error: unknown): string[] {
  if (!ApiError.is(error) || error.code !== 'VALIDATION_FAILED') return [];
  const details = error.details as { unknownCodes?: unknown } | undefined;
  return Array.isArray(details?.unknownCodes)
    ? details.unknownCodes.filter((c): c is string => typeof c === 'string')
    : [];
}

export function useRegisterBasket(input: {
  /** The flow's cart, once it exists. */
  basketId: string | null;
  /** The lines to plan; null for a cart opened from elsewhere (nothing to plan). */
  desired: readonly DesiredLine[] | null;
  /** The cart's owner when one is made (the signed-in person). */
  ownerPersonId: string | null;
  onBasket: (basketId: string) => void;
}) {
  const api = useApi();
  const createBasket = useApiCommand('post', '/baskets', { invalidate: [MY_BASKETS_KEY] });
  const addLine = useApiCommand('post', '/baskets/{id}/lines', { invalidate: [MY_BASKETS_KEY] });
  const removeLine = useApiCommand('post', '/baskets/{id}/lines/{lineId}/remove', {
    invalidate: [MY_BASKETS_KEY],
  });
  const release = useApiCommand('post', '/baskets/{id}/release', { invalidate: [MY_BASKETS_KEY] });
  const hold = useApiCommand('post', '/baskets/{id}/hold', {
    invalidate: [['api', '/baskets/{id}'], MY_BASKETS_KEY],
  });
  const requote = useApiCommand('post', '/registration-quotes');
  const [status, setStatus] = useState<PrepareStatus>('idle');
  const [basket, setBasket] = useState<Basket | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const running = useRef(false);
  const inputRef = useRef(input);
  inputRef.current = input;

  /** Prices the cart with these codes; an unknown code is dropped and said inline. */
  const priceWith = useCallback(
    async (
      target: Basket,
      codes: readonly string[],
    ): Promise<{ quote: Quote; codes: string[] }> => {
      try {
        const next = await requote.submit({
          body: { basketId: target.id, discountCodes: [...codes] },
        });
        return { quote: next, codes: [...codes] };
      } catch (error) {
        const unknown = unknownCodesOf(error);
        if (unknown.length === 0) throw error;
        setCodeError(INVALID_CODE_MESSAGE);
        const kept = codes.filter((c) => !unknown.some((u) => u.toLowerCase() === c.toLowerCase()));
        const next = await requote.submit({ body: { basketId: target.id, discountCodes: kept } });
        return { quote: next, codes: kept };
      }
    },
    [requote],
  );

  /**
   * Runs the steps above; resolves with the codes that stood (an unknown one is dropped) and the
   * final status. Concurrent calls are ignored (a second tap while working).
   */
  const prepare = useCallback(
    async (codes: readonly string[]): Promise<{ status: PrepareStatus; codes: string[] }> => {
      if (running.current) return { status: 'working', codes: [...codes] };
      running.current = true;
      setStatus('working');
      setFailure(null);
      setCodeError(null);
      const { basketId, desired, ownerPersonId, onBasket } = inputRef.current;
      try {
        let current: Basket | null = null;
        if (basketId) {
          current = await api.get('/baskets/{id}', { path: { id: basketId } });
        }
        if (
          current &&
          (current.status === 'checking_out' ||
            current.status === 'fulfilled' ||
            current.status === 'partially_fulfilled')
        ) {
          setBasket(current);
          setStatus('started');
          return { status: 'started', codes: [...codes] };
        }
        if (desired) {
          if (!current || (current.status !== 'open' && current.status !== 'held')) {
            current = await createBasket.submit({
              body: {
                ...(ownerPersonId ? { ownerPersonId } : {}),
                fulfillmentMode: 'all_or_nothing',
                acceptPartialFulfillment: false,
              },
            });
            onBasket(current.id);
          }
          const changes = planChanges(current.lines, desired);
          if ((changes.remove.length > 0 || changes.add.length > 0) && current.status === 'held') {
            current = await release.submit({
              path: { id: current.id },
              body: { reason: CHANGE_REASON, expectedRevision: current.revision },
            });
          }
          for (const line of changes.remove) {
            current = await removeLine.submit({
              path: { id: current.id, lineId: line.id },
              body: { expectedRevision: current.revision },
            });
          }
          for (const line of changes.add) {
            current = await addLine.submit({
              path: { id: current.id },
              body: {
                participantPersonId: line.participantPersonId,
                offeringId: line.offeringId,
                intent: line.intent,
                quantity: 1,
                ...(line.addons.length > 0 ? { addons: line.addons } : {}),
                ...(line.uniform ? { uniform: line.uniform } : {}),
                ...(line.priceTierId ? { priceTierId: line.priceTierId } : {}),
                ...(line.selectedSessionIds && line.selectedSessionIds.length > 0
                  ? { selectedSessionIds: line.selectedSessionIds }
                  : {}),
                expectedRevision: current.revision,
              },
            });
          }
        }
        if (!current) throw new Error('No cart to review.');
        setBasket(current);
        let next: PrepareStatus = 'ready';
        if (current.status === 'open' && !current.approvalPending) {
          try {
            current = await hold.submit({
              path: { id: current.id },
              body: { expectedRevision: current.revision },
            });
            setBasket(current);
          } catch (error) {
            const apiError = error as ApiError;
            if (apiError.code === 'MISSING_ACKNOWLEDGMENT') next = 'needs_forms';
            else if (apiError.code === 'CAPACITY_UNAVAILABLE') {
              setFailure(apiError);
              setStatus('place_lost');
              return { status: 'place_lost', codes: [...codes] };
            } else throw error;
          }
        }
        const priced = await priceWith(current, codes);
        setQuote(priced.quote);
        setStatus(next);
        return { status: next, codes: priced.codes };
      } catch (error) {
        setFailure(error as ApiError);
        setStatus('failed');
        return { status: 'failed', codes: [...codes] };
      } finally {
        running.current = false;
      }
    },
    [api, createBasket, release, removeLine, addLine, hold, priceWith],
  );

  /** A new price for the cart as it is (a code applied or removed). */
  const reprice = useCallback(
    async (codes: readonly string[]): Promise<string[] | null> => {
      if (!basket) return null;
      try {
        const priced = await priceWith(basket, codes);
        setQuote(priced.quote);
        return priced.codes;
      } catch (error) {
        setFailure(error as ApiError);
        return null;
      }
    },
    [basket, priceWith],
  );

  return {
    status,
    basket,
    quote,
    failure,
    codeError,
    clearCodeError: () => setCodeError(null),
    prepare,
    reprice,
    repricing: requote.isProcessing,
  };
}
