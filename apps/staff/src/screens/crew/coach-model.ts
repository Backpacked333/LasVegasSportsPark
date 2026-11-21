/**
 * The coach's week (staff redesign Phase 8 item 1), composed from reads the API already has:
 * `GET /v1/me/assignments` (classes and sessions the coach is assigned to), `GET /v1/me/team-entries`
 * (the teams the coach captains: a youth team's coach holds its captain role, SPK-CAP-001) and
 * `GET /v1/me/fixtures` (those teams' games with each side's availability counts, SPK-CAP-003).
 * Times are each activity's facility zone (SPK-SCHED-008).
 */
import type { Schema } from '@sportspark/api-client';
import { localDayOf } from './crew-ui';

export type WorkspaceAssignment = Schema<'WorkspaceAssignment'>;
export type FixtureDetail = Schema<'FixtureDetail'>;
export type MyTeamEntry = Schema<'MyTeamEntry'>;
export type AvailabilitySummary = Schema<'AvailabilitySummary'>;

export interface WeekItem {
  id: string;
  kind: 'game' | 'session';
  title: string;
  start: string;
  end: string;
  place: string | null;
  timezone: string | null;
  /** A game: the fixture and the coach's side. */
  fixtureId?: string;
  teamEntryId?: string;
  teamName?: string;
  opponentName?: string | null;
  availability?: AvailabilitySummary;
  fixtureStatus?: FixtureDetail['status'];
  /** A session: the coach's assignment. */
  assignmentId?: string;
  assignmentStatus?: WorkspaceAssignment['assignment']['status'];
}

/** The team entries the viewer captains (the coach of a youth team holds its captain role). */
export function captainedEntries(
  entries: readonly MyTeamEntry[],
  personId: string | null,
): MyTeamEntry[] {
  if (!personId) return [];
  return entries.filter((e) =>
    e.members.some(
      (m) =>
        m.personId === personId && (m.roles.includes('captain') || m.roles.includes('co_captain')),
    ),
  );
}

export function weekItems(
  assignments: readonly WorkspaceAssignment[],
  fixtures: readonly FixtureDetail[],
  captained: readonly MyTeamEntry[],
): WeekItem[] {
  const out: WeekItem[] = [];
  for (const a of assignments) {
    if (a.assignment.kind !== 'coach') continue;
    if (a.assignment.status !== 'accepted' && a.assignment.status !== 'offered') continue;
    // A game the coach also captains is listed once, as the game.
    if (a.activity.targetType === 'fixture' && fixtures.some((f) => f.id === a.activity.targetId)) {
      continue;
    }
    out.push({
      id: `assignment:${a.assignment.id}`,
      kind: 'session',
      title: a.activity.title,
      start: a.activity.scheduledStart,
      end: a.activity.scheduledEnd,
      place: a.activity.facility?.name ?? null,
      timezone: a.activity.facility?.timezone ?? null,
      assignmentId: a.assignment.id,
      assignmentStatus: a.assignment.status,
    });
  }
  const mine = new Set(captained.map((e) => e.teamEntry.id));
  for (const f of fixtures) {
    if (!f.scheduledStart || !f.scheduledEnd) continue;
    if (f.status === 'canceled' || f.status === 'postponed' || f.status === 'unscheduled') continue;
    const home = mine.has(f.home.entryId);
    const away = f.away ? mine.has(f.away.entryId) : false;
    if (!home && !away) continue;
    const side = home ? f.home : f.away!;
    const other = home ? f.away : f.home;
    out.push({
      id: `fixture:${f.id}`,
      kind: 'game',
      title: `${side.teamName} vs ${other?.teamName ?? 'bye'}`,
      start: f.scheduledStart,
      end: f.scheduledEnd,
      place: f.venue
        ? [f.venue.resources.map((r) => r.name).join(', '), f.venue.facilityName]
            .filter(Boolean)
            .join(' · ')
        : null,
      timezone: f.venue?.timezone ?? null,
      fixtureId: f.id,
      teamEntryId: side.entryId,
      teamName: side.teamName,
      opponentName: other?.teamName ?? null,
      availability: side.availability,
      fixtureStatus: f.status,
    });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Monday to Sunday of the week holding `now`, as facility-local dates. */
export function weekDays(now: Date, timeZone: string | null): string[] {
  const today = localDayOf(now, timeZone);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  const weekday = new Date(base).getUTCDay();
  const monday = base - ((weekday + 6) % 7) * 86_400_000;
  return Array.from({ length: 7 }, (_, i) =>
    new Date(monday + i * 86_400_000).toISOString().slice(0, 10),
  );
}

/** "Mon", "21" for a `YYYY-MM-DD` date. */
export function dayChipOf(day: string): { weekday: string; date: string } {
  const at = new Date(`${day}T12:00:00Z`);
  return {
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(at),
    date: String(at.getUTCDate()),
  };
}

/** The next item that has not ended (the one on now first). */
export function nextItem(items: readonly WeekItem[], now: Date): WeekItem | null {
  const t = now.getTime();
  return (
    items.find(
      (i) =>
        new Date(i.end).getTime() > t && (i.kind === 'game' || i.assignmentStatus === 'accepted'),
    ) ?? null
  );
}
