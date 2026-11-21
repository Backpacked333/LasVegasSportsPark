/**
 * What Explore and the activity page answer for one family (redesign handoff 1d, 3d; INTERACTIONS
 * "1d · Explore" rows 2 to 4; SPK-SCHED-008, SPK-REG-002, SPK-REG-005). Pure: no clock, no state.
 *
 * - **Age** comes from the person's date of birth (`GET /v1/people/{id}`) on the facility's day,
 *   and is compared with the activity's published age band. It narrows what Explore lists for a
 *   child ("Only showing activities for ages 8"); the API's eligibility on the Who step still
 *   decides who can register.
 * - **Fit**: the activity's sessions against the child's calendar (program sessions, bookings and
 *   team games read from the family calendar and the fixtures): ▲ "Clashes with Desert Foxes" when
 *   any overlap, ✓ "Fits Maya's week" otherwise. A read that has not answered (or failed) gives no
 *   answer: never a guess.
 * - **Places**: "3 left" at five or fewer, "Full · waitlist" when full; nothing when the count is
 *   not known (the read failed, or the activity has no capacity pool).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';
import { formatMoney } from '../registration/format';
import { formatTime, localDayKey } from '../today/time';

type Availability = Schema<'OfferingAvailability'>;
type OfferingSession = Schema<'OfferingSession'>;
type PublicOffering = Schema<'PublicOffering'>;

/** Whole years between a date of birth and a calendar day (both YYYY-MM-DD). */
export function ageOn(dateOfBirth: string, day: string): number | null {
  const birth = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  const today = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!birth || !today) return null;
  const [by, bm, bd] = birth.slice(1).map(Number) as [number, number, number];
  const [ty, tm, td] = today.slice(1).map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age >= 0 ? age : null;
}

/** Whether an age is inside a published age band (an open band takes everyone). */
export function ageFits(
  band: { minAgeYears?: number; maxAgeYears?: number },
  age: number,
): boolean {
  if (band.minAgeYears !== undefined && age < band.minAgeYears) return false;
  if (band.maxAgeYears !== undefined && age > band.maxAgeYears) return false;
  return true;
}

/** "Ages 7–11", "Ages 5 and up", "All ages". */
export function agesShort(band: { minAgeYears?: number; maxAgeYears?: number }): string {
  const { minAgeYears: min, maxAgeYears: max } = band;
  if (min !== undefined && max !== undefined) return `Ages ${min}–${max}`;
  if (min !== undefined) return `Ages ${min} and up`;
  if (max !== undefined) return `Ages ${max} and under`;
  return 'All ages';
}

/** "3 left" (warning) at five or fewer, "Full · waitlist" (danger); null when not known. */
export function placesBadge(
  availability: Availability | undefined,
  words: { few: (n: number) => string; full: string } = {
    few: (n) => `${n} left`,
    full: 'Full · waitlist',
  },
): StatusBadgeProps | null {
  if (!availability || availability.status === 'not_configured') return null;
  if (availability.status === 'full' || (availability.remaining ?? 0) <= 0) {
    return { tone: 'danger', label: words.full };
  }
  const left = availability.remaining ?? 0;
  return left <= 5 ? { tone: 'warning', label: words.few(left) } : null;
}

/** Whether the activity is full (the waitlist answer replaces the fit answer). */
export function isFull(availability: Availability | undefined): boolean {
  return (
    availability !== undefined &&
    availability.status !== 'not_configured' &&
    (availability.status === 'full' || (availability.remaining ?? 0) <= 0)
  );
}

/** Something on a child's calendar: a time and the name a clash names it by. */
export interface BusyTime {
  start: string;
  end: string;
  /** "Desert Foxes", "Mini kickers". */
  title: string;
  /** The activity it belongs to (a program session); absent for a team game. */
  offeringId?: string;
}

/** Live (not canceled) sessions in time order. */
export function liveSessions(sessions: readonly OfferingSession[]): OfferingSession[] {
  return sessions
    .filter((s) => s.status !== 'canceled')
    .sort((a, b) => Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart));
}

