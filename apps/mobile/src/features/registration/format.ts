/**
 * Display formatting for the registration screens (SCR-C-07 to SCR-C-16). Display only: amounts
 * come from the API in minor units (SPK-PAY-001), instants are the server's (holds, quotes and
 * offers expire on the server clock, SPK-REG-006), and nothing here computes a policy value.
 *
 * Times are shown in the device's time zone with the zone named, because the public offering does
 * not carry its facility's time zone (SPK-SCHED-008; reported as an API gap).
 */
import { formatMinorUnits, type Schema } from '@sportspark/api-client';

export type OfferingKind = Schema<'OfferingKind'>;
export type RegistrationIntent = Schema<'RegistrationIntent'>;

export function formatMoney(amountMinor: number, currency: string): string {
  return formatMinorUnits(amountMinor, currency);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar date (`2026-11-02`) as "Nov 2, 2026", without any time-zone shift. */
export function formatDateOnly(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1] ?? month} ${Number(day)}, ${year}`;
}

export function formatDateRange(startsOn: string, endsOn: string): string {
  return startsOn === endsOn
    ? formatDateOnly(startsOn)
    : `${formatDateOnly(startsOn)} to ${formatDateOnly(endsOn)}`;
}

/** An instant as "Sat, Oct 24, 12:10 PM UTC" in the device's time zone (zone always named). */
export function formatInstant(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone,
  }).format(date);
}

/** Whole minutes from `now` until `iso` (0 when passed): an informational countdown only. */
export function minutesUntil(iso: string, now: Date): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - now.getTime()) / 60_000));
}

export function hasPassed(iso: string, now: Date): boolean {
  return new Date(iso).getTime() <= now.getTime();
}

/** "about 9 minutes left", "less than a minute left", for a server-owned expiry. */
export function timeLeftPhrase(iso: string, now: Date): string {
  const minutes = minutesUntil(iso, now);
  if (hasPassed(iso, now)) return 'time is up';
  if (minutes < 1) return 'less than a minute left';
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'} left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'} left`;
}

export const OFFERING_KIND_LABELS: Record<OfferingKind, string> = {
  season: 'League season',
  term: 'Program',
  camp: 'Camp',
  session: 'Single session',
  trial: 'Trial',
  makeup: 'Makeup session',
  pickup: 'Pickup session',
  private_coaching: 'Private coaching',
  rental: 'Rental',
  package: 'Package',
  membership: 'Membership',
};

export function ageBandLabel(band: { minAgeYears?: number; maxAgeYears?: number }): string | null {
  const { minAgeYears: min, maxAgeYears: max } = band;
  if (min !== undefined && max !== undefined) {
    return min === max ? `Age ${min}` : `Ages ${min} to ${max}`;
  }
  if (min !== undefined) return `Ages ${min} and over`;
  if (max !== undefined) return `Ages up to ${max}`;
  return null;
}

const CAPACITY_UNIT_LABELS: Record<Schema<'CapacityUnitKind'>, [string, string]> = {
  team_entries: ['team entry', 'team entries'],
  roster_places: ['roster place', 'roster places'],
  seats: ['place', 'places'],
  session_seats: ['session place', 'session places'],
  camp_group_places: ['camp group place', 'camp group places'],
  rental_resources: ['rental space', 'rental spaces'],
};

export function capacityLabel(capacity: { unit: Schema<'CapacityUnitKind'>; limit: number }) {
  const [one, many] = CAPACITY_UNIT_LABELS[capacity.unit];
  return `${capacity.limit} ${capacity.limit === 1 ? one : many}`;
}

/** Field-level messages from a VALIDATION_FAILED answer: zod issues or a service `path`. */
export function fieldMessages(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(details)) {
    for (const issue of details) {
      if (issue && typeof issue === 'object') {
        const { path, message } = issue as { path?: unknown; message?: unknown };
        if (typeof path === 'string' && typeof message === 'string') out[path] = message;
      }
    }
  } else if (details && typeof details === 'object') {
    const { path, field } = details as { path?: unknown; field?: unknown };
    const key = typeof path === 'string' ? path : typeof field === 'string' ? field : null;
    if (key) out[key] = 'Check this entry.';
  }
  return out;
}
