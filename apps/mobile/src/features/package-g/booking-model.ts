/**
 * What the rentals and parties screens show (Package G, §3.16 Rentals and Parties rows;
 * SPK-COND-003, ENR-13; capabilities `rentals` and `parties`, DEC-016, DEC-076, DEC-077).
 * Everything here describes what the API sent: the status and what is still outstanding, the
 * approved booking terms, the free times of `GET /v1/offerings/{id}/booking-availability`. Nothing
 * here decides a price, a deposit, a guest limit or whether a booking is allowed.
 *
 * SPK-COND-003: a paid booking whose staff are not yet assigned (`awaiting_staff`) is never shown
 * as confirmed; "Confirmed" is only the API's `confirmed`.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';

export type Booking = Schema<'Booking'>;
export type BookingKind = Schema<'BookingKind'>;
export type BookingStatus = Schema<'BookingStatus'>;
export type BookingOutstanding = Schema<'BookingOutstanding'>;
export type BookingAvailability = Schema<'BookingAvailability'>;
export type PolicyVersion = Schema<'PolicyVersion'>;

type Status = Pick<StatusBadgeProps, 'tone' | 'label'>;

/** The booking kind of an offering kind; null for anything that is not a rental or a party. */
export function bookingKindOf(offeringKind: string): BookingKind | null {
  if (offeringKind === 'rental') return 'rental';
  if (offeringKind === 'party') return 'party';
  return null;
}

export const KIND_LABELS: Record<BookingKind, string> = { rental: 'Rental', party: 'Party' };

/** The capability switch a new booking of this kind needs (DEC-076, DEC-077). */
export function capabilityOfKind(kind: BookingKind): 'rentals' | 'parties' {
  return kind === 'rental' ? 'rentals' : 'parties';
}

/**
 * Customer status phrases (**Proposed**, in the style of docs/package-a/journeys.md section 3,
 * which has no booking row yet): text and glyph differ for every state.
 */
export function bookingStatus(booking: Pick<Booking, 'status' | 'outstanding'>): Status {
  switch (booking.status) {
    case 'requested':
      return { tone: 'pending', label: 'Request awaiting approval' };
    case 'held':
      return { tone: 'warning', label: 'Held for you: pay to confirm' };
    case 'awaiting_staff':
      // SPK-COND-003: paid, but not complete until its mandatory staff are assigned.
      return { tone: 'info', label: 'Paid: staff still being arranged' };
    case 'confirmed':
      return { tone: 'success', label: 'Confirmed' };
    case 'declined':
      return { tone: 'neutral', label: 'Not approved' };
    case 'expired':
      return { tone: 'neutral', label: 'Expired' };
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
    case 'completed':
      return { tone: 'neutral', label: 'Completed' };
  }
}

const OUTSTANDING_WORDS: Record<BookingOutstanding, string> = {
  approval: 'Staff approve or decline the request. Nothing is reserved until they approve it.',
  payment: 'Your payment, in your basket. The booking is confirmed only when it is paid.',
  staffing:
    'The facility assigns the staff this booking needs. It is confirmed only when they are assigned.',
};

/** What still stands between the booking and confirmed, as the API lists it. */
export function outstandingText(outstanding: readonly BookingOutstanding[]): string[] {
  return outstanding.map((o) => OUTSTANDING_WORDS[o]);
}

/** States the booking machine lets the booker cancel from (BookingMachine `cancel`). */
const CANCELLABLE: ReadonlySet<BookingStatus> = new Set([
  'requested',
  'held',
  'awaiting_staff',
  'confirmed',
]);

export function isCancellable(status: BookingStatus): boolean {
  return CANCELLABLE.has(status);
}

/**
 * Which consequence a cancellation has, by what the booking holds: a request holds nothing; a held
 * booking holds time and an unpaid basket; a paid one ends through its enrollment's cancellation,
 * whose money consequence the API previews (`GET /v1/enrollments/{id}/cancellation-preview`) and
 * the command binds (`acceptedConsequence`, ENR-03).
 */
export type CancelBasis = 'request' | 'hold' | 'paid';

export function cancelBasis(booking: Pick<Booking, 'status'>): CancelBasis | null {
  switch (booking.status) {
    case 'requested':
      return 'request';
    case 'held':
      return 'hold';
    case 'awaiting_staff':
    case 'confirmed':
      return 'paid';
    default:
      return null;
  }
}

export type BasketStatus = Schema<'BasketStatus'>;

/**
 * Where a held booking's payment stands, from its basket's status (`GET /v1/baskets/{id}`). A
 * booking moves from `held` to paid only when the API delivers the enrollment's confirmation
 * (outbox), so a booking can still read `held` after its checkout completed:
 * - `unpaid`: `open` or `held`; nothing has been charged and canceling releases the basket;
 * - `paying`: `checking_out`; a payment may be on its way, its outcome is not known yet;
 * - `paid`: `fulfilled` or `partially_fulfilled`; a payment went through and the booking is being
 *   updated (never "nothing charged", and the hold-release cancellation is not offered);
 * - `ended`: `expired`, `released` or `abandoned`; the hold ended without a payment and the
 *   booking is being updated.
 */
