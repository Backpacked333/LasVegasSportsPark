/**
 * What the memberships screen shows (Package G, §3.16 Memberships row; ENR-12, SPK-COND-001;
 * capability `memberships`, DEC-016, DEC-072). SPK-COND-001: a membership includes exactly what
 * its entitlement states: "Unlimited sessions" only when the API says `unlimited`, and nothing is
 * assumed when the API cannot read the definition (`attendance: null`).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { formatDateOnly } from '../money/format';
import { formatDayIn } from './time';

export type Membership = Schema<'Membership'>;
export type MembershipSuspension = Schema<'MembershipSuspension'>;
type Attendance = NonNullable<Membership['attendance']>;

type Status = Pick<StatusBadgeProps, 'tone' | 'label'>;

const PERIOD_WORDS: Record<NonNullable<Attendance['limit']>['period'], string> = {
  week: 'each week',
  month: 'each month',
  membership_term: 'during the membership term',
};

/** SPK-COND-001: the attendance the membership includes, exactly as its definition states it. */
export function attendanceText(attendance: Membership['attendance']): string {
  if (!attendance) {
    return 'What this membership includes cannot be shown right now. Ask the front desk.';
  }
  switch (attendance.mode) {
    case 'none':
      return 'No sessions included';
    case 'unlimited':
      return 'Unlimited sessions';
    case 'included_sessions': {
      if (!attendance.limit) return 'Included sessions (the number is not available)';
      const { count, period } = attendance.limit;
      return `${count} session${count === 1 ? '' : 's'} ${PERIOD_WORDS[period]}`;
    }
  }
}

/** Where the included sessions can be used, as counts of what the definition names. */
export function appliesToText(attendance: Membership['attendance']): string | null {
  const applies = attendance?.appliesTo;
  if (!applies) return null;
  const count = applies.offeringIds.length + applies.programIds.length;
  if (count === 0) return null;
  return `For ${count} ${count === 1 ? 'activity or program' : 'activities or programs'} named by the membership`;
}

/**
 * A usage period key as the API forms it (`term`, `month:2026-10`, `week:2026-10-19`, local dates
 * of the facility) in words. An unknown form is shown as sent.
 */
export function periodLabel(periodKey: string): string {
  if (periodKey === 'term') return 'this membership term';
  const month = /^month:(\d{4})-(\d{2})$/.exec(periodKey);
  if (month) {
    const [, year, mm] = month;
    const name = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(Number(year), Number(mm) - 1, 1)),
    );
    return `${name} ${year}`;
  }
  const week = /^week:(\d{4}-\d{2}-\d{2})$/.exec(periodKey);
  if (week) return `the week of ${formatDateOnly(week[1] as string)}`;
  return periodKey;
}

/** "3 of 8 sessions used in October 2026". */
export function usageText(usage: Membership['usage'][number]): string {
  return `${usage.usedCount} of ${usage.limitCount} sessions used in ${periodLabel(usage.periodKey)}`;
}

/** The suspension in force at `now`, if any (from, until or open-ended, not ended). */
export function activeSuspension(
  membership: Pick<Membership, 'suspensions'>,
  now: Date,
): MembershipSuspension | null {
  return (
    membership.suspensions.find(
      (s) =>
        s.status === 'active' &&
        new Date(s.from).getTime() <= now.getTime() &&
        (s.until === null || new Date(s.until).getTime() > now.getTime()),
    ) ?? null
  );
}

export function suspensionText(suspension: MembershipSuspension, zone: string): string {
  const from = formatDayIn(suspension.from, zone);
  if (suspension.status === 'ended') {
    return suspension.endedAt
      ? `Suspended from ${from}; the suspension ended ${formatDayIn(suspension.endedAt, zone)}`
      : `Suspended from ${from}; the suspension ended`;
  }
  return suspension.until
    ? `Suspended from ${from} until ${formatDayIn(suspension.until, zone)}`
    : `Suspended from ${from} until the front desk ends it`;
}

/**
 * The last local day a term includes. The API's `termEndsAt` is exclusive: the local midnight after
 * the offering's last day (offering-dated terms) or the confirmation instant plus the term length;
 * the day it falls on is not part of the term unless the term ends later that day.
 */
