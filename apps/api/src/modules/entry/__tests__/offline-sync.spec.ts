import { newId } from '@sportspark/contracts';
import { json, seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createRelationshipFixture } from '../../identity';
import { at } from '../../scheduling';
import {
  adultCustomer,
  enroll,
  entryTestApp,
  exceptionsOf,
  family,
  key,
  post,
  program,
  sessionRef,
  staffMember,
  TODAY,
  type Actor,
  type Family,
  type Program,
} from './support';

describe('offline synchronization (§4.15, SPK-AT-018)', () => {
  let t: TestApp;
  let desk: Actor;
  let manager: Actor;
  let fam: Family;
  let p: Program;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
    p = await program(t, manager);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    await enroll(t, p, fam.childB, fam.guardian.personId);
    // The device reconnects at 11:30; its roster snapshot was taken at 09:00.
    t.clock.set(at(TODAY, '11:30'));
  });
  afterAll(async () => {
    await t.close();
  });

  const snapshot = (takenAt = at(TODAY, '09:00')) => ({ reference: `roster-${takenAt}`, takenAt });
  const attendance = (personId: string, observedState: string, time = '10:05') => ({
    kind: 'attendance',
    clientObservationId: newId(),
    observedAt: at(TODAY, time),
    personId,
    activity: sessionRef(p),
    observedState,
  });

  it('SPK-AT-018: a batch synchronized twice is recorded once, however it is resent', async () => {
    const items = [
      {
        kind: 'arrival',
        clientObservationId: newId(),
        observedAt: at(TODAY, '09:50'),
        personId: fam.childA,
        visitorCategory: 'participant',
      },
      attendance(fam.childA, 'present'),
      attendance(fam.childB, 'absent'),
    ];
    const body = {
      deviceId: 'tablet-1',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items,
    };
    const idem = key();
    const first = await post(t, '/v1/offline-sync', desk, body, idem);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      replayed: false,
      stale: false,
      counts: { items: 3, accepted: 3, acceptedWithConflict: 0, duplicate: 0, rejected: 0 },
      snapshotAgeSeconds: 2.5 * 3600,
      maxRosterAgeMinutes: 120,
      receivedAt: t.clock.now().toISOString(),
    });
    const observations = await t.db
      .selectFrom('attendance_observations')
      .selectAll()
      .where('sync_batch_id', '=', first.body.id)
      .execute();
    expect(observations).toHaveLength(2);
    for (const row of observations) {
      // §4.15: unique id, actor, event, observed time, snapshot reference and received time.
      expect(row).toMatchObject({
        source: 'offline_sync',
        device_id: 'tablet-1',
        snapshot_reference: body.snapshot.reference,
        recorded_by_person_id: desk.personId,
      });
      expect(row.client_observation_id).not.toBeNull();
      expect(new Date(row.received_at).toISOString()).toBe(t.clock.now().toISOString());
      expect(new Date(row.observed_at).toISOString()).toBe(at(TODAY, '10:05'));
    }
    const operation = await t.http.get(`/v1/operations/${first.body.operationId}`).set(desk.header);
    expect(operation.body).toMatchObject({ kind: 'entry.offline_sync', status: 'succeeded' });

    // 1. The same request again (lost acknowledgement, same key): the stored response.
    const sameKey = await post(t, '/v1/offline-sync', desk, body, idem);
    expect(sameKey.headers['idempotent-replayed']).toBe('true');
    expect(sameKey.body).toEqual(first.body);
    // 2. The same batch under a new key: the stored outcome, marked replayed.
    const newKey = await post(t, '/v1/offline-sync', desk, body);
    expect(newKey.status).toBe(201);
    expect(newKey.body).toMatchObject({ id: first.body.id, replayed: true });
    expect(newKey.body.items).toEqual(first.body.items);
    // 3. The same items in a new batch: every item is a duplicate.
    const rebatched = await post(t, '/v1/offline-sync', desk, { ...body, clientBatchId: newId() });
    expect(rebatched.body.counts).toMatchObject({ duplicate: 3, accepted: 0 });
    expect(rebatched.body.items.map((i: { recordId: string }) => i.recordId)).toEqual(
      first.body.items.map((i: { recordId: string }) => i.recordId),
    );
    const total = await t.db
      .selectFrom('attendance_observations')
      .select('id')
      .where('device_id', '=', 'tablet-1')
      .execute();
    expect(total).toHaveLength(2);
    const visits = await t.db
      .selectFrom('visits')
      .select('id')
      .where('person_id', '=', fam.childA)
      .execute();
    expect(visits).toHaveLength(1);
  });

  it('SPK-AT-018: two devices racing to upload the same batch record it once (true concurrency under PostgreSQL)', async () => {
    const body = {
      deviceId: 'tablet-race',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items: [
        attendance(fam.childA, 'present', '10:15'),
        attendance(fam.childB, 'present', '10:15'),
      ],
    };
    const [a, b] = await Promise.all([
      post(t, '/v1/offline-sync', desk, body),
      post(t, '/v1/offline-sync', desk, body),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    const batches = await t.db
      .selectFrom('offline_sync_batches')
      .select('id')
      .where('device_id', '=', 'tablet-race')
      .execute();
    expect(batches).toHaveLength(1);
    const rows = await t.db
      .selectFrom('attendance_observations')
      .select('id')
      .where('device_id', '=', 'tablet-race')
      .execute();
    expect(rows).toHaveLength(2);
  });

  it('SPK-AT-018: observations made against a roster older than the maximum age are accepted but flagged for review', async () => {
    const res = await post(t, '/v1/offline-sync', desk, {
      deviceId: 'tablet-2',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(at(TODAY, '07:30')),
      items: [attendance(fam.childA, 'present', '09:00'), attendance(fam.childA, 'late', '10:10')],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.stale).toBe(true);
    expect(res.body.counts.stale).toBe(1);
    expect(res.body.items[0].flags).toEqual([]);
    expect(res.body.items[1]).toMatchObject({ outcome: 'accepted', flags: ['stale_snapshot'] });
    const stored = await t.db
      .selectFrom('attendance_observations')
      .select('flags')
      .where('id', '=', res.body.items[1].recordId)
      .executeTakeFirstOrThrow();
    expect(stored.flags).toEqual(['stale_snapshot']);
    const raised = await exceptionsOf(t, 'entry.stale_offline_snapshot');
    expect(raised.map((e) => e.id)).toEqual(expect.arrayContaining(res.body.exceptionIds));
  });

  it('SPK-AT-018 / §4.15 / §4.7 invariant 12: a queued release is rejected without an approved manual outage procedure, stale authority is never asserted, and a critical follow-up is raised', async () => {
    const items = [
      {
        kind: 'release',
        clientObservationId: newId(),
        observedAt: at(TODAY, '11:05'),
        childPersonId: fam.childA,
        collector: { personId: fam.guardian.personId },
      },
      {
        kind: 'release',
        clientObservationId: newId(),
        observedAt: at(TODAY, '11:06'),
        childPersonId: fam.childA,
        collector: { personId: fam.guardian.personId },
        manualProcedureReference: 'PAPER-PICKUP-LOG',
      },
      // SPK-ENTRY-007: the child participant seen leaving: a release was required.
      {
        kind: 'departure',
        clientObservationId: newId(),
        observedAt: at(TODAY, '11:07'),
        personId: fam.childA,
      },
    ];
    const res = await post(t, '/v1/offline-sync', desk, {
      deviceId: 'tablet-3',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items,
    });
    expect(res.status).toBe(201);
    expect(
      res.body.items.map((i: { outcome: string; reason: string }) => `${i.outcome}:${i.reason}`),
    ).toEqual([
      'rejected:release_requires_online_check',
      'rejected:release_requires_online_check',
      'rejected:release_required',
    ]);
    // Nobody may assume the child is still in care: each item opens a critical exception for the
    // pickup queue, naming the child, the device and the observed time.
    expect(res.body.exceptionIds).toHaveLength(3);
    const raised = (await exceptionsOf(t, 'entry.offline_release_unrecorded')).filter((e) =>
      res.body.exceptionIds.includes(e.id),
    );
    expect(raised).toHaveLength(3);
    for (const exception of raised) {
      expect(exception).toMatchObject({
        severity: 'critical',
        status: 'open',
        affected_type: 'person',
        affected_id: fam.childA,
        owner_queue: 'general_manager',
        facility_id: t.facilityId,
      });
      expect(exception.details).toMatchObject({ deviceId: 'tablet-3', batchId: res.body.id });
    }
    // Re-sending the same items in a new batch opens no second exception.
    const resent = await post(t, '/v1/offline-sync', desk, {
      deviceId: 'tablet-3',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items,
    });
    expect([...resent.body.exceptionIds].sort()).toEqual([...res.body.exceptionIds].sort());
    const open = (await exceptionsOf(t, 'entry.offline_release_unrecorded')).filter(
      (e) => (e.details as { deviceId?: string }).deviceId === 'tablet-3',
    );
    expect(open).toHaveLength(3);
    const releases = await t.db
      .selectFrom('release_records')
      .select('id')
      .where('child_person_id', '=', fam.childA)
      .execute();
    expect(releases).toHaveLength(0);
    const visit = await t.db
      .selectFrom('visits')
      .select('status')
      .where('person_id', '=', fam.childA)
      .executeTakeFirstOrThrow();
    expect(visit.status).toBe('on_site');
  });

  it('§4.15: with an approved manual procedure the release is recorded and authority is re-checked online at sync', async () => {
    const annex = newId();
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
    const payer = await adultCustomer(t);
    await createRelationshipFixture(t, {
      actorPersonId: payer.personId,
      subjectPersonId: fam.childB,
      kind: 'caregiver',
      permissions: ['pay', 'view'],
    });
    const release = (childPersonId: string, collectorPersonId: string, time: string) => ({
      kind: 'release',
      clientObservationId: newId(),
      observedAt: at(TODAY, time),
      childPersonId,
      collector: { personId: collectorPersonId },
      manualProcedureReference: 'OUTAGE-PROC-1',
    });
    const res = await post(t, '/v1/offline-sync', desk, {
      deviceId: 'annex-tablet',
      clientBatchId: newId(),
      facilityId: annex,
      snapshot: snapshot(),
      items: [
        {
          kind: 'arrival',
          clientObservationId: newId(),
          observedAt: at(TODAY, '09:30'),
          personId: fam.childB,
          visitorCategory: 'participant',
        },
        release(fam.childB, payer.personId, '11:00'),
        release(fam.childA, fam.guardian.personId, '11:01'),
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [arrival, unverified, verified] = res.body.items;
    expect(arrival.outcome).toBe('accepted');
    expect(unverified).toMatchObject({
      outcome: 'accepted_with_conflict',
      reason: 'authority_not_held_at_sync',
    });
    expect(verified.outcome).toBe('accepted');
    const rows = await t.db
      .selectFrom('release_records')
      .selectAll()
      .where('sync_batch_id', '=', res.body.id)
      .orderBy('decided_at')
      .execute();
    expect(rows.map((r) => [r.verification_outcome, r.post_sync_authority, r.outcome])).toEqual([
      ['manual_outage_procedure', 'not_held', 'released'],
      ['manual_outage_procedure', 'held', 'released'],
    ]);
    expect(rows[0]!.manual_procedure_reference).toBe('OUTAGE-PROC-1');
    const critical = await exceptionsOf(t, 'entry.offline_release_unverified');
    expect(critical.find((e) => e.affected_id === rows[0]!.id)).toMatchObject({
      severity: 'critical',
    });
    const departure = await t.db
      .selectFrom('departures')
      .select(['release_record_id', 'source'])
      .where('person_id', '=', fam.childB)
      .executeTakeFirstOrThrow();
    expect(departure).toMatchObject({ release_record_id: rows[0]!.id, source: 'release' });
  });

  it('§4.15: a conflicting offline observation is preserved for review rather than overwriting', async () => {
    const online = await post(t, '/v1/attendance-observations', desk, {
      personId: fam.childB,
      activity: sessionRef(p),
      observedState: 'present',
    });
    expect(online.status).toBe(201);
    const res = await post(t, '/v1/offline-sync', desk, {
      deviceId: 'tablet-4',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items: [attendance(fam.childB, 'absent', '10:20')],
    });
    expect(res.body.items[0]).toMatchObject({
      outcome: 'accepted_with_conflict',
      flags: ['conflict'],
    });
    expect(res.body.counts.acceptedWithConflict).toBe(1);
    const both = await t.db
      .selectFrom('attendance_observations')
      .select(['id', 'observed_state'])
      .where('id', 'in', [online.body.observation.id, res.body.items[0].recordId])
      .execute();
    expect(both.map((r) => r.observed_state).sort()).toEqual(['absent', 'present']);
    expect(res.body.exceptionIds.length).toBeGreaterThan(0);
  });

  it('rejects items outside the device scope, before the snapshot, in the future or for unassigned field staff', async () => {
    const coach = await staffMember(t, ['coach']);
    const coachBatch = await post(t, '/v1/offline-sync', coach, {
      deviceId: 'coach-phone',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items: [
        attendance(fam.childA, 'present'),
        {
          kind: 'arrival',
          clientObservationId: newId(),
          observedAt: at(TODAY, '09:40'),
          personId: fam.childB,
          visitorCategory: 'participant',
        },
      ],
    });
    expect(coachBatch.status, JSON.stringify(coachBatch.body)).toBe(201);
    expect(coachBatch.body.items.map((i: { reason: string }) => i.reason)).toEqual([
      'not_assigned',
      'not_permitted',
    ]);
    const timing = await post(t, '/v1/offline-sync', desk, {
      deviceId: 'tablet-5',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items: [
        attendance(fam.childA, 'present', '08:30'),
        attendance(fam.childA, 'present', '13:00'),
        {
          ...attendance(fam.childA, 'present'),
          activity: { type: 'session', offeringId: p.offering.offeringId, sessionId: newId() },
        },
      ],
    });
    expect(timing.body.items.map((i: { reason: string }) => i.reason)).toEqual([
      'observed_before_snapshot',
      'observed_in_future',
      'activity_not_found',
    ]);
    expect(timing.body.counts.rejected).toBe(3);
    const customer = await post(t, '/v1/offline-sync', fam.guardian, {
      deviceId: 'phone',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items: [attendance(fam.childA, 'present')],
    });
    expect(customer.status).toBe(403);
    const other = await seedOrganization(t.db);
    const foreignDesk = await staffMember(t, ['front_desk'], {
      organizationId: other.organizationId,
    });
    const foreign = await post(t, '/v1/offline-sync', foreignDesk, {
      deviceId: 'foreign',
      clientBatchId: newId(),
      facilityId: t.facilityId,
      snapshot: snapshot(),
      items: [attendance(fam.childA, 'present')],
    });
    expect(foreign.status).toBe(404);
  });
});