/** The first busy time a session overlaps (touching end to start is not a clash). */
export function firstClash(
  sessions: readonly Pick<OfferingSession, 'scheduledStart' | 'scheduledEnd' | 'status'>[],
  busy: readonly BusyTime[],
): BusyTime | null {
  for (const session of sessions) {
    if (session.status === 'canceled') continue;
    const start = Date.parse(session.scheduledStart);
    const end = Date.parse(session.scheduledEnd);
    const hit = busy.find((b) => Date.parse(b.start) < end && start < Date.parse(b.end));
    if (hit) return hit;
  }
  return null;
}

export type FitAnswer =
  | { kind: 'in'; badge: StatusBadgeProps }
  | { kind: 'full'; badge: StatusBadgeProps }
  | { kind: 'clash'; badge: StatusBadgeProps; with: string }
  | { kind: 'fits'; badge: StatusBadgeProps };

/**
 * The one answer a card gives: full (waitlist) first, then a clash, then "fits". Null while what
 * it needs is unknown: no child chosen, sessions or the calendar not read.
 */
export function fitAnswer(input: {
  /** The activities the card stands for (a camp's weeks): the child's own sessions of them are not a clash. */
  offeringIds?: readonly string[];
  availability: Availability | undefined;
  sessions: readonly OfferingSession[] | undefined;
  busy: readonly BusyTime[] | undefined;
  /** The child's given name; null for "Everyone". */
  childName: string | null;
}): FitAnswer | null {
  const own = new Set(input.offeringIds ?? []);
  if (input.childName && input.busy?.some((b) => b.offeringId && own.has(b.offeringId))) {
    const who = input.childName === 'your' ? 'You are' : `${input.childName} is`;
    return { kind: 'in', badge: { tone: 'success', label: `${who} in` } };
  }
  if (isFull(input.availability)) {
    return { kind: 'full', badge: { tone: 'danger', label: 'Full · waitlist' } };
  }
  if (!input.childName || !input.sessions || !input.busy) return null;
  // Nothing to compare (a membership, a rental): no answer rather than a promise.
  if (liveSessions(input.sessions).length === 0) return null;
  const clash = firstClash(
    input.sessions,
    input.busy.filter((b) => !b.offeringId || !own.has(b.offeringId)),
  );
  if (clash) {
    return {
      kind: 'clash',
      with: clash.title,
      badge: { tone: 'warning', label: `Clashes with ${clash.title}` },
    };
  }
  return { kind: 'fits', badge: { tone: 'success', label: `Fits ${input.childName}'s week` } };
}

const WEEKDAYS = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];

