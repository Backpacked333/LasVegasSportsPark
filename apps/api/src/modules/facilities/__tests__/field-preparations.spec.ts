import { newId } from '@sportspark/contracts';
import { isCheckViolation, isForeignKeyViolation, isUniqueViolation, json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { seedPitchWithHalves, seedResource, type PitchFixture } from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { keepFakePrincipals } from './support';

/**
 * The field crew's daily pitch preparation (migration 0975; SPK-FAC-001, SPK-READY-001 field
 * readiness, SPK-UX-006; staff redesign Phase 8 "Field crew · Fields").
 */
describe('field preparations (SPK-READY-001, SPK-FAC-001, migration 0975)', () => {
  let t: TestApp;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let crew: { Authorization: string };
  let desk: { Authorization: string };
  let coach: { Authorization: string };
  let today: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-11-21T15:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Field 2',
    });
    const crewPerson = await createPersonFixture(t, {
      kind: 'adult',
      givenName: 'Marco',
      familyName: 'Crew',
    });
    crew = await t.authHeader(
      staffPrincipal(org, ['facilities_operator'], { personId: crewPerson }),
    );
    desk = await t.authHeader(staffPrincipal(org, ['front_desk']));
    coach = await t.authHeader(staffPrincipal(org, ['coach']));
    const day = await t.http
      .get('/v1/field-preparations')
      .query({ facilityId: facility })
      .set(desk);
    expect(day.status, JSON.stringify(day.body)).toBe(200);
    today = day.body.date;
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object, headers = crew) =>
    t.http.post(path).set(headers).set('Idempotency-Key', key()).send(body);

  it('SPK-READY-001: the crew ticks the checklist; "Mark ready" is refused until every item is ticked', async () => {
    const first = await post('/v1/field-preparations', {
      facilityId: facility,
      resourceId: pitch.pitchId,
      date: today,
      checkedItems: ['nets', 'lines'],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // Walking order, whatever order the items were sent in.
    expect(first.body).toMatchObject({
      checkedItems: ['lines', 'nets'],
      status: 'in_progress',
      readyAt: null,
      revision: 1,
    });

    const early = await post(`/v1/field-preparations/${first.body.id}/ready`, {
      expectedRevision: 1,
    });
    expect(early.status).toBe(422);
    expect(early.body.details).toMatchObject({
      code: 'checklist_incomplete',
      missingItems: ['goals_anchored', 'corner_flags'],
    });

    const all = await post('/v1/field-preparations', {
      facilityId: facility,
      resourceId: pitch.pitchId,
      date: today,
      checkedItems: ['lines', 'goals_anchored', 'nets', 'corner_flags'],
      expectedRevision: 1,
    });
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const ready = await post(`/v1/field-preparations/${first.body.id}/ready`, {
      expectedRevision: all.body.revision,
    });
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(ready.body).toMatchObject({ status: 'ready', revision: 3 });
    expect(ready.body.readyAt).toBe('2026-11-21T15:00:00.000Z');

    // Today's field check reads the day (the desk holds facilities.view_maintenance).
    const day = await t.http
      .get('/v1/field-preparations')
      .query({ facilityId: facility })
      .set(desk);
    expect(day.body.checklist).toEqual(['lines', 'goals_anchored', 'nets', 'corner_flags']);
    expect(day.body.items).toEqual([
      expect.objectContaining({ resourceId: pitch.pitchId, status: 'ready' }),
    ]);

    const audit = await t.db
      .selectFrom('audit_records')
      .select('action')
      .where('target_id', '=', first.body.id)
      .execute();
    expect(audit.map((a) => a.action)).toContain('facilities.field_marked_ready');
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', first.body.id)
      .execute();
    expect(events.map((e) => e.event_type)).toEqual(['facilities.field_marked_ready']);
  });

  it('SPK-READY-001: unticking an item of a ready pitch reopens it; a stale revision is refused', async () => {
    const day = await t.http
      .get('/v1/field-preparations')
      .query({ facilityId: facility })
      .set(desk);
    const current = day.body.items[0];
    expect(current.status).toBe('ready');
    const stale = await post('/v1/field-preparations', {
      facilityId: facility,
      resourceId: pitch.pitchId,
      date: today,
      checkedItems: ['lines'],
      expectedRevision: current.revision - 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const reopened = await post('/v1/field-preparations', {
      facilityId: facility,
      resourceId: pitch.pitchId,
      date: today,
      checkedItems: ['lines', 'goals_anchored', 'corner_flags'],
      expectedRevision: current.revision,
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body).toMatchObject({ status: 'in_progress', readyAt: null, readyBy: null });
  });

  it('SPK-FAC-001: only a whole pitch of the facility, today or tomorrow, by the crew', async () => {
    const half = await post('/v1/field-preparations', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      date: today,
      checkedItems: [],
    });
    expect(half.status).toBe(400);
    expect(half.body.details).toMatchObject({ code: 'not_a_pitch' });

    const later = await post('/v1/field-preparations', {
      facilityId: facility,
      resourceId: pitch.pitchId,
      date: '2026-12-25',
      checkedItems: [],
    });
    expect(later.status).toBe(400);
    expect(later.body.details).toMatchObject({ code: 'date_out_of_range' });

    const byDesk = await post(
      '/v1/field-preparations',
      { facilityId: facility, resourceId: pitch.pitchId, date: today, checkedItems: [] },
      desk,
    );
    expect(byDesk.status).toBe(403);
    const coachRead = await t.http
      .get('/v1/field-preparations')
      .query({ facilityId: facility })
      .set(coach);
    expect(coachRead.status).toBe(403);
  });

  it('SPK-READY-001 (migration 0975): the database refuses a ready pitch with an item unticked, a second record for the day, and a pitch of another facility', async () => {
    const { resourceId: other } = await seedResource(t.db, {
      organizationId: org,
      facilityId: facility,
      kind: 'pitch',
      name: 'Field 9',
    });
    const base = {
      organization_id: org,
      facility_id: facility,
      resource_id: other,
      local_date: today,
      updated_by: json({ kind: 'system', actorLabel: 'test' }),
    };
    await expect(
      t.db
        .insertInto('field_preparations')
        .values({
          ...base,
          id: newId(),
          checked_items: ['lines', 'nets'],
          status: 'ready',
          ready_at: new Date(),
          ready_by: json({ kind: 'system', actorLabel: 'test' }),
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      t.db
        .insertInto('field_preparations')
        .values({
          ...base,
          id: newId(),
          status: 'ready',
          checked_items: ['lines', 'goals_anchored', 'nets', 'corner_flags'],
        })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await t.db
      .insertInto('field_preparations')
      .values({ ...base, id: newId() })
      .execute();
    await expect(
      t.db
        .insertInto('field_preparations')
        .values({ ...base, id: newId() })
        .execute(),
    ).rejects.toSatisfy(isUniqueViolation);
    await expect(
      t.db
        .insertInto('field_preparations')
        .values({ ...base, id: newId(), checked_items: ['lines', 'sprinklers' as 'lines'] })
        .execute(),
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      t.db
        .insertInto('field_preparations')
        .values({ ...base, id: newId(), facility_id: newId(), local_date: '2026-11-22' })
        .execute(),
    ).rejects.toSatisfy(isForeignKeyViolation);
  });
});
