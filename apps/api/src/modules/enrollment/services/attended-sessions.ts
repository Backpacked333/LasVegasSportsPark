import { sql, type RawBuilder, type SqlBool } from 'kysely';

/**
 * The sessions an enrollment attends (SPK-PAY-014, proposed amendment PA-03): the one rule every
 * reader of "the sessions of an enrollment" uses, in this module and, through `index.ts`, in the
 * modules that read enrollments through ENROLLMENT_PORT.
 *
 * An enrollment stores a day selection (`selected_session_ids`, migration 0521) only when the
 * participant chose days under a price tier that lets them. Without one it attends every session
 * of its offering, which is every enrollment written before the amendment and every one made
 * while `price_tiers_addons` is off. With one it attends exactly the sessions selected: it is
 * expected at arrival, shown on the family calendar, listed for attendance, told of changes and
 * counted on session capacity for those sessions and no others.
 */
export type DaySelection = readonly string[] | null | undefined;

/** Whether an enrollment with this day selection attends the session. */
export function attendsSession(selection: DaySelection, sessionId: string): boolean {
  return !selection || selection.includes(sessionId);
}

/** The sessions of the enrollment's offering it attends: all of them when no selection is stored. */
export function attendedSessions<T extends { id: string }>(
  selection: DaySelection,
  sessionsOfOffering: readonly T[],
): T[] {
  if (!selection) return [...sessionsOfOffering];
  const selected = new Set(selection);
  return sessionsOfOffering.filter((session) => selected.has(session.id));
}

/**
 * The same rule for a query over `enrollments` (the table may be aliased): true for the rows that
 * attend `sessionId`. `sessionId` is a value, or a column reference built with `sql.ref`.
 */
export function attendsSessionSql(
  sessionId: string | RawBuilder<unknown>,
  table = 'enrollments',
): RawBuilder<SqlBool> {
  const selection = sql.ref(`${table}.selected_session_ids`);
  const session = typeof sessionId === 'string' ? sql`${sessionId}::uuid` : sessionId;
  return sql<SqlBool>`(${selection} is null or ${session} = any(${selection}))`;
}

/**
 * For other modules, over the `Enrollment` they read through ENROLLMENT_PORT: whether the
 * enrollment attends the session (entry's arrival checks and pass scan).
 */
export function enrollmentAttendsSession(
  enrollment: { selectedSessionIds: readonly string[] | null },
  sessionId: string,
): boolean {
  return attendsSession(enrollment.selectedSessionIds, sessionId);
}
