/**
 * Routes of the customer Package G screens (§3.16, §6.5): my rentals and parties with the booking
 * flow, my memberships, my session packages, point-of-sale receipts. Reachable from Account
 * (SCR-C-30; the intent chooser SCR-C-09 links the booking flow when it is built), never as a sixth
 * tab (SPK-UX-002). Parameters are opaque record ids only, never names or child data (§4.14).
 */
export const packageGRoutes = {
  bookings: () => '/bookings' as const,
  /** One rental or party (GET /v1/bookings/{id}) with its cancellation. */
  booking: (bookingId: string) => `/bookings/${bookingId}` as const,
  /** The booking flow for a published rental or party offering (POST /v1/bookings). */
  newBooking: (offeringId: string) => `/bookings/new/${offeringId}` as const,
  memberships: () => '/memberships' as const,
  sessionPackages: () => '/session-packages' as const,
  posReceipts: () => '/pos-receipts' as const,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The record id of a route parameter (Expo Router gives a string or an array), or `null` unless it
 * is a UUID: a malformed link is "Link not available" without any request (SCR-C-39).
 */
export function routeId(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && UUID.test(first) ? first : null;
}
