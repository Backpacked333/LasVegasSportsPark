import { newId, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PeriodicJobRegistry, PeriodicJobRunner } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import {
  at,
  createScheduledEvent,
  EventsService,
  seedPitchWithHalves,
  type PitchFixture,
} from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { RAISE_UNRELEASED_RESTRICTION_EXCEPTIONS_JOB } from '../services/facilities-jobs';
import { RESTRICTION_UNRELEASED_AT_END } from '../services/restrictions.service';
import { keepFakePrincipals } from './support';

/**
 * R4-OPS-MODULES-02 (SPK-FAC-004 "returning a space to service requires an authorized release",
 * SPK-AT-021 "authorized reopening"). A restriction is approved for a bounded interval and its
 * scheduling closure ends with it, so an active restriction nobody releases stops blocking the area
 * at its end. The periodic job facilities.raise_unreleased_restriction_exceptions raises one owned
 * exception per such restriction for the facilities operator: `high` before the end while the
 * task's inspection is outstanding, `warning` once the interval ended without a release. A
 * follow-on restriction of the same task (migration 0906) keeps the area closed past the end under
 * the same inspection gate. Tests advance the FixedClock and call PeriodicJobRunner.runOnce.
 */
describe('restrictions reaching the end of their interval unreleased (R4-OPS-MODULES-02, SPK-FAC-004)', () => {
  let t: TestApp;
  let runner: PeriodicJobRunner;
  let events: EventsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let operator: Principal;
  let auth: { Authorization: string };
  let managerAuth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      // 2026-11-01 22:00 in the facility zone (America/Los_Angeles, the `at` helper's default)
      clockStart: '2026-11-02T06:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    runner = t.app.get(PeriodicJobRunner);
    events = t.app.get(EventsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch R',
    });
    operator = staffPrincipal(org, ['facilities_operator']);
    auth = await t.authHeader(operator);
    managerAuth = await t.authHeader(staffPrincipal(org, ['general_manager']));
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object, headers = auth) =>
    t.http.post(path).set(headers).set('Idempotency-Key', key()).send(body);
  const patch = (path: string, body: object) =>
    t.http.patch(path).set(auth).set('Idempotency-Key', key()).send(body);
  const run = async () => {
    const [summary] = await runner.runOnce([RAISE_UNRELEASED_RESTRICTION_EXCEPTIONS_JOB], {
      ignoreInterval: true,
    });
    return summary;
  };
  const exceptionsOf = (restrictionId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('organization_id', '=', org)
      .where('category', '=', RESTRICTION_UNRELEASED_AT_END)
      .where('affected_id', '=', restrictionId)
      .orderBy('opened_at')
      .execute();
  const restrictionRevision = async (id: string): Promise<number> =>
    (await t.http.get(`/v1/maintenance-restrictions/${id}`).set(auth)).body.revision;

  async function inspectedTask(resourceId: string, issue: string): Promise<string> {
    const reported = await post('/v1/maintenance-tasks', {
      facilityId: facility,
      resourceId,
      issue,
      severity: 'high',
    });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    const gated = await patch(`/v1/maintenance-tasks/${reported.body.id as string}`, {
      requiresInspection: true,
      expectedRevision: reported.body.revision,
    });
    expect(gated.status, JSON.stringify(gated.body)).toBe(200);
    return reported.body.id as string;
  }

  async function resolveAndPass(taskId: string): Promise<void> {
    const current = (await t.http.get(`/v1/maintenance-tasks/${taskId}`).set(auth)).body;
    const resolved = await patch(`/v1/maintenance-tasks/${taskId}`, {
      status: 'resolved',
      resolution: { summary: 'repaired' },
      expectedRevision: current.revision,
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    t.clock.advance(60_000);
    const passed = await post(`/v1/maintenance-tasks/${taskId}/inspections`, {
      outcome: 'passed',
    });
    expect(passed.status, JSON.stringify(passed.body)).toBe(201);
  }

  it('is registered every 300 seconds, owned by the facilities operator queue (§4.12)', () => {
    const job = t.app.get(PeriodicJobRegistry).get(RAISE_UNRELEASED_RESTRICTION_EXCEPTIONS_JOB);
    expect(job).toMatchObject({ intervalSeconds: 300, failureOwner: 'facilities_operator' });
  });

  it('SPK-FAC-004 / SPK-AT-021: an active restriction whose task still needs its inspection raises an owned exception before its interval ends, and a follow-on restriction of the same task keeps the area closed past the end under the same inspection gate', async () => {
    const taskId = await inspectedTask(pitch.northHalfId, 'Turf seam lifted');
    const first = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      taskId,
      kind: 'closed',
      interval: { start: at('2026-11-02', '08:00'), end: at('2026-11-04', '08:00') },
      reason: 'Turf seam repair',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.status).toBe('active');
    const r1: string = first.body.id;

    // more than restrictionEndWarningHours (proposed 24 h) before the end: nothing is due yet
    expect(await run()).toMatchObject({ ran: true, failed: false, processed: 0 });
    expect(await exceptionsOf(r1)).toEqual([]);

    // the repair overruns: a day before the end, the inspection is still outstanding
    t.clock.set(at('2026-11-03', '09:00'));
    expect(await run()).toMatchObject({ ran: true, failed: false, processed: 1 });
    const raised = await exceptionsOf(r1);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      facility_id: facility,
      severity: 'high',
      owner_queue: 'facilities_operator',
      status: 'open',
      affected_type: 'restriction',
      dedupe_key: `restriction:${r1}:unreleased_at_end`,
      details: {
        restrictionId: r1,
        taskId,
        resourceId: pitch.northHalfId,
        ended: false,
        inspectionOutstanding: { cause: 'not_inspected', taskId },
      },
    });
    expect(new Date(raised[0]?.deadline_at as Date).toISOString()).toBe(at('2026-11-04', '08:00'));
    // a replay raises nothing new (dedupe key per restriction)
    await run();
    expect(await exceptionsOf(r1)).toHaveLength(1);

    // the task's unreleased restrictions never overlap (migration 0906) ...
    const overlapping = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      taskId,
      kind: 'closed',
      interval: { start: at('2026-11-04', '07:00'), end: at('2026-11-06', '08:00') },
      reason: 'Overlapping continuation',
    });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'TASK_RESTRICTION_OVERLAP', taskId },
    });
    // ... and a follow-on starting where the open one ends continues it
    const followOn = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      taskId,
      kind: 'closed',
      interval: { start: at('2026-11-04', '08:00'), end: at('2026-11-06', '08:00') },
      reason: 'Turf seam repair continues',
    });
    expect(followOn.status, JSON.stringify(followOn.body)).toBe(201);
    expect(followOn.body.status).toBe('active');
    const r2: string = followOn.body.id;
    expect(
      (
        await t.http.get(`/v1/maintenance-tasks/${taskId}`).set(auth)
      ).body.openRestrictionIds.sort(),
    ).toEqual([r1, r2].sort());
    // the follow-on settles the warning: the area no longer reopens at the end
    await run();
    expect((await exceptionsOf(r1)).map((e) => e.status)).toEqual(['resolved']);

    // past the first interval the area is still closed, by the follow-on's closure
    t.clock.set(at('2026-11-04', '09:00'));
    await expect(
      createScheduledEvent(events, {
        organizationId: org,
        facilityId: facility,
        resourceIds: [pitch.northHalfId],
        start: at('2026-11-04', '10:00'),
        end: at('2026-11-04', '11:00'),
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const status = await t.http
      .get(`/v1/facilities/${facility}/operating-status`)
      .query({ at: at('2026-11-04', '09:00') })
      .set(auth);
    expect(
      status.body.resources.find((r: { resourceId: string }) => r.resourceId === pitch.northHalfId),
    ).toMatchObject({ status: 'restricted', restrictions: [{ restrictionId: r2 }] });
    // the ended first restriction is continued: nothing is raised for it, nor for the follow-on yet
    await run();
    expect((await exceptionsOf(r1)).filter((e) => e.status === 'open')).toEqual([]);
    expect(await exceptionsOf(r2)).toEqual([]);

    // the same inspection gate decides the follow-on's release
    const early = await post(
      `/v1/maintenance-restrictions/${r2}/release`,
      { reason: 'looks fine' },
      managerAuth,
    );
    expect(early.status).toBe(422);
    expect(early.body.details).toMatchObject({ code: 'inspection_required', taskId });
    await resolveAndPass(taskId);
    const released2 = await post(
      `/v1/maintenance-restrictions/${r2}/release`,
      { reason: 'repaired and inspected', expectedRevision: await restrictionRevision(r2) },
      managerAuth,
    );
    expect(released2.status, JSON.stringify(released2.body)).toBe(200);

    // the first restriction ended without its release and nothing continues it any more
    expect(await run()).toMatchObject({ ran: true, failed: false, processed: 1 });
    const ended = (await exceptionsOf(r1)).filter((e) => e.status === 'open');
    expect(ended).toEqual([
      expect.objectContaining({
        severity: 'warning',
        owner_queue: 'facilities_operator',
        details: expect.objectContaining({ ended: true, inspectionOutstanding: null }),
      }),
    ]);
    // the authorized release settles it in its own unit of work
    const released1 = await post(
      `/v1/maintenance-restrictions/${r1}/release`,
      { reason: 'repaired and inspected', expectedRevision: await restrictionRevision(r1) },
      managerAuth,
    );
    expect(released1.status, JSON.stringify(released1.body)).toBe(200);
    expect((await exceptionsOf(r1)).map((e) => e.status)).toEqual(['resolved', 'resolved']);
    expect(await run()).toMatchObject({ ran: true, failed: false, processed: 0 });
  });

  it('SPK-FAC-004: a passed inspection before the end settles the warning; an interval that then ends without a release is raised again until the release settles it', async () => {
    t.clock.set(at('2026-11-10', '06:00'));
    const taskId = await inspectedTask(pitch.southHalfId, 'Divider anchor loose');
    const created = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      taskId,
      kind: 'closed',
      interval: { start: at('2026-11-10', '08:00'), end: at('2026-11-10', '20:00') },
      reason: 'Divider anchor',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id: string = created.body.id;
    await run();
    expect(await exceptionsOf(id)).toEqual([
      expect.objectContaining({ status: 'open', severity: 'high' }),
    ]);
    // the work is resolved and the inspection passes before the end: nothing is due any more
    t.clock.set(at('2026-11-10', '12:00'));
    await resolveAndPass(taskId);
    await run();
    expect((await exceptionsOf(id)).map((e) => e.status)).toEqual(['resolved']);
    // the interval ends and nobody released the area: raised again, as a warning
    t.clock.set(at('2026-11-10', '21:00'));
    await run();
    const open = (await exceptionsOf(id)).filter((e) => e.status === 'open');
    expect(open).toEqual([
      expect.objectContaining({
        severity: 'warning',
        title: 'A restriction ended without an authorized release',
        details: expect.objectContaining({ ended: true }),
      }),
    ]);
    const released = await post(
      `/v1/maintenance-restrictions/${id}/release`,
      { reason: 'inspected', expectedRevision: await restrictionRevision(id) },
      managerAuth,
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect((await exceptionsOf(id)).map((e) => e.status)).toEqual(['resolved', 'resolved']);
  });
});
