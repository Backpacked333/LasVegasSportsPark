import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { at } from '../../scheduling';
import { createAssignmentFixture } from '../../workforce';
import {
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
 * Offline reconciliation (§4.15, SPK-AT-018): reused batch ids, uploads that arrive out of order,
 * the authority a queued release needs, and authority checked at the recorded handover time.
 * The device reconnects at 11:30; its roster snapshot was taken at 09:00. The annex facility has
 * an approved manual outage procedure (OUTAGE-PROC-1); the main facility has none.
 */
describe('offline reconciliation (§4.15, SPK-AT-018)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let fam: Family;
  let p: Program;
  let annex: string;
  let annexProgram: Program;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
    p = await program(t, manager);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    annex = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: annex,
        organization_id: t.organizationId,
        slug: `annex-${annex}`,
        name: 'Annex',
        timezone: 'America/Los_Angeles',
        settings: json({ entry: { approvedOutageProcedures: ['OUTAGE-PROC-1'] } }),
      })
      .execute();
    annexProgram = await program(t, manager, { facilityId: annex });
    await enroll(t, annexProgram, fam.childA, fam.guardian.personId);
    t.clock.set(at(TODAY, '11:30'));
  });
  afterAll(async () => {
    await t.close();
  });

  const snapshot = { reference: 'roster-0900', takenAt: at(TODAY, '09:00') };
  const sync = (actor: Actor, body: object) => post(t, '/v1/offline-sync', actor, body);
  const batch = (
    deviceId: string,
    facilityId: string,
    items: object[],
    clientBatchId = newId(),
  ) => ({
    deviceId,
    clientBatchId,
    facilityId,
    snapshot,
    items,
  });
  const attendance = (personId: string, time = '10:05') => ({
    kind: 'attendance',
    clientObservationId: newId(),
    observedAt: at(TODAY, time),
    personId,
    activity: sessionRef(p),
    observedState: 'present',
  });
  const arrival = (personId: string, time: string, visitorCategory = 'spectator') => ({
    kind: 'arrival',
    clientObservationId: newId(),
    observedAt: at(TODAY, time),
    personId,
    visitorCategory,
  });
  const departure = (personId: string, time: string) => ({
    kind: 'departure',
    clientObservationId: newId(),
    observedAt: at(TODAY, time),
    personId,
  });
  const release = (
    childPersonId: string,
    collectorPersonId: string,
    time = '11:00',
    extra: object = {},
  ) => ({
    kind: 'release',
    clientObservationId: newId(),
    observedAt: at(TODAY, time),
    childPersonId,
    collector: { personId: collectorPersonId },
    manualProcedureReference: 'OUTAGE-PROC-1',
    ...extra,
  });
  /** A child with a guardian who has held every permission since 08:00. */
  const childWithGuardian = async () => {
    const child = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, {
      actorPersonId: fam.guardian.personId,
      subjectPersonId: child,
      effectiveFrom: new Date(at(TODAY, '08:00')),
    });
    return child;
  };
  const visitsOf = (personId: string) =>
    t.db
      .selectFrom('visits')
      .selectAll()
      .where('person_id', '=', personId)
      .orderBy('arrived_at')
      .execute();

  it('§4.9 / SPK-AT-018 / §4.14: a client batch id reused for different contents is a conflict that records nothing and reveals nothing', async () => {
    const clientBatchId = newId();
    const a = attendance(fam.childA, '10:05');
    const b = attendance(fam.guardian.personId, '10:06');
    const first = await sync(desk, batch('tab-reuse', t.facilityId, [a], clientBatchId));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const stored = async (item: { clientObservationId: string }) =>
      t.db
        .selectFrom('attendance_observations')
        .select('id')
        .where('client_observation_id', '=', item.clientObservationId)
        .execute();

    // Different items, and the original items with one appended: a conflict, nothing recorded.
    for (const items of [[b], [a, b]]) {
      const reused = await sync(desk, batch('tab-reuse', t.facilityId, items, clientBatchId));
      expect(reused.status, JSON.stringify(reused.body)).toBe(409);
      expect(reused.body.details).toMatchObject({ code: 'batch_id_reused', clientBatchId });
      expect(await stored(b)).toHaveLength(0);
    }
    // The same contents under a new idempotency key replay the stored outcome.
    const same = await sync(desk, batch('tab-reuse', t.facilityId, [a], clientBatchId));
    expect(same.status).toBe(201);
    expect(same.body).toMatchObject({ id: first.body.id, replayed: true });
    // The new items under a new client batch id: the old one is a duplicate, the new one lands.
    const rebatched = await sync(desk, batch('tab-reuse', t.facilityId, [a, b]));
    expect(rebatched.body.items.map((i: { outcome: string }) => i.outcome)).toEqual([
      'duplicate',
      'accepted',
    ]);
    expect(await stored(b)).toHaveLength(1);

    // Staff of another facility naming this device and batch id learn nothing about it.
    const annexDesk = await staffMember(t, ['front_desk'], { facilityIds: [annex] });
    const foreign = await sync(annexDesk, batch('tab-reuse', annex, [a], clientBatchId));
    expect(foreign.status).toBe(409);
    expect(foreign.body.details).toMatchObject({ code: 'batch_id_reused' });
    expect(JSON.stringify(foreign.body)).not.toContain(first.body.id);
    expect(foreign.body.items).toBeUndefined();
  });

  it('§4.15 / SPK-AT-018: a departure synchronized before its arrival is held for review and closes the visit when the arrival synchronizes; replays and re-sends record it once', async () => {
    const adult = await createPersonFixture(t, { kind: 'adult' });
    // The exit tablet reconnects first.
    const left = departure(adult, '10:30');
    const exitBody = batch('exit-tablet', t.facilityId, [left]);
    const exit = await sync(desk, exitBody);
    expect(exit.status, JSON.stringify(exit.body)).toBe(201);
    expect(exit.body.items[0]).toMatchObject({ outcome: 'rejected', reason: 'no_open_visit' });
    expect(exit.body.exceptionIds).toHaveLength(1);
    const held = (await exceptionsOf(t, 'entry.offline_departure_unmatched')).find(
      (e) => e.id === exit.body.exceptionIds[0],
    );
    expect(held).toMatchObject({ status: 'open', facility_id: t.facilityId });
    expect(held?.details).toMatchObject({
      personId: adult,
      observedAt: at(TODAY, '10:30'),
      deviceId: 'exit-tablet',
      clientObservationId: left.clientObservationId,
      batchId: exit.body.id,
    });

    // The entrance tablet's arrival closes the visit at the departure's observed time.
    const entrance = await sync(
      desk,
      batch('entrance-tablet', t.facilityId, [arrival(adult, '09:30')]),
    );
    expect(entrance.body.items[0]).toMatchObject({
      outcome: 'accepted',
      flags: ['closed_by_earlier_synced_departure'],
    });
    const [visit] = await visitsOf(adult);
    expect(visit).toMatchObject({ status: 'departed' });
    expect(new Date(visit!.departed_at!).toISOString()).toBe(at(TODAY, '10:30'));
    const departures = await t.db
      .selectFrom('departures')
      .selectAll()
      .where('person_id', '=', adult)
      .execute();
    expect(departures).toHaveLength(1);
    expect(departures[0]).toMatchObject({
      visit_id: visit!.id,
      source: 'offline_sync',
      device_id: 'exit-tablet',
      client_observation_id: left.clientObservationId,
      sync_batch_id: exit.body.id,
    });

    // Replaying the exit batch returns its stored outcome; re-sending the item is a duplicate.
    const replay = await sync(desk, exitBody);
    expect(replay.body).toMatchObject({ id: exit.body.id, replayed: true });
    const resent = await sync(desk, batch('exit-tablet', t.facilityId, [left]));
    expect(resent.body.items[0]).toMatchObject({
      outcome: 'duplicate',
      recordId: departures[0]!.id,
    });
    // The next day's arrival is not swallowed by a stale open visit.
    const again = await post(t, '/v1/visits', desk, {
      facilityId: t.facilityId,
      arrivals: [{ personId: adult, visitorCategory: 'spectator' }],
    });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('SPK-ENTRY-007 / §4.7 invariant 12: a child participant departure synchronized before the arrival never closes the visit; a critical follow-up is raised', async () => {
    const child = await childWithGuardian();
    const left = departure(child, '10:30');
    const exit = await sync(desk, batch('exit-child', t.facilityId, [left]));
    expect(exit.body.items[0]).toMatchObject({ outcome: 'rejected', reason: 'no_open_visit' });
    const entrance = await sync(
      desk,
      batch('entrance-child', t.facilityId, [arrival(child, '09:30', 'participant')]),
    );
    expect(entrance.body.items[0]).toMatchObject({ outcome: 'accepted', flags: [] });
    const [visit] = await visitsOf(child);
    expect(visit!.status).toBe('on_site');
    const critical = (await exceptionsOf(t, 'entry.offline_release_unrecorded')).filter((e) =>
      entrance.body.exceptionIds.includes(e.id),
    );
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({ severity: 'critical', affected_id: child });
    expect(critical[0]!.details).toMatchObject({
      deviceId: 'exit-child',
      clientObservationId: left.clientObservationId,
      reason: 'release_required',
      visitId: visit!.id,
    });
  });

  it('§4.15: a release synchronized before the child arrival closes the visit through the release; an arrival observed after the release stays on site', async () => {
    const child = await childWithGuardian();
    const released = await sync(
      desk,
      batch('annex-exit', annex, [release(child, fam.guardian.personId)]),
    );
    expect(released.body.items[0]).toMatchObject({ outcome: 'accepted' });
    const releaseId = released.body.items[0].recordId as string;
    const arrived = await sync(
      desk,
      batch('annex-entrance', annex, [arrival(child, '09:30', 'participant')]),
    );
    expect(arrived.body.items[0]).toMatchObject({
      outcome: 'accepted',
      flags: ['closed_by_earlier_synced_release'],
    });
    const [visit] = await visitsOf(child);
    expect(visit!.status).toBe('departed');
    const closing = await t.db
      .selectFrom('departures')
      .select(['source', 'release_record_id'])
      .where('visit_id', '=', visit!.id)
      .executeTakeFirstOrThrow();
    expect(closing).toEqual({ source: 'release', release_record_id: releaseId });

    // Negative: the child came back after the release; that visit is not closed by it.
    const later = await childWithGuardian();
    await sync(desk, batch('annex-exit', annex, [release(later, fam.guardian.personId, '10:40')]));
    const back = await sync(
      desk,
      batch('annex-entrance', annex, [arrival(later, '10:50', 'participant')]),
    );
    expect(back.body.items[0]).toMatchObject({ outcome: 'accepted', flags: [] });
    const [open] = await visitsOf(later);
    expect(open!.status).toBe('on_site');
  });

  it('SPK-AT-018 / SPK-ENTRY-007: authority that began after an offline release is not asserted as held', async () => {
    // A: a delegate whose collect grant takes effect at 11:15 (the child left at 11:00).
    const a = await createPersonFixture(t, { kind: 'child' });
    const futureDelegate = await createPersonFixture(t, { kind: 'adult' });
    await createRelationshipFixture(t, {
      actorPersonId: futureDelegate,
      subjectPersonId: a,
      kind: 'delegate',
      permissions: ['collect'],
      effectiveFrom: new Date(at(TODAY, '11:15')),
    });
    // B: a guardian under a temporary restriction 10:00-11:15 (in force at the handover).
    const b = await createPersonFixture(t, { kind: 'child' });
    const restrictedGuardian = await createPersonFixture(t, { kind: 'adult' });
    await createRelationshipFixture(t, {
      actorPersonId: restrictedGuardian,
      subjectPersonId: b,
      permissions: ['view', 'collect'],
      effectiveFrom: new Date(at(TODAY, '08:00')),
    });
    t.clock.set(at(TODAY, '10:00'));
    const support = await staffMember(t, ['support_operator']);
    const review = await post(t, '/v1/access-reviews', support, {
      subjectPersonId: b,
      reason: 'pickup dispute pending a call back',
    });
    expect(review.status, JSON.stringify(review.body)).toBe(201);
    const restricted = await post(t, `/v1/access-reviews/${review.body.id}/decisions`, support, {
      kind: 'restrict',
      actorPersonId: restrictedGuardian,
      effectiveTo: at(TODAY, '11:15'),
    });
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(201);
    // C: a grant created at 11:20, after the handover.
    const c = await createPersonFixture(t, { kind: 'child' });
    const latecomer = await createPersonFixture(t, { kind: 'adult' });
    t.clock.set(at(TODAY, '11:20'));
    await createRelationshipFixture(t, {
      actorPersonId: latecomer,
      subjectPersonId: c,
      kind: 'delegate',
      permissions: ['collect'],
    });
    // D (control): a guardian who held collect throughout.
    const d = await childWithGuardian();
    t.clock.set(at(TODAY, '11:30'));

    const res = await sync(
      desk,
      batch('annex-asof', annex, [
        release(a, futureDelegate),
        release(b, restrictedGuardian),
        release(c, latecomer),
        release(d, fam.guardian.personId),
      ]),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [ra, rb, rc, rd] = res.body.items;
    for (const item of [ra, rb, rc]) {
      expect(item).toMatchObject({
        outcome: 'accepted_with_conflict',
        reason: 'authority_not_held_at_release',
      });
    }
    expect(rd).toMatchObject({ outcome: 'accepted', reason: null });
    const rows = await t.db
      .selectFrom('release_records')
      .selectAll()
      .where('sync_batch_id', '=', res.body.id)
      .execute();
    const byChild = new Map(rows.map((r) => [r.child_person_id, r]));
    const critical = await exceptionsOf(t, 'entry.offline_release_unverified');
    for (const child of [a, b, c]) {
      const row = byChild.get(child)!;
      expect(row).toMatchObject({ post_sync_authority: 'not_held', outcome: 'released' });
      expect(row.collector_permissions).toContain('collect');
      expect(row.denial_reason).toMatch(/at the recorded release time/);
      expect(critical.find((e) => e.id === row.escalation_exception_id)).toMatchObject({
        severity: 'critical',
        affected_id: row.id,
      });
    }
    expect(byChild.get(d)).toMatchObject({
      post_sync_authority: 'held',
      escalation_exception_id: null,
    });
  });

  it('§4.11 / SPK-ENTRY-007: a queued release needs the online release authority — an official or a desk role without record_release is refused, a coach releases only a child of the assigned activity', async () => {
    const official = await staffMember(t, ['official']);
    const coach = await staffMember(t, ['coach']);
    for (const [person, kind] of [
      [official, 'official'],
      [coach, 'coach'],
    ] as const) {
      await createAssignmentFixture(t, {
        targetType: 'session',
        targetId: annexProgram.sessionId,
        offeringId: annexProgram.offering.offeringId,
        personId: person.personId,
        kind,
        role: kind === 'coach' ? 'head_coach' : 'referee',
        status: 'accepted',
        scheduledStart: annexProgram.start,
        scheduledEnd: annexProgram.end,
        facilityId: annex,
      });
    }
    const leagueManager = await staffMember(t, ['league_manager']);
    const fromSession = { activity: sessionRef(annexProgram) };
    // Online, an official and a league manager may not record a release at all.
    const online = await post(t, '/v1/releases', official, {
      facilityId: annex,
      childPersonId: fam.childA,
      collector: { personId: fam.guardian.personId },
      activity: sessionRef(annexProgram),
      recordDeparture: false,
    });
    expect(online.status).toBe(403);
    for (const actor of [official, leagueManager]) {
      const res = await sync(
        actor,
        batch(`phone-${actor.personId}`, annex, [
          release(fam.childA, fam.guardian.personId, '11:00', fromSession),
        ]),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.items[0]).toMatchObject({ outcome: 'rejected', reason: 'not_permitted' });
      // The handover the device saw is still followed up.
      const raised = (await exceptionsOf(t, 'entry.offline_release_unrecorded')).filter((e) =>
        res.body.exceptionIds.includes(e.id),
      );
      expect(raised).toHaveLength(1);
    }

    // The coach: a child of the assigned session is released; another child is not in it.
    const outsider = await childWithGuardian();
    await sync(desk, batch('annex-desk', annex, [arrival(outsider, '09:30', 'participant')]));
    const coached = await sync(
      coach,
      batch('coach-phone', annex, [
        release(fam.childA, fam.guardian.personId, '11:00', fromSession),
        release(outsider, fam.guardian.personId, '11:01', fromSession),
      ]),
    );
    expect(coached.status, JSON.stringify(coached.body)).toBe(201);
    expect(
      coached.body.items.map(
        (i: { outcome: string; reason: string | null }) => `${i.outcome}:${i.reason}`,
      ),
    ).toEqual(['accepted:null', 'rejected:not_in_activity']);
    const [outsiderVisit] = await visitsOf(outsider);
    expect(outsiderVisit!.status).toBe('on_site');
    const outsiderReleases = await t.db
      .selectFrom('release_records')
      .select('id')
      .where('child_person_id', '=', outsider)
      .execute();
    expect(outsiderReleases).toHaveLength(0);
  });
});
