/**
 * Registrations in progress, read from the API so they come back after the app was closed,
 * reinstalled or used on another device (SPK-UX-001 foreground refresh after interrupted
 * registration or payment; SPK-AT-023 interrupted work; SPK-PAY-007; §4.11):
 *
 * - `GET /v1/me/baskets`: the caller's own baskets, newest first (ENR-01, SPK-REG-004);
 * - `GET /v1/me/registration-checkouts`: their checkouts, including one that needs recovery
 *   (FIN-01), so a payment whose outcome is unknown or a `recovery_required` checkout is found
 *   again without anything kept on the device;
 * - `GET /v1/me/waitlist-entries?status=offered`: entries with an open offer and its server
 *   expiry (ENR-01, SPK-REG-008).
 *
 * One read of each (the first page, newest first) is shared by Discover, the intent chooser, the
 * basket, the quote and the checkout, under the same cache keys; commands that change them
 * invalidate these keys. The device keeps only a checkout request whose answer never arrived
 * (`progress.tsx`).
 */
import type { Schema } from '@sportspark/api-client';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { checkoutInFlight } from './status';

type Basket = Schema<'Basket'>;
type Checkout = Schema<'Checkout'>;

/** First page of each list: in-progress work is the newest, so this is enough to resume it. */
export const IN_PROGRESS_PAGE_SIZE = 20;

/** Query keys of the lists, for `invalidate` on the commands that change them. */
export const MY_BASKETS_KEY = ['api', '/me/baskets'] as const;
export const MY_CHECKOUTS_KEY = ['api', '/me/registration-checkouts'] as const;
export const MY_WAITLIST_KEY = ['api', '/me/waitlist-entries'] as const;

/** A basket the customer can still act on (an open basket with lines, held, or checking out). */
export function basketInProgress(basket: Basket): boolean {
  return (
    (basket.status === 'open' && basket.lines.length > 0) ||
    basket.status === 'held' ||
    basket.status === 'checking_out'
  );
}

/** A checkout that is still on its way or needs the facility to finish it (§4.11). */
export function checkoutNeedsAttention(checkout: Checkout): boolean {
  return checkout.status === 'recovery_required' || checkoutInFlight(checkout);
}

export function useMyBaskets(enabled = true) {
  const { session } = useApp();
  return useApiQuery({
    path: '/me/baskets',
    request: { query: { limit: IN_PROGRESS_PAGE_SIZE } },
    enabled: enabled && session.status === 'signed_in',
  });
}

export function useMyCheckouts(enabled = true) {
  const { session } = useApp();
  return useApiQuery({
    path: '/me/registration-checkouts',
    request: { query: { limit: IN_PROGRESS_PAGE_SIZE } },
    enabled: enabled && session.status === 'signed_in',
  });
}

export function useMyOffers(enabled = true) {
  const { session } = useApp();
  return useApiQuery({
    path: '/me/waitlist-entries',
    request: { query: { status: 'offered', limit: IN_PROGRESS_PAGE_SIZE } },
    enabled: enabled && session.status === 'signed_in',
  });
}

/** The newest open basket of the caller, if the list is known (undefined while it is not). */
export function openBasketOf(
  page: { items: readonly Basket[] } | undefined,
): Basket | null | undefined {
  if (!page) return undefined;
  return page.items.find((b) => b.status === 'open') ?? null;
}

/** The newest checkout of a basket or of a quote in the caller's list. */
export function checkoutOf(
  page: { items: readonly Checkout[] } | undefined,
  match: { basketId?: string; quoteId?: string },
): Checkout | null {
  return (
    page?.items.find(
      (c) =>
        (match.basketId === undefined || c.basketId === match.basketId) &&
        (match.quoteId === undefined || c.quoteId === match.quoteId),
    ) ?? null
  );
}
