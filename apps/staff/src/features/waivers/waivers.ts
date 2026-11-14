/**
 * Wording for liability waivers on staff screens (SPK-REG-011, proposed amendment PA-01;
 * SPK-UX-010 plain words). A paper acceptance is always described as recorded from paper by staff,
 * never as a signature (SPK-REG-009).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export type PersonWaiver = Schema<'PersonWaiver'>;
export type WaiverAcceptance = Schema<'WaiverAcceptance'>;
export type WaiverStatusValue = PersonWaiver['status'] | 'not_evaluated';

export const WAIVER_STATUS: Record<WaiverStatusValue, { tone: StatusTone; label: string }> = {
  current: { tone: 'success', label: 'Waiver current' },
  lapsed: { tone: 'warning', label: 'Waiver lapsed' },
  missing: { tone: 'danger', label: 'Waiver missing' },
  not_evaluated: { tone: 'neutral', label: 'Waiver not evaluated' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar date as written, e.g. "10 Nov 2026" (no zone: it is a date, not an instant). */
export function formatCalendarDate(dateOnly: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return dateOnly;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

/** Why a waiver is not current, in plain words. */
export function waiverReason(waiver: {
  reason: PersonWaiver['reason'];
  lapsedAt: string | null;
}): string | null {
  switch (waiver.reason) {
    case 'never_accepted':
      return 'Never accepted.';
    case 'no_version_in_force':
      return 'No approved version of this waiver is in force.';
    case 'new_version':
      return 'A newer version is in force and has to be accepted.';
    case 'renewal_due':
      return waiver.lapsedAt
        ? `Renewal was due on ${formatCalendarDate(waiver.lapsedAt.slice(0, 10))}.`
        : 'Renewal is due.';
    default:
      return null;
  }
}

/** How an acceptance was given: a digital acceptance, or a staff entry from a signed paper. */
export function acceptanceMethod(acceptance: WaiverAcceptance): string {
  if (acceptance.method === 'paper') {
    return `Recorded from paper by staff; paper dated ${
      acceptance.paperDatedOn ? formatCalendarDate(acceptance.paperDatedOn) : 'unknown'
    }`;
  }
  return acceptance.recordedByKind === 'staff'
    ? 'Accepted digitally at the desk'
    : 'Accepted digitally';
}

/** Who accepted: the person themselves, or a guardian on their behalf. */
export function acceptanceSigner(acceptance: WaiverAcceptance): string {
  return acceptance.basis === 'self' ? 'by the person themselves' : 'by a guardian';
}
