import { newId, type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher, UnitOfWork } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { MAINTENANCE_REPORT_PORT, type MaintenanceReportPort } from '../ports';
import { MaintenanceTasksService } from '../services/maintenance-tasks.service';
import { reportMaintenanceTask, seedAsset } from '../testing/facilities-fixtures';
import { keepFakePrincipals } from './support';

describe('assets, maintenance tasks and inspections (SPK-FAC-001/002/004, SPK-UX-006)', () => {
  let t: TestApp;
  let tasks: MaintenanceTasksService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let operator: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-10-19T12:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    tasks = t.app.get(MaintenanceTasksService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 2',
    });
    // a real person: the operator is also assigned as task owner (SPK-FAC-002, migration 0901)
    operator = staffPrincipal(org, ['facilities_operator'], {
      personId: await createPersonFixture(t, { kind: 'adult' }),
    });
    auth = await t.authHeader(operator);
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object, headers = auth, k = key()) =>
    t.http.post(path).set(headers).set('Idempotency-Key', k).send(body);
  const patch = (path: string, body: object, headers = auth) =>
    t.http.patch(path).set(headers).set('Idempotency-Key', key()).send(body);

  it('is exported as MaintenanceReportPort', () => {
    expect(t.app.get<MaintenanceReportPort>(MAINTENANCE_REPORT_PORT)).toBe(tasks);
  });

  it('SPK-FAC-001: assets are registered, edited, retired and scoped to their organization', async () => {
    const denied = await post(
      '/v1/assets',
      { facilityId: facility, kind: 'goal', name: 'Goal A' },
      await t.authHeader(staffPrincipal(org, ['front_desk'])),
    );
    expect(denied.status).toBe(403);
    const k = key();
    const body = {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'goal',
      name: 'North goal',
      identifier: 'GOAL-N-1',
      attributes: { size: '7v7' },
    };
    const created = await post('/v1/assets', body, auth, k);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      status: 'in_service',
      revision: 1,
      identifier: 'GOAL-N-1',
    });
    const replay = await post('/v1/assets', body, auth, k);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(created.body.id);
    const duplicate = await post('/v1/assets', { ...body, name: 'Another' });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe('VALIDATION_FAILED');
    const wrongFacility = await post('/v1/assets', { ...body, facilityId: newId() });
    expect(wrongFacility.status).toBe(404);
    const foreignResource = await post('/v1/assets', {
      ...body,
      identifier: 'GOAL-X',
      resourceId: newId(),
    });
    expect(foreignResource.status).toBe(404);

    const list = await t.http
      .get('/v1/assets')
      .query({ facilityId: facility, kind: 'goal' })
      .set(await t.authHeader(staffPrincipal(org, ['scheduler'])));
    expect(list.status).toBe(200);
    expect(list.body.map((a: { id: string }) => a.id)).toContain(created.body.id);

    const stale = await patch(`/v1/assets/${created.body.id}`, {
      status: 'out_of_service',
      expectedRevision: 7,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const updated = await patch(`/v1/assets/${created.body.id}`, {
      status: 'out_of_service',
      name: 'North goal (bent)',
      expectedRevision: 1,
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ status: 'out_of_service', revision: 2 });

    const other = await seedOrganization(t.db);
    const crossOrg = await t.http
      .get(`/v1/assets/${created.body.id}`)
      .set(await t.authHeader(staffPrincipal(other.organizationId, ['system_administrator'])));
    expect(crossOrg.status).toBe(404);

    // an asset with open maintenance cannot retire; afterwards retirement is idempotent
    const open = await reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      assetId: created.body.id,
      severity: 'low',
    });
    const blocked = await t.http
      .delete(`/v1/assets/${created.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('INVALID_TRANSITION');
    await tasks.update(operator, open.id, {
      status: 'closed',
      resolution: { summary: 'n/a' },
      expectedRevision: (await tasks.get(operator, open.id)).revision,
    });
    const retired = await t.http
      .delete(`/v1/assets/${created.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({ reason: 'replaced' });
    expect(retired.status).toBe(200);
    expect(retired.body.status).toBe('retired');
    const again = await t.http
      .delete(`/v1/assets/${created.body.id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({});
    expect(again.body.status).toBe('retired');
    // §4.9: an asset edit without expectedRevision is refused, never applied over newer work
    const blindAsset = await patch(`/v1/assets/${created.body.id}`, { name: 'blind' });
    expect(blindAsset.status).toBe(400);
    expect(blindAsset.body.code).toBe('VALIDATION_FAILED');
    const editRetired = await patch(`/v1/assets/${created.body.id}`, {
      name: 'x',
      expectedRevision: again.body.revision,
    });
    expect(editRetired.body.code).toBe('INVALID_TRANSITION');
    const reuse = await post('/v1/assets', { ...body, name: 'Replacement goal' });
    expect(reuse.status).toBe(201);
    const hidden = await t.http.get('/v1/assets').query({ facilityId: facility }).set(auth);
    expect(hidden.body.map((a: { id: string }) => a.id)).not.toContain(created.body.id);
    const shown = await t.http
      .get('/v1/assets')
      .query({ facilityId: facility, includeRetired: true })
      .set(auth);
    expect(shown.body.map((a: { id: string }) => a.id)).toContain(created.body.id);
  });

  it('SPK-FAC-002: any staff may report; the record carries asset or space, severity, reporter, evidence, owner, due date, resolution and inspection', async () => {
    const asset = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.southHalfId,
      kind: 'lighting',
      name: 'South floodlight',
    });
    for (const roles of [['coach'], ['official'], ['finance_operator']] as const) {
      const res = await post(
        '/v1/maintenance-tasks',
        { facilityId: facility, assetId: asset, issue: 'Flicker', severity: 'low' },
        await t.authHeader(staffPrincipal(org, [...roles])),
      );
      expect(res.status, roles.join()).toBe(201);
      expect(res.body.reporter.staffRoles).toEqual([...roles]);
    }
    const neither = await post('/v1/maintenance-tasks', {
      facilityId: facility,
      issue: 'no target',
      severity: 'low',
    });
    expect(neither.status).toBe(400);

    const reporter = staffPrincipal(org, ['front_desk']);
    const reported = await post(
      '/v1/maintenance-tasks',
      {
        facilityId: facility,
        assetId: asset,
        issue: 'Floodlight bank 2 is out',
        severity: 'high',
        evidence: [{ kind: 'photo', reference: 'evidence/bank2.jpg', label: 'from the stand' }],
      },
      await t.authHeader(reporter),
    );
    expect(reported.status).toBe(201);
    expect(reported.body).toMatchObject({
      status: 'open',
      assetId: asset,
      resourceId: pitch.southHalfId,
      reporter: { kind: 'staff', personId: reporter.personId },
      evidence: [{ kind: 'photo', reference: 'evidence/bank2.jpg' }],
      assignedOwnerPersonId: null,
      requiresInspection: false,
      latestInspection: null,
      openRestrictionIds: [],
    });
    // proposed default due lead time: 24 hours for high (pending operations decision)
    expect(reported.body.dueAt).toBe('2026-10-20T12:00:00.000Z');
    const id: string = reported.body.id;

    // only the facilities operator / general manager manage the task
    const denied = await patch(
      `/v1/maintenance-tasks/${id}`,
      { assignedOwnerPersonId: reporter.personId, expectedRevision: 1 },
      await t.authHeader(reporter),
    );
    expect(denied.status).toBe(403);
    // §4.9: a task edit without expectedRevision is refused, never applied over newer work
    const blindTask = await patch(`/v1/maintenance-tasks/${id}`, { severity: 'low' });
    expect(blindTask.status).toBe(400);
    expect(blindTask.body.code).toBe('VALIDATION_FAILED');
    const assigned = await patch(`/v1/maintenance-tasks/${id}`, {
      assignedOwnerPersonId: operator.personId,
      dueAt: '2026-10-21T18:00:00Z',
      evidence: [{ kind: 'note', reference: 'breaker reset attempted' }],
      expectedRevision: 1,
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({
      status: 'assigned',
      assignedOwnerPersonId: operator.personId,
      dueAt: '2026-10-21T18:00:00.000Z',
      revision: 2,
    });
    expect(assigned.body.evidence).toHaveLength(2);
    const unassigned = await patch(`/v1/maintenance-tasks/${id}`, {
      assignedOwnerPersonId: null,
      expectedRevision: assigned.body.revision,
    });
    expect(unassigned.body.status).toBe('open');
    const started = await patch(`/v1/maintenance-tasks/${id}`, {
      assignedOwnerPersonId: operator.personId,
      status: 'in_progress',
      expectedRevision: unassigned.body.revision,
    });
    expect(started.body.status).toBe('in_progress');
    const noResolution = await patch(`/v1/maintenance-tasks/${id}`, {
      status: 'resolved',
      expectedRevision: started.body.revision,
    });
    expect(noResolution.status).toBe(400);
    const resolved = await patch(`/v1/maintenance-tasks/${id}`, {
      status: 'resolved',
      resolution: { summary: 'Replaced driver on bank 2' },
      expectedRevision: started.body.revision,
    });
    expect(resolved.body).toMatchObject({
      status: 'resolved',
      resolution: { summary: 'Replaced driver on bank 2', resolvedBy: { kind: 'staff' } },
    });
    expect(resolved.body.resolvedAt).not.toBeNull();

    // SPK-FAC-004: a failed inspection sends the resolved task back to work; a pass is recorded
    const inspectorDenied = await post(
      `/v1/maintenance-tasks/${id}/inspections`,
      { outcome: 'passed' },
      await t.authHeader(staffPrincipal(org, ['general_manager'])),
    );
    expect(inspectorDenied.status).toBe(403);
    const failed = await post(`/v1/maintenance-tasks/${id}/inspections`, {
      outcome: 'failed',
      notes: 'bank 2 still dark',
    });
    expect(failed.status).toBe(201);
    const afterFail = await t.http.get(`/v1/maintenance-tasks/${id}`).set(auth);
    expect(afterFail.body).toMatchObject({
      status: 'in_progress',
      resolvedAt: null,
      latestInspection: { outcome: 'failed', notes: 'bank 2 still dark' },
    });
    const resolvedAgain = await patch(`/v1/maintenance-tasks/${id}`, {
      status: 'resolved',
      resolution: { summary: 'Replaced driver and lamp on bank 2' },
      expectedRevision: afterFail.body.revision,
    });
    expect(resolvedAgain.status).toBe(200);
    // SPK-FAC-004: an inspection is recorded once it has happened; a future-dated pass would
    // outrank every later failed inspection in the release decision
    const ahead = await post(`/v1/maintenance-tasks/${id}/inspections`, {
      outcome: 'passed',
      inspectedAt: '2026-10-20T09:00:00Z',
    });
    expect(ahead.status).toBe(400);
    expect(ahead.body.details).toMatchObject({ code: 'inspection_in_future', path: 'inspectedAt' });
    const passed = await post(`/v1/maintenance-tasks/${id}/inspections`, { outcome: 'passed' });
    expect(passed.status).toBe(201);
    const inspections = await t.http.get(`/v1/maintenance-tasks/${id}/inspections`).set(auth);
    expect(inspections.body.map((i: { outcome: string }) => i.outcome)).toEqual([
      'passed',
      'failed',
    ]);
    const closed = await patch(`/v1/maintenance-tasks/${id}`, {
      status: 'closed',
      expectedRevision: (await t.http.get(`/v1/maintenance-tasks/${id}`).set(auth)).body.revision,
    });
    expect(closed.body).toMatchObject({
      status: 'closed',
      latestInspection: { outcome: 'passed' },
    });
    expect(closed.body.closedAt).not.toBeNull();
    const reopenClosed = await patch(`/v1/maintenance-tasks/${id}`, {
      status: 'in_progress',
      expectedRevision: closed.body.revision,
    });
    expect(reopenClosed.body.code).toBe('INVALID_TRANSITION');
    // a failed inspection on a closed task is recorded and escalated, the task stays closed
    const lateFail = await post(`/v1/maintenance-tasks/${id}/inspections`, { outcome: 'failed' });
    expect(lateFail.status).toBe(201);
    expect((await t.http.get(`/v1/maintenance-tasks/${id}`).set(auth)).body.status).toBe('closed');
    const escalation = await t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'owner_queue'])
      .where('dedupe_key', '=', `maintenance_task:${id}:inspection_failed`)
      .executeTakeFirstOrThrow();
    expect(escalation).toMatchObject({
      category: 'facilities.inspection_failed_after_close',
      owner_queue: 'facilities_operator',
    });
    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.action)).toContain('facilities.maintenance_task_reported');
    expect(audit.map((a) => a.action)).toContain('facilities.maintenance_task_updated');
    const outbox = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', id)
      .execute();
    expect(new Set(outbox.map((o) => o.event_type))).toEqual(
      new Set([
        'facilities.maintenance_task_reported',
        'facilities.maintenance_task_updated',
        'facilities.inspection_recorded',
      ]),
    );
  });

  it('SPK-FAC-002 / §4.3: a task is assigned only to an active adult person of its own organization', async () => {
    const reported = await reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.northHalfId,
      principal: operator,
    });
    const other = await seedOrganization(t.db);
    const foreign = await createPersonFixture(t, {
      kind: 'adult',
      organizationId: other.organizationId,
    });
    const child = await createPersonFixture(t, { kind: 'child' });
    const inactive = await createPersonFixture(t, { kind: 'adult', status: 'inactive' });
    for (const personId of [foreign, newId(), child, inactive]) {
      const refused = await patch(`/v1/maintenance-tasks/${reported.id}`, {
        assignedOwnerPersonId: personId,
        expectedRevision: reported.revision,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { path: 'assignedOwnerPersonId' },
      });
    }
    const unchanged = await t.http.get(`/v1/maintenance-tasks/${reported.id}`).set(auth);
    expect(unchanged.body).toMatchObject({
      status: 'open',
      assignedOwnerPersonId: null,
      revision: reported.revision,
    });
    const owner = await createPersonFixture(t, { kind: 'adult' });
    const assigned = await patch(`/v1/maintenance-tasks/${reported.id}`, {
      assignedOwnerPersonId: owner,
      expectedRevision: reported.revision,
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect(assigned.body).toMatchObject({ status: 'assigned', assignedOwnerPersonId: owner });
  });

  it('lists tasks with filters, pagination and organization scope', async () => {
    const other = await seedOrganization(t.db);
    const page1 = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility, limit: 2 })
      .set(await t.authHeader(staffPrincipal(org, ['support_operator'])));
    expect(page1.status).toBe(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility, limit: 2, cursor: page1.body.nextCursor })
      .set(auth);
    expect(page2.status).toBe(200);
    const ids1 = page1.body.items.map((i: { id: string }) => i.id);
    for (const item of page2.body.items) expect(ids1).not.toContain(item.id);
    const closedOnly = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility, status: 'closed' })
      .set(auth);
    expect(closedOnly.body.items.every((i: { status: string }) => i.status === 'closed')).toBe(
      true,
    );
    const crossOrg = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility })
      .set(await t.authHeader(staffPrincipal(other.organizationId, ['facilities_operator'])));
    expect(crossOrg.status).toBe(404);
    const coach = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility })
      .set(await t.authHeader(staffPrincipal(org, ['coach'])));
    expect(coach.status).toBe(403);
  });

  it('SPK-UX-006: an overdue critical task raises exactly one operational exception (dedupe key per task)', async () => {
    const reported = await reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.pitchId,
      issue: 'Main pitch floodlights tripped',
      severity: 'critical',
      principal: operator,
    });
    // proposed default: critical is due four hours after the report
    expect(reported.dueAt).toBe('2026-10-19T16:00:00.000Z');
    const timer = await t.db
      .selectFrom('outbox_events')
      .select(['available_at', 'status'])
      .where('aggregate_id', '=', reported.id)
      .where('event_type', '=', 'facilities.maintenance_task_due_reached')
      .executeTakeFirstOrThrow();
    expect(new Date(timer.available_at).toISOString()).toBe('2026-10-19T16:00:00.000Z');
    const dispatcher = t.app.get(OutboxDispatcher);
    await dispatcher.runOnce(100);
    const early = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('dedupe_key', '=', `maintenance_task:${reported.id}:overdue`)
      .execute();
    expect(early).toEqual([]);
    t.clock.advance(5 * 3600_000);
    await dispatcher.runOnce(100);
    const raised = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('dedupe_key', '=', `maintenance_task:${reported.id}:overdue`)
      .execute();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      category: 'facilities.maintenance_task_overdue',
      severity: 'critical',
      owner_queue: 'facilities_operator',
      facility_id: facility,
      status: 'open',
    });
    // the sweep used by automation finds the same task and does not duplicate the exception
    const uow = t.app.get(UnitOfWork);
    const swept = await uow.run((ctx) => tasks.raiseOverdueExceptions(ctx.trx, org, t.clock.now()));
    expect(swept).toBe(1);
    expect(
      await t.db
        .selectFrom('operational_exceptions')
        .select('id')
        .where('affected_id', '=', reported.id)
        .execute(),
    ).toHaveLength(1);
    // a resolved task is never escalated, even when its timer fires later
    const resolved = await reportMaintenanceTask(tasks, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.pitchId,
      issue: 'Scoreboard dead',
      severity: 'critical',
      principal: operator,
    });
    await tasks.update(operator, resolved.id, {
      status: 'resolved',
      resolution: { summary: 'fuse replaced' },
      expectedRevision: resolved.revision,
    });
    t.clock.advance(5 * 3600_000);
    await dispatcher.runOnce(100);
    expect(
      await t.db
        .selectFrom('operational_exceptions')
        .select('id')
        .where('affected_id', '=', resolved.id)
        .execute(),
    ).toEqual([]);
    const overdueList = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility, overdue: true })
      .set(auth);
    expect(overdueList.body.items.map((i: { id: string }) => i.id)).toEqual([reported.id]);
  });

  it('IF-06 (FAC-01): list flags read ?overdue=false and ?includeRetired=false as false and refuse other values', async () => {
    const all = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility, limit: 200 })
      .set(auth);
    const overdue = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility, limit: 200, overdue: 'true' })
      .set(auth);
    const notFiltered = await t.http
      .get('/v1/maintenance-tasks')
      .query({ facilityId: facility, limit: 200, overdue: 'false' })
      .set(auth);
    expect(overdue.body.items.length).toBeGreaterThan(0);
    expect(overdue.body.items.length).toBeLessThan(all.body.items.length);
    // false is not a filter: the same items as without the flag (z.coerce.boolean read it as true)
    expect(notFiltered.body.items.map((i: { id: string }) => i.id)).toEqual(
      all.body.items.map((i: { id: string }) => i.id),
    );
    for (const value of ['yes', '1', 'TRUE']) {
      const refused = await t.http
        .get('/v1/maintenance-tasks')
        .query({ facilityId: facility, overdue: value })
        .set(auth);
      expect(refused.status, value).toBe(400);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
    }
    const assets = (includeRetired?: string) =>
      t.http
        .get('/v1/assets')
        .query(
          includeRetired === undefined
            ? { facilityId: facility }
            : { facilityId: facility, includeRetired },
        )
        .set(auth);
    const statuses = async (includeRetired?: string) =>
      ((await assets(includeRetired)).body as Array<{ status: string }>).map((a) => a.status);
    expect(await statuses('true')).toContain('retired');
    expect(await statuses('false')).not.toContain('retired');
    expect(await statuses('false')).toEqual(await statuses());
    const refused = await assets('no');
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
  });
});