function weekdayOf(iso: string, zone: string): number {
  const key = localDayKey(iso, zone);
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

/**
 * When an activity meets, from its sessions on the facility clock: "Wednesdays 5:00 PM" (`range`:
 * "Wednesdays 5:00–6:00 PM") when every session is on one weekday at one time, "Weekdays 9:00 AM"
 * for a camp that meets Monday to Friday, else null (the dates say it instead).
 */
export function meetingPattern(
  sessions: readonly OfferingSession[],
  zone: string,
  options: { range?: boolean } = {},
): string | null {
  const live = liveSessions(sessions);
  const first = live[0];
  if (!first) return null;
  const time = formatTime(first.scheduledStart, zone);
  const end = formatTime(first.scheduledEnd, zone);
  const sameTime = live.every((s) => formatTime(s.scheduledStart, zone) === time);
  if (!sameTime) return null;
  const days = new Set(live.map((s) => weekdayOf(s.scheduledStart, zone)));
  const when = options.range ? timeRange(time, end) : time;
  if (days.size === 1) return `${WEEKDAYS[weekdayOf(first.scheduledStart, zone)]} ${when}`;
  if ([...days].every((d) => d >= 1 && d <= 5)) return `Weekdays ${when}`;
  return null;
}

/** "5:00–6:00 PM", "11:00 AM–12:00 PM". */
export function timeRange(start: string, end: string): string {
  const [startTime, startHalf] = start.split(' ');
  const [, endHalf] = end.split(' ');
  return startHalf && startHalf === endHalf ? `${startTime}–${end}` : `${start}–${end}`;
}

/** "8 weeks", "5 days", "1 session": how long an activity runs, from its live sessions. */
export function lengthWords(sessions: readonly OfferingSession[], zone: string): string | null {
  const live = liveSessions(sessions);
  if (live.length === 0) return null;
  const days = new Set(live.map((s) => localDayKey(s.scheduledStart, zone)));
  const weekdays = new Set(live.map((s) => weekdayOf(s.scheduledStart, zone)));
  if (weekdays.size === 1 && days.size > 1) return `${days.size} weeks`;
  if (days.size > 1) return `${days.size} days`;
  return live.length === 1 ? '1 session' : `${live.length} sessions`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(day: string): { month: number; date: number } | null {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return match ? { month: Number(match[1]) - 1, date: Number(match[2]) } : null;
}

/** "Dec 22–26", "Dec 29–Jan 2", "Mar 7": calendar dates, short. */
export function shortRange(startsOn: string, endsOn: string): string {
  const a = parts(startsOn);
  const b = parts(endsOn);
  if (!a || !b) return `${startsOn}–${endsOn}`;
  const first = `${MONTHS[a.month]} ${a.date}`;
  if (startsOn === endsOn) return first;
  return a.month === b.month ? `${first}–${b.date}` : `${first}–${MONTHS[b.month]} ${b.date}`;
}

/** "Mar 7": a calendar date, short. */
export function shortDate(day: string): string {
  const a = parts(day);
  return a ? `${MONTHS[a.month]} ${a.date}` : day;
}

/** "$95", "$145": whole amounts without cents, as the cards show them. */
export function wholeMoney(amountMinor: number, currency: string): string {
  const full = formatMoney(amountMinor, currency);
  return amountMinor % 100 === 0 ? full.replace(/\.00$/, '') : full;
}

/** The card's price: "$95"; a price per class reads "$24 a class"; null with no quotable price. */
export function cardPrice(price: PublicOffering['price']): string | null {
  if (!price || price.notQuotable) return null;
  const amount = wholeMoney(price.basePriceMinor, price.currency);
  return price.pricingBasis === 'per_session' ? `${amount} a class` : amount;
}

/**
 * Camp weeks of one program are one camp (handoff 1d shows "Winter Break Camp" once, its weeks
 * are chosen on Options): the camp's name is the weeks' shared name before " · ", e.g.
 * "Winter Break Camp · Week 1" → "Winter Break Camp".
 */
export function campName(name: string): string {
  const at = name.indexOf(' · ');
  return at > 0 ? name.slice(0, at) : name;
}

/** The week's own label after the camp's name ("Week 1"), or the whole name. */
export function weekLabel(name: string): string {
  const at = name.indexOf(' · ');
  return at > 0 ? name.slice(at + 3) : name;
}

export interface ExploreItem<
  T extends Pick<PublicOffering, 'id' | 'kind' | 'programId' | 'name' | 'startsOn' | 'endsOn'>,
> {
  /** The offering the card opens (the first open week of a camp). */
  lead: T;
  /** Every week of a camp (one item for anything else), in date order. */
  members: T[];
  name: string;
}

/** One card per camp program (its weeks together), one per other activity; order kept. */
export function groupForExplore<
  T extends Pick<PublicOffering, 'id' | 'kind' | 'programId' | 'name' | 'startsOn' | 'endsOn'> & {
    publicationState?: string;
  },
>(items: readonly T[]): ExploreItem<T>[] {
  const out: ExploreItem<T>[] = [];
  const camps = new Map<string, ExploreItem<T>>();
  for (const item of items) {
    if (item.kind !== 'camp') {
      out.push({ lead: item, members: [item], name: item.name });
      continue;
    }
    const key = `${item.programId}:${campName(item.name)}`;
    const known = camps.get(key);
    if (known) {
      known.members.push(item);
      known.members.sort((a, b) => a.startsOn.localeCompare(b.startsOn));
      known.lead =
        known.members.find((m) => m.publicationState === 'registration_open') ??
        known.members[0] ??
        item;
      continue;
    }
    const group = { lead: item, members: [item], name: campName(item.name) };
    camps.set(key, group);
    out.push(group);
  }
  return out;
}
