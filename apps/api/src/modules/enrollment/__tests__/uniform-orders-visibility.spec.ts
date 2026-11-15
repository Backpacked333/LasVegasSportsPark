import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingUniformFixture } from '../../catalog';
import { createEnrollmentFixture } from '../testing/enrollment-fixtures';
import { adult, child, enrollmentTestApp, offering, post, staff, type Actor } from './support';

type Json = Record<string, unknown>;

/**
 * Uniform orders (SPK-REG-012, proposed amendment PA-07; capability `uniforms`): who learns that
 * an order exists (§4.10; security review L-5). An order is a family's purchase: the hand-over
 * commands answer a caller who may not act on it exactly as they answer an unknown id.
 */
describe('uniform orders: an order that is not yours answers like one that does not exist (SPK-REG-012, §4.10)', () => {
  let t: TestApp;
  let desk: Actor;
  let parent: Actor;
  let orderId: string;

  beforeAll(async () => {
    t = await enrollmentTestApp({ capabilities: ['uniforms'] });
    desk = await staff(t, ['front_desk']);
    parent = await adult(t);
    const kid = await child(t, [parent]);
    const setup = await offering(t, {});
    const uniformId = await createOfferingUniformFixture(t, {
      offeringId: setup.offeringId,
      requirement: 'optional',
      priceMinor: 2_500,
    });
    const enrollmentId = await createEnrollmentFixture(t, {
      offeringId: setup.offeringId,
      participantPersonId: kid,
      status: 'confirmed',
    });
    orderId = newId();
    await t.db
      .insertInto('uniform_orders')
      .values({
        id: orderId,
        organization_id: t.organizationId,
        enrollment_id: enrollmentId,
        basket_line_id: null,
        offering_id: setup.offeringId,
        offering_uniform_id: uniformId,
        team_entry_id: null,
        participant_person_id: kid,
        item_key: 'kit',
        name: 'Team kit',
        size: 'YM',
        price_minor: 2_500,
        currency: 'USD',
        status: 'paid',
        ordered_at: t.clock.now(),
        paid_at: t.clock.now(),
        handed_over_at: null,
        handed_over_by: null,
        handed_over_by_person_id: null,
        canceled_at: null,
        cancel_reason: null,
      })
      .execute();
  });
  afterAll(async () => {
    await t.close();
  });

  const answer = (res: { status: number; body: Json }) => ({
    status: res.status,
    code: res.body['code'],
    message: res.body['message'],
    details: res.body['details'],
  });
  const handOver = (actor: Actor, id: string) =>
    post(t, `/v1/uniform-orders/${id}/hand-over`, actor.header, { expectedRevision: 1 });
  const correct = (actor: Actor, id: string) =>
    post(t, `/v1/uniform-orders/${id}/hand-over-corrections`, actor.header, {
      expectedRevision: 1,
      reason: 'Handed to the wrong child',
    });

  it('SPK-REG-012 (security review L-5): the hand-over commands answer a customer, and staff who may not hand uniforms over, the same for an existing order and for an unknown one', async () => {
    const stranger = await adult(t);
    const coach = await staff(t, ['coach' as never]);
    for (const command of [handOver, correct]) {
      const unknown = answer(await command(stranger, newId()));
      expect(unknown).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      // The order of somebody else's child, the family's own order (a customer never hands a
      // uniform over), and a staff role that does not: one answer, the unknown order's.
      for (const actor of [stranger, parent, coach]) {
        expect(answer(await command(actor, orderId))).toEqual(unknown);
        expect(answer(await command(actor, newId()))).toEqual(unknown);
      }
      // The answer names no id, so it cannot differ by which id was asked for.
      expect(JSON.stringify(unknown)).not.toContain(orderId);
    }
    // Nothing was recorded on the way.
    expect(
      await t.db
        .selectFrom('uniform_handover_events')
        .select('id')
        .where('uniform_order_id', '=', orderId)
        .execute(),
    ).toEqual([]);
    // Staff who hand uniforms over at the facility act on the order, and get the same
    // not-found answer for an id that names nothing.
    expect(answer(await handOver(desk, newId()))).toMatchObject({ status: 404 });
    const done = await handOver(desk, orderId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ id: orderId, status: 'handed_over' });
  });
});
