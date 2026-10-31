import { newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at, createScheduledEvent, EventsService, seedResource } from '../../scheduling';
import { createRequirementFixture } from '../../workforce';
import { expectPgError, get, reportingTestApp, staff, valueOf, type Actor } from './support';

const DATE = '2027-02-03';
const RESTRICT = '23001';

/**
 * Migration 1303 (REP-03, WRK-02): the requirements view exposes `retired_at`, read from the whole
 * row. Workforce migration 0704 (retired_at, retired_reason, retired_by and the
 * assignment_requirements_retirement_facts check) is a merged dependency of view 1303, so the
 * retirement facts are written together as that check requires; a change to 0704's columns fails
 * this test rather than being patched over here (R2-TESTS-09).
 */
async function retire(t: TestApp, requirementId: string, at: Date): Promise<void> {
  await sql`update assignment_requirements
               set retired_at = ${at}, retired_reason = 'Booking withdrawn',
                   retired_by = ${JSON.stringify({ kind: 'system', actorLabel: 'tests' })}::jsonb
             where id = ${requirementId}`.execute(t.db);
}

describe('retired staffing requirements are not counted (migration 1303, WRK-02)', () => {
  let t: TestApp;
  let gm: Actor;
  let first: string;
  let retiredRole: string;
  let retiredTarget: string;

  beforeAll(async () => {
    t = await reportingTestApp();
    gm = await staff(t, ['general_manager']);
    const events = t.app.get(EventsService);
    const room = await seedResource(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Party room',
    });
    const event = async (start: string, end: string) =>
      (
        await createScheduledEvent(events, {
          organizationId: t.organizationId,
          facilityId: t.facilityId,
          resourceIds: [room.resourceId],
          start: at(DATE, start),
          end: at(DATE, end),
          kind: 'party',
          title: `Party ${start}`,
        })
      ).id;
    first = await event('10:00', '12:00');
    const second = await event('14:00', '16:00');
    await createRequirementFixture(t, {
      targetType: 'event',
      targetId: first,
      kind: 'supervisor',
      role: 'program_manager',
      requiredCount: 1,
    });
    retiredRole = await createRequirementFixture(t, {
      targetType: 'event',
      targetId: first,
      kind: 'organizer',
      role: 'league_manager',
      requiredCount: 2,
    });
    retiredTarget = await createRequirementFixture(t, {
      targetType: 'event',
      targetId: second,
      kind: 'supervisor',
      role: 'program_manager',
      requiredCount: 1,
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const uncovered = () =>
    get(t, '/v1/reports/uncovered-assignments', gm, {
      facilityId: t.facilityId,
      from: DATE,
      to: DATE,
    });

  it('WRK-02: a retired requirement never counts in the uncovered-assignments report', async () => {
    const before = await uncovered();
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(valueOf(before.body, 'MET-017')).toBe(4);

    await retire(t, retiredRole, t.clock.now());
    await retire(t, retiredTarget, t.clock.now());
    const view = await t.db
      .selectFrom('reporting_assignment_requirements_v')
      .select(['requirement_id', 'retired_at'])
      .where('organization_id', '=', t.organizationId)
      .execute();
    expect(
      view
        .filter((r) => r.retired_at !== null)
        .map((r) => r.requirement_id)
        .sort(),
    ).toEqual([retiredRole, retiredTarget].sort());

    const after = await uncovered();
    expect(after.status).toBe(200);
    expect(valueOf(after.body, 'MET-017')).toBe(1);
    expect(after.body.rows).toEqual([
      expect.objectContaining({ targetId: first, role: 'program_manager', uncovered: 1 }),
    ]);
    expect((after.body.disclosures as string[]).join(' ')).toContain('Retired requirements');
  });

  it('§4.2: the replaced requirements view still refuses every write', async () => {
    await expectPgError(
      sql`insert into reporting_assignment_requirements_v (requirement_id, organization_id) values (${newId()}, ${t.organizationId})`.execute(
        t.db,
      ),
      RESTRICT,
    );
    await expectPgError(
      sql`update reporting_assignment_requirements_v set retired_at = null`.execute(t.db),
      RESTRICT,
    );
  });
});
