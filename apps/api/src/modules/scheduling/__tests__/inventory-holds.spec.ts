import { DomainError, newId, type Principal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { EventsService } from '../services/events.service';
import { SchedulingModule } from '../scheduling.module';
import { at } from '../testing/scheduling-fixtures';

/**
 * SPK-SCHED-002 / §4.7 invariant 4: a whole-field reservation conflicts with every overlapping
 * subdivision reservation. The guarantee rests on the unit mapping and on the units each
 * reservation holds, so inventory changes keep both right: a whole space always keeps the units of
 * its subdivisions, and a resource that gains units has them added to its active holds.
 */
describe('inventory changes keep whole-space holds covering their subdivisions (SPK-SCHED-002, §4.7 invariant 4)', () => {
  let t: TestApp;
  let events: EventsService;
  let scheduler: Principal;
  let auth: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({ imports: [SchedulingModule], clockStart: '2026-10-19T12:00:00Z' });
    events = t.app.get(EventsService);
    scheduler = staffPrincipal(t.organizationId, ['scheduler']);
    auth = await t.authHeader(scheduler);
  });
  afterAll(async () => {
    await t.close();
  });

  const key = () => `key-${newId()}`;
  const post = (path: string, body: object) =>
    t.http.post(path).set(auth).set('Idempotency-Key', key()).send(body);
  const patch = (path: string, body: object) =>
    t.http.patch(path).set(auth).set('Idempotency-Key', key()).send(body);
  const resource = async (body: Record<string, unknown>) => {
    const res = await post('/v1/resources', { facilityId: t.facilityId, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; conflictUnitIds: string[]; revision: number };
  };
  const unit = async (name: string) => {
    const res = await post('/v1/conflict-units', { facilityId: t.facilityId, name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const book = (resourceId: string, day: string, from = '18:00', to = '19:00') =>
    events.createEvent(scheduler, {
      facilityId: t.facilityId,
      kind: 'game',
      title: 'Game',
      scheduledStart: at(day, from),
      scheduledEnd: at(day, to),
      resourceIds: [resourceId],
      sourceType: 'fixture',
      sourceId: newId(),
    });
  const outcome = (p: Promise<{ status: string }>) =>
    p.then(
      (e) => e.status,
      (error: unknown) => (DomainError.is(error) ? error.code : String(error)),
    );
  const pitchWithHalves = async (name: string) => {
    const pitch = await resource({ kind: 'pitch', name });
    const north = await resource({
      kind: 'subdivision',
      name: `${name} north`,
      parentResourceId: pitch.id,
    });
    const south = await resource({
      kind: 'subdivision',
      name: `${name} south`,
      parentResourceId: pitch.id,
    });
    return { pitch, north, south, ownUnit: pitch.conflictUnitIds[0] as string };
  };

  it('SPK-SCHED-002 / §4.7 invariant 4: updating a whole pitch conflictUnitIds keeps its subdivisions units, so the pitch still conflicts with each half', async () => {
    const { pitch, north, south, ownUnit } = await pitchWithHalves('Field 7');
    const goalLine = await unit('Field 7 goal line');
    const updated = await patch(`/v1/resources/${pitch.id}`, {
      expectedRevision: pitch.revision,
      conflictUnitIds: [ownUnit, goalLine],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect([...updated.body.conflictUnitIds].sort()).toEqual(
      [ownUnit, goalLine, ...north.conflictUnitIds, ...south.conflictUnitIds].sort(),
    );
    await book(pitch.id, '2026-11-02');
    expect(await outcome(book(north.id, '2026-11-02'))).toBe('RESOURCE_CONFLICT');
    expect(await outcome(book(south.id, '2026-11-02'))).toBe('RESOURCE_CONFLICT');
    await book(north.id, '2026-11-03');
    expect(await outcome(book(pitch.id, '2026-11-03'))).toBe('RESOURCE_CONFLICT');
    // the change of units is recorded
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('target_id', '=', pitch.id)
      .where('action', '=', 'scheduling.resource_updated')
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ conflictUnitIds: { from: expect.any(Array) } });
  });

  it('SPK-SCHED-002 / §4.7 invariant 4: a unit added to a resource is added to its active future holds', async () => {
    const field = await resource({ kind: 'pitch', name: 'Field 8' });
    const shared = await unit('Field 8 run-off');
    const game = await book(field.id, '2026-11-04');
    // an already-ended hold is not extended
    t.clock.set(new Date('2026-11-05T12:00:00Z'));
    const later = await book(field.id, '2026-11-06');
    const updated = await patch(`/v1/resources/${field.id}`, {
      expectedRevision: field.revision,
      conflictUnitIds: [...field.conflictUnitIds, shared],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const unitsOf = async (eventId: string) =>
      (
        await t.db
          .selectFrom('reservation_units')
          .select('conflict_unit_id')
          .where('event_id', '=', eventId)
          .where('status', '=', 'active')
          .execute()
      )
        .map((r) => r.conflict_unit_id)
        .sort();
    expect(await unitsOf(later.id)).toEqual([...field.conflictUnitIds, shared].sort());
    expect(await unitsOf(game.id)).toEqual(field.conflictUnitIds);
    // a resource mapped only to the added unit cannot be booked over the existing hold
    const runOff = await resource({ kind: 'other', name: 'Run-off', conflictUnitIds: [shared] });
    expect(await outcome(book(runOff.id, '2026-11-06'))).toBe('RESOURCE_CONFLICT');
    expect(await outcome(book(runOff.id, '2026-11-06', '20:00', '21:00'))).toBe('published');
    // re-stating the current units of a resource with future bookings still succeeds
    const restated = await patch(`/v1/resources/${field.id}`, {
      expectedRevision: updated.body.revision,
      conflictUnitIds: [...field.conflictUnitIds, shared],
    });
    expect(restated.status, JSON.stringify(restated.body)).toBe(200);
    t.clock.set(new Date('2026-10-19T12:00:00Z'));
  });

  it('SPK-SCHED-002 / §4.7 invariant 4: a subdivision added after a whole-pitch booking cannot be booked over it', async () => {
    const field = await resource({ kind: 'pitch', name: 'Field 9' });
    const whole = await book(field.id, '2026-11-07');
    const east = await resource({
      kind: 'subdivision',
      name: 'Field 9 east',
      parentResourceId: field.id,
    });
    const slots = await events.findAvailableSlots(scheduler, {
      resourceId: east.id,
      interval: { start: at('2026-11-07', '17:00'), end: at('2026-11-07', '20:00') },
      durationMinutes: 60,
      stepMinutes: 60,
    });
    expect(slots.map((s) => s.start)).toEqual([
      at('2026-11-07', '17:00'),
      at('2026-11-07', '19:00'),
    ]);
    const refused = await outcome(book(east.id, '2026-11-07'));
    expect(refused).toBe('RESOURCE_CONFLICT');
    expect(await outcome(book(east.id, '2026-11-07', '19:00', '20:00'))).toBe('published');
    const held = await t.db
      .selectFrom('reservation_units')
      .select('conflict_unit_id')
      .where('event_id', '=', whole.id)
      .where('status', '=', 'active')
      .execute();
    expect(held.map((h) => h.conflict_unit_id).sort()).toEqual(
      [...field.conflictUnitIds, ...east.conflictUnitIds].sort(),
    );
  });

  it('SPK-SCHED-002 / §4.7 invariant 4: an inventory change that would put a hold on space already reserved is refused and changes nothing', async () => {
    const a = await resource({ kind: 'pitch', name: 'Field 10' });
    const b = await resource({ kind: 'pitch', name: 'Field 11' });
    await book(a.id, '2026-11-08');
    const onB = await book(b.id, '2026-11-08');
    const refused = await patch(`/v1/resources/${a.id}`, {
      expectedRevision: a.revision,
      conflictUnitIds: [...a.conflictUnitIds, ...b.conflictUnitIds],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    expect(refused.body.details.conflictingEventIds).toContain(onB.id);
    const after = await t.http.get(`/v1/resources/${a.id}`).set(auth);
    expect(after.body).toMatchObject({ conflictUnitIds: a.conflictUnitIds, revision: a.revision });
  });
});
