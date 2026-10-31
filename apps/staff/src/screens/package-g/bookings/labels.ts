/**
 * Booking states for staff (SCR-S-51 Rentals, SCR-S-52 Parties; ENR-13, SPK-COND-003). Staff labels
 * are the machine state names (BookingMachine in apps/api enrollment.state-machines.ts;
 * journeys.md section 3 rule 4), each with a glyph and text through `StatusBadge`, and a sentence
 * saying what the state means. A paid booking still waiting for staff is `awaiting_staff`, never
 * "confirmed" (SPK-UX-004).
 *
 * The transition table only decides which commands are worth offering for a state; the API stays
 * the authority and answers INVALID_TRANSITION or ACCESS_DENIED.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../../ui/StatusBadge';

export type BookingKind = Schema<'BookingKind'>;
export type BookingStatus = Schema<'BookingStatus'>;
export type Booking = Schema<'Booking'>;

export const BOOKING_STATUS: Record<
  BookingStatus,
  { tone: StatusTone; label: string; meaning: string }
> = {
  requested: {
    tone: 'pending',
    label: 'requested',
    meaning: 'Waiting for approval. Nothing is reserved or charged until it is approved.',
  },
  held: {
    tone: 'warning',
    label: 'held',
    meaning: 'Reserved and held for payment until the hold expires.',
  },
  awaiting_staff: {
    tone: 'warning',
    label: 'awaiting_staff',
    meaning: 'Paid, but not confirmed: every required staff assignment must be accepted first.',
  },
  confirmed: { tone: 'success', label: 'confirmed', meaning: 'Paid and fully staffed.' },
  declined: { tone: 'neutral', label: 'declined', meaning: 'The request was declined.' },
  expired: {
    tone: 'neutral',
    label: 'expired',
    meaning: 'The request or hold ended before it was decided or paid.',
  },
  canceled: {
    tone: 'neutral',
    label: 'canceled',
    meaning: 'Canceled; its reservations were released.',
  },
  completed: { tone: 'info', label: 'completed', meaning: 'The booking took place.' },
};

export const OUTSTANDING: Record<Schema<'BookingOutstanding'>, string> = {
  approval: 'approval',
  payment: 'payment',
  staffing: 'staff acceptance',
};

export const KIND_WORDS: Record<BookingKind, { one: string; many: string; title: string }> = {
  rental: { one: 'rental', many: 'rentals', title: 'Rental' },
  party: { one: 'party', many: 'parties', title: 'Party' },
};

export const KIND_PATH: Record<BookingKind, string> = {
  rental: '/schedule/rentals',
  party: '/schedule/parties',
};

/** The capability that gates new bookings and approvals of a kind (DEC-076, DEC-077). */
export const KIND_CAPABILITY = { rental: 'rentals', party: 'parties' } as const;

/** BookingMachine: which commands a state allows. */
export const CAN = {
  decide: (s: BookingStatus) => s === 'requested',
  cancel: (s: BookingStatus) =>
    s === 'requested' || s === 'held' || s === 'awaiting_staff' || s === 'confirmed',
} as const;

export const BOOKING_STATUSES = Object.keys(BOOKING_STATUS) as BookingStatus[];
