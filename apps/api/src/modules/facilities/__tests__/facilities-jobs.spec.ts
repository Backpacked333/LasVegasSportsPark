import { type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher, PeriodicJobRegistry, PeriodicJobRunner } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { RAISE_OVERDUE_TASK_EXCEPTIONS_JOB } from '../services/facilities-jobs';
import { MaintenanceTasksService } from '../services/maintenance-tasks.service';
import { reportMaintenanceTask } from '../testing/facilities-fixtures';
import { keepFakePrincipals } from './support';

/**
 * FAC-03 (SPK-UX-006, SPK-FAC-002, §4.12): the overdue maintenance sweep runs as the periodic job
 * facilities.raise_overdue_task_exceptions. Tests call PeriodicJobRunner.runOnce after advancing
 * the FixedClock; the outbox due timer is deliberately not dispatched before the job runs, so the
 * exception comes from the job.
 */
describe('overdue maintenance sweep (FAC-03, SPK-UX-006)', () => {
  let t: TestApp;
  let tasks: MaintenanceTasksService;
  let runner: PeriodicJobRunner;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let operator: Principal;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-10-19T12:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    tasks = t.app.get(MaintenanceTasksService);
    runner = t.app.get(PeriodicJobRunner);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch J',
    });
    operator = staffPrincipal(org, ['facilities_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  const overdueExceptions = (taskId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('affected_id', '=', taskId)
      .where('category', '=', 'facilities.maintenance_task_overdue')
      .execute();
  const run = async () => {
    const [summary] = await runner.runOnce([RAISE_OVERDUE_TASK_EXCEPTIONS_JOB]);
    return summary;
  };

  it('is registered every 300 seconds, owned by the facilities operator queue (§4.12)', () => {
    const job = t.app.get(PeriodicJobRegistry).get(RAISE_OVERDUE_TASK_EXCEPTIONS_JOB);
    expect(job).toMatchObject({ intervalSeconds: 300, failureOwner: 'facilities_operator' });
  });

  it('an escalating task past due raises one exception when the job runs after FixedClock passes its due time', async () => {
    const critical = await reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.pitchId,
      issue: 'Floodlight bank 2 out',
      severity: 'critical',
      principal: operator,
    });
    // proposed default (pending, DEC-001): critical is due four hours after the report
    expect(critical.dueAt).toBe('2026-10-19T16:00:00.000Z');
    const medium = await reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.northHalfId,
      issue: 'Corner flag missing',
      severity: 'medium',
      dueAt: '2026-10-19T13:00:00.000Z',
      principal: operator,
    });
    // another organization with an active facility is swept in its own transaction
    const other = await seedOrganization(t.db);
    const otherPitch = await seedPitchWithHalves(t.db, {
      organizationId: other.organizationId,
      facilityId: other.facilityId,
      name: 'Other pitch',
    });
    const otherCritical = await reportMaintenanceTask(tasks, {
      organizationId: other.organizationId,
      facilityId: other.facilityId,
      resourceId: otherPitch.pitchId,
      issue: 'Gate lock broken',
      severity: 'critical',
      principal: staffPrincipal(other.organizationId, ['facilities_operator']),
    });

    const early = await run();
    expect(early).toMatchObject({ ran: true, failed: false, processed: 0 });
    expect(await overdueExceptions(critical.id)).toEqual([]);

    t.clock.advance(5 * 3_600_000);
    const due = await run();
    expect(due).toMatchObject({ ran: true, failed: false, processed: 2, remaining: 0 });
    const raised = await overdueExceptions(critical.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      organization_id: org,
      facility_id: facility,
      severity: 'critical',
      owner_queue: 'facilities_operator',
      status: 'open',
      dedupe_key: `maintenance_task:${critical.id}:overdue`,
    });
    expect(new Date(raised[0]?.deadline_at as Date).toISOString()).toBe(critical.dueAt);
    // a non-escalating severity is listed as overdue but never raised (FACILITIES_POLICY)
    expect(await overdueExceptions(medium.id)).toEqual([]);
    expect(await overdueExceptions(otherCritical.id)).toEqual([
      expect.objectContaining({ organization_id: other.organizationId, status: 'open' }),
    ]);
  });

  it('a second run raises nothing new', async () => {
    const before = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('category', '=', 'facilities.maintenance_task_overdue')
      .execute();
    expect(before).toHaveLength(2);
    // inside the interval the runner does not run the job again
    expect(await run()).toMatchObject({ ran: false });
    t.clock.advance(301_000);
    const again = await run();
    expect(again).toMatchObject({ ran: true, failed: false });
    // the outbox due timers fire too: the dedupe key keeps one open exception per task
    await t.app.get(OutboxDispatcher).runOnce(100);
    const after = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('category', '=', 'facilities.maintenance_task_overdue')
      .execute();
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });
});
