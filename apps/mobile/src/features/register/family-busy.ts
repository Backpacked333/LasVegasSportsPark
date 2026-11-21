/**
 * A child's busy times for the next eight weeks (handoff 1d row 3, 3d, 2e "No clash with Maya's
 * calendar"; SPK-YOUTH-007): program sessions and bookings from `GET /v1/me/family-calendar` (two
 * 28-day windows) and the games of the child's teams from `GET /v1/me/fixtures` with
 * `GET /v1/me/team-entries`. `busy` is undefined until every read has answered, so a clash or a
 * fit is never shown from half a calendar.
 */
import type { Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useNow } from '../../providers/AppProviders';
import { calendarWindowQuery, mergeCalendars } from '../today/calendar';
import { entryPersonIds, fixtureEntry } from '../today/entries';
import { useCalendarWindows, useMyFixtures, useMyTeams } from '../today/queries';
import type { BusyTime } from './fit';

type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;

/** How far ahead a clash is looked for. */
export const FIT_WINDOW_DAYS = 56;

/** "Desert Foxes U9" → "Desert Foxes": the team's name without its age group. */
export function teamShortName(name: string): string {
  return name.replace(/\s+U\d{1,2}$/u, '');
}

/** The child's team in a game: the side whose entry lists them, else the home side. */
function childSide(fixture: FixtureDetail, personId: string, teams: readonly MyTeamEntry[]) {
  const mine = teams.find(
    (t) =>
      t.members.some((m) => m.personId === personId) &&
      (t.teamEntry.id === fixture.home.entryId || t.teamEntry.id === fixture.away?.entryId),
  );
  if (mine && fixture.away?.entryId === mine.teamEntry.id) return fixture.away;
  return fixture.home;
}

/** Busy times of one person (pure, for tests). */
export function busyTimesOf(
  personId: string,
  items: readonly Schema<'FamilyCalendarItem'>[],
  fixtures: readonly FixtureDetail[],
  teams: readonly MyTeamEntry[],
): BusyTime[] {
  const out: BusyTime[] = [];
  for (const item of items) {
    if (item.personId !== personId) continue;
    if (item.status === 'canceled') continue;
    out.push({ start: item.start, end: item.end, title: item.title, offeringId: item.offeringId });
  }
  for (const fixture of fixtures) {
    const entry = fixtureEntry(fixture);
    if (!entry || fixture.status === 'canceled' || fixture.status === 'postponed') continue;
    if (!entryPersonIds(entry, teams).includes(personId)) continue;
    out.push({
      start: entry.start,
      end: entry.end,
      title: teamShortName(childSide(fixture, personId, teams)?.teamName ?? 'a game'),
    });
  }
  return out;
}

export function useBusyTimes(personId: string | null, zone: string) {
  const now = useNow();
  // One anchor per facility day, so the reads keep their cache keys through the day.
  const dayKey = calendarWindowQuery(now, 0, 1, zone).from;
  const anchor = useMemo(() => new Date(dayKey), [dayKey]);
  const windows = useCalendarWindows(anchor, 2, FIT_WINDOW_DAYS / 2, zone);
  const range = useMemo(() => {
    const first = calendarWindowQuery(anchor, 0, FIT_WINDOW_DAYS, zone);
    return { from: first.from, to: first.to };
  }, [anchor, zone]);
  const fixtures = useMyFixtures(range, personId !== null);
  const teams = useMyTeams(personId !== null);
  const calendars = windows.map((w) => w.data);
  const ready =
    personId !== null &&
    calendars.every((c) => c !== undefined) &&
    fixtures.data !== undefined &&
    teams.data !== undefined;
  const failed =
    windows.some((w) => w.error !== null) || fixtures.error !== null || teams.error !== null;
  const busy = useMemo(() => {
    if (!ready || !personId) return undefined;
    const merged = mergeCalendars(calendars as Schema<'FamilyCalendar'>[]);
    return busyTimesOf(personId, merged?.items ?? [], fixtures.data ?? [], teams.data ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the reads' data stand for `calendars`
  }, [ready, personId, ...calendars, fixtures.data, teams.data]);
  return { busy, failed };
}
