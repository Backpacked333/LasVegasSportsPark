import type { FixtureAttendanceMarksTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { Reader } from './competition.queries';

export type AttendanceMarkRow = Selectable<FixtureAttendanceMarksTable>;

/**
 * Each player's current attendance mark of the fixtures (migration 0465: marks are append-only and
 * chained, the current one is the mark nobody supersedes). Cleared marks are returned too; callers
 * that show a state leave them out.
 */
export async function latestAttendanceMarks(
  db: Reader,
  organizationId: string,
  fixtureIds: readonly string[],
): Promise<AttendanceMarkRow[]> {
  if (fixtureIds.length === 0) return [];
  return db
    .selectFrom('fixture_attendance_marks as m')
    .selectAll('m')
    .where('m.organization_id', '=', organizationId)
    .where('m.fixture_id', 'in', [...fixtureIds])
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('fixture_attendance_marks as n')
            .select('n.id')
            .whereRef('n.organization_id', '=', 'm.organization_id')
            .whereRef('n.supersedes_mark_id', '=', 'm.id'),
        ),
      ),
    )
    .orderBy('m.fixture_id')
    .orderBy('m.team_entry_id')
    .orderBy('m.person_id')
    .execute();
}

/** The current mark of one player on one fixture side (null before the first mark). */
export async function currentAttendanceMark(
  db: Reader,
  organizationId: string,
  fixtureId: string,
  teamEntryId: string,
  personId: string,
): Promise<AttendanceMarkRow | null> {
  const rows = await latestAttendanceMarks(db, organizationId, [fixtureId]);
  return rows.find((r) => r.team_entry_id === teamEntryId && r.person_id === personId) ?? null;
}
