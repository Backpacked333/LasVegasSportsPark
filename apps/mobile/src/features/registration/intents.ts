/**
 * Registration intents (SPK-REG-001) as the customer sees them on SCR-C-09.
 *
 * Which intents an offering kind accepts is decided by the API (`INTENT_OFFERING_KINDS` in
 * apps/api/src/modules/enrollment/enrollment.policy.ts); the API exposes no "available intents"
 * for an offering, so the same table is mirrored here only to avoid offering choices the API would
 * refuse (reported as an API gap). The API still evaluates every line: an intent that does not fit
 * comes back as an eligibility reason on the line, never as a client decision.
 */
import type { OfferingKind, RegistrationIntent } from './format';

export const INTENT_OFFERING_KINDS: Record<RegistrationIntent, readonly OfferingKind[]> = {
  individual_league: ['season', 'term'],
  join_team: ['season'],
  create_team_entry: ['season'],
  youth: ['term', 'camp', 'session', 'private_coaching', 'season'],
  trial: ['trial'],
  makeup: ['makeup', 'session', 'term', 'camp'],
  pickup: ['pickup'],
  rental_request: ['rental'],
};

/**
 * How the app can carry an intent today:
 * - `basket`: a household basket line (SPK-REG-004), then quote, forms, hold and checkout.
 * - `team_invitation`: joining a known team needs the team entry from an invitation (SCR-C-17).
 * - `session_booking`: trials, makeups and pickup have their own commands
 *   (`/trial-participations`, `/makeup-entitlements/{id}/redeem`, `/session-bookings`), which this
 *   screen group does not build.
 */
export type IntentHandling = 'basket' | 'team_invitation' | 'session_booking';

export const INTENT_HANDLING: Record<RegistrationIntent, IntentHandling> = {
  individual_league: 'basket',
  youth: 'basket',
  create_team_entry: 'basket',
  rental_request: 'basket',
  join_team: 'team_invitation',
  trial: 'session_booking',
  makeup: 'session_booking',
  pickup: 'session_booking',
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
};

/** Intents the API accepts for this kind of offering, in the order SPK-REG-001 lists them. */
export function intentsFor(kind: OfferingKind): RegistrationIntent[] {
  return (Object.keys(INTENT_OFFERING_KINDS) as RegistrationIntent[]).filter((intent) =>
    INTENT_OFFERING_KINDS[intent].includes(kind),
  );
}
