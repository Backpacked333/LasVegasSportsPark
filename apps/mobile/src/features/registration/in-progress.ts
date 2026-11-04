/**
 * Registrations in progress, read from the API so they come back after the app was closed,
 * reinstalled or used on another device (SPK-UX-001 foreground refresh after interrupted
 * registration or payment; SPK-AT-023 interrupted work; SPK-PAY-007; §4.11):
 *
 * - `GET /v1/me/baskets`: the caller's own baskets, newest first (ENR-01, SPK-REG-004);
 * - `GET /v1/me/registration-checkouts`: their checkouts, including one that needs recovery
 *   (FIN-01), so a payment whose outcome is unknown or a `recovery_required` checkout is found
 *   again without anything kept on the device; `useRecoveryCheckouts` reads every page of the
 *   `recovery_required` ones, so a label that depends on them never misses an older one (the
 *   enrollment row and record, the basket's "See your payment", Discover's "In progress"), and
 *   `recoveryCheckoutsKnown` says when that list is complete;
 * - `GET /v1/me/waitlist-entries?status=offered`: entries with an open offer and its server
 *   expiry (ENR-01, SPK-REG-008).
 *
 * One read of each (the first page, newest first) is shared by Discover, the intent chooser, the
 * basket, the quote and the checkout, under the same cache keys; commands that change them
 * invalidate these keys. The device keeps only a checkout request whose answer never arrived
 * (`progress.tsx`).
 */
import { presentationForError, type Schema } from '@sportspark/api-client';
import { useEffect } from 'react';
import { useApiPages, type ApiPagesResult } from '../../api/useApiPages';
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

/**
 * Every checkout of the caller in `recovery_required` (§4.11; FIN-01 `status` filter), all pages:
 * the enrollment list and record label a pending enrollment from it, and a checkout in recovery
 * can be older than any number of newer checkouts of the same payer (R3-SCREEN-STATES-04). Few
 * checkouts are in recovery at once, so following the cursor to the end is cheap. Same query as
 * Home's pinned list, so both read one cache entry.
 */
export function useRecoveryCheckouts(enabled = true) {
  const { session } = useApp();
  const pages = useApiPages({
    path: '/me/registration-checkouts',
    request: { query: { status: 'recovery_required', limit: IN_PROGRESS_PAGE_SIZE } },
    enabled: enabled && session.status === 'signed_in',
  });
  const { hasNextPage, isFetchingNextPage, nextPageError, loadMore } = pages;
  useEffect(() => {
    // A failed page stops the paging: until it is read the list is not known
    // (`recoveryCheckoutsKnown`), and the screens show that page's failure with "Try again"
    // (`loadMore`), after which the remaining pages follow. A refresh starts over from page one.
    if (hasNextPage && !isFetchingNextPage && !nextPageError) loadMore();
  }, [hasNextPage, isFetchingNextPage, nextPageError, loadMore]);
  return pages;
}

/**
 * Every checkout of the caller in recovery is known: all pages were read, or the API does not show
 * this account the list (§4.10). While the first page loads, a later page is still to come, or a
 * page failed, a checkout missing from what was read proves nothing (R3-SCREEN-STATES-04): a screen
 * never concludes from it that a payment is not finished.
 */
export function recoveryCheckoutsKnown(
  pages: Pick<ApiPagesResult<unknown>, 'data' | 'error' | 'hasNextPage'>,
): boolean {
  if (pages.data === undefined) {
    return pages.error !== null && presentationForError(pages.error) === 'unavailable';
  }
  return !pages.hasNextPage;
}

/**
 * The checkout of a basket that is checking out (SCR-C-11 "See your payment", Discover's "In
 * progress"): the basket's newest checkout that still needs attention in the first page of all the
 * caller's checkouts, else its checkout in recovery from every page of those
 * (`useRecoveryCheckouts`), which can be older than any number of newer checkouts
 * (R3-SCREEN-STATES-04), else its newest listed checkout.
 */
export function basketCheckoutOf(
  firstPage: { items: readonly Checkout[] } | undefined,
  recovery: readonly Checkout[] | undefined,
  basketId: string,
): Checkout | null {
  const listed = (firstPage?.items ?? []).filter((c) => c.basketId === basketId);
  return (
    listed.find(checkoutNeedsAttention) ??
    recovery?.find((c) => c.basketId === basketId && c.status === 'recovery_required') ??
    listed[0] ??
    null
  );
}

/**
 * Checkouts that need attention, for Discover's "In progress": those in the first page of all the
 * caller's checkouts (in flight or in recovery), then every checkout in recovery not among them,
 * however old (R3-SCREEN-STATES-04). Newest first within each source.
 */
export function checkoutsNeedingAttention(
  firstPage: { items: readonly Checkout[] } | undefined,
  recovery: readonly Checkout[] | undefined,
): Checkout[] {
  const listed = (firstPage?.items ?? []).filter(checkoutNeedsAttention);
  const seen = new Set(listed.map((c) => c.id));
  return [
    ...listed,
    ...(recovery ?? []).filter((c) => c.status === 'recovery_required' && !seen.has(c.id)),
  ];
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
