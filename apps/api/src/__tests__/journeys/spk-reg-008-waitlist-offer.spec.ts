import { describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import { createAcknowledgmentFixture, type OfferingFixture } from '../../modules/catalog';
import { FakePaymentTokens } from '../../modules/finance';
import { basketFor, offering, quoteFor } from '../../modules/finance/__tests__/support';
import { createRelationshipFixture } from '../../modules/identity';
import { adult, child, drain, get, journeyApp, ok, post, staff, type Actor } from './support';

const HOUR = 3_600_000;

interface MyEntry {
  id: string;
  status: string;
  position: number | null;
  openOffer: { id: string; status: string; expiresAt: string } | null;
}

/**
 * SPK-REG-008 (waitlist offers), SPK-COMMS-002 (the notice reaches whoever holds
 * receive_messages) and §4.8, across enrollment (capacity, waitlist, baskets), finance (quote,
 * checkout), identity (relationship permissions) and communications (inbox), on the assembled
 * application. The offer window is the configured value; nothing is assumed about it.
 */
describe('SPK-REG-008: a waitlist place offered, expired, re-offered and paid (assembled application)', () => {
  it('a freed seat is offered in order; the notice reaches the guardian who may receive messages; an expired offer cannot be accepted; the next family accepts and pays', async () => {
    const t: TestApp = await journeyApp({ clockStart: '2026-11-02T15:00:00Z' });
    try {
      const pm = await staff(t, ['program_manager']);
      const program = await offering(t, {
        basePriceMinor: 10_000,
        capacityUnits: [{ unit: 'seats', limit: 1 }],
      });
      const acknowledge = (guardian: Actor, kid: string, setup: OfferingFixture) =>
        createAcknowledgmentFixture(t, {
          subjectPersonId: kid,
          policyVersionId: setup.formPolicyVersionId,
          signedByPersonId: guardian.personId,
        });
      const pay = async (actor: Actor, basketId: string) => {
        const quote = await quoteFor(t, actor, basketId);
        const checkout = await ok<{ status: string }>(
          post(t, '/v1/registration-checkouts', actor.header, {
            quoteId: quote.id,
            payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
          }),
          201,
        );
        expect(checkout.status).toBe('completed');
        await drain(t);
      };

      // The only seat is taken and paid for.
      const holder = await adult(t);
      const seated = await child(t, [holder]);
      const { basketId: seatedBasket } = await basketFor(t, holder, [program], {
        participants: [seated],
      });
      await pay(holder, seatedBasket);

      // Two families join the waitlist in order; one guardian may receive the child's messages,
      // the other family's second adult may not.
      const first = await adult(t);
      const firstKid = await child(t, [first], ['view', 'register', 'pay', 'receive_messages']);
      const firstOther = await adult(t);
      await createRelationshipFixture(t, {
        actorPersonId: firstOther.personId,
        subjectPersonId: firstKid,
        kind: 'caregiver',
        permissions: ['view'],
      });
      const second = await adult(t);
      const secondKid = await child(t, [second], ['view', 'register', 'pay', 'receive_messages']);
      for (const [guardian, kid] of [
        [first, firstKid],
        [second, secondKid],
      ] as const) {
        await acknowledge(guardian, kid, program);
        await ok(
          post(t, '/v1/waitlist-entries', guardian.header, {
            offeringId: program.offeringId,
            participantPersonId: kid,
            intent: 'youth',
          }),
          201,
        );
      }
      const myEntry = async (actor: Actor) =>
        (await ok<{ items: MyEntry[] }>(get(t, '/v1/me/waitlist-entries', actor.header))).items[0]!;
      expect(await myEntry(first)).toMatchObject({ status: 'waiting', position: 1 });
      expect(await myEntry(second)).toMatchObject({ status: 'waiting', position: 2 });

      // The seated child withdraws under the previewed consequence; the seat is free.
      const seatedEnrollment = (
        await ok<{ items: Array<{ id: string; status: string; revision: number }> }>(
          get(t, `/v1/enrollments?participantPersonId=${seated}`, holder.header),
        )
      ).items.find((e) => e.status === 'confirmed')!;
      const preview = await ok<{
        financialConsequence: { kind: string; amountMinor: number | null; currency: string | null };
      }>(get(t, `/v1/enrollments/${seatedEnrollment.id}/cancellation-preview`, holder.header));
      await ok(
        post(t, `/v1/enrollments/${seatedEnrollment.id}/cancel`, holder.header, {
          reason: 'We are moving away',
          expectedRevision: seatedEnrollment.revision,
          acceptedConsequence: {
            kind: preview.financialConsequence.kind,
            amountMinor: preview.financialConsequence.amountMinor,
            currency: preview.financialConsequence.currency,
          },
        }),
      );
      await drain(t);

      // The freed seat is offered to the first family in line (DEC-006 waitlist first): a
      // staff offer to a later family is refused, and the notice reaches the first family's
      // guardian who may receive messages only.
      const offered = await myEntry(first);
      expect(offered).toMatchObject({ status: 'offered', openOffer: { status: 'offered' } });
      const skipping = await post(
        t,
        `/v1/waitlist-entries/${(await myEntry(second)).id}/offer`,
        pm.header,
        { reason: 'Trying to skip the queue' },
      );
      expect(skipping.status).toBeGreaterThanOrEqual(400);
      expect(skipping.status).toBeLessThan(500);
      const inboxKinds = async (actor: Actor) =>
        (
          await ok<{ items: Array<{ kind: string }> }>(
            get(t, '/v1/me/inbox?limit=50', actor.header),
          )
        ).items.map((i) => i.kind);
      expect(await inboxKinds(first)).toContain('waitlist_offer');
      expect(await inboxKinds(firstOther)).not.toContain('waitlist_offer');
      expect(await inboxKinds(second)).not.toContain('waitlist_offer');

      // The family does not answer in time: the offer expires, releasing the place to the next
      // family under the configured expiry behaviour.
      t.clock.set(new Date(Date.parse(offered.openOffer!.expiresAt) + HOUR));
      await drain(t);
      const late = await post(
        t,
        `/v1/waitlist-offers/${offered.openOffer!.id}/accept`,
        first.header,
        {},
      );
      // The expiry timer already closed the offer, so accepting it is no longer a transition.
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('INVALID_TRANSITION');
      expect(
        await ok(get(t, `/v1/waitlist-offers/${offered.openOffer!.id}`, first.header)),
      ).toMatchObject({ status: 'expired' });
      expect(await myEntry(second)).toMatchObject({ status: 'offered' });
      expect(await inboxKinds(second)).toContain('waitlist_offer');

      // The next family accepts and pays through checkout.
      const secondOffer = (await myEntry(second)).openOffer!;
      const accepted = await ok<{
        basket: { id: string; revision: number; status: string } | null;
      }>(post(t, `/v1/waitlist-offers/${secondOffer.id}/accept`, second.header, {}));
      expect(accepted.basket).not.toBeNull();
      let basket = accepted.basket!;
      if (basket.status !== 'held') {
        basket = await ok(
          post(t, `/v1/baskets/${basket.id}/hold`, second.header, {
            expectedRevision: basket.revision,
          }),
        );
      }
      await pay(second, basket.id);
      const enrolled = await ok<{ items: Array<{ status: string }> }>(
        get(t, `/v1/enrollments?participantPersonId=${secondKid}`, second.header),
      );
      expect(enrolled.items.map((e) => e.status)).toContain('confirmed');
      // Accepting the same offer twice is refused; the first family stays on the list.
      const again = await post(
        t,
        `/v1/waitlist-offers/${secondOffer.id}/accept`,
        second.header,
        {},
      );
      expect(again.status).toBe(409);
      expect((await myEntry(first)).status).not.toBe('converted');
    } finally {
      await t.close();
    }
  });
});
