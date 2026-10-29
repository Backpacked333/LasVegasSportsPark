import { newId, systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { CatalogEvents } from '../../catalog';
import { createPersonFixture, IdentityEvents } from '../../identity';
import {
  at,
  createScheduledEvent,
  EventsService,
  personCommitment,
  seedPitchWithHalves,
} from '../../scheduling';
import { createVisitFixture } from '../testing/entry-fixtures';
import {
  adultCustomer,
  drainOutbox,
  enroll,
  entryTestApp,
  exceptionsOf,
  family,
  post,
  program,
  sessionRef,
  staffMember,
  TODAY,
  type Actor,
  type Family,
  type Program,
} from './support';

/**
 * ENT-03 (§4.6, §4.12, SPK-ENTRY-003, SPK-AT-009) and ENT-04 (SPK-IAM-007, SPK-ENTRY-002): entry
 * follows other modules' facts — canceled activities, corrections that resolve conflicts,
 * reordered offline uploads and person merges — changing only its own records.
 */
describe('entry follow-ups (ENT-03, ENT-04)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let fam: Family;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
  });
  afterAll(async () => {
    await t.close();
  });

  const checkinRows = (activityId: string) =>
    t.db
      .selectFrom('session_checkins')
      .selectAll()
      .where('activity_id', '=', activityId)
      .orderBy('person_id')
      .execute();
  const checkinEvents = async (checkinIds: string[]) =>
    (
      await t.db
        .selectFrom('outbox_events')
        .select(['aggregate_id', 'payload'])
        .where('event_type', '=', 'entry.session_checkin_changed')
        .where('aggregate_id', 'in', checkinIds)
        .execute()
    ).map((e) => ({ id: e.aggregate_id, status: (e.payload as { status: string }).status }));
  const arrive = async (personId: string) => {
    const res = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId, visitorCategory: 'participant' }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.visits[0].id as string;
  };

  describe('canceled activities (ENT-03)', () => {
    let p: Program;
    let visitIds: string[];

    beforeAll(async () => {
      p = await program(t, manager, { from: '10:00', to: '11:00' });
      await enroll(t, p, fam.childA, fam.guardian.personId);
      // childB has not acknowledged the form: held.
      await enroll(t, p, fam.childB, fam.guardian.personId, { acknowledge: false });
      visitIds = [await arrive(fam.childA), await arrive(fam.childB)];
      for (const child of [fam.childA, fam.childB]) {
        const res = await post(t, '/v1/session-checkins', desk, {
          personId: child,
          activity: sessionRef(p),
        });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
      }
      expect((await checkinRows(p.sessionId)).map((c) => c.status).sort()).toEqual([
        'admitted',
        'held',
      ]);
    });

    it('a canceled session withdraws its live check-ins once and leaves visits open', async () => {
      const canceled = await post(t, `/v1/sessions/${p.sessionId}/cancel`, manager, {
        reason: 'Pitch flooded',
      });
      expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
      await drainOutbox(t);
      const rows = await checkinRows(p.sessionId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'withdrawn',
          withdrawn_reason: 'activity_canceled',
          revision: 2,
        });
      }
      // Visits stay open: the children are still on site and leave through a release.
      const visits = await t.db
        .selectFrom('visits')
        .select('status')
        .where('id', 'in', visitIds)
        .execute();
      expect(visits.map((v) => v.status)).toEqual(['on_site', 'on_site']);
      // Audited as the system; one withdrawal event per check-in.
      const audit = await t.db
        .selectFrom('audit_records')
        .select(['actor', 'details'])
        .where('target_type', '=', 'session_checkin')
        .where(
          'target_id',
          'in',
          rows.map((r) => r.id),
        )
        .where('reason', '=', 'activity_canceled')
        .execute();
      expect(audit).toHaveLength(2);
      for (const record of audit) {
        expect(record.actor).toMatchObject({ kind: 'system' });
      }
      const events = await checkinEvents(rows.map((r) => r.id));
      expect(events.filter((e) => e.status === 'withdrawn')).toHaveLength(2);
    });

    it('a replayed cancellation event changes nothing', async () => {
      const before = await checkinRows(p.sessionId);
      // The same fact announced again (a redelivery under a new event id).
      await t.app.get(UnitOfWork).run(async ({ trx }) => {
        await t.app.get(Outbox).enqueue(trx, CatalogEvents.sessionCanceled, {
          organizationId: t.organizationId,
          aggregateType: 'offering',
          aggregateId: p.offering.offeringId,
          payload: {
            sessionId: p.sessionId,
            offeringId: p.offering.offeringId,
            sequence: 1,
            schedulingEventId: null,
            reason: 'Pitch flooded',
          },
          correlationId: null,
        });
      });
      await drainOutbox(t);
      expect(await checkinRows(p.sessionId)).toEqual(before);
      const events = await checkinEvents(before.map((r) => r.id));
      expect(events.filter((e) => e.status === 'withdrawn')).toHaveLength(2);
    });

    it('a canceled scheduling event withdraws its live check-ins; other changes leave them', async () => {
      const pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
      });
      const player = await createPersonFixture(t, { kind: 'adult' });
      const events = t.app.get(EventsService);
      const event = await createScheduledEvent(events, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        start: at(TODAY, '13:00'),
        end: at(TODAY, '14:00'),
        kind: 'practice',
        sourceType: 'program',
        commitments: [personCommitment(player, 'participant')],
      });
      await arrive(player);
      const checkin = await post(t, '/v1/session-checkins', desk, {
        personId: player,
        activity: { type: 'event', eventId: event.id },
      });
      expect(checkin.status, JSON.stringify(checkin.body)).toBe(201);
      expect(checkin.body.status).toBe('admitted');
      await drainOutbox(t);
      expect((await checkinRows(event.id))[0]!.status).toBe('admitted');
      await events.cancelEvent(systemPrincipal(t.organizationId, 'test'), event.id, {
        reason: 'Lightning',
      });
      await drainOutbox(t);
      expect(await checkinRows(event.id)).toEqual([
        expect.objectContaining({ status: 'withdrawn', withdrawn_reason: 'activity_canceled' }),
      ]);
    });
  });

  it('ENT-03 / SPK-ENTRY-005: a correction that resolves an attendance conflict resolves its review exception', async () => {
    const p = await program(t, manager, { from: '10:00', to: '11:30' });
    const child = await createPersonFixture(t, { kind: 'child' });
    await enroll(t, p, child, fam.guardian.personId);
    const observe = (observedState: string) =>
      post(t, '/v1/attendance-observations', desk, {
        personId: child,
        activity: sessionRef(p),
        observedState,
      });
    const present = await observe('present');
    const absent = await observe('absent');
    expect(absent.body.conflict).not.toBeNull();
    const exceptionId = absent.body.conflict.exceptionId as string;
    const reviewOf = async () =>
      (await exceptionsOf(t, 'entry.attendance_conflict')).find((e) => e.id === exceptionId)!;
    expect((await reviewOf()).status).toBe('open');
    // A third, agreeing observation resolves nothing: the absent head still disagrees.
    await observe('late');
    expect((await reviewOf()).status).toBe('open');
    // Correcting the absent observation leaves the heads agreeing: the review is resolved.
    const corrected = await post(
      t,
      `/v1/attendance-observations/${absent.body.observation.id}/corrections`,
      desk,
      { observedState: 'present', reason: 'Coach confirmed the child played' },
    );
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(201);
    expect(corrected.body.conflict).toBeNull();
    const resolved = await reviewOf();
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolution: {
        resolvedByObservationId: corrected.body.observation.id,
        effectiveState: 'present',
      },
    });
    expect(present.body.observation.id).toBeDefined();
    const history = await t.db
      .selectFrom('audit_records')
      .select(['action', 'actor'])
      .where('target_id', '=', exceptionId)
      .execute();
    expect(history).toEqual([
      expect.objectContaining({
        action: 'exceptions.resolved',
        actor: expect.objectContaining({ kind: 'system' }),
      }),
    ]);
  });

  it('§4.15 / ENT-03: an arrival that closes an offline-departure gap resolves entry.offline_departure_unmatched', async () => {
    t.clock.set(at(TODAY, '12:30'));
    const visitor = await createPersonFixture(t, { kind: 'adult' });
    const batch = (items: unknown[]) =>
      post(t, '/v1/offline-sync', desk, {
        deviceId: 'gate-tablet',
        clientBatchId: newId(),
        facilityId: t.facilityId,
        snapshot: { reference: 'roster-1200', takenAt: at(TODAY, '12:00') },
        items,
      });
    // The exit tablet reconnects first: the departure has no open visit yet.
    const exit = await batch([
      {
        kind: 'departure',
        clientObservationId: newId(),
        observedAt: at(TODAY, '12:20'),
        personId: visitor,
      },
    ]);
    expect(exit.status, JSON.stringify(exit.body)).toBe(201);
    expect(exit.body.items[0]).toMatchObject({ outcome: 'rejected', reason: 'no_open_visit' });
    const held = (await exceptionsOf(t, 'entry.offline_departure_unmatched')).filter(
      (e) => (e.details as { personId?: string }).personId === visitor,
    );
    expect(held).toHaveLength(1);
    expect(held[0]!.status).toBe('open');
    // The entrance tablet's arrival arrives: the visit closes and the review is resolved.
    const entrance = await batch([
      {
        kind: 'arrival',
        clientObservationId: newId(),
        observedAt: at(TODAY, '12:05'),
        personId: visitor,
        visitorCategory: 'guardian',
      },
    ]);
    expect(entrance.body.items[0]).toMatchObject({
      outcome: 'accepted',
      flags: ['closed_by_earlier_synced_departure'],
    });
    const after = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('id', '=', held[0]!.id)
      .executeTakeFirstOrThrow();
    expect(after).toMatchObject({
      status: 'resolved',
      resolution: { closedBy: 'arrival_synchronized' },
    });
  });

  describe('person merges (ENT-04)', () => {
    let admin: Actor;
    let support: Actor;

    beforeAll(async () => {
      admin = await staffMember(t, ['system_administrator']);
      support = await staffMember(t, ['support_operator']);
    });

    const merge = async (survivorPersonId: string, mergedPersonId: string) => {
      const flagged = await post(t, '/v1/duplicate-candidates', support, {
        personAId: survivorPersonId,
        personBId: mergedPersonId,
        reasons: ['same name and birthday'],
        score: 90,
      });
      expect(flagged.status, JSON.stringify(flagged.body)).toBe(201);
      const merged = await post(t, `/v1/duplicate-candidates/${flagged.body.id}/merge`, admin, {
        survivorPersonId,
        reason: 'Confirmed by phone',
      });
      expect(merged.status, JSON.stringify(merged.body)).toBe(201);
      await drainOutbox(t);
      return merged.body.id as string;
    };

    it('SPK-IAM-007: a merge leaving two active passes raises one front-desk exception and revokes nothing', async () => {
      const survivor = await adultCustomer(t);
      const duplicate = await adultCustomer(t);
      const passes: string[] = [];
      for (const holder of [survivor, duplicate]) {
        const res = await post(t, '/v1/passes', holder, {
          holder: { kind: 'person', personId: holder.personId },
        });
        expect(res.status).toBe(201);
        passes.push(res.body.pass.id as string);
      }
      const mergeId = await merge(survivor.personId, duplicate.personId);
      const raised = (await exceptionsOf(t, 'entry.merged_duplicate_pass')).filter(
        (e) => e.affected_id === mergeId,
      );
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({
        owner_queue: 'front_desk',
        status: 'open',
        details: expect.objectContaining({
          survivorPersonId: survivor.personId,
          mergedPersonId: duplicate.personId,
          passIds: expect.arrayContaining(passes),
        }),
      });
      const stored = await t.db
        .selectFrom('passes')
        .select(['id', 'status', 'holder_person_id'])
        .where('id', 'in', passes)
        .execute();
      // Nothing is revoked, and the merged person's pass keeps its original holder.
      expect(stored.map((s) => s.status)).toEqual(['active', 'active']);
      expect(stored.find((s) => s.id === passes[1])!.holder_person_id).toBe(duplicate.personId);
      // The same merge announced again raises nothing more.
      await t.app.get(UnitOfWork).run(async ({ trx }) => {
        await t.app.get(Outbox).enqueue(trx, IdentityEvents.personsMerged, {
          organizationId: t.organizationId,
          aggregateType: 'person',
          aggregateId: survivor.personId,
          payload: {
            mergeId,
            survivorPersonId: survivor.personId,
            mergedPersonId: duplicate.personId,
            operationId: newId(),
          },
          correlationId: null,
        });
      });
      await drainOutbox(t);
      expect(
        (await exceptionsOf(t, 'entry.merged_duplicate_pass')).filter(
          (e) => e.affected_id === mergeId,
        ),
      ).toHaveLength(1);
      // The survivor now lists both passes (the merged one under its original holder).
      const mine = await t.http.get('/v1/me/passes').set(survivor.header);
      expect(mine.body.map((x: { id: string }) => x.id).sort()).toEqual([...passes].sort());
    });

    it('a merge where only one person holds a pass raises nothing', async () => {
      const survivor = await adultCustomer(t);
      const duplicate = await createPersonFixture(t, { kind: 'adult' });
      await post(t, '/v1/passes', desk, {
        holder: { kind: 'person', personId: duplicate },
      });
      const mergeId = await merge(survivor.personId, duplicate);
      expect(
        (await exceptionsOf(t, 'entry.merged_duplicate_pass')).filter(
          (e) => e.affected_id === mergeId,
        ),
      ).toEqual([]);
    });

    it('the survivor’s visit history includes the merged person’s visits', async () => {
      const survivor = await createPersonFixture(t, { kind: 'adult', givenName: 'Sam' });
      const duplicate = await createPersonFixture(t, { kind: 'adult', givenName: 'Sam' });
      const earlier = await createVisitFixture(t, {
        personId: duplicate,
        visitorCategory: 'guardian',
        arrivedAt: new Date(at('2027-01-09', '09:00')),
      });
      const today = await createVisitFixture(t, {
        personId: survivor,
        visitorCategory: 'guardian',
      });
      // An attendance observation recorded under the duplicate.
      const p = await program(t, manager, { from: '10:00', to: '11:45' });
      await enroll(t, p, duplicate, duplicate);
      const observed = await post(t, '/v1/attendance-observations', desk, {
        personId: duplicate,
        activity: sessionRef(p),
        observedState: 'present',
      });
      expect(observed.status, JSON.stringify(observed.body)).toBe(201);
      await merge(survivor, duplicate);

      const history = await t.http
        .get(`/v1/visits?facilityId=${t.facilityId}&personId=${survivor}`)
        .set(desk.header);
      expect(history.status, JSON.stringify(history.body)).toBe(200);
      expect(history.body.items.map((v: { id: string }) => v.id)).toEqual([earlier, today]);
      // Rows keep the person id they were recorded under (append-only facts are never rewritten).
      expect(history.body.items.map((v: { personId: string }) => v.personId)).toEqual([
        duplicate,
        survivor,
      ]);
      // The merged id reads only its own rows; a facility day still filters by date.
      const old = await t.http
        .get(`/v1/visits?facilityId=${t.facilityId}&personId=${duplicate}`)
        .set(desk.header);
      expect(old.body.items.map((v: { id: string }) => v.id)).toEqual([earlier]);
      const day = await t.http
        .get(`/v1/visits?facilityId=${t.facilityId}&personId=${survivor}&date=${TODAY}`)
        .set(desk.header);
      expect(day.body.items.map((v: { id: string }) => v.id)).toEqual([today]);

      const attendance = await t.http
        .get(
          `/v1/attendance?activityType=session&activityId=${p.sessionId}&offeringId=${p.offering.offeringId}&personId=${survivor}`,
        )
        .set(desk.header);
      expect(attendance.status, JSON.stringify(attendance.body)).toBe(200);
      expect(attendance.body.people).toEqual([
        expect.objectContaining({
          personId: survivor,
          givenName: 'Sam',
          effectiveState: 'present',
          history: [expect.objectContaining({ personId: duplicate })],
        }),
      ]);
    });
  });
});
