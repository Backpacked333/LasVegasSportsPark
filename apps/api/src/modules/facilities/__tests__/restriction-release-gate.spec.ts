import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import {
  at,
  createScheduledEvent,
  EventsService,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { keepFakePrincipals } from './support';

/**
 * R4-OPS-MODULES-03 (SPK-FAC-004 "must not silently reopen a field if a separate inspection remains
 * required", SPK-FAC-002 "resolution and inspection"). The release gate needs a passed inspection
 * that speaks for the work as it now stands: recorded at or after the restriction's approval and
 * the task's latest resolution, with the task not back at work. The FixedClock advances between
 * steps, as real requests do.
 */
describe('release gate: the inspection must follow the current work (R4-OPS-MODULES-03, SPK-FAC-004)', () => {
  let t: TestApp;
  let events: EventsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let auth: { Authorization: string };
  let managerAuth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-10-19T12:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    events = t.app.get(EventsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch G',
    });
    auth = await t.authHeader(staffPrincipal(org, ['facilities_operator']));
    managerAuth = await t.authHeader(staffPrincipal(org, ['general_manager']));
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object, headers = auth) =>
    t.http.post(path).set(headers).set('Idempotency-Key', key()).send(body);
  const minute = () => t.clock.advance(60_000);
  const task = async (id: string) =>
    (await t.http.get(`/v1/maintenance-tasks/${id}`).set(auth)).body;
  const setStatus = async (id: string, status: 'in_progress' | 'resolved') => {
    const current = await task(id);
    const res = await t.http
      .patch(`/v1/maintenance-tasks/${id}`)
      .set(auth)
      .set('Idempotency-Key', key())
      .send({
        status,
        ...(status === 'resolved' ? { resolution: { summary: 'repaired' } } : {}),
        expectedRevision: current.revision,
      });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  };
  const inspect = async (id: string, outcome: 'passed' | 'failed') => {
    const res = await post(`/v1/maintenance-tasks/${id}/inspections`, { outcome });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body;
  };
  const release = async (restrictionId: string) => {
    const current = (await t.http.get(`/v1/maintenance-restrictions/${restrictionId}`).set(auth))
      .body;
    return post(
      `/v1/maintenance-restrictions/${restrictionId}/release`,
      { reason: 'returned to service', expectedRevision: current.revision },
      managerAuth,
    );
  };
  async function gatedTask(resourceId: string, issue: string): Promise<string> {
    const reported = await post('/v1/maintenance-tasks', {
      facilityId: facility,
      resourceId,
      issue,
      severity: 'high',
      requiresInspection: true,
    });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    expect(reported.body.requiresInspection).toBe(true);
    return reported.body.id as string;
  }
  async function restrict(resourceId: string, taskId: string, day: string): Promise<string> {
    const res = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId,
      taskId,
      kind: 'closed',
      interval: { start: at(day, '08:00'), end: at(day, '20:00') },
      reason: 'Repair',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('active');
    return res.body.id as string;
  }

  it('SPK-FAC-004: a pass recorded before the task was reopened for rework does not release the area', async () => {
    const taskId = await gatedTask(pitch.northHalfId, 'Goal anchor sheared');
    const restrictionId = await restrict(pitch.northHalfId, taskId, '2026-11-20');
    minute();
    await setStatus(taskId, 'resolved');
    minute();
    const firstPass = await inspect(taskId, 'passed');
    minute();
    // rework is found after the pass: the task goes back to work
    expect((await setStatus(taskId, 'in_progress')).status).toBe('in_progress');
    minute();
    const whileWorking = await release(restrictionId);
    expect(whileWorking.status).toBe(422);
    expect(whileWorking.body).toMatchObject({
      code: 'ELIGIBILITY_FAILED',
      details: {
        code: 'inspection_required',
        cause: 'work_in_progress',
        taskId,
        taskStatus: 'in_progress',
        latestInspection: { id: firstPass.id, outcome: 'passed' },
      },
    });
    // resolving the rework again does not revive the old pass
    minute();
    const resolvedAgain = await setStatus(taskId, 'resolved');
    const stale = await release(restrictionId);
    expect(stale.status).toBe(422);
    expect(stale.body.details).toMatchObject({
      code: 'inspection_required',
      cause: 'inspection_predates_current_work',
      inspectionRequiredAfter: resolvedAgain.resolvedAt,
      latestInspection: { id: firstPass.id, outcome: 'passed' },
    });
    // the area is still closed in scheduling
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-20', '12:00'),
        end: at('2026-11-20', '13:00'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    // a new pass of the reworked repair releases it
    minute();
    await inspect(taskId, 'passed');
    const released = await release(restrictionId);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.status).toBe('released');
  });

  it('SPK-FAC-004: the pass that released an earlier restriction of the task does not release a later one', async () => {
    const taskId = await gatedTask(pitch.southHalfId, 'Divider net torn');
    const first = await restrict(pitch.southHalfId, taskId, '2026-11-21');
    minute();
    await setStatus(taskId, 'resolved');
    minute();
    const pass = await inspect(taskId, 'passed');
    minute();
    expect((await release(first)).status).toBe(200);

    // a new defect is found on the same record and the area is closed again
    minute();
    const second = await restrict(pitch.southHalfId, taskId, '2026-11-22');
    minute();
    const reused = await release(second);
    expect(reused.status).toBe(422);
    expect(reused.body.details).toMatchObject({
      code: 'inspection_required',
      cause: 'inspection_predates_current_work',
      latestInspection: { id: pass.id, outcome: 'passed' },
    });
    const approvedAt = (await t.http.get(`/v1/maintenance-restrictions/${second}`).set(auth)).body
      .approvedAt;
    expect(reused.body.details.inspectionRequiredAfter).toBe(approvedAt);
    // a new pass after the approval releases it
    minute();
    await inspect(taskId, 'passed');
    const released = await release(second);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
  });

  it('SPK-FAC-004: an open or assigned task may be released on a pass recorded after the approval (the inspection found the area fit)', async () => {
    const taskId = await gatedTask(pitch.pitchId, 'Floodlight cable exposed');
    const restrictionId = await restrict(pitch.pitchId, taskId, '2026-11-23');
    const none = await release(restrictionId);
    expect(none.body.details).toMatchObject({
      code: 'inspection_required',
      cause: 'not_inspected',
      latestInspection: null,
    });
    minute();
    await inspect(taskId, 'passed');
    expect((await task(taskId)).status).toBe('open');
    expect((await release(restrictionId)).status).toBe(200);
  });
});
