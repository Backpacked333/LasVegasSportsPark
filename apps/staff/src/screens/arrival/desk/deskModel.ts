/**
 * The arrival desk's reading of a scan (staff S 2a, SPK-ENTRY-003, SPK-ENTRY-004): one household,
 * one verdict per person, each with the session it is for.
 *
 * - A pass scan (`POST /v1/passes/scan`) and a lookup by name (`POST /v1/arrival-lookups`) answer
 *   the same people, sessions and arrival checks; both record nobody.
 * - A person's verdict comes from the API's checks for their next session today: "cleared" when no
 *   check is blocking, "not cleared" with the blocking check's words and fix otherwise. Warnings
 *   (not on site yet, an unrelated balance) never block (SPK-ENTRY-004).
 * - Times are the facility's (SPK-SCHED-008), written as the desk reads a clock ("9:00").
 */
import type { Schema } from '@sportspark/api-client';

export type PassScan = Schema<'PassScan'>;
export type ArrivalLookup = Schema<'ArrivalLookup'>;
export type ScanPerson = Schema<'ScanPerson'>;
export type ScanActivity = Schema<'ScanActivity'>;
export type ArrivalIssue = Schema<'ArrivalIssue'>;

/** What the desk opened: a pass, or a family found by name. */
export interface DeskOpening {
  source: 'pass' | 'lookup';
  /** The pass, for a scan (arrivals record which pass opened them). */
  passId: string | null;
  facilityId: string;
  /** The service's time of the opening (the roster snapshot for queued check-ins, §4.15). */
  openedAt: string;
  people: ScanPerson[];
  /** How the desk reopens it to re-check the verdict (after a signature on the tablet). */
  reopen: { kind: 'pass'; reference: string } | { kind: 'lookup'; holder: ArrivalLookup['holder'] };
}

export function fromScan(scan: PassScan, reference: string): DeskOpening {
  return {
    source: 'pass',
    passId: scan.pass.id,
    facilityId: scan.facilityId,
    openedAt: scan.scannedAt,
    people: scan.people,
    reopen: { kind: 'pass', reference },
  };
}

export function fromLookup(lookup: ArrivalLookup): DeskOpening {
  return {
    source: 'lookup',
    passId: null,
    facilityId: lookup.facilityId,
    openedAt: lookup.scannedAt,
    people: lookup.people,
    reopen: { kind: 'lookup', holder: lookup.holder },
  };
}

export const fullName = (p: Pick<ScanPerson, 'givenName' | 'familyName'>): string =>
  `${p.givenName} ${p.familyName}`.trim();

export type Verdict =
  | { kind: 'checked_in'; activity: ScanActivity }
  | { kind: 'cleared'; activity: ScanActivity }
  | { kind: 'not_cleared'; activity: ScanActivity; blocking: ArrivalIssue[] }
  | { kind: 'no_activity' };

/** The session the desk acts on for this person: the first today not yet checked in. */
export function nextActivity(person: ScanPerson, now: Date): ScanActivity | null {
  const upcoming = person.activities.filter((a) => new Date(a.scheduledEnd) > now);
  return (
    upcoming.find((a) => a.checkin?.status !== 'admitted') ??
    upcoming[0] ??
    person.activities.find((a) => a.checkin?.status !== 'admitted') ??
    null
  );
}

export function verdictOf(person: ScanPerson, now: Date): Verdict {
  const activity = nextActivity(person, now);
  if (!activity) return { kind: 'no_activity' };
  if (activity.checkin?.status === 'admitted') return { kind: 'checked_in', activity };
  // Older services answer without checks: nothing is known to block.
  const blocking = (activity.issues ?? []).filter((i) => i.severity === 'blocking');
  return blocking.length > 0
    ? { kind: 'not_cleared', activity, blocking }
    : { kind: 'cleared', activity };
}

/** The quoted title an issue message names, e.g. "Liability waiver" in `"Liability waiver" has…`. */
function quotedTitle(message: string): string | null {
  const match = /^"([^"]+)"/.exec(message);
  return match?.[1] ?? null;
}

/** A blocking check in desk words (the API's message stays the source of truth for the rest). */
export function blockerWords(issue: ArrivalIssue): string {
  const title = quotedTitle(issue.message);
  switch (issue.code) {
    case 'waiver_missing':
      return `${title ?? 'Liability waiver'} not signed`;
    case 'waiver_lapsed':
      return `${title ?? 'Liability waiver'} has expired`;
    case 'missing_acknowledgment':
      return 'A required form is not signed';
    case 'no_participation':
      return 'Not registered for this session';
    case 'not_registered_for_session':
      return 'Registered for other days, not this one';
    case 'enrollment_not_confirmed':
      return 'Registration not confirmed yet';
    case 'outstanding_balance':
      return 'A balance has to be settled first';
    case 'activity_canceled':
      return 'This session is cancelled';
    case 'desk_review_required':
      return 'The desk has to review this first';
    default:
      return issue.message;
  }
}

/**
 * A blocking waiver or required form the parent can sign here, with the version it names (a
 * waiver acceptance, SPK-REG-011, or a form acknowledgment, SPK-REG-009).
 */
export function signableWaiver(issues: readonly ArrivalIssue[]): ArrivalIssue | null {
  return (
    issues.find(
      (i) =>
        (i.code === 'waiver_missing' ||
          i.code === 'waiver_lapsed' ||
          i.code === 'missing_acknowledgment') &&
        i.reference?.type === 'policy_version',
    ) ?? null
  );
}

/** "9:00" on the facility's clock (the device zone when unknown). */
export function deskClock(iso: string, timeZone?: string | null, seconds = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  return parts
    .filter((p) => p.type !== 'dayPeriod')
    .map((p) => p.value)
    .join('')
    .trim();
}

/** A person's age in whole years on a date, from a YYYY-MM-DD birth date. */
export function ageOn(dateOfBirth: string | null | undefined, on: Date): number | null {
  if (!dateOfBirth) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  let age = on.getUTCFullYear() - y;
  const month = on.getUTCMonth() + 1;
  if (month < m || (month === m && on.getUTCDate() < d)) age -= 1;
  return age >= 0 ? age : null;
}

/**
 * Names of the people the desk scanned in this tab, kept in memory only (never stored on the
 * device, §4.15: the queue holds identifiers only), so the "Waiting to sync" list can name them.
 */
const names = new Map<string, string>();
export function rememberNames(people: readonly ScanPerson[]): void {
  for (const p of people) names.set(p.personId, fullName(p));
}
export function rememberedName(personId: string): string | null {
  return names.get(personId) ?? null;
}
