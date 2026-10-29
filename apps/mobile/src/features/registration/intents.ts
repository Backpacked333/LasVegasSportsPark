/**
 * Registration intents (SPK-REG-001) as the customer sees them on SCR-C-09.
 *
 * Which intents an offering accepts is the API's answer: `GET /v1/offerings/{id}/registration-options`
 * `availableIntents` (ENR-05). Nothing here decides that; this file only says how the app carries
 * an intent the API offers, and which capability switch (DEC-016) a Package G intent sits behind,
 * so a switch reported off reads "turned off" before anything is sent. The API still checks every
 * command (CAPABILITY_DISABLED, eligibility on the line, PARTICIPANT_AUTHORITY_REQUIRED).
 */
import type { CapabilityId } from '@sportspark/api-client';
import type { RegistrationIntent } from './format';

/**
 * How the app can carry an intent:
 * - `basket`: a household basket line (SPK-REG-004), then quote, forms, hold and checkout.
 *   Memberships and session packages are basket lines too (ENR-10, ENR-11, ENR-12).
 * - `booking`: a rental or party exists only with its reservation (`POST /v1/bookings`,
 *   SPK-COND-003); the chooser hands over to the Package G booking route.
 * - `makeup`: a makeup is redeemed from the participant's makeup entitlement (SCR-C-35).
 * - `team_invitation`: joining a known team needs the team's invitation (SCR-C-17).
 * - `not_in_app`: trials and pickup sessions have their own commands (`/trial-participations`,
 *   `/session-bookings`), which the app does not build yet (see the README).
 */
export type IntentHandling = 'basket' | 'booking' | 'makeup' | 'team_invitation' | 'not_in_app';

export const INTENT_HANDLING: Record<RegistrationIntent, IntentHandling> = {
  individual_league: 'basket',
  youth: 'basket',
  create_team_entry: 'basket',
  membership: 'basket',
  package_purchase: 'basket',
  rental_request: 'booking',
  party_request: 'booking',
  makeup: 'makeup',
  join_team: 'team_invitation',
  trial: 'not_in_app',
  pickup: 'not_in_app',
};

/**
 * The capability switch a new commitment of a Package G intent needs (§3.16, DEC-016; DEC-072,
 * DEC-074, DEC-076, DEC-077, DEC-082). Used only to show "turned off" from `GET /v1/me/permissions`.
 */
export const INTENT_CAPABILITY: Partial<Record<RegistrationIntent, CapabilityId>> = {
  membership: 'memberships',
  package_purchase: 'session_packages',
  rental_request: 'rentals',
  party_request: 'parties',
  pickup: 'pickup_sessions',
};

export const INTENT_LABELS: Record<RegistrationIntent, { title: string; description: string }> = {
  individual_league: {
    title: 'Individual league entry',
    description: 'Register one adult player; staff place individual players on a team.',
  },
  join_team: {
    title: 'Join a known team',
    description: 'Join a team that has invited you.',
  },
  create_team_entry: {
    title: 'Create a team entry',
    description: 'Enter a team in this league as its organizer.',
  },
  youth: {
    title: 'Youth enrollment',
    description: 'Enroll a child in this program.',
  },
  trial: { title: 'Trial', description: 'Try one session before enrolling.' },
  makeup: { title: 'Makeup session', description: 'Use a makeup for a missed session.' },
  pickup: { title: 'Pickup session', description: 'Book a place in one pickup session.' },
  rental_request: { title: 'Rental request', description: 'Request this rental.' },
  membership: { title: 'Membership', description: 'Join this membership.' },
  package_purchase: { title: 'Session package', description: 'Buy this package of sessions.' },
  party_request: { title: 'Party booking', description: 'Book this party.' },
};

/** What the chooser says for an intent it does not carry as a basket line. */
export const HANDLING_NOTE: Record<Exclude<IntentHandling, 'basket'>, string> = {
  booking: 'Choose a time and what you need on the next screen.',
  makeup: 'A makeup is booked from the makeup sessions you have (Account, credits and makeups).',
  team_invitation: 'Joining a team uses the invitation the team sends you (Account, invitations).',
  not_in_app: 'Booking a single session is not available in the app yet.',
};
