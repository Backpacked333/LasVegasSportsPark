import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
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
 * Release checklists (migration 0909, SPK-FAC-004 "returning a space to service requires an
 * authorized release") and the facility day summary for page headers (SPK-SCHED-008 local day).
 */
describe('release checklist and facility day summary (SPK-FAC-004, SPK-SCHED-008)', () => {
  let t: TestApp;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let auth: { Authorization: string };
  let ownerId: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-11-02T20:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Field 3',
    });
    auth = await t.authHeader(staffPrincipal(org, ['facilities_operator']));
    ownerId = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Luis',
      familyName: 'Ortega',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object, headers = auth) =>
    t.http.post(path).set(headers).set('Idempotency-Key', key()).send(body);
  const checklist = async (id: string) =>
    (await t.http.get(`/v1/maintenance-restrictions/${id}/release-checklist`).set(auth)).body;

  async function activeRestriction(day: string, withOwner = false) {
    const task = await post('/v1/maintenance-tasks', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      issue: 'Goal net torn',
      severity: 'medium',
    });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    if (withOwner) {
      const assigned = await t.http
        .patch(`/v1/maintenance-tasks/${task.body.id}`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send({ assignedOwnerPersonId: ownerId, expectedRevision: task.body.revision });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    }
    const res = await post('/v1/maintenance-restrictions', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      taskId: task.body.id,
      kind: 'closed',
      interval: { start: at(day, '08:00'), end: at(day, '20:00') },
      reason: 'Goal net torn',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; revision: number };
  }
  const release = async (id: string) => {
    const current = (await t.http.get(`/v1/maintenance-restrictions/${id}`).set(auth)).body;
    return post(`/v1/maintenance-restrictions/${id}/release`, {
      reason: 'back in service',
      expectedRevision: current.revision,
    });
  };

  it('SPK-FAC-004: the checklist names the task owner and blocks the release until every item is confirmed', async () => {
    const restriction = await activeRestriction('2026-11-03', true);
    const empty = await checklist(restriction.id);
    expect(empty).toMatchObject({
      restrictionId: restriction.id,
      items: [],
      complete: true,
      taskOwner: { personId: ownerId, displayName: 'Luis Ortega' },
    });
    const net = await post(`/v1/maintenance-restrictions/${restriction.id}/checklist-items`, {
      label: 'Net replaced and tensioned',
    });
    expect(net.status, JSON.stringify(net.body)).toBe(201);
    const walk = await post(`/v1/maintenance-restrictions/${restriction.id}/checklist-items`, {
      label: 'Area walked, no debris',
    });
    expect(walk.body.position).toBe(1);

    const refused = await release(restriction.id);
    expect(refused.status).toBe(422);
    expect(refused.body.details).toMatchObject({ code: 'checklist_incomplete' });
    expect(refused.body.details.openItems).toHaveLength(2);

    const done = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items/${net.body.id}/complete`,
      { expectedRevision: net.body.revision, note: 'new net fitted' },
    );
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.complete).toBe(false);
    expect(done.body.items[0]).toMatchObject({
      completionNote: 'new net fitted',
      completedBy: expect.objectContaining({ kind: 'staff' }),
    });
    // a stale confirmation is refused
    const stale = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items/${walk.body.id}/complete`,
      { expectedRevision: walk.body.revision + 3 },
    );
    expect(stale.status).toBe(409);
    const all = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items/${walk.body.id}/complete`,
      { expectedRevision: walk.body.revision },
    );
    expect(all.body.complete).toBe(true);

    const released = await release(restriction.id);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.status).toBe('released');

    // the checklist of a released restriction is history
    const closed = await post(`/v1/maintenance-restrictions/${restriction.id}/checklist-items`, {
      label: 'Late addition',
    });
    expect(closed.status).toBe(409);
    // ... in the database too (migration 0909 guard)
    await expect(
      t.db
        .updateTable('restriction_checklist_items')
        .set({ label: 'rewritten' })
        .where('restriction_id', '=', restriction.id)
        .execute(),
    ).rejects.toThrow(/checklist of released restriction/);
  });

  it('SPK-FAC-004: reopening and removing are explained; a confirmed item is reopened before removal', async () => {
    const restriction = await activeRestriction('2026-11-04');
    const item = (
      await post(`/v1/maintenance-restrictions/${restriction.id}/checklist-items`, {
        label: 'Goal anchored',
      })
    ).body;
    const confirmed = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items/${item.id}/complete`,
      { expectedRevision: item.revision },
    );
    const revision = confirmed.body.items[0].revision;
    const removeConfirmed = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items/${item.id}/remove`,
      { expectedRevision: revision, reason: 'duplicate' },
    );
    expect(removeConfirmed.status).toBe(409);
    const noReason = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items/${item.id}/reopen`,
      { expectedRevision: revision },
    );
    expect(noReason.status).toBe(400);
    const reopened = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items/${item.id}/reopen`,
      { expectedRevision: revision, reason: 'pull test failed' },
    );
    expect(reopened.body.items[0].completedAt).toBeNull();
    const removed = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items/${item.id}/remove`,
      { expectedRevision: reopened.body.items[0].revision, reason: 'duplicate' },
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.items).toEqual([]);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', restriction.id)
      .where('action', 'like', 'facilities.checklist_item_%')
      .execute();
    expect(audit.map((a) => a.action).sort()).toEqual([
      'facilities.checklist_item_added',
      'facilities.checklist_item_completed',
      'facilities.checklist_item_removed',
      'facilities.checklist_item_reopened',
    ]);
  });

  it('migration 0909: the database refuses to release a restriction with an unconfirmed item, and a confirmation that names no one', async () => {
    const restriction = await activeRestriction('2026-11-05');
    await post(`/v1/maintenance-restrictions/${restriction.id}/checklist-items`, {
      label: 'Lights checked',
    });
    await expect(
      t.db
        .updateTable('restrictions')
        .set({
          status: 'released',
          released_at: new Date(),
          released_by: JSON.stringify({ kind: 'system' }) as never,
        })
        .where('id', '=', restriction.id)
        .execute(),
    ).rejects.toThrow(/unconfirmed release checklist items/);
    await expect(
      t.db
        .updateTable('restriction_checklist_items')
        .set({ completed_at: new Date() })
        .where('restriction_id', '=', restriction.id)
        .execute(),
    ).rejects.toThrow(/check/);
  });

  it('§4.3: only the facilities roles manage the checklist; a front desk reads it', async () => {
    const restriction = await activeRestriction('2026-11-06');
    const desk = await t.authHeader(staffPrincipal(org, ['front_desk']));
    const denied = await post(
      `/v1/maintenance-restrictions/${restriction.id}/checklist-items`,
      { label: 'x' },
      desk,
    );
    expect(denied.status).toBe(403);
    const read = await t.http
      .get(`/v1/maintenance-restrictions/${restriction.id}/release-checklist`)
      .set(desk);
    expect(read.status).toBe(200);
  });

  it('SPK-SCHED-008: the day summary counts activities, closures, restrictions and tasks for the facility-local day', async () => {
    const events = t.app.get(EventsService);
    await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      start: at('2026-11-07', '18:00'),
      end: at('2026-11-07', '19:00'),
    });
    await createScheduledEvent(events, {
      organizationId: org,
      facilityId: facility,
      resourceIds: [pitch.southHalfId],
      // 23:30 local on the 7th is the 8th in UTC: still counted on the local 7th
      start: at('2026-11-07', '23:00'),
      end: at('2026-11-07', '23:45'),
      kind: 'practice',
    });
    await activeRestriction('2026-11-07');
    const res = await t.http
      .get(`/v1/facilities/${facility}/day-summary`)
      .set(await t.authHeader(staffPrincipal(org, ['front_desk'])))
      .query({ date: '2026-11-07' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      facilityId: facility,
      date: '2026-11-07',
      window: {
        start: new Date(at('2026-11-07', '00:00')).toISOString(),
        end: new Date(at('2026-11-08', '00:00')).toISOString(),
      },
      schedule: {
        activities: { total: 2, published: 2, byKind: { game: 1, practice: 1 } },
        closures: { active: 1, pending: 0 },
      },
      restrictions: { active: 1, approved: 0, proposed: 0 },
    });
    expect(res.body.maintenance.openTasks).toBeGreaterThan(0);
  });

  it('§4.10: a section the viewer may not read is null, never 0', async () => {
    const coach = await t.authHeader(staffPrincipal(org, ['coach']));
    const res = await t.http
      .get(`/v1/facilities/${facility}/day-summary`)
      .set(coach)
      .query({ date: '2026-11-07' });
    expect(res.status).toBe(200);
    expect(res.body.schedule).not.toBeNull();
    expect(res.body.restrictions).toBeNull();
    expect(res.body.maintenance).toBeNull();
  });
});
