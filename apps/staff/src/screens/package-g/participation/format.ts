/**
 * Display helpers shared by the Package G participation screens SCR-S-51 to SCR-S-54 (rentals,
 * parties, memberships, session packages; §3.16).
 *
 * - Money is the API's integer minor units with its currency (SPK-PAY-001); the client formats it
 *   and never computes, rounds or defaults a price, term or deposit.
 * - Instants are shown in the facility's IANA zone when the API names it (SPK-SCHED-008), with the
 *   zone written out. When the zone is not known the time is shown in UTC and says so, never as
 *   facility-local time.
 */
import { formatMinorUnits } from '@sportspark/api-client';
import {
  formatInstant as formatInZone,
  formatLocalDate,
  formatRange as formatRangeInZone,
} from '../../../features/schedule-facilities/time';

/** "$125.50" from 12550 USD; a missing amount is said in words, never shown as zero. */
export function formatMoney(
  amountMinor: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amountMinor === null || amountMinor === undefined) return 'Not stated';
  if (!currency) return `${amountMinor} minor units (currency not stated)`;
  return formatMinorUnits(amountMinor, currency);
}

/** The first eight characters of an opaque id, for staff to quote. */
export function shortRef(id: string): string {
  return id.slice(0, 8);
}

/** The zone to show times in, and whether it is the facility's (false: UTC fallback). */
export function zoneOf(timeZone: string | null | undefined): { zone: string; known: boolean } {
  return timeZone ? { zone: timeZone, known: true } : { zone: 'UTC', known: false };
}

/** "Sat, Oct 24, 18:00 PDT" in the facility's zone, or "… UTC (facility time zone not known)". */
export function formatInstant(
  iso: string | null | undefined,
  timeZone: string | null | undefined,
): string {
  if (!iso) return 'Not set';
  if (Number.isNaN(new Date(iso).getTime())) return 'Not set';
  const { zone, known } = zoneOf(timeZone);
  const text = formatInZone(iso, zone);
  return known ? text : `${text} (facility time zone not known)`;
}

/** "Sat, Oct 24, 18:00 to 19:30 PDT" in the facility's zone (UTC, said so, when unknown). */
export function formatRange(
  start: string,
  end: string,
  timeZone: string | null | undefined,
): string {
  const { zone, known } = zoneOf(timeZone);
  const text = formatRangeInZone(start, end, zone);
  return known ? text : `${text} (facility time zone not known)`;
}

/** A calendar date ("2026-12-31") written out without shifting it through a zone. */
export function formatDate(date: string | null | undefined): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return date ?? 'Not set';
  return formatLocalDate(date);
}

/** "1 session", "3 sessions". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
