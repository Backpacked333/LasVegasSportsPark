import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createAttendanceObservationFixture } from '../../entry';
import { createPersonFixture } from '../../identity';
import {
  at,
  ClosuresService,
  createAppliedClosure,
  createScheduledEvent,
  EventsService,
  seedOperatingHours,
  seedPitchWithHalves,
  seedResource,
  type PitchFixture,
} from '../../scheduling';
import { get, HOUR, key, reportingTestApp, staff, valueOf, type Actor } from './support';

const DATE = '2027-02-03';

type Row = Record<string, string | number | boolean | null>;

describe('field utilization (SPK-REPORT-003)', () => {
  let t: TestApp;
  let scheduler: Actor;
  let pitch: PitchFixture;
  let roomId: string;
  let wholeEventId: string;
  let halfEventId: string;

  const report = (actor: Actor, query: Record<string, string> = {}) =>
    get(t, '/v1/reports/utilization', actor, {
      facilityId: t.facilityId,
      from: DATE,
      to: DATE,
      ...query,
    });

  beforeAll(async () => {
    t = await reportingTestApp();
    scheduler = await staff(t, ['scheduler']);
    const org = t.organizationId;
    await seedOperatingHours(t.db, {
      organizationId: org,
      facilityId: t.facilityId,
      opensAt: '08:00',
      closesAt: '22:00',
    });
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: t.facilityId,
      name: 'Pitch 1',
      defaultCleanupMinutes: 10,
    });
    roomId = (
      await seedResource(t.db, {
        organizationId: org,
        facilityId: t.facilityId,
        name: 'Room A',
        kind: 'room',
      })
    ).resourceId;
    const events = t.app.get(EventsService);
    // A whole-pitch game: occupies both halves' units 10:00-11:10 (ten-minute cleanup, SPK-SCHED-003).
    wholeEventId = (
      await createScheduledEvent(events, {
        organizationId: org,
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        start: at(DATE, '10:00'),
        end: at(DATE, '11:00'),
        kind: 'game',
      })
    ).id;
    // A half-pitch practice: occupies only the north unit 14:00-15:10.
    halfEventId = (
      await createScheduledEvent(events, {
        organizationId: org,
        facilityId: t.facilityId,
        resourceIds: [pitch.northHalfId],
        start: at(DATE, '14:00'),
        end: at(DATE, '15:00'),
        kind: 'practice',
      })
    ).id;
    // The south half is closed 18:00-20:00 (inside operating hours).
    await createAppliedClosure(t.app.get(ClosuresService), {
      organizationId: org,
      facilityId: t.facilityId,
      resourceId: pitch.southHalfId,
      start: at(DATE, '18:00'),
      end: at(DATE, '20:00'),
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-003 (U1/U9): whole-field and subdivision reporting count the same physical time once', async () => {
    const res = await report(scheduler);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body.rows as Row[];
    const row = (id: string) => rows.find((r) => r.resourceId === id)!;
    // The pitch is two conflict units: the whole game (70 min on each) plus the half practice (70 min on north).
    expect(row(pitch.pitchId).reservedUnitHours).toBeCloseTo(3.5, 4);
    expect(row(pitch.northHalfId).reservedUnitHours).toBeCloseTo(140 / 60, 4);
    expect(row(pitch.southHalfId).reservedUnitHours).toBeCloseTo(70 / 60, 4);
    // Adding the rows would double count (7 h); the facility total sums each unit once (3.5 h).
    const sumOfRows = rows.reduce((sum, r) => sum + Number(r.reservedUnitHours), 0);
    expect(sumOfRows).toBeCloseTo(7, 4);
    expect(valueOf(res.body, 'MET-065', 'Reserved unit-hours')).toBeCloseTo(3.5, 4);
    expect(row(pitch.pitchId).reservedFieldHours).toBeCloseTo(1.75, 4);
  });

  it('SPK-REPORT-003 (U4): reserved, available, observed and closure hours are reported separately', async () => {
    const res = await report(scheduler);
    expect(res.status).toBe(200);
    const body = res.body;
    // 14 h per unit for three units (north, south, room), less the 2 h south-half closure.
    expect(valueOf(body, 'MET-064', 'Available unit-hours')).toBeCloseTo(14 * 3 - 2, 4);
    expect(valueOf(body, 'MET-068', 'Closure unit-hours')).toBeCloseTo(2, 4);
    // Buffers: 10 min on each of the three occupied unit intervals (U5).
    expect(valueOf(body, 'MET-066', 'Buffer unit-hours')).toBeCloseTo(0.5, 4);
    expect(valueOf(body, 'MET-067', 'Activity unit-hours')).toBeCloseTo(3, 4);
    expect(valueOf(body, 'MET-070', 'Utilization rate')).toBeCloseTo(3.5 / 40, 4);
    // No attendance captured yet: observed use is unavailable, never zero (G13, U7).
    const observed = body.values.find((v: { metric: string }) => v.metric === 'MET-069');
    expect(observed.value).toBeNull();
    expect(observed.unavailableReason).toMatch(/not captured/);
    expect(valueOf(body, 'MET-073', 'Reserved unit-hours: game')).toBeCloseTo(140 / 60, 4);
    expect(valueOf(body, 'MET-073', 'Reserved unit-hours: practice')).toBeCloseTo(70 / 60, 4);
    // Every response carries the metric definitions and the as-of instant (SPK-REPORT-001).
    expect(body.asOf).toBe(t.clock.now().toISOString());
    const definition = body.metrics.find((m: { metricKey: string }) => m.metricKey === 'MET-065');
    expect(definition).toMatchObject({
      grain: 'conflict unit x day',
      currency: 'none',
      accessScope: 'reporting.view_utilization',
    });
    for (const field of [
      'businessQuestion',
      'numerator',
      'denominator',
      'timeBasis',
      'freshness',
    ]) {
      expect(definition[field]).toBeTruthy();
    }
  });

  it('SPK-REPORT-003 (U3): resource-equivalent utilization discloses its weighting and refuses weighting a subdivision', async () => {
    const byUnits = await report(scheduler);
    // Default: a space weighs its conflict units (pitch 2, room 1) — only whole spaces are weighted.
    expect(valueOf(byUnits.body, 'MET-071')).toBeCloseTo((1.75 * 2) / (13 * 2 + 14 * 1), 4);
    const disclosure = (byUnits.body.disclosures as string[]).find((d) =>
      d.startsWith('Resource-equivalent'),
    );
    expect(disclosure).toContain('Pitch 1 = 2');
    expect(disclosure).toContain('Room A = 1');

    const custom = await report(scheduler, {
      weighting: 'custom',
      weights: `${pitch.pitchId}:1,${roomId}:3`,
    });
    expect(custom.status, JSON.stringify(custom.body)).toBe(200);
    expect(valueOf(custom.body, 'MET-071')).toBeCloseTo(1.75 / (13 + 14 * 3), 4);
    expect((custom.body.disclosures as string[]).join(' ')).toContain('Room A = 3');

    const subdivision = await report(scheduler, {
      weighting: 'custom',
      weights: `${pitch.northHalfId}:1`,
    });
    expect(subdivision.status).toBe(400);
    expect(subdivision.body.code).toBe('VALIDATION_FAILED');
  });

  it('SPK-REPORT-003 (U7): observed-use hours overlay reserved hours once attendance is captured', async () => {
    const playerId = await createPersonFixture(t, { kind: 'adult' });
    await createAttendanceObservationFixture(t, {
      personId: playerId,
      activity: { type: 'event', eventId: wholeEventId },
      observedState: 'present',
    });
    const res = await report(scheduler);
    // The whole-pitch game is observed: its 70 min on each of the two units.
    expect(valueOf(res.body, 'MET-069')).toBeCloseTo(140 / 60, 4);
    expect(valueOf(res.body, 'MET-065', 'Reserved unit-hours')).toBeCloseTo(3.5, 4);
  });

  it('SPK-REPORT-003 (U8) / SPK-REPORT-007: a released reservation counts only before its release, and a release after the as-of instant is ignored', async () => {
    const beforeCancel = t.clock.now();
    t.clock.advance(HOUR);
    await t.app
      .get(EventsService)
      .cancelEvent(systemPrincipal(t.organizationId, 'tests'), halfEventId, {
        reason: 'Coach unavailable',
      });
    t.clock.advance(HOUR);
    const now = await report(scheduler);
    expect(valueOf(now.body, 'MET-065', 'Reserved unit-hours')).toBeCloseTo(140 / 60, 4);
    const asOfBefore = await report(scheduler, {
      asOf: new Date(beforeCancel.getTime() + 30 * 60_000).toISOString(),
    });
    expect(asOfBefore.status, JSON.stringify(asOfBefore.body)).toBe(200);
    expect(valueOf(asOfBefore.body, 'MET-065', 'Reserved unit-hours')).toBeCloseTo(3.5, 4);
  });

  it('includeBuffers=false reports activity time as reserved time (U5)', async () => {
    const res = await report(scheduler, { includeBuffers: 'false' });
    expect(res.status).toBe(200);
    expect(valueOf(res.body, 'MET-065', 'Reserved unit-hours')).toBeCloseTo(2, 4);
    expect(valueOf(res.body, 'MET-066', 'Buffer unit-hours')).toBeCloseTo(140 / 60 - 2, 4);
  });

  it('access: utilization viewers only; facility scope applies (G2)', async () => {
    const frontDesk = await staff(t, ['front_desk']);
    expect((await report(frontDesk)).status).toBe(403);
    const finance = await staff(t, ['finance_operator']);
    expect((await report(finance)).status).toBe(200);
    const otherFacilityStaff = await staff(t, ['scheduler'], { facilityIds: [pitch.pitchId] });
    expect((await report(otherFacilityStaff)).status).toBe(403);
  });
});