export type HoldPayment = 'unpaid' | 'paying' | 'paid' | 'ended';

export function holdPaymentOf(status: BasketStatus): HoldPayment {
  switch (status) {
    case 'open':
    case 'held':
      return 'unpaid';
    case 'checking_out':
      return 'paying';
    case 'fulfilled':
    case 'partially_fulfilled':
      return 'paid';
    case 'expired':
    case 'released':
    case 'abandoned':
      return 'ended';
  }
}

/** Why a booking ended, in words; the API's own reason text is shown as written. */
export function endReasonText(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'not_decided') return 'The request was not decided before its start time.';
  if (reason === 'hold_expired') return 'The hold ended before the booking was paid.';
  return reason;
}

/**
 * The approved booking terms of an offering (`booking_terms` policy content, CAT-02, POL-040), read
 * only as far as the API's closed shape states it. Null when the content is not that shape: the
 * screen then says the terms cannot be shown, and never fills one in.
 */
export interface BookingTerms {
  confirmationMode: 'instant' | 'request';
  /** The approved installment policy whose first installment is the deposit; null: paid in full. */
  installmentPolicyKey: string | null;
  accessConditions: string | null;
  hostResponsibilities: string | null;
}

function textOrNull(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : undefined;
}

export function bookingTermsOf(
  policy: Pick<PolicyVersion, 'kind' | 'content'>,
): BookingTerms | null {
  if (policy.kind !== 'booking_terms') return null;
  const c = policy.content as Record<string, unknown>;
  const mode = c.confirmationMode;
  if (mode !== 'instant' && mode !== 'request') return null;
  const installmentPolicyKey = textOrNull(c.installmentPolicyKey);
  const accessConditions = textOrNull(c.accessConditions);
  const hostResponsibilities = textOrNull(c.hostResponsibilities);
  if (
    installmentPolicyKey === undefined ||
    accessConditions === undefined ||
    hostResponsibilities === undefined
  ) {
    return null;
  }
  return { confirmationMode: mode, installmentPolicyKey, accessConditions, hostResponsibilities };
}

/** How the terms confirm a booking, in the customer's words. */
export function confirmationText(mode: 'instant' | 'request'): string {
  return mode === 'instant'
    ? 'Booked at once: the time is held for you, then you pay in your basket to confirm it.'
    : 'By request: staff approve or decline it. Nothing is reserved or charged until they approve it.';
}

/** What the terms say about paying (the amount is the basket's quote, never the app's). */
export function paymentText(terms: Pick<BookingTerms, 'installmentPolicyKey'>): string {
  return terms.installmentPolicyKey
    ? "A deposit is taken at checkout under the facility's approved payment plan, and the rest later. Your basket shows the amounts."
    : 'Paid in full at checkout. Your basket shows the price, taxes and fees.';
}

/** One start time the customer may choose, with the resources free at it. */
export interface BookableTime {
  start: string;
  end: string;
  /** Resources free for the whole slot, in the API's order. */
  resources: { resourceId: string; name: string | null }[];
}

/**
 * The start times at which at least `resourceCount` of the offering's resources are free, from
 * the API's free intervals (each one is a whole slot of the booking's duration), later than `now`
 * (the API refuses a start in the past). Sorted by start.
 */
export function bookableTimes(availability: BookingAvailability, now: Date): BookableTime[] {
  const byStart = new Map<string, BookableTime>();
  for (const resource of availability.resources) {
    for (const interval of resource.freeIntervals) {
      if (new Date(interval.start).getTime() <= now.getTime()) continue;
      const key = new Date(interval.start).toISOString();
      const time = byStart.get(key) ?? { start: interval.start, end: interval.end, resources: [] };
      time.resources.push({ resourceId: resource.resourceId, name: resource.name });
      byStart.set(key, time);
    }
  }
  return [...byStart.entries()]
    .filter(([, time]) => time.resources.length >= availability.resourceCount)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, time]) => time);
}

/** A resource name as the API gives it, or a neutral word when it no longer knows one. */
export function resourceName(name: string | null): string {
  return name ?? 'Reserved space';
}

/** Conflicts a request-mode booking answered with (RESOURCE_CONFLICT `details.conflicts`). */
export function conflictsOf(details: unknown): { occurrenceStart: string; resourceId: string }[] {
  const conflicts = (details as { conflicts?: unknown } | null | undefined)?.conflicts;
  if (!Array.isArray(conflicts)) return [];
  return conflicts.filter(
    (c): c is { occurrenceStart: string; resourceId: string } =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as { occurrenceStart?: unknown }).occurrenceStart === 'string' &&
      typeof (c as { resourceId?: unknown }).resourceId === 'string',
  );
}

/** The `details.code` of a RESOURCE_CONFLICT answer (CONSEQUENCE_CHANGED, BASKET_NOT_EMPTY …). */
export function detailCode(details: unknown): string | null {
  const code = (details as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : null;
}