export function lastTermDay(termEndsAt: string, zone: string): string {
  const end = new Date(termEndsAt).getTime();
  if (Number.isNaN(end)) return termEndsAt;
  return formatDayIn(new Date(end - 1).toISOString(), zone);
}

/** Where `now` stands against the API's term (null bounds: the API could not set one). */
export type TermPhase = 'unknown' | 'not_started' | 'in_term' | 'ended';

export function termPhase(
  membership: Pick<Membership, 'termStartsAt' | 'termEndsAt'>,
  now: Date,
): TermPhase {
  if (!membership.termStartsAt || !membership.termEndsAt) return 'unknown';
  if (now.getTime() < new Date(membership.termStartsAt).getTime()) return 'not_started';
  if (now.getTime() >= new Date(membership.termEndsAt).getTime()) return 'ended';
  return 'in_term';
}

/**
 * SPK-COND-001: "Membership active" only inside the term the API states. A confirmed membership
 * whose term the API could not set books nothing (POL-038), so it never reads active.
 */
export function membershipStatus(membership: Membership, now: Date, zone: string): Status {
  switch (membership.status) {
    case 'pending':
      return { tone: 'pending', label: 'Membership pending' };
    case 'confirmed': {
      const phase = termPhase(membership, now);
      if (phase === 'unknown') {
        return { tone: 'warning', label: 'Term not available: ask the front desk' };
      }
      if (phase === 'not_started') {
        return {
          tone: 'info',
          label: `Starts ${formatDayIn(membership.termStartsAt as string, zone)}`,
        };
      }
      if (phase === 'ended') return { tone: 'neutral', label: 'Term ended' };
      const suspended = activeSuspension(membership, now);
      if (suspended) return { tone: 'warning', label: 'Membership suspended' };
      return { tone: 'success', label: 'Membership active' };
    }
    case 'canceled':
      return { tone: 'neutral', label: 'Canceled' };
    case 'transferred':
      return { tone: 'neutral', label: 'Transferred' };
    case 'completed':
      return { tone: 'neutral', label: 'Membership ended' };
  }
}

/** "Jan 1, 2026 to Dec 31, 2026": the first and the last local day the term includes. */
export function termText(membership: Membership, zone: string): string {
  if (membership.termStartsAt && membership.termEndsAt) {
    return `${formatDayIn(membership.termStartsAt, zone)} to ${lastTermDay(membership.termEndsAt, zone)}`;
  }
  return membership.status === 'pending' ? 'Set when the membership is confirmed' : 'Not available';
}

/**
 * Whether to offer booking a session with the membership's included sessions (ENR-12): confirmed,
 * inside its term, not suspended now, and including sessions of named activities. The API decides
 * on submit (period limits, the session's own term and suspension checks); this only avoids
 * offering what it would certainly refuse.
 */
export function membershipBookable(membership: Membership, now: Date): boolean {
  const attendance = membership.attendance;
  if (membership.status !== 'confirmed' || !attendance) return false;
  if (attendance.mode === 'none') return false;
  const applies = attendance.appliesTo;
  if (!applies || applies.offeringIds.length + applies.programIds.length === 0) return false;
  return termPhase(membership, now) === 'in_term' && activeSuspension(membership, now) === null;
}

/** Whether a session starting at `start` falls inside the membership's term (start inclusive). */
export function inTerm(membership: Pick<Membership, 'termStartsAt' | 'termEndsAt'>, start: string) {
  return termPhase(membership, new Date(start)) === 'in_term';
}

/** Why the API refused a membership booking, in the customer's words (ENR-12). */
export function membershipBookingRefusal(code: string | null): string | null {
  switch (code) {
    case 'MEMBERSHIP_SESSIONS_USED':
      return 'Not available: every session this membership includes for that period is used';
    case 'MEMBERSHIP_NOT_ACTIVE':
      return 'Not available: this membership is not active';
    case 'MEMBERSHIP_SUSPENDED':
      return 'Not available: the membership is suspended at that time';
    case 'OUTSIDE_MEMBERSHIP_TERM':
      return 'Not available: that session is outside the membership term';
    case 'MEMBERSHIP_INCLUDES_NO_SESSIONS':
      return 'Not available: this membership includes no sessions';
    case 'MEMBERSHIP_BENEFIT_UNKNOWN':
      return 'Not available: what this membership includes cannot be read. Ask the front desk.';
    default:
      return null;
  }
}