describe('field utilization of closed spaces (SPK-REPORT-003, MET-064)', () => {
  let t: TestApp;
  let scheduler: Actor;
  let pitch: PitchFixture;
  let roomId: string;

  const report = (query: Record<string, string> = {}) =>
    get(t, '/v1/reports/utilization', scheduler, {
      facilityId: t.facilityId,
      from: DATE,
      to: DATE,
      ...query,
    });
  const rowOf = (body: { rows: Row[] }, resourceId: string) =>
    body.rows.find((r) => r.resourceId === resourceId)!;
  /** Changes a space's status through the scheduling API, as a scheduler would. */
  const setStatus = async (resourceId: string, status: 'active' | 'closed') => {
    const current = await get(t, `/v1/resources/${resourceId}`, scheduler);
    const res = await t.http
      .patch(`/v1/resources/${resourceId}`)
      .set(scheduler.header)
      .set('Idempotency-Key', key())
      .send({ status, expectedRevision: current.body.revision, reason: 'Space status change' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };

  beforeAll(async () => {
    t = await reportingTestApp();
    scheduler = await staff(t, ['scheduler']);
    await seedOperatingHours(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      opensAt: '08:00',
      closesAt: '22:00',
    });
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
      defaultCleanupMinutes: 10,
    });
    roomId = (
      await seedResource(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Room X',
        kind: 'room',
      })
    ).resourceId;
    // A one-hour game on the north half (70 min with its cleanup).
    await createScheduledEvent(t.app.get(EventsService), {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [pitch.northHalfId],
      start: at(DATE, '10:00'),
      end: at(DATE, '11:00'),
      kind: 'game',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-003 (MET-064): a closed space counts as closure hours, not available hours; a closed whole pitch with open subdivisions stays available', async () => {
    const reserved = 70 / 60;
    const open = await report();
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    expect(valueOf(open.body, 'MET-064', 'Available unit-hours')).toBeCloseTo(14 * 3, 4);

    // The room is closed: scheduling refuses it, so its 14 operating hours are closure hours.
    const beforeClosing = t.clock.now();
    t.clock.advance(HOUR);
    await setStatus(roomId, 'closed');
    const closed = await report();
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(valueOf(closed.body, 'MET-064', 'Available unit-hours')).toBeCloseTo(28, 4);
    expect(valueOf(closed.body, 'MET-068', 'Closure unit-hours')).toBeCloseTo(14, 4);
    expect(valueOf(closed.body, 'MET-070', 'Utilization rate')).toBeCloseTo(reserved / 28, 4);
    expect(valueOf(closed.body, 'MET-072')).toBeCloseTo(28 - reserved, 4);
    expect(rowOf(closed.body, roomId)).toMatchObject({
      availableUnitHours: 0,
      closureUnitHours: 14,
      utilizationRate: null,
    });
    expect((closed.body.disclosures as string[]).join(' ')).toContain(
      `Room X (closed from ${t.clock.now().toISOString()})`,
    );
    // As of before the change the room was open (G3): the earlier evaluation is unchanged.
    const earlier = await report({ asOf: beforeClosing.toISOString() });
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
    expect(valueOf(earlier.body, 'MET-064', 'Available unit-hours')).toBeCloseTo(42, 4);

    // A closed whole pitch whose halves are open: scheduling still books the halves.
    t.clock.advance(HOUR);
    await setStatus(pitch.pitchId, 'closed');
    const pitchClosed = await report();
    expect(valueOf(pitchClosed.body, 'MET-064', 'Available unit-hours')).toBeCloseTo(28, 4);
    expect(rowOf(pitchClosed.body, pitch.pitchId)).toMatchObject({
      availableUnitHours: 28,
      closureUnitHours: 0,
    });
    // Once the south half is closed too, its unit has no open space left; the north unit has one.
    await setStatus(pitch.southHalfId, 'closed');
    const halfClosed = await report();
    expect(valueOf(halfClosed.body, 'MET-064', 'Available unit-hours')).toBeCloseTo(14, 4);
    expect(rowOf(halfClosed.body, pitch.southHalfId)).toMatchObject({
      availableUnitHours: 0,
      closureUnitHours: 14,
    });
    expect(rowOf(halfClosed.body, pitch.northHalfId)).toMatchObject({ availableUnitHours: 14 });

    // Reopened before the day: closed only while it was closed, so the day is available again.
    t.clock.advance(HOUR);
    const whileClosed = t.clock.now();
    t.clock.advance(HOUR);
    await setStatus(roomId, 'active');
    const reopened = await report();
    expect(valueOf(reopened.body, 'MET-064', 'Available unit-hours')).toBeCloseTo(28, 4);
    expect(rowOf(reopened.body, roomId)).toMatchObject({ availableUnitHours: 14 });
    const asClosed = await report({ asOf: whileClosed.toISOString() });
    expect(rowOf(asClosed.body, roomId)).toMatchObject({ availableUnitHours: 0 });
  });
});
