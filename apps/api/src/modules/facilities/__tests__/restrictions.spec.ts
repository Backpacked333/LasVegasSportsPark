import { newId, systemPrincipal, type Principal } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import {
  at,
  ClosuresService,
  createScheduledEvent,
  EventsService,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { OPERATING_STATUS_PORT, type OperatingStatusPort } from '../ports';
import { RestrictionsService } from '../services/restrictions.service';
import { seedAsset } from '../testing/facilities-fixtures';

describe('operating restrictions (SPK-FAC-003/004, §4.8 POST /maintenance-restrictions, SPK-AT-021)', () => {
  let t: TestApp;
  let events: EventsService;
  let closures: ClosuresService;
  let restrictions: RestrictionsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let operator: Principal;
  let manager: Principal;
  let frontDesk: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({ imports: [FacilitiesModule], clockStart: '2026-10-19T12:00:00Z' });
    events = t.app.get(EventsService);
    closures = t.app.get(ClosuresService);
    restrictions = t.app.get(RestrictionsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch 1',
    });
    operator = staffPrincipal(org, ['facilities_operator']);
    manager = staffPrincipal(org, ['general_manager']);
    frontDesk = staffPrincipal(org, ['front_desk']);
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

  it('is exported as OperatingStatusPort', () => {
    expect(t.app.get<OperatingStatusPort>(OPERATING_STATUS_PORT)).toBe(restrictions);
  });

  it('SPK-AT-021: a turf restriction on one half blocks that half and the whole pitch, leaves the other half bookable, survives the task being closed, and reopens only through inspection plus an authorized release', async () => {
    const turf = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'turf',
      name: 'North half turf',
    });
    // any staff may report (SPK-FAC-002); the operator assigns and requires an inspection
    const reported = await post(
      '/v1/maintenance-tasks',
      {
        facilityId: facility,
        assetId: turf,
        issue: 'Turf seam lifted near the penalty spot',
        severity: 'high',
        evidence: [{ kind: 'photo', reference: 'evidence/seam.jpg' }],
      },
      await t.authHeader(frontDesk),
    );
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    expect(reported.body).toMatchObject({
      status: 'open',
      resourceId: pitch.northHalfId,
      reporter: { kind: 'staff' },
    });
    const task = await patch(`/v1/maintenance-tasks/${reported.body.id}`, {
      assignedOwnerPersonId: operator.personId,
      requiresInspection: true,
      expectedRevision: 1,
    });
    expect(task.status).toBe(200);
    expect(task.body).toMatchObject({ status: 'assigned', requiresInspection: true, revision: 2 });

    // §4.8 POST /v1/maintenance-restrictions: approved restriction on the north half
    const interval = { start: at('2026-11-15', '08:00'), end: at('2026-11-15', '20:00') };
    const res = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      assetId: turf,
      taskId: reported.body.id,
      kind: 'closed',
      interval,
      reason: 'Turf repair north half',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      status: 'active',
      resourceId: pitch.northHalfId,
      affectedConflictUnitIds: [pitch.units.north],
      approvedBy: { kind: 'staff' },
      kind: 'closed',
    });
    const restrictionId: string = res.body.id;
    // the closure was created through the scheduling authority, never by writing scheduling tables
    const closure = await closures.getClosure(operator, res.body.schedulingClosureId);
    expect(closure).toMatchObject({
      status: 'active',
      source: 'maintenance',
      resourceId: pitch.northHalfId,
      reason: 'Turf repair north half',
    });
    const operation = await t.http.get(`/v1/operations/${res.body.operationId}`).set(auth);
    expect(operation.body).toMatchObject({
      kind: 'facilities.approve_restriction',
      status: 'succeeded',
      result: { schedulingClosureId: res.body.schedulingClosureId },
    });
    // the asset follows its restriction
    expect((await t.http.get(`/v1/assets/${turf}`).set(auth)).body.status).toBe('restricted');

    // booking impact (SPK-FAC-003): only the north half's conflict unit is blocked
    const southOk = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-15', '12:00'),
      end: at('2026-11-15', '13:00'),
      title: 'South half clinic',
    });
    expect(southOk.status).toBe('published');
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-15', '12:00'),
        end: at('2026-11-15', '13:00'),
      }),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        conflicts: [expect.objectContaining({ code: 'closure', closureId: closure.id })],
      },
    });
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.pitchId],
        start: at('2026-11-15', '14:00'),
        end: at('2026-11-15', '15:00'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const northLater = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-15', '20:00'),
      end: at('2026-11-15', '21:00'),
    });
    expect(northLater.status).toBe('published');

    // operating status per resource during and after the interval
    const during = await t.http
      .get(`/v1/facilities/${facility}/operating-status`)
      .query({ at: at('2026-11-15', '12:00') })
      .set(await t.authHeader(frontDesk));
    expect(during.status).toBe(200);
    const statusOf = (id: string) =>
      during.body.resources.find((r: { resourceId: string }) => r.resourceId === id);
    expect(statusOf(pitch.northHalfId)).toMatchObject({
      status: 'restricted',
      restrictions: [{ restrictionId, kind: 'closed', reason: 'Turf repair north half' }],
    });
    expect(statusOf(pitch.pitchId).status).toBe('restricted');
    expect(statusOf(pitch.southHalfId)).toMatchObject({ status: 'in_service', restrictions: [] });
    const after = await t.http
      .get(`/v1/facilities/${facility}/operating-status`)
      .query({ at: at('2026-11-16', '12:00') })
      .set(auth);
    expect(after.body.resources.every((r: { status: string }) => r.status === 'in_service')).toBe(
      true,
    );

    // SPK-FAC-004: closing the task does not reopen the half while the inspection is outstanding
    const closed = await patch(`/v1/maintenance-tasks/${reported.body.id}`, {
      status: 'closed',
      resolution: { summary: 'Seam re-glued and rolled' },
      expectedRevision: 2,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', openRestrictionIds: [restrictionId] });
    expect(
      (await t.http.get(`/v1/maintenance-restrictions/${restrictionId}`).set(auth)).body.status,
    ).toBe('active');
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-15', '16:00'),
        end: at('2026-11-15', '17:00'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const blocked = await post(`/v1/maintenance-restrictions/${restrictionId}/release`, {
      reason: 'repair done',
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body).toMatchObject({
      code: 'ELIGIBILITY_FAILED',
      details: { code: 'inspection_required', taskId: reported.body.id, latestInspection: null },
    });
    // a failed inspection does not help
    const failed = await post(`/v1/maintenance-tasks/${reported.body.id}/inspections`, {
      outcome: 'failed',
      notes: 'seam still visible',
    });
    expect(failed.status).toBe(201);
    const stillBlocked = await post(`/v1/maintenance-restrictions/${restrictionId}/release`, {
      reason: 'repair done',
    });
    expect(stillBlocked.body.details).toMatchObject({
      latestInspection: { outcome: 'failed' },
    });
    const passed = await post(`/v1/maintenance-tasks/${reported.body.id}/inspections`, {
      outcome: 'passed',
      notes: 'seam flat, infill level',
    });
    expect(passed.status).toBe(201);
    expect(passed.body).toMatchObject({ outcome: 'passed', inspector: { kind: 'staff' } });

    // a non-authorized role cannot release (scheduler may manage closures in scheduling, not here)
    for (const roles of [['front_desk'], ['scheduler'], ['coach']] as const) {
      const denied = await post(
        `/v1/maintenance-restrictions/${restrictionId}/release`,
        { reason: 'nope' },
        await t.authHeader(staffPrincipal(org, [...roles])),
      );
      expect(denied.status, roles.join()).toBe(403);
      expect(denied.body.code).toBe('ACCESS_DENIED');
    }
    const other = await seedOrganization(t.db);
    const crossOrg = await post(
      `/v1/maintenance-restrictions/${restrictionId}/release`,
      { reason: 'nope' },
      await t.authHeader(staffPrincipal(other.organizationId, ['general_manager'])),
    );
    expect(crossOrg.status).toBe(404);
    expect(
      (await t.http.get(`/v1/maintenance-restrictions/${restrictionId}`).set(auth)).body.status,
    ).toBe('active');

    // stale revision fails rather than overwriting newer work (§4.9)
    const stale = await post(
      `/v1/maintenance-restrictions/${restrictionId}/release`,
      { reason: 'inspection passed', expectedRevision: 1 },
      await t.authHeader(manager),
    );
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');

    // authorized release by the general manager lifts the closure and reopens the half
    const current = (await t.http.get(`/v1/maintenance-restrictions/${restrictionId}`).set(auth))
      .body;
    const released = await post(
      `/v1/maintenance-restrictions/${restrictionId}/release`,
      { reason: 'inspection passed', expectedRevision: current.revision },
      await t.authHeader(manager),
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body).toMatchObject({
      status: 'released',
      releasedBy: { kind: 'staff', personId: manager.personId },
      releaseReason: 'inspection passed',
    });
    expect(released.body.releasedAt).not.toBeNull();
    expect((await closures.getClosure(operator, closure.id)).status).toBe('lifted');
    const reopened = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-15', '12:00'),
      end: at('2026-11-15', '13:00'),
    });
    expect(reopened.status).toBe('published');
    const statusAfter = await t.http
      .get(`/v1/facilities/${facility}/operating-status`)
      .query({ at: at('2026-11-15', '12:00') })
      .set(auth);
    expect(
      statusAfter.body.resources.every((r: { status: string }) => r.status === 'in_service'),
    ).toBe(true);
    expect((await t.http.get(`/v1/assets/${turf}`).set(auth)).body.status).toBe('in_service');
    const releasedAgain = await post(`/v1/maintenance-restrictions/${restrictionId}/release`, {
      reason: 'again',
    });
    expect(releasedAgain.body.code).toBe('INVALID_TRANSITION');
    const outbox = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', restrictionId)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    expect(outbox.map((o) => o.event_type)).toEqual([
      'facilities.restriction_activated',
      'facilities.restriction_released',
    ]);
    const releaseOp = await t.http.get(`/v1/operations/${released.body.operationId}`).set(auth);
    expect(releaseOp.body).toMatchObject({
      kind: 'facilities.release_restriction',
      status: 'succeeded',
    });
  });

  it('SPK-FAC-003: the affected area decides what is blocked: a whole-pitch restriction blocks both halves', async () => {
    const whole = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.pitchId,
      kind: 'closed',
      interval: { start: at('2026-11-20', '08:00'), end: at('2026-11-20', '12:00') },
      reason: 'Full pitch line painting',
      approve: true,
    });
    expect(whole.status).toBe('active');
    expect([...whole.affectedConflictUnitIds].sort()).toEqual(
      [pitch.units.north, pitch.units.south].sort(),
    );
    for (const resourceId of [pitch.northHalfId, pitch.southHalfId, pitch.pitchId]) {
      await expect(
        createScheduledEvent(events, {
          organizationId: org,
          facilityId: facility,
          resourceIds: [resourceId],
          start: at('2026-11-20', '09:00'),
          end: at('2026-11-20', '10:00'),
        }),
      ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    }
    const status = await restrictions.operatingStatus(
      operator,
      facility,
      at('2026-11-20', '09:00'),
    );
    expect(status.resources.map((r) => r.status)).toEqual([
      'restricted',
      'restricted',
      'restricted',
    ]);
    const active = await restrictions.activeRestrictions(operator, facility, {
      start: at('2026-11-20', '00:00'),
      end: at('2026-11-21', '00:00'),
    });
    expect(active.map((r) => r.id)).toEqual([whole.id]);
    await restrictions.release(operator, whole.id, { reason: 'paint dry' });
  });

  it('an existing booking inside the interval is handled by the scheduling closure resolution mode', async () => {
    const booked = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-22', '10:00'),
      end: at('2026-11-22', '11:00'),
      title: 'Rental on the south half',
      kind: 'rental',
      sourceType: 'rental',
    });
    const res = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      kind: 'limited',
      interval: { start: at('2026-11-22', '08:00'), end: at('2026-11-22', '12:00') },
      reason: 'Goal frame replacement',
      resolutionMode: 'cancel_affected',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const canceled = await events.getEvent(operator, booked.id);
    expect(canceled).toMatchObject({ status: 'canceled' });
    expect(canceled.cancelReason).toMatch(/Goal frame replacement/);
    await restrictions.release(operator, res.body.id, { reason: 'frame replaced' });
  });

  it('proposed restrictions hold no space until approved; approval resumes an interrupted activation', async () => {
    const proposed = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'closed',
      interval: { start: at('2026-11-25', '08:00'), end: at('2026-11-25', '12:00') },
      reason: 'Proposed only',
      approve: false,
    });
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({
      status: 'proposed',
      schedulingClosureId: null,
      approvedBy: null,
    });
    const bookable = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.northHalfId],
      start: at('2026-11-25', '09:00'),
      end: at('2026-11-25', '10:00'),
    });
    expect(bookable.status).toBe('published');
    const notActive = await post(`/v1/maintenance-restrictions/${proposed.body.id}/release`, {
      reason: 'x',
    });
    expect(notActive.body.code).toBe('INVALID_TRANSITION');
    // simulate an activation interrupted after the authority was recorded (approved, no closure)
    await t.db
      .updateTable('restrictions')
      .set({
        status: 'approved',
        approved_by: json({ kind: 'staff', actorLabel: 'crashed' }),
        approved_at: t.clock.now(),
      })
      .where('id', '=', proposed.body.id)
      .execute();
    const resumed = await post(`/v1/maintenance-restrictions/${proposed.body.id}/approve`, {
      resolutionMode: 'leave_for_resolution',
    });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({
      status: 'active',
      approvedBy: { actorLabel: 'crashed' },
      affectedConflictUnitIds: [pitch.units.north],
    });
    expect(resumed.body.schedulingClosureId).not.toBeNull();
    // the booking that existed before activation was left for staff resolution (SPK-SCHED-009)
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'status'])
      .where('dedupe_key', '=', `closure:${resumed.body.schedulingClosureId}`)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({ owner_queue: 'scheduler', status: 'open' });
    const approveAgain = await post(`/v1/maintenance-restrictions/${proposed.body.id}/approve`, {});
    expect(approveAgain.body.code).toBe('INVALID_TRANSITION');
  });

  it('a closure lifted in scheduling without a facilities release is surfaced, never reopened silently (SPK-FAC-004)', async () => {
    const restriction = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      kind: 'closed',
      interval: { start: at('2026-11-28', '08:00'), end: at('2026-11-28', '12:00') },
      reason: 'Net replacement',
      approve: true,
    });
    const dispatcher = t.app.get(OutboxDispatcher);
    await dispatcher.runOnce(100);
    const scheduler = staffPrincipal(org, ['scheduler']);
    await closures.liftClosure(scheduler, restriction.schedulingClosureId as string, {
      reason: 'lifted directly',
    });
    await dispatcher.runOnce(100);
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('dedupe_key', '=', `restriction:${restriction.id}:closure_lifted`)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({
      category: 'facilities.closure_lifted_outside_release',
      owner_queue: 'facilities_operator',
      status: 'open',
    });
    expect((await restrictions.get(operator, restriction.id)).status).toBe('active');
    // the facilities release still completes (the closure is already lifted) and raises nothing
    const released = await restrictions.release(operator, restriction.id, {
      reason: 'confirmed after the fact',
    });
    expect(released.status).toBe('released');
    await dispatcher.runOnce(100);
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select('id')
      .where('affected_id', '=', restriction.id)
      .execute();
    expect(exceptions).toHaveLength(1);
  });

  it('authorization, idempotency and uniqueness: front desk cannot restrict, replays return the same restriction, one open restriction per task', async () => {
    const body = {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'closed',
      interval: { start: at('2026-12-01', '08:00'), end: at('2026-12-01', '12:00') },
      reason: 'Idempotent restriction',
    };
    const denied = await post('/v1/maintenance-restrictions', body, await t.authHeader(frontDesk));
    expect(denied.status).toBe(403);
    const k = key();
    const first = await post('/v1/maintenance-restrictions', body, auth, k);
    const replay = await post('/v1/maintenance-restrictions', body, auth, k);
    expect(first.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.id).toBe(first.body.id);
    expect(
      await t.db
        .selectFrom('restrictions')
        .select('id')
        .where('reason', '=', 'Idempotent restriction')
        .execute(),
    ).toHaveLength(1);
    const other = await seedOrganization(t.db);
    const otherAuth = await t.authHeader(
      staffPrincipal(other.organizationId, ['facilities_operator']),
    );
    expect(
      (await t.http.get(`/v1/maintenance-restrictions/${first.body.id}`).set(otherAuth)).status,
    ).toBe(404);
    expect(
      (await t.http.get(`/v1/facilities/${facility}/operating-status`).set(otherAuth)).status,
    ).toBe(404);
    const scoped = await t.authHeader(
      staffPrincipal(org, ['facilities_operator'], { facilityIds: [newId()] }),
    );
    expect(
      (await t.http.get(`/v1/maintenance-restrictions/${first.body.id}`).set(scoped)).status,
    ).toBe(403);
    // one unreleased restriction per task (database unique index, reported as a conflict)
    const taskRes = await post('/v1/maintenance-tasks', {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      issue: 'Divider jammed',
      severity: 'medium',
    });
    const withTask = { ...body, resourceId: pitch.southHalfId, taskId: taskRes.body.id };
    expect((await post('/v1/maintenance-restrictions', withTask)).status).toBe(201);
    const duplicate = await post('/v1/maintenance-restrictions', withTask);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('RESOURCE_CONFLICT');
    // the affected area may also be derived from an asset attached to a space
    const asset = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.southHalfId,
      kind: 'goal',
    });
    const fromAsset = await restrictions.create(systemPrincipal(org, 'fixtures'), {
      facilityId: facility,
      assetId: asset,
      kind: 'closed',
      interval: { start: at('2026-12-02', '08:00'), end: at('2026-12-02', '12:00') },
      reason: 'Goal anchors',
      approve: false,
    });
    expect(fromAsset).toMatchObject({ resourceId: pitch.southHalfId, assetId: asset });
    const detached = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      kind: 'other',
    });
    await expect(
      restrictions.create(operator, {
        facilityId: facility,
        assetId: detached,
        kind: 'closed',
        interval: fromAsset.interval,
        reason: 'Detached asset',
        approve: false,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
