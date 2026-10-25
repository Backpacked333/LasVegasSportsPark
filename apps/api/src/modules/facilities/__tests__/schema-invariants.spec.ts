import { newId, systemPrincipal } from '@sportspark/contracts';
import {
  isCheckViolation,
  isForeignKeyViolation,
  isUniqueViolation,
  json,
  seedOrganization,
  tstzrange,
  type Db,
} from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import {
  at,
  ClosuresService,
  seedPitchWithHalves,
  seedResource,
  type PitchFixture,
} from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { seedAsset } from '../testing/facilities-fixtures';

/**
 * Integrity invariants proven at the database (CLAUDE.md "Integrity that matters is enforced in
 * the database"): rows are inserted through Kysely, bypassing the services.
 */
describe('facilities schema invariants (migrations 0900-0902)', () => {
  let t: TestApp;
  let db: Db;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let assetId: string;

  beforeAll(async () => {
    t = await createTestApp({ imports: [FacilitiesModule], clockStart: '2026-10-19T12:00:00Z' });
    db = t.db;
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(db, { organizationId: org, facilityId: facility, name: 'P' });
    assetId = await seedAsset(db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.northHalfId,
      identifier: 'TURF-N',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const taskValues = (extra: Record<string, unknown> = {}) => ({
    id: newId(),
    organization_id: org,
    facility_id: facility,
    asset_id: assetId,
    resource_id: pitch.northHalfId,
    issue: 'seam lifted',
    severity: 'high' as const,
    reporter: json({ kind: 'staff', actorLabel: 'test' }),
    reported_at: new Date('2026-10-19T12:00:00Z'),
    assigned_owner_person_id: null,
    due_at: null,
    resolution: null,
    resolved_at: null,
    closed_at: null,
    preventive_schedule_id: null,
    occurrence_index: null,
    ...extra,
  });

  const insertTask = (extra: Record<string, unknown> = {}) =>
    db
      .insertInto('maintenance_tasks')
      .values(taskValues(extra) as never)
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);

  const restrictionValues = (extra: Record<string, unknown> = {}) => ({
    id: newId(),
    organization_id: org,
    facility_id: facility,
    resource_id: pitch.northHalfId,
    asset_id: null,
    task_id: null,
    preventive_schedule_id: null,
    occurrence_index: null,
    kind: 'closed' as const,
    during: tstzrange(at('2026-11-15', '08:00'), at('2026-11-15', '20:00')),
    reason: 'turf repair',
    approved_by: null,
    approved_at: null,
    scheduling_closure_id: null,
    released_by: null,
    released_at: null,
    release_reason: null,
    operation_id: null,
    ...extra,
  });

  const insertRestriction = (extra: Record<string, unknown> = {}) =>
    db
      .insertInto('restrictions')
      .values(restrictionValues(extra) as never)
      .returning('id')
      .executeTakeFirstOrThrow()
      .then((r) => r.id);

  async function appliedClosure(): Promise<string> {
    const closures = t.app.get(ClosuresService);
    const principal = systemPrincipal(org, 'fixtures');
    const created = await closures.createClosure(principal, {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      interval: { start: at('2026-12-01', '08:00'), end: at('2026-12-01', '10:00') },
      reason: 'x',
      source: 'maintenance',
    });
    return created.id;
  }

  it('§4.3: an asset, task or restriction of one facility cannot name a space, asset, task or closure of another facility (0301, 0902)', async () => {
    const otherFacility = newId();
    await db
      .insertInto('facilities')
      .values({
        id: otherFacility,
        organization_id: org,
        slug: `other-${otherFacility.slice(0, 8)}`,
        name: 'Other facility',
        timezone: 'America/Los_Angeles',
      })
      .execute();
    const there = await seedResource(db, {
      organizationId: org,
      facilityId: otherFacility,
      name: 'Pitch over there',
    });
    const assetThere = await seedAsset(db, {
      organizationId: org,
      facilityId: otherFacility,
      resourceId: there.resourceId,
      identifier: 'GOAL-THERE',
    });
    // an asset of this facility on the other facility's pitch
    await expect(
      seedAsset(db, {
        organizationId: org,
        facilityId: facility,
        resourceId: there.resourceId,
        identifier: 'GOAL-BORROWED',
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // a task of this facility about the other facility's space or asset
    await expect(insertTask({ asset_id: null, resource_id: there.resourceId })).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    await expect(insertTask({ asset_id: assetThere, resource_id: null })).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    // a restriction of this facility closing the other facility's pitch, asset or task
    await expect(insertRestriction({ resource_id: there.resourceId })).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    await expect(insertRestriction({ asset_id: assetThere })).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    const taskThere = await insertTask({
      facility_id: otherFacility,
      asset_id: assetThere,
      resource_id: there.resourceId,
    });
    await expect(insertRestriction({ task_id: taskThere })).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    // a restriction of the other facility backed by this facility's closure
    const closureHere = await appliedClosure();
    await expect(
      insertRestriction({
        facility_id: otherFacility,
        resource_id: there.resourceId,
        status: 'approved',
        approved_by: json({ kind: 'staff' }),
        approved_at: new Date(),
        scheduling_closure_id: closureHere,
      }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // the same rows within one facility are accepted
    await expect(
      insertRestriction({
        facility_id: otherFacility,
        resource_id: there.resourceId,
        asset_id: assetThere,
        task_id: taskThere,
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it('§4.3: references cannot cross organizations (composite foreign keys)', async () => {
    const other = await seedOrganization(db);
    await expect(
      db
        .insertInto('assets')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: other.facilityId,
          resource_id: null,
          kind: 'goal',
          name: 'Foreign goal',
          identifier: null,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    await expect(
      db
        .insertInto('assets')
        .values({
          id: newId(),
          organization_id: other.organizationId,
          facility_id: other.facilityId,
          resource_id: pitch.northHalfId,
          kind: 'goal',
          name: 'Goal on another org pitch',
          identifier: null,
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    await expect(insertTask({ organization_id: other.organizationId })).rejects.toSatisfy(
      isForeignKeyViolation,
    );
    await expect(
      insertRestriction({ organization_id: other.organizationId, facility_id: other.facilityId }),
    ).rejects.toSatisfy(isForeignKeyViolation);
    // a restriction can only point at a closure of its own organization
    const closureId = await appliedClosure();
    const foreign = await seedResource(db, {
      organizationId: other.organizationId,
      facilityId: other.facilityId,
      name: 'Foreign pitch',
    });
    await expect(
      db
        .insertInto('restrictions')
        .values(
          restrictionValues({
            organization_id: other.organizationId,
            facility_id: other.facilityId,
            resource_id: foreign.resourceId,
            status: 'approved',
            approved_by: json({ kind: 'staff' }),
            approved_at: new Date(),
            scheduling_closure_id: closureId,
          }) as never,
        )
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
    await expect(
      db
        .insertInto('inspections')
        .values({
          id: newId(),
          organization_id: other.organizationId,
          task_id: await insertTask(),
          inspector: json({ kind: 'staff' }),
          outcome: 'passed',
          notes: null,
          inspected_at: new Date(),
        })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('SPK-FAC-002 / §4.3: a task can only be assigned to a person of its own organization (migration 0901)', async () => {
    const other = await seedOrganization(db);
    const foreign = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    const own = await createPersonFixture(t, { kind: 'adult' });
    const assigned = (personId: string) => ({
      status: 'assigned',
      assigned_owner_person_id: personId,
    });
    await expect(insertTask(assigned(foreign))).rejects.toSatisfy(isForeignKeyViolation);
    await expect(insertTask(assigned(newId()))).rejects.toSatisfy(isForeignKeyViolation);
    const ok = taskValues(assigned(own));
    await insertTask(ok);
    await expect(
      db
        .updateTable('maintenance_tasks')
        .set({ assigned_owner_person_id: foreign })
        .where('id', '=', ok.id)
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });

  it('check constraints list exactly the lifecycle states (§4.6)', async () => {
    await expect(
      db
        .insertInto('assets')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          resource_id: null,
          kind: 'goal',
          name: 'bad status',
          identifier: null,
          status: 'broken' as never,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('assets')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          resource_id: null,
          kind: 'trampoline' as never,
          name: 'bad kind',
          identifier: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(insertTask({ status: 'done' })).rejects.toSatisfy(isCheckViolation);
    await expect(insertTask({ severity: 'urgent' })).rejects.toSatisfy(isCheckViolation);
    await expect(insertRestriction({ status: 'pending' })).rejects.toSatisfy(isCheckViolation);
    await expect(insertRestriction({ kind: 'partial' })).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('inspections')
        .values({
          id: newId(),
          organization_id: org,
          task_id: await insertTask(),
          inspector: json({ kind: 'staff' }),
          outcome: 'ok' as never,
          notes: null,
          inspected_at: new Date(),
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      db
        .insertInto('preventive_schedules')
        .values({
          id: newId(),
          organization_id: org,
          facility_id: facility,
          resource_id: pitch.northHalfId,
          asset_id: null,
          name: 'bad',
          recurrence: json({}),
          local_start_time: '06:00',
          duration_minutes: 60,
          timezone: 'America/Los_Angeles',
          task_template: json({}),
          restriction_kind: 'closed',
          lead_time_days: 7,
          status: 'running' as never,
          last_generated_at: null,
          last_generated_through: null,
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-FAC-002: a maintenance record names an asset or a space, and its states carry their facts', async () => {
    await expect(insertTask({ asset_id: null, resource_id: null })).rejects.toSatisfy(
      isCheckViolation,
    );
    await expect(insertTask({ status: 'assigned' })).rejects.toSatisfy(isCheckViolation);
    await expect(insertTask({ status: 'resolved' })).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertTask({ status: 'resolved', resolution: json({ summary: 'fixed' }) }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertTask({
        status: 'closed',
        resolution: json({ summary: 'fixed' }),
        resolved_at: new Date(),
      }),
    ).rejects.toSatisfy(isCheckViolation);
    await insertTask({
      status: 'closed',
      resolution: json({ summary: 'fixed' }),
      resolved_at: new Date(),
      closed_at: new Date(),
    });
    await expect(insertTask({ occurrence_index: 3 })).rejects.toSatisfy(isCheckViolation);
  });

  it('SPK-FAC-003/004: approval, activation and release facts are inseparable from the state', async () => {
    await expect(insertRestriction({ approved_at: new Date() })).rejects.toSatisfy(
      isCheckViolation,
    );
    await expect(insertRestriction({ status: 'approved' })).rejects.toSatisfy(isCheckViolation);
    const approved = { approved_by: json({ kind: 'staff' }), approved_at: new Date() };
    await insertRestriction({ status: 'approved', ...approved });
    // active needs a scheduling closure
    await expect(insertRestriction({ status: 'active', ...approved })).rejects.toSatisfy(
      isCheckViolation,
    );
    const closureId = await appliedClosure();
    await expect(
      insertRestriction({ status: 'active', ...approved, scheduling_closure_id: closureId }),
    ).resolves.toBeTruthy();
    // one closure backs at most one restriction
    await expect(
      insertRestriction({ status: 'active', ...approved, scheduling_closure_id: closureId }),
    ).rejects.toSatisfy(isUniqueViolation);
    // released needs who, when and the closure that was lifted
    await expect(
      insertRestriction({ status: 'released', ...approved, scheduling_closure_id: closureId }),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      insertRestriction({
        status: 'released',
        ...approved,
        released_at: new Date(),
        released_by: json({ kind: 'staff' }),
      }),
    ).rejects.toSatisfy(isCheckViolation);
    const closure2 = await appliedClosure();
    await insertRestriction({
      status: 'released',
      ...approved,
      scheduling_closure_id: closure2,
      released_at: new Date(),
      released_by: json({ kind: 'staff' }),
      release_reason: 'inspection passed',
    });
  });

  it('SPK-FAC-002: a task carries at most one unreleased operating restriction', async () => {
    const taskId = await insertTask();
    await insertRestriction({ task_id: taskId });
    await expect(insertRestriction({ task_id: taskId })).rejects.toSatisfy(isUniqueViolation);
    // a released one does not count
    const closureId = await appliedClosure();
    const released = await insertTask();
    await insertRestriction({
      task_id: released,
      status: 'released',
      approved_by: json({ kind: 'staff' }),
      approved_at: new Date(),
      scheduling_closure_id: closureId,
      released_at: new Date(),
      released_by: json({ kind: 'staff' }),
    });
    await insertRestriction({ task_id: released });
  });

  it('SPK-FAC-005: a preventive schedule materializes each occurrence at most once', async () => {
    const scheduleId = newId();
    await db
      .insertInto('preventive_schedules')
      .values({
        id: scheduleId,
        organization_id: org,
        facility_id: facility,
        resource_id: pitch.northHalfId,
        asset_id: null,
        name: 'Monthly grooming',
        recurrence: json({ frequency: 'weekly', interval: 4, startDate: '2026-11-02', count: 6 }),
        local_start_time: '06:00',
        duration_minutes: 120,
        timezone: 'America/Los_Angeles',
        task_template: json({ issue: 'groom', severity: 'low' }),
        restriction_kind: 'closed',
        lead_time_days: 14,
        last_generated_at: null,
        last_generated_through: null,
      })
      .execute();
    await insertTask({ preventive_schedule_id: scheduleId, occurrence_index: 0 });
    await expect(
      insertTask({ preventive_schedule_id: scheduleId, occurrence_index: 0 }),
    ).rejects.toSatisfy(isUniqueViolation);
    await insertRestriction({ preventive_schedule_id: scheduleId, occurrence_index: 0 });
    await expect(
      insertRestriction({ preventive_schedule_id: scheduleId, occurrence_index: 0 }),
    ).rejects.toSatisfy(isUniqueViolation);
    await expect(insertRestriction({ preventive_schedule_id: scheduleId })).rejects.toSatisfy(
      isCheckViolation,
    );
  });

  it('SPK-FAC-001: an identifier names at most one non-retired asset per facility', async () => {
    await expect(
      seedAsset(db, { organizationId: org, facilityId: facility, identifier: 'TURF-N' }),
    ).rejects.toSatisfy(isUniqueViolation);
    await db.updateTable('assets').set({ status: 'retired' }).where('id', '=', assetId).execute();
    await seedAsset(db, { organizationId: org, facilityId: facility, identifier: 'TURF-N' });
  });

  it('inspections are append-only observations (corrections are new rows)', async () => {
    const id = newId();
    await db
      .insertInto('inspections')
      .values({
        id,
        organization_id: org,
        task_id: await insertTask(),
        inspector: json({ kind: 'staff' }),
        outcome: 'failed',
        notes: null,
        inspected_at: new Date(),
      })
      .execute();
    await expect(
      db.updateTable('inspections').set({ outcome: 'passed' }).where('id', '=', id).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(db.deleteFrom('inspections').where('id', '=', id).execute()).rejects.toThrow(
      /append-only/,
    );
  });
});
