import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../../modules';
import {
  CLOCK_START,
  TODAY,
  enroll,
  family,
  post,
  program,
  sessionRef,
  staffMember,
} from '../../modules/entry/__tests__/support';
import { at } from '../../modules/scheduling';
import { createTestApp, type TestApp } from '../../testing';

/**
 * SPK-AT-018 (spec §6.1): "Offline staff check-in reconnects — observations synchronize once",
 * over the assembled application. §4.15: each queued observation is recorded once; §4.9: the same
 * client batch id with different contents is a conflict, never a silent replay that drops the new
 * observations (which would make them synchronize zero times).
 */
describe('SPK-AT-018: offline staff check-in reconnects (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: CLOCK_START,
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('SPK-AT-018 / §4.9: a resent batch replays once; the same batch id with a grown queue is refused, and the grown queue under a new batch id records only the new observation', async () => {
    const desk = await staffMember(t, ['front_desk']);
    const manager = await staffMember(t, ['program_manager']);
    const fam = await family(t, desk);
    const p = await program(t, manager);
    await enroll(t, p, fam.childA, fam.guardian.personId);
    await enroll(t, p, fam.childB, fam.guardian.personId);
    t.clock.set(at(TODAY, '11:30'));
    const observation = (personId: string, time: string) => ({
      kind: 'attendance' as const,
      clientObservationId: newId(),
      observedAt: at(TODAY, time),
      personId,
      activity: sessionRef(p),
      observedState: 'present' as const,
    });
    const snapshot = { reference: 'roster-0900', takenAt: at(TODAY, '09:00') };
    const batch = (clientBatchId: string, items: object[]) => ({
      deviceId: 'tablet-at018',
      clientBatchId,
      facilityId: t.facilityId,
      snapshot,
      items,
    });
    const stored = async () =>
      (
        await t.db
          .selectFrom('attendance_observations')
          .select('client_observation_id')
          .where('organization_id', '=', t.organizationId)
          .where('person_id', 'in', [fam.childA, fam.childB])
          .execute()
      ).map((r) => r.client_observation_id);

    const a = observation(fam.childA, '10:05');
    const batchId = newId();
    const first = await post(t, '/v1/offline-sync', desk, batch(batchId, [a]));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.items).toEqual([expect.objectContaining({ outcome: 'accepted' })]);

    // the acknowledgement was lost: the identical upload replays its stored outcome
    const replay = await post(t, '/v1/offline-sync', desk, batch(batchId, [a]));
    expect(replay.status).toBe(201);
    expect(replay.body.replayed).toBe(true);

    // meanwhile the device queued one more observation; the same batch id is a conflict
    const b = observation(fam.childB, '10:20');
    const grown = await post(t, '/v1/offline-sync', desk, batch(batchId, [a, b]));
    expect(grown.status, JSON.stringify(grown.body)).toBe(409);
    expect(grown.body.details).toMatchObject({ code: 'batch_id_reused' });
    expect(await stored()).toEqual([a.clientObservationId]);

    // under a new batch id the first observation is a duplicate and the second is recorded once
    const resent = await post(t, '/v1/offline-sync', desk, batch(newId(), [a, b]));
    expect(resent.status, JSON.stringify(resent.body)).toBe(201);
    const outcomes = Object.fromEntries(
      (resent.body.items as Array<{ clientObservationId: string; outcome: string }>).map((i) => [
        i.clientObservationId,
        i.outcome,
      ]),
    );
    expect(outcomes).toEqual({
      [a.clientObservationId]: 'duplicate',
      [b.clientObservationId]: 'accepted',
    });
    expect((await stored()).sort()).toEqual([a.clientObservationId, b.clientObservationId].sort());
  });
});
