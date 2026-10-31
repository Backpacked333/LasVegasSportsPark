import { newId } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture, createRelationshipFixture } from '../../identity';
import { at } from '../../scheduling';
import {
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
 * Concurrent synchronization (§4.15, SPK-AT-018). Each test sends its requests at the same time;
 * under PGlite they serialize, under TEST_DATABASE_URL (PostgreSQL, READ COMMITTED) they truly
 * race, and the outcome must be the same: conflicts preserved for review, departures and releases
 * recorded once, reused batch ids refused. Several rounds make a lost race visible.
 */
describe('concurrent offline synchronization (§4.15, SPK-AT-018; true concurrency under PostgreSQL)', () => {
  const ROUNDS = 6;
  let t: TestApp;
  let desk: Actor;
  let otherDesk: Actor;
  let manager: Actor;
  let fam: Family;
  let p: Program;
  let annex: string;

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    otherDesk = await staffMember(t, ['front_desk']);
    manager = await staffMember(t, ['program_manager']);
    fam = await family(t, desk);
    p = await program(t, manager);
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
    t.clock.set(at(TODAY, '11:30'));
  });
  afterAll(async () => {
    await t.close();
  });

  const snapshot = { reference: 'roster-0900', takenAt: at(TODAY, '09:00') };
  const batch = (deviceId: string, items: object[], facilityId = t.facilityId) => ({
    deviceId,
    clientBatchId: newId(),
    facilityId,
    snapshot,
    items,
  });
  const attendance = (personId: string, observedState: string) => ({
    kind: 'attendance',
    clientObservationId: newId(),
    observedAt: at(TODAY, '10:10'),
    personId,
    activity: sessionRef(p),
    observedState,
  });
  const conflictsOf = async (personId: string) =>
    (await exceptionsOf(t, 'entry.attendance_conflict')).filter(
      (e) => e.affected_id === `session:${p.sessionId}:${personId}`,
    );
  const flagsOf = async (personId: string) =>
    (
      await t.db
        .selectFrom('attendance_observations')
        .select('flags')
        .where('person_id', '=', personId)
        .execute()
    ).map((r) => [...r.flags]);

  it('§4.15 "Reconnection must preserve conflicting observations for review": two devices synchronizing contradicting observations at once raise the conflict', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const child = await createPersonFixture(t, { kind: 'child' });
      const [a, b] = await Promise.all([
        post(t, '/v1/offline-sync', desk, batch(`dev-a-${round}`, [attendance(child, 'present')])),
        post(
          t,
          '/v1/offline-sync',
          otherDesk,
          batch(`dev-b-${round}`, [attendance(child, 'absent')]),
        ),
      ]);
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([201, 201]);
      const outcomes = [a.body.items[0].outcome, b.body.items[0].outcome].sort();
      expect(outcomes, `round ${round}`).toEqual(['accepted', 'accepted_with_conflict']);
      const flags = await flagsOf(child);
      expect(
        flags.filter((f) => f.includes('conflict')),
        `round ${round}`,
      ).toHaveLength(1);
      expect(await conflictsOf(child), `round ${round}`).toHaveLength(1);
    }
  });

  it('§4.15 / SPK-ENTRY-005: two staff recording contradicting observations online at once raise the conflict', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const child = await createPersonFixture(t, { kind: 'child' });
      const observe = (actor: Actor, observedState: string) =>
        post(t, '/v1/attendance-observations', actor, {
          personId: child,
          activity: sessionRef(p),
          observedState,
        });
      const [a, b] = await Promise.all([observe(desk, 'present'), observe(otherDesk, 'absent')]);
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([201, 201]);
      expect(
        [a.body.conflict, b.body.conflict].filter((c) => c !== null),
        `round ${round}`,
      ).toHaveLength(1);
      expect(await conflictsOf(child), `round ${round}`).toHaveLength(1);
    }
  });

  it('SPK-AT-018: two batches listing the same people in opposite orders both synchronize and both conflicts are raised', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const c1 = await createPersonFixture(t, { kind: 'child' });
      const c2 = await createPersonFixture(t, { kind: 'child' });
      const [a, b] = await Promise.all([
        post(
          t,
          '/v1/offline-sync',
          desk,
          batch(`dev-c-${round}`, [attendance(c1, 'present'), attendance(c2, 'present')]),
        ),
        post(
          t,
          '/v1/offline-sync',
          otherDesk,
          batch(`dev-d-${round}`, [attendance(c2, 'absent'), attendance(c1, 'absent')]),
        ),
      ]);
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([201, 201]);
      expect(await conflictsOf(c1), `round ${round}`).toHaveLength(1);
      expect(await conflictsOf(c2), `round ${round}`).toHaveLength(1);
    }
  });

  it('§4.15 / SPK-AT-018: a departure and its arrival synchronized at the same moment by two devices close the visit once', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const adult = await createPersonFixture(t, { kind: 'adult' });
      const [exit, entrance] = await Promise.all([
        post(
          t,
          '/v1/offline-sync',
          desk,
          batch(`exit-${round}`, [
            {
              kind: 'departure',
              clientObservationId: newId(),
              observedAt: at(TODAY, '10:30'),
              personId: adult,
            },
          ]),
        ),
        post(
          t,
          '/v1/offline-sync',
          otherDesk,
          batch(`entrance-${round}`, [
            {
              kind: 'arrival',
              clientObservationId: newId(),
              observedAt: at(TODAY, '09:30'),
              personId: adult,
              visitorCategory: 'spectator',
            },
          ]),
        ),
      ]);
      expect([exit.status, entrance.status], JSON.stringify([exit.body, entrance.body])).toEqual([
        201, 201,
      ]);
      const visits = await t.db
        .selectFrom('visits')
        .select('status')
        .where('person_id', '=', adult)
        .execute();
      expect(
        visits.map((v) => v.status),
        `round ${round}`,
      ).toEqual(['departed']);
      const departures = await t.db
        .selectFrom('departures')
        .select('id')
        .where('person_id', '=', adult)
        .execute();
      expect(departures, `round ${round}`).toHaveLength(1);
    }
  });

  it('SPK-AT-018: the same release or departure item in two batches uploaded at once is recorded once; the other is a duplicate', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const child = await createPersonFixture(t, { kind: 'child' });
      await createRelationshipFixture(t, {
        actorPersonId: fam.guardian.personId,
        subjectPersonId: child,
        effectiveFrom: new Date(at(TODAY, '08:00')),
      });
      const releaseItem = {
        kind: 'release',
        clientObservationId: newId(),
        observedAt: at(TODAY, '11:00'),
        childPersonId: child,
        collector: { personId: fam.guardian.personId },
        manualProcedureReference: 'OUTAGE-PROC-1',
      };
      const device = `annex-tablet-${round}`;
      const [a, b] = await Promise.all([
        post(t, '/v1/offline-sync', desk, batch(device, [releaseItem], annex)),
        post(t, '/v1/offline-sync', desk, batch(device, [releaseItem], annex)),
      ]);
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([201, 201]);
      expect([a.body.items[0].outcome, b.body.items[0].outcome].sort()).toEqual([
        'accepted',
        'duplicate',
      ]);
      const releases = await t.db
        .selectFrom('release_records')
        .select('id')
        .where('child_person_id', '=', child)
        .execute();
      expect(releases, `round ${round}`).toHaveLength(1);

      const adult = await createPersonFixture(t, { kind: 'adult' });
      const arrived = await post(t, '/v1/visits', desk, {
        facilityId: t.facilityId,
        arrivals: [{ personId: adult, visitorCategory: 'spectator' }],
      });
      expect(arrived.status).toBe(201);
      const departureItem = {
        kind: 'departure',
        clientObservationId: newId(),
        observedAt: at(TODAY, '11:10'),
        personId: adult,
      };
      const [c, d] = await Promise.all([
        post(t, '/v1/offline-sync', desk, batch(`exit-dup-${round}`, [departureItem])),
        post(t, '/v1/offline-sync', desk, batch(`exit-dup-${round}`, [departureItem])),
      ]);
      expect([c.status, d.status], JSON.stringify([c.body, d.body])).toEqual([201, 201]);
      expect([c.body.items[0].outcome, d.body.items[0].outcome].sort()).toEqual([
        'accepted',
        'duplicate',
      ]);
    }
  });

  it('§4.9 / SPK-AT-018: two uploads of one client batch id with different contents at once: one is recorded, the other is a conflict', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const c1 = await createPersonFixture(t, { kind: 'child' });
      const c2 = await createPersonFixture(t, { kind: 'child' });
      const clientBatchId = newId();
      const body = (personId: string) => ({
        ...batch(`reuse-${round}`, [attendance(personId, 'present')]),
        clientBatchId,
      });
      const [a, b] = await Promise.all([
        post(t, '/v1/offline-sync', desk, body(c1)),
        post(t, '/v1/offline-sync', desk, body(c2)),
      ]);
      expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.details).toMatchObject({ code: 'batch_id_reused' });
      const rows = await t.db
        .selectFrom('attendance_observations')
        .select('id')
        .where('person_id', 'in', [c1, c2])
        .execute();
      expect(rows, `round ${round}`).toHaveLength(1);
    }
  });
});
