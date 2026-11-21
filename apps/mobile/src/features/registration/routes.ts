/**
 * Routes of the registration screens (app/registration/*). Parameters are opaque record ids only:
 * no names, dates of birth or other child data ever appear in a route (§4.14).
 */
export const registrationRoutes = {
  discover: () => '/discover' as const,
  offering: (offeringId: string) => `/registration/offering/${offeringId}` as const,
  start: (offeringId: string) => `/registration/start/${offeringId}` as const,
  /** Who (1e) with one person ticked (an opaque person id, as the pass's `?person=`). */
  startFor: (offeringId: string, personId: string) =>
    `/registration/start/${offeringId}?person=${personId}` as const,
  /** Review & pay (1f) of a cart that already holds its lines. */
  review: (basketId: string) => `/registration/review/${basketId}` as const,
  /** Review & pay of a taken waitlist place (2e → 1f): held until the offer ends. */
  offerReview: (basketId: string) => `/registration/review/${basketId}?offer=1` as const,
  placement: (basketId: string, lineId: string) =>
    `/registration/placement/${lineId}?basketId=${basketId}` as const,
  basket: (basketId: string) => `/registration/basket/${basketId}` as const,
  quote: (quoteId: string) => `/registration/quote/${quoteId}` as const,
  basketForms: (basketId: string) => `/registration/forms?basketId=${basketId}` as const,
  waitlistForms: (entryId: string) => `/registration/forms?waitlistEntryId=${entryId}` as const,
  checkout: (quoteId: string) => `/registration/checkout/${quoteId}` as const,
  outcome: (checkoutId: string) => `/registration/outcome/${checkoutId}` as const,
  waitlist: (entryId: string) => `/registration/waitlist/${entryId}` as const,
  waitlists: () => '/registration/waitlists' as const,
};

/** First value of a route parameter (Expo Router gives a string or an array). */
export function param(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
