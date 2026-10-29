import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../../modules';
import { createAcknowledgmentFixture } from '../../modules/catalog';
import { FakePaymentTokens } from '../../modules/finance';
import {
  adult,
  drain,
  offering,
  post,
  provider,
  type Actor,
} from '../../modules/finance/__tests__/support';
import { createPersonFixture, createRelationshipFixture } from '../../modules/identity';
import { createTestApp, type TestApp } from '../../testing';

const DAY = 86_400_000;
const payment = { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed };

/**
 * SPK-AT-004 (spec §6.1): "Two guardians register the same child — one equivalent entitlement",
 * over the assembled application, paying through finance. The first guardian walking away from an
 * unpaid basket (release, line removal or abandonment) never blocks the second guardian; whichever
 * household checks out first holds the one entitlement, the other is refused with
 * DUPLICATE_ENTITLEMENT without learning who holds it (§4.10), and only one charge is made
 * (§4.7 invariants 2 and 5).
 */
describe('SPK-AT-004: two guardians register the same child (assembled application)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00Z',
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  async function household() {
    const g1 = await adult(t);
    const g2 = await adult(t);
    const kid = await createPersonFixture(t, { kind: 'child' });
    await createRelationshipFixture(t, { actorPersonId: g1.personId, subjectPersonId: kid });
    await createRelationshipFixture(t, { actorPersonId: g2.personId, subjectPersonId: kid });
    const setup = await offering(t, { basePriceMinor: 10_000 });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: kid,
      policyVersionId: setup.formPolicyVersionId,
      signedByPersonId: g1.personId,
    });
    return { g1, g2, kid, setup };
  }

  async function addLine(guardian: Actor, kid: string, offeringId: string) {
    const basket = await post(t, '/v1/baskets', guardian.header, {
      ownerPersonId: guardian.personId,
    });
    expect(basket.status, JSON.stringify(basket.body)).toBe(201);
    return post(t, `/v1/baskets/${basket.body.id as string}/lines`, guardian.header, {
      participantPersonId: kid,
      offeringId,
      intent: 'youth',
    });
  }

  async function payFor(guardian: Actor, basketId: string) {
    const quote = await post(t, '/v1/registration-quotes', guardian.header, { basketId });
    if (quote.status !== 201) return quote;
    return post(t, '/v1/registration-checkouts', guardian.header, {
      quoteId: quote.body.id,
      payment,
    });
  }

  async function liveEnrollments(kid: string) {
    return t.db
      .selectFrom('enrollments')
      .select(['status', 'payer_person_id'])
      .where('organization_id', '=', t.organizationId)
      .where('participant_person_id', '=', kid)
      .where('status', 'in', ['pending', 'confirmed'])
      .execute();
  }

  for (const mode of ['release', 'remove_line', 'abandon'] as const) {
    it(`SPK-AT-004: after the first guardian's unpaid basket is ${mode === 'abandon' ? 'abandoned for 14 days' : mode === 'release' ? 'released' : 'emptied'}, the second guardian registers and pays; the stale basket cannot take a second entitlement`, async () => {
      const { g1, g2, kid, setup } = await household();
      const first = await addLine(g1, kid, setup.offeringId);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const firstBasket = first.body.id as string;
      if (mode === 'release') {
        const released = await post(t, `/v1/baskets/${firstBasket}/release`, g1.header, {
          reason: 'changed my mind',
          expectedRevision: first.body.revision,
        });
        expect(released.status, JSON.stringify(released.body)).toBe(200);
      } else if (mode === 'remove_line') {
        const removed = await post(
          t,
          `/v1/baskets/${firstBasket}/lines/${first.body.lines[0].id as string}/remove`,
          g1.header,
          { expectedRevision: first.body.revision },
        );
        expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      } else {
        t.clock.advance(14 * DAY);
        await drain(t);
      }

      const second = await addLine(g2, kid, setup.offeringId);
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      const charged = provider(t).paymentCalls.length;
      const paid = await payFor(g2, second.body.id as string);
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.status).toBe('completed');
      await drain(t);
      expect(provider(t).paymentCalls.length).toBe(charged + 1);
      expect(await liveEnrollments(kid)).toEqual([
        { status: 'confirmed', payer_person_id: g2.personId },
      ]);

      if (mode === 'abandon') {
        // the abandoned open basket still holds g1's line; paying it now is refused
        const stale = await payFor(g1, firstBasket);
        expect(stale.status, JSON.stringify(stale.body)).toBe(409);
        expect(stale.body.code).toBe('DUPLICATE_ENTITLEMENT');
        expect(JSON.stringify(stale.body)).not.toContain(g2.personId);
        expect(provider(t).paymentCalls.length).toBe(charged + 1);
        expect(await liveEnrollments(kid)).toHaveLength(1);
      }
    });
  }

  it('SPK-AT-004: both guardians build a basket; the first checkout takes the one entitlement, the second is DUPLICATE_ENTITLEMENT without naming the other payer, and one charge is made', async () => {
    const { g1, g2, kid, setup } = await household();
    const a = await addLine(g1, kid, setup.offeringId);
    const b = await addLine(g2, kid, setup.offeringId);
    expect([a.status, b.status]).toEqual([201, 201]);
    const charged = provider(t).paymentCalls.length;

    const winner = await payFor(g2, b.body.id as string);
    expect(winner.status, JSON.stringify(winner.body)).toBe(201);
    expect(winner.body.status).toBe('completed');
    const loser = await payFor(g1, a.body.id as string);
    expect(loser.status, JSON.stringify(loser.body)).toBe(409);
    expect(loser.body.code).toBe('DUPLICATE_ENTITLEMENT');
    expect(JSON.stringify(loser.body)).not.toContain(g2.personId);
    await drain(t);

    expect(provider(t).paymentCalls.length).toBe(charged + 1);
    expect(await liveEnrollments(kid)).toEqual([
      { status: 'confirmed', payer_person_id: g2.personId },
    ]);
    // g1 reads only their own registration state; the other household's payment stays private
    const mine = await t.http.get(`/v1/enrollments?participantPersonId=${kid}`).set(g1.header);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toContain(winner.body.orderId as string);
  });
});
