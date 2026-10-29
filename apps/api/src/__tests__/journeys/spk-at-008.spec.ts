import { newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../../modules';
import { authHeaderForPerson, createStaffMemberFixture } from '../../modules/identity';
import { at, seedPitchWithHalves } from '../../modules/scheduling';
import { createTestApp, type TestApp } from '../../testing';

const key = () => `k-${newId()}`;

/**
 * SPK-AT-008 (spec §6.1): "Whole pitch and subdivision booked concurrently — at most one
 * conflicting reservation commits", over the assembled application through
 * `POST /v1/schedule-drafts/{id}/publish`. Under PGlite the publications serialize; under
 * TEST_DATABASE_URL (PostgreSQL) they race. Either way the committed set never overlaps (the GiST
 * exclusion constraint on reservation units, §4.7), and every other draft fails whole.
 */
describe('SPK-AT-008: whole pitch and subdivision booked concurrently (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2026-10-19T12:00:00Z',
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('SPK-AT-008 / §4.7: concurrent publications of the whole pitch and both halves commit a non-overlapping set and nothing partial', async () => {
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 8',
    });
    const scheduler = await createStaffMemberFixture(t, { roles: ['scheduler'] });
    const header = await authHeaderForPerson(t, scheduler.personId);
    const create = (day: string, resourceIds: string[]) => ({
      kind: 'create',
      proposed: {
        kind: 'game',
        title: `Game ${newId()}`,
        scheduledStart: at(day, '10:00'),
        scheduledEnd: at(day, '11:00'),
      },
      resourceIds,
    });

    for (let round = 0; round < 3; round += 1) {
      const day = `2026-11-${String(10 + round).padStart(2, '0')}`;
      const drafts: string[] = [];
      for (const resources of [
        [pitch.pitchId],
        [pitch.northHalfId],
        [pitch.southHalfId],
        [pitch.pitchId],
      ]) {
        const draft = await t.http
          .post('/v1/schedule-drafts')
          .set(header)
          .set('Idempotency-Key', key())
          .send({
            facilityId: t.facilityId,
            name: `draft-${newId()}`,
            changes: [create(day, resources)],
          });
        expect(draft.status, JSON.stringify(draft.body)).toBe(201);
        drafts.push(draft.body.id as string);
      }
      const results = await Promise.all(
        drafts.map((id) =>
          t.http
            .post(`/v1/schedule-drafts/${id}/publish`)
            .set(header)
            .set('Idempotency-Key', key())
            .send({}),
        ),
      );
      const won = results.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
      for (const r of results.filter((r) => r.status !== 200)) {
        expect(r.status, JSON.stringify(r.body)).toBe(409);
      }
      // one whole-pitch booking, or both halves; never a half together with the whole pitch
      expect([[0], [3], [1, 2]]).toContainEqual(won);

      const overlaps = await sql<{ n: number }>`
        select count(*)::int as n from reservation_units a
        join reservation_units b on a.id < b.id
          and a.conflict_unit_id = b.conflict_unit_id
          and a.status = 'active' and b.status = 'active'
          and a.occupied && b.occupied`.execute(t.db);
      expect(overlaps.rows[0]?.n).toBe(0);
      const published = await sql<{ n: number }>`
        select count(*)::int as n from events
        where organization_id = ${t.organizationId}
          and status = 'published'
          and scheduled_start = ${at(day, '10:00')}::timestamptz`.execute(t.db);
      expect(published.rows[0]?.n).toBe(won.length);
    }
  });
});
