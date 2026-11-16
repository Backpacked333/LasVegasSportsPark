/**
 * Wording for liability waivers in the customer app (SPK-REG-011, proposed amendment PA-01;
 * SPK-UX-010 plain words). A paper acceptance is always described as recorded from paper at the
 * front desk, never as a signature by the customer (SPK-REG-009).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export type PersonWaiver = Schema<'PersonWaiver'>;
export type WaiverAcceptance = Schema<'WaiverAcceptance'>;
export type RosterWaiverStatus = PersonWaiver['status'] | 'not_evaluated';

export const PERSON_WAIVERS_KEY = ['api', '/people/{id}/waivers'] as const;

export const WAIVER_STATUS: Record<RosterWaiverStatus, { tone: StatusTone; label: string }> = {
  current: { tone: 'success', label: 'Waiver accepted' },
  lapsed: { tone: 'warning', label: 'Waiver needs accepting again' },
  missing: { tone: 'pending', label: 'Waiver not accepted yet' },
  not_evaluated: { tone: 'neutral', label: 'Waiver not checked' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar date as written, e.g. "10 Nov 2026" (a date, not an instant: no zone). */
export function formatCalendarDate(dateOnly: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOnly);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return dateOnly;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** Why a waiver is not current, in plain words; null when it is. */
export function waiverReason(waiver: {
  reason: PersonWaiver['reason'];
  lapsedAt: string | null;
}): string | null {
  switch (waiver.reason) {
    case 'never_accepted':
      return 'It has not been accepted yet.';
    case 'no_version_in_force':
      return 'There is no approved version to accept right now. Ask the front desk.';
    case 'new_version':
      return 'The wording changed and has to be accepted again.';
    case 'renewal_due':
      return waiver.lapsedAt
        ? `It was due for renewal on ${formatCalendarDate(waiver.lapsedAt)}.`
        : 'It is due for renewal.';
    default:
      return null;
  }
}

/**
 * How and by whom an acceptance was given. `signer` is the display name of the person who
 * accepted ("you" when it is the account holder).
 */
export function acceptanceDetail(acceptance: WaiverAcceptance, signer: string): string {
  if (acceptance.method === 'paper') {
    const dated = acceptance.paperDatedOn
      ? `paper dated ${formatCalendarDate(acceptance.paperDatedOn)}`
      : 'paper';
    return `Recorded from paper by the front desk (${dated}); the paper names ${signer} as the signer`;
  }
  const desk = acceptance.recordedByKind === 'staff' ? ' at the front desk' : '';
  return `Accepted on ${formatCalendarDate(acceptance.signedAt)} by ${signer}${desk}`;
}
