import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at } from '../../scheduling';
import {
  adultCustomer,
  entryTestApp,
  family,
  post,
  staffMember,
  TODAY,
  type Actor,
  type Family,
} from './support';

/**
 * ENT-06 (§4.15, SPK-AT-018, SCR-S-31): desk readers list every device's synchronized batches at
 * their facility, newest first, filtered by device or by "needs review"; the rows omit item
 * outcomes. Anyone else, and a facility outside the reader's scope, is refused.
 */
describe('facility list of synchronized offline batches (ENT-06)', () => {
  let t: TestApp;
  let desk: Actor;
  let fam: Family;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await entryTestApp();
    desk = await staffMember(t, ['front_desk']);
    fam = await family(t, desk);
    const arrival = (personId: string, time: string) => ({
      kind: 'arrival',
      clientObservationId: newId(),
      observedAt: at(TODAY, time),
      personId,
      visitorCategory: 'participant',
    });
    const sync = async (name: string, deviceId: string, items: object[], clock: string) => {
      t.clock.set(at(TODAY, clock));
      const res = await post(t, '/v1/offline-sync', desk, {
        deviceId,
        clientBatchId: newId(),
        facilityId: t.facilityId,
        snapshot: { reference: `roster-${name}`, takenAt: at(TODAY, '09:00') },
        items,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ids[name] = res.body.id as string;
    };
    await sync('clean', 'tablet-1', [arrival(fam.childA, '09:10')], '09:30');
    // An unknown person is rejected: the batch needs review.
    await sync('review', 'tablet-1', [arrival(newId(), '09:20')], '09:40');
    await sync('other', 'tablet-2', [arrival(fam.childB, '09:25')], '09:50');
  });
  afterAll(async () => {
    await t.close();
  });

  const list = (actor: Actor, query: string) =>
    t.http.get(`/v1/offline-sync?facilityId=${t.facilityId}${query}`).set(actor.header);

  it('SCR-S-31: lists every device’s batches newest first, without item outcomes, and pages by cursor', async () => {
    const all = await list(desk, '');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.items.map((b: { id: string }) => b.id)).toEqual([
      ids.other,
      ids.review,
      ids.clean,
    ]);
    const review = all.body.items[1];
    expect(review).toMatchObject({
      deviceId: 'tablet-1',
      facilityId: t.facilityId,
      needsReview: true,
      counts: { items: 1, rejected: 1 },
      submittedBy: { kind: 'staff', personId: desk.personId },
    });
    expect(review).not.toHaveProperty('items');
    expect(all.body.items[0]).toMatchObject({ needsReview: false, counts: { accepted: 1 } });

    const first = await list(desk, '&limit=2');
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await list(desk, `&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items.map((b: { id: string }) => b.id)).toEqual([ids.clean]);
    expect(second.body.nextCursor).toBeNull();
  });

  it('§4.15: filters by device and by "needs review"', async () => {
    const tablet1 = await list(desk, '&deviceId=tablet-1');
    expect(tablet1.body.items.map((b: { id: string }) => b.id)).toEqual([ids.review, ids.clean]);
    const needsReview = await list(desk, '&needsReview=true');
    expect(needsReview.body.items.map((b: { id: string }) => b.id)).toEqual([ids.review]);
    const settled = await list(desk, '&needsReview=false');
    expect(settled.body.items.map((b: { id: string }) => b.id)).toEqual([ids.other, ids.clean]);
    expect((await list(desk, '&needsReview=yes')).status).toBe(400);
  });

  it('§4.3: a customer, a coach and a desk member of another facility are refused (ACCESS_DENIED), with no batch in the answer', async () => {
    const customer = await adultCustomer(t);
    const asCustomer = await list(customer, '');
    expect([asCustomer.status, asCustomer.body.code]).toEqual([403, 'ACCESS_DENIED']);
    const coach = await staffMember(t, ['coach']);
    const asCoach = await list(coach, '');
    expect([asCoach.status, asCoach.body.code]).toEqual([403, 'ACCESS_DENIED']);
    const elsewhere = await staffMember(t, ['front_desk'], { facilityIds: [newId()] });
    const res = await list(elsewhere, '');
    expect([res.status, res.body.code]).toEqual([403, 'ACCESS_DENIED']);
    expect(JSON.stringify(res.body)).not.toContain(ids.clean as string);
  });
});
