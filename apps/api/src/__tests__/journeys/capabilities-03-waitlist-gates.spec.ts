import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  createProgramFixture,
  type OfferingFixture,
} from '../../modules/catalog';
import {
  adult,
  disableCapability,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  staff,
  type Actor,
} from './support';

interface Entry {
  id: string;
  status: string;
  revision: number;
  offers: Array<{ id: string; status: string; revision: number }>;
}

/**
 * CAPABILITIES-03 (DEC-016, DEC-082; ENR-10, SPK-REG-008, SPK-PLACE-004) on the assembled
 * application: the waitlist is no way around the pickup_sessions switch. While the administrator
 * has it off nobody joins a pickup waitlist, no offer is made (so no waiter loses their place to an
 * offer they could not accept), staff cannot offer the seat and an offer made before cannot be
 * accepted; the cancellation that freed the seat and the reads keep working. Switched on again
 * (`core.capability_changed`), the held seat is offered to the first waiter, who books it.
 */
describe('CAPABILITIES-03: waitlist join, offer and acceptance follow the pickup_sessions switch (assembled application)', () => {
  it('DEC-082: with pickup_sessions off no pickup seat is waited for, offered or accepted; switched on, the freed seat is offered and booked', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2026-11-09T16:00:00Z' });
    try {
      const admin = await staff(t, ['system_administrator']);
      const pm = await staff(t, ['program_manager']);
      await enableCapability(t, admin, 'pickup_sessions', 'DEC-082');

      const program = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
      const pickup: OfferingFixture = await createOfferingFixture(t, {
        responsibleManagerPersonId: pm.personId,
        programId: program,
        kind: 'pickup',
        basePriceMinor: 0,
        capacityUnits: [{ unit: 'seats', limit: 1 }],
      });
      const sessionId = await createOfferingSessionFixture(t, {
        offeringId: pickup.offeringId,
        scheduledStart: new Date('2026-11-20T02:00:00Z'),
        scheduledEnd: new Date('2026-11-20T03:30:00Z'),
      });
      const player = async (): Promise<Actor> => {
        const actor = await adult(t);
        await createAcknowledgmentFixture(t, {
          subjectPersonId: actor.personId,
          policyVersionId: pickup.formPolicyVersionId,
          signedByPersonId: actor.personId,
        });
        return actor;
      };
      const join = (actor: Actor) =>
        post(t, '/v1/waitlist-entries', actor.header, {
          offeringId: pickup.offeringId,
          participantPersonId: actor.personId,
          intent: 'pickup',
          sessionId,
        });
      const entryOf = (actor: Actor, id: string) =>
        ok<Entry>(get(t, `/v1/waitlist-entries/${id}`, actor.header));
      // C is the only waiter of this journey: every waitlist_offer notice is theirs.
      const offerNotices = async () =>
        (
          await t.db
            .selectFrom('notifications')
            .select('id')
            .where('kind', '=', 'waitlist_offer')
            .execute()
        ).length;

      // The only seat is booked; C waits for it.
      const a = await player();
      const c = await player();
      const seat = await ok<{ id: string; revision: number }>(
        post(t, '/v1/session-bookings', a.header, {
          offeringId: pickup.offeringId,
          sessionId,
          participantPersonId: a.personId,
        }),
        201,
      );
      const waiting = await ok<Entry>(join(c), 201);

      // The administrator switches pickup sessions off.
      await disableCapability(t, admin, 'pickup_sessions', 'DEC-082');
      await drain(t);

      // Nobody joins the queue for something they could not book.
      const d = await player();
      const refusedJoin = await join(d);
      expect(refusedJoin.status, JSON.stringify(refusedJoin.body)).toBe(403);
      expect(refusedJoin.body.details).toMatchObject({
        code: 'CAPABILITY_DISABLED',
        capability: 'pickup_sessions',
      });

      // A cancels (never gated): the seat is free, but no offer is made while the switch is off,
      // so C keeps their place and is not invited to accept what would be refused.
      await ok(
        post(t, `/v1/session-bookings/${seat.id}/cancel`, a.header, {
          expectedRevision: seat.revision,
          reason: 'Cannot make it',
        }),
      );
      await drain(t);
      expect(await entryOf(c, waiting.id)).toMatchObject({ status: 'waiting', offers: [] });
      expect(await offerNotices()).toBe(0);
      // Staff cannot offer it either.
      const staffOffer = await post(t, `/v1/waitlist-entries/${waiting.id}/offer`, pm.header, {
        reason: 'Seat freed',
        expectedRevision: waiting.revision,
      });
      expect(staffOffer.status, JSON.stringify(staffOffer.body)).toBe(403);
      expect(staffOffer.body.details.code).toBe('CAPABILITY_DISABLED');

      // Switched on again, the freed seat is offered to C at once.
      await enableCapability(t, admin, 'pickup_sessions', 'DEC-082');
      await drain(t);
      const offered = await entryOf(c, waiting.id);
      expect(offered.status).toBe('offered');
      expect(offered.offers).toEqual([expect.objectContaining({ status: 'offered' })]);
      expect(await offerNotices()).toBe(1);

      // An offer made while it was on cannot be accepted while it is off; it stays open, its seat
      // held, and is accepted once the switch is back.
      await disableCapability(t, admin, 'pickup_sessions', 'DEC-082');
      const offer = offered.offers[0]!;
      const refusedAccept = await post(t, `/v1/waitlist-offers/${offer.id}/accept`, c.header, {
        expectedRevision: offer.revision,
      });
      expect(refusedAccept.status, JSON.stringify(refusedAccept.body)).toBe(403);
      expect(refusedAccept.body.details.code).toBe('CAPABILITY_DISABLED');
      expect(
        await t.db
          .selectFrom('session_bookings')
          .select('id')
          .where('participant_person_id', '=', c.personId)
          .execute(),
      ).toEqual([]);
      expect(await entryOf(c, waiting.id)).toMatchObject({
        status: 'offered',
        offers: [expect.objectContaining({ id: offer.id, status: 'offered' })],
      });
      await enableCapability(t, admin, 'pickup_sessions', 'DEC-082');
      await drain(t);
      const accepted = await ok<{ sessionBooking: { status: string; kind: string } | null }>(
        post(t, `/v1/waitlist-offers/${offer.id}/accept`, c.header, {
          expectedRevision: offer.revision,
        }),
      );
      expect(accepted.sessionBooking).toMatchObject({ status: 'confirmed', kind: 'pickup' });
    } finally {
      await t.close();
    }
  });
});
