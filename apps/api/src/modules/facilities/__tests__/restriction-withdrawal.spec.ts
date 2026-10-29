import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditWriter, UnitOfWork } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import {
  at,
  CLOSURE_PORT,
  ClosuresService,
  createScheduledEvent,
  EventsService,
  seedPitchWithHalves,
  type ClosurePort,
  type PitchFixture,
} from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { PreventiveSchedulesService } from '../services/preventive-schedules.service';
import { RestrictionsService } from '../services/restrictions.service';
import { createPreventiveSchedule } from '../testing/facilities-fixtures';
import { keepFakePrincipals } from './support';

/**
 * FAC-01 (SPK-FAC-004, §4.6 RestrictionMachine `withdraw`, §4.9, §4.2): a restriction that never
 * took effect is withdrawn with its reason; an approved one withdraws its pending scheduling closure
 * through CLOSURE_PORT.withdrawClosure (IF-11) in the same unit of work.
 *
 * The tests that need scheduling's closure withdrawal (SCH-01, migration 0302) check for it and
 * skip with a note where that work item is not merged yet; they run on the integrated branch.
 */
describe('restriction withdrawal (FAC-01, SPK-FAC-004)', () => {
  let t: TestApp;
  let events: EventsService;
  let closures: ClosuresService;
  let restrictions: RestrictionsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let operator: Principal;
  let manager: Principal;
  let auth: { Authorization: string };
  let closureWithdrawal = false;
  const needsClosureWithdrawal =
    'needs scheduling closure withdrawal (SCH-01, migration 0302), not merged on this branch';

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-10-19T12:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    events = t.app.get(EventsService);
    closures = t.app.get(ClosuresService);
    restrictions = t.app.get(RestrictionsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch W',
    });
    operator = staffPrincipal(org, ['facilities_operator'], {
      personId: await createPersonFixture(t, { kind: 'adult' }),
    });
    manager = staffPrincipal(org, ['general_manager']);
    auth = await t.authHeader(operator);
    const column = await sql<{ one: number }>`
      select 1 as one from information_schema.columns
      where table_name = 'closures' and column_name = 'withdrawn_at'`.execute(t.db);
    closureWithdrawal = column.rows.length > 0;
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object, headers = auth, k = key()) =>
    t.http.post(path).set(headers).set('Idempotency-Key', k).send(body);
  const withdrawPath = (id: string) => `/v1/maintenance-restrictions/${id}/withdraw`;
  const propose = async (day: string, extra: Record<string, unknown> = {}) => {
    const res = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'closed',
      interval: { start: at(day, '08:00'), end: at(day, '12:00') },
      reason: `Proposed ${day}`,
      approve: false,
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('proposed');
    return res.body as { id: string; revision: number; interval: { start: string; end: string } };
  };
  const book = (day: string, resourceIds = [pitch.northHalfId]) =>
    createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds,
      start: at(day, '09:00'),
      end: at(day, '10:00'),
    });
  /** An activation interrupted by an earlier version: approved, backed by a closure, not active. */
  const strandApproved = async (restrictionId: string, closureId: string | null) => {
    await t.db
      .updateTable('restrictions')
      .set({
        status: 'approved',
        approved_by: json({ kind: 'staff', actorLabel: 'interrupted' }),
        approved_at: t.clock.now(),
        scheduling_closure_id: closureId,
      })
      .where('id', '=', restrictionId)
      .execute();
    return (await restrictions.get(operator, restrictionId)).revision;
  };
  const pendingClosure = async (day: string, reason: string) =>
    closures.createClosure(operator, {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      interval: { start: at(day, '08:00'), end: at(day, '12:00') },
      reason,
      source: 'maintenance',
    });

  it('SPK-FAC-004: a proposed restriction is withdrawn with its reason, audited and announced; it holds nothing and can never take effect', async () => {
    const task = await post('/v1/maintenance-tasks', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      issue: 'Divider net sagging',
      severity: 'medium',
    });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    const proposed = await propose('2026-11-03', { taskId: task.body.id });

    // §4.9: a reason is required; the restriction authority is required; scope is enforced
    const noReason = await post(withdrawPath(proposed.id), {});
    expect(noReason.status).toBe(400);
    const frontDesk = await post(
      withdrawPath(proposed.id),
      { reason: 'not mine' },
      await t.authHeader(staffPrincipal(org, ['front_desk'])),
    );
    expect(frontDesk.status).toBe(403);
    const other = await seedOrganization(t.db);
    const crossOrg = await post(
      withdrawPath(proposed.id),
      { reason: 'not ours' },
      await t.authHeader(staffPrincipal(other.organizationId, ['general_manager'])),
    );
    expect(crossOrg.status).toBe(404);
    const stale = await post(withdrawPath(proposed.id), {
      reason: 'stale',
      expectedRevision: proposed.revision + 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');

    const k = key();
    const withdrawn = await post(
      withdrawPath(proposed.id),
      { reason: 'Divider replaced instead', expectedRevision: proposed.revision },
      auth,
      k,
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body).toMatchObject({
      status: 'withdrawn',
      withdrawnBy: { kind: 'staff', personId: operator.personId },
      withdrawnAt: t.clock.now().toISOString(),
      withdrawalReason: 'Divider replaced instead',
      schedulingClosureId: null,
      approvedBy: null,
      revision: proposed.revision + 1,
    });
    const replay = await post(
      withdrawPath(proposed.id),
      { reason: 'Divider replaced instead', expectedRevision: proposed.revision },
      auth,
      k,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(withdrawn.body);

    // terminal: never withdrawn twice, approved or released afterwards
    for (const [path, body] of [
      [withdrawPath(proposed.id), { reason: 'again' }],
      [`/v1/maintenance-restrictions/${proposed.id}/approve`, {}],
      [`/v1/maintenance-restrictions/${proposed.id}/release`, { reason: 'release' }],
    ] as const) {
      const refused = await post(path, body);
      expect(refused.status, path).toBe(409);
      expect(refused.body.code, path).toBe('INVALID_TRANSITION');
    }
    expect((await book('2026-11-03')).status).toBe('published');

    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'reason', 'before_revision', 'after_revision', 'details'])
      .where('target_id', '=', proposed.id)
      .where('action', '=', 'facilities.restriction_withdrawn')
      .execute();
    expect(audit).toEqual([
      {
        action: 'facilities.restriction_withdrawn',
        reason: 'Divider replaced instead',
        before_revision: proposed.revision,
        after_revision: proposed.revision + 1,
        details: { from: 'proposed', schedulingClosureId: null, closureWithdrawn: false },
      },
    ]);
    const outbox = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_id', '=', proposed.id)
      .execute();
    expect(outbox).toEqual([
      {
        event_type: 'facilities.restriction_withdrawn',
        payload: {
          restrictionId: proposed.id,
          facilityId: facility,
          resourceId: pitch.northHalfId,
          assetId: null,
          taskId: task.body.id,
          interval: proposed.interval,
          reason: 'Divider replaced instead',
          schedulingClosureId: null,
        },
      },
    ]);
    const operation = await t.http.get(`/v1/operations/${withdrawn.body.operationId}`).set(auth);
    expect(operation.body).toMatchObject({
      kind: 'facilities.withdraw_restriction',
      status: 'succeeded',
      result: { restrictionId: proposed.id, status: 'withdrawn', closureWithdrawn: false },
    });

    // the task no longer carries it and may carry a new restriction (index 0903)
    const reread = await t.http.get(`/v1/maintenance-tasks/${task.body.id}`).set(auth);
    expect(reread.body.openRestrictionIds).toEqual([]);
    const again = await propose('2026-11-04', { taskId: task.body.id });
    expect(again.id).not.toBe(proposed.id);
    const listed = await t.http
      .get('/v1/maintenance-restrictions')
      .query({ facilityId: facility, status: 'withdrawn' })
      .set(auth);
    expect(listed.status).toBe(200);
    expect(listed.body.map((r: { id: string }) => r.id)).toEqual([proposed.id]);
    await restrictions.withdraw(operator, again.id, { reason: 'cleanup' });
  });

  it('SPK-FAC-004: a proposed restriction is withdrawn; an approved one withdraws its pending closure atomically', async (ctx) => {
    if (!closureWithdrawal) ctx.skip(needsClosureWithdrawal);
    const proposed = await propose('2026-11-05');
    const withdrawnProposal = await restrictions.withdraw(operator, proposed.id, {
      reason: 'Not needed',
    });
    expect(withdrawnProposal).toMatchObject({ status: 'withdrawn', schedulingClosureId: null });

    // an approved restriction whose activation stopped after scheduling created its closure
    const approved = await propose('2026-11-06');
    const closure = await pendingClosure('2026-11-06', 'Proposed 2026-11-06');
    const revision = await strandApproved(approved.id, closure.id);
    expect(closure.status).toBe('pending');

    // a failure after the closure withdrawal rolls both modules' writes back together
    const audit = t.app.get(AuditWriter);
    const record = audit.record.bind(audit);
    const spy = vi.spyOn(audit, 'record').mockImplementation(async (trx, input) => {
      if (input.action === 'facilities.restriction_withdrawn') {
        throw new Error('Connection terminated unexpectedly');
      }
      return record(trx, input);
    });
    const crashed = await post(withdrawPath(approved.id), { reason: 'Repair postponed' });
    spy.mockRestore();
    expect(crashed.status).toBe(500);
    expect(await restrictions.get(operator, approved.id)).toMatchObject({
      status: 'approved',
      revision,
      withdrawnAt: null,
    });
    expect(await closures.getClosure(operator, closure.id)).toMatchObject({
      status: 'pending',
      revision: closure.revision,
    });
    expect(
      await t.db
        .selectFrom('operations')
        .select('id')
        .where('kind', '=', 'facilities.withdraw_restriction')
        .where('status', '=', 'running')
        .execute(),
    ).toEqual([]);

    // retried, the restriction and its closure are withdrawn together
    const withdrawn = await post(withdrawPath(approved.id), {
      reason: 'Repair postponed',
      expectedRevision: revision,
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body).toMatchObject({
      status: 'withdrawn',
      approvedBy: { actorLabel: 'interrupted' },
      schedulingClosureId: closure.id,
      withdrawalReason: 'Repair postponed',
      affectedConflictUnitIds: [],
    });
    expect(await closures.getClosure(operator, closure.id)).toMatchObject({
      status: 'withdrawn',
    });
    const actions = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', 'in', [approved.id, closure.id])
      .where('action', 'in', ['scheduling.closure_withdrawn', 'facilities.restriction_withdrawn'])
      .orderBy('action')
      .execute();
    expect(actions.map((a) => a.action)).toEqual([
      'facilities.restriction_withdrawn',
      'scheduling.closure_withdrawn',
    ]);
    const operation = await t.http.get(`/v1/operations/${withdrawn.body.operationId}`).set(auth);
    expect(operation.body).toMatchObject({
      kind: 'facilities.withdraw_restriction',
      status: 'succeeded',
      result: { schedulingClosureId: closure.id, closureWithdrawn: true },
    });
    // the withdrawn closure never blocked the area and can never be applied
    expect((await book('2026-11-06')).status).toBe('published');
    await expect(
      closures.applyClosure(operator, closure.id, { mode: 'leave_for_resolution' }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('SPK-FAC-004: an approved restriction whose activation never created a closure is withdrawn without a scheduling call', async () => {
    const approved = await propose('2026-11-07');
    const revision = await strandApproved(approved.id, null);
    const port = t.app.get<ClosurePort>(CLOSURE_PORT);
    const spy = vi.spyOn(port, 'withdrawClosure');
    const withdrawn = await restrictions.withdraw(manager, approved.id, {
      reason: 'Contractor cancelled',
      expectedRevision: revision,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    expect(withdrawn).toMatchObject({
      status: 'withdrawn',
      approvedBy: { actorLabel: 'interrupted' },
      withdrawnBy: { kind: 'staff' },
      schedulingClosureId: null,
      revision: revision + 1,
    });
  });

  it('an active restriction cannot be withdrawn', async () => {
    const active = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'closed',
      interval: { start: at('2026-11-10', '08:00'), end: at('2026-11-10', '12:00') },
      reason: 'Goal mouth reseeding',
      approve: true,
    });
    expect(active.status).toBe('active');
    const refused = await post(withdrawPath(active.id), { reason: 'changed my mind' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { machine: 'Restriction', from: 'active', event: 'withdraw' },
    });
    expect(await restrictions.get(operator, active.id)).toMatchObject({
      status: 'active',
      revision: active.revision,
    });
    expect((await closures.getClosure(operator, active.schedulingClosureId as string)).status).toBe(
      'active',
    );
    await expect(book('2026-11-10')).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });

    // approved, but the closure was already applied: the area was closed, so it is completed
    // (approve) and released, never withdrawn
    const stalled = await propose('2026-11-11');
    const closure = await pendingClosure('2026-11-11', 'Proposed 2026-11-11');
    const applied = await closures.applyClosure(operator, closure.id, {
      mode: 'leave_for_resolution',
      expectedRevision: closure.revision,
    });
    expect(applied.status).toBe('active');
    await strandApproved(stalled.id, closure.id);
    const appliedRefused = await post(withdrawPath(stalled.id), { reason: 'too late' });
    expect(appliedRefused.status).toBe(409);
    expect(appliedRefused.body).toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { machine: 'SchedulingClosure', from: 'active', event: 'withdraw' },
    });
    expect((await restrictions.get(operator, stalled.id)).status).toBe('approved');
    expect((await closures.getClosure(operator, closure.id)).status).toBe('active');
    const completed = await restrictions.approve(operator, stalled.id, {});
    expect(completed).toMatchObject({ status: 'active', schedulingClosureId: closure.id });

    // the authorized release ends both; a released restriction is final
    for (const id of [active.id, stalled.id]) {
      const released = await restrictions.release(manager, id, { reason: 'reopened' });
      expect(released.status).toBe('released');
      const late = await post(withdrawPath(id), { reason: 'after release' });
      expect(late.body).toMatchObject({
        code: 'INVALID_TRANSITION',
        details: { from: 'released', event: 'withdraw' },
      });
    }
  });

  it('SPK-FAC-004 / SPK-AT-021: an approval that loses the race for the closure link withdraws the closure it created', async (ctx) => {
    if (!closureWithdrawal) ctx.skip(needsClosureWithdrawal);
    const proposed = await propose('2026-11-12');
    const port = t.app.get<ClosurePort>(CLOSURE_PORT);
    const createClosure = port.createClosure.bind(port);
    const race: { winner?: string } = {};
    // while this approval creates its closure, a concurrent approval links its own closure first
    const spy = vi.spyOn(port, 'createClosure').mockImplementationOnce(async (principal, input) => {
      const own = await createClosure(principal, input);
      const other = await createClosure(principal, { ...input, reason: 'concurrent approval' });
      race.winner = other.id;
      await t.app
        .get(UnitOfWork)
        .run(({ trx }) =>
          trx
            .updateTable('restrictions')
            .set({ scheduling_closure_id: other.id })
            .where('id', '=', proposed.id)
            .execute(),
        );
      return own;
    });
    const active = await restrictions.approve(operator, proposed.id, {});
    spy.mockRestore();
    const winner = race.winner as string;
    expect(winner).toBeDefined();
    expect(active).toMatchObject({ status: 'active', schedulingClosureId: winner });
    const superseded = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', proposed.id)
      .where('action', '=', 'facilities.restriction_closure_superseded')
      .executeTakeFirstOrThrow();
    const details = superseded.details as { supersededClosureId: string };
    expect(details).toMatchObject({
      schedulingClosureId: winner,
      supersededClosureWithdrawn: true,
    });
    // the losing closure is withdrawn (it never applied); exactly one closure blocks the area
    expect(await closures.getClosure(operator, details.supersededClosureId)).toMatchObject({
      status: 'withdrawn',
      appliedAt: null,
    });
    expect((await closures.getClosure(operator, winner)).status).toBe('active');
    await expect(book('2026-11-12')).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await restrictions.release(operator, proposed.id, { reason: 'done' });
    expect((await book('2026-11-12')).status).toBe('published');
  });

  it('SPK-FAC-005: a withdrawn preventive occurrence is decided and never materialized again', async () => {
    const schedules = t.app.get(PreventiveSchedulesService);
    const schedule = await createPreventiveSchedule(schedules, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.southHalfId,
      name: 'Weekly line marking',
      recurrence: { frequency: 'weekly', byWeekday: [1], startDate: '2026-10-26', count: 2 },
      leadTimeDays: 21,
    });
    // a proposal left by an interrupted generation for occurrence 0
    const leftover = await restrictions.propose(systemPrincipal(org, 'fixtures'), {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      preventiveScheduleId: schedule.id,
      occurrenceIndex: 0,
      kind: 'closed',
      interval: { start: at('2026-10-26', '06:00'), end: at('2026-10-26', '08:00') },
      reason: 'Preventive maintenance: Weekly line marking',
    });
    await restrictions.withdraw(operator, leftover.id, { reason: 'Skip this week' });
    const result = await schedules.generate(staffPrincipal(org, ['scheduler']), schedule.id);
    expect(result.alreadyGeneratedOccurrenceIndexes).toEqual([0]);
    expect(result.generated.map((g) => g.occurrenceIndex)).toEqual([1]);
    expect((await restrictions.get(operator, leftover.id)).status).toBe('withdrawn');
    const tasks = await t.db
      .selectFrom('maintenance_tasks')
      .select('occurrence_index')
      .where('preventive_schedule_id', '=', schedule.id)
      .execute();
    expect(tasks.map((r) => r.occurrence_index)).toEqual([1]);
    for (const g of result.generated) {
      await restrictions.release(operator, g.restrictionId, { reason: 'marked' });
    }
  });
});
