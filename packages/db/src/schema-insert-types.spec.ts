import type { Insertable } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Database } from './schema';

/**
 * CLAUDE.md "Kysely table interfaces for the module": a column the database requires on insert
 * (`not null` without a default) is required by its Insertable type, and a column with a default
 * is optional, so an insert that type-checks does not fail at runtime with a not-null violation.
 * Checked by `pnpm typecheck` (packages/db/tsconfig.spec.json): an unused `@ts-expect-error` fails.
 */
type ReportInsert = Insertable<Database['reconciliation_reports']>;
type CheckinInsert = Insertable<Database['session_checkins']>;

// reconciliation_reports.required_areas is `text[] not null` with no default (migration 1200).
// @ts-expect-error required_areas may not be omitted
const withoutAreas: Omit<ReportInsert, 'required_areas'> extends ReportInsert ? true : never = true;
// session_checkins.issues defaults to '[]' (migration 0800), so it may be omitted.
const withoutIssues: Omit<CheckinInsert, 'issues'> extends CheckinInsert ? true : never = true;

describe('Kysely insert types follow the migrated columns', () => {
  it('a column required by the database is required on insert; one with a default is optional', () => {
    expect([withoutAreas, withoutIssues]).toEqual([true, true]);
  });
});
