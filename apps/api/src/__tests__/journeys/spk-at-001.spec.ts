import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOMAIN_MODULES } from '../../modules';
import { createAcknowledgmentFixture, createOfferingSessionFixture } from '../../modules/catalog';
import { createEnrollmentFixture } from '../../modules/enrollment';
import { FakePaymentTokens } from '../../modules/finance';
import {
  adult,
  basketFor,
  child,
  drain,
  offering,
  post,
  quoteFor,
  staff,
} from '../../modules/finance/__tests__/support';
import { createPersonFixture, createRelationshipFixture } from '../../modules/identity';
import { createTestApp, type TestApp } from '../../testing';

/**
 * SPK-AT-001 (spec §6.1): "Returning parent registers two children for different programs —
 * correct permissions, prices, basket behaviour, enrollments and schedules", over the assembled
 * application (every domain module, the identity module's principal resolver), through the public
 * routes only: basket (enrollment), quote and checkout (finance), enrollments and the family
 * calendar (enrollment over catalog sessions). §4.10: a guardian who may register but not pay is
 * told which participant needs pay authority; nobody else learns the basket exists.
 */
describe('SPK-AT-001: returning parent registers two children (assembled application)', () => {
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

  it('SPK-AT-001: two children, two programs — server prices, one checkout, both enrollments confirmed and both sessions on the family calendar with the overlap', async () => {
    const parent = await adult(t);
    const first = await child(t, [parent]);
    const second = await child(t, [parent]);
    // a returning family: last season's participation is history, not a duplicate
    const lastSeason = await offering(t, { basePriceMinor: 9_000 });
    await createEnrollmentFixture(t, {
      offeringId: lastSeason.offeringId,
      participantPersonId: first,
      payerPersonId: parent.personId,
      status: 'completed',
    });
    const soccer = await offering(t, { basePriceMinor: 12_500 });
    const swim = await offering(t, { basePriceMinor: 30_000 });
    const soccerSession = await createOfferingSessionFixture(t, {
      offeringId: soccer.offeringId,
      scheduledStart: new Date('2027-01-12T01:00:00Z'),
      scheduledEnd: new Date('2027-01-12T02:00:00Z'),
    });
    const swimSession = await createOfferingSessionFixture(t, {
      offeringId: swim.offeringId,
      scheduledStart: new Date('2027-01-12T01:30:00Z'),
      scheduledEnd: new Date('2027-01-12T02:30:00Z'),
    });

    const { basketId } = await basketFor(t, parent, [soccer, swim], {
      hold: false,
      participants: [first, second],
    });
    // a stranger learns nothing about the basket (§4.10)
    const stranger = await adult(t);
    const peek = await post(t, '/v1/registration-quotes', stranger.header, { basketId });
    expect(peek.status).toBe(404);

    // SPK-PAY-001: prices come from the catalog's rules, never the client
    const quote = await quoteFor(t, parent, basketId);
    const lines = (quote['lines'] as Array<Record<string, unknown>>).map((l) => ({
      participantPersonId: l['participantPersonId'],
      totalMinor: l['totalMinor'],
    }));
    expect(lines).toEqual(
      expect.arrayContaining([
        { participantPersonId: first, totalMinor: 12_500 },
        { participantPersonId: second, totalMinor: 30_000 },
      ]),
    );
    expect(quote.totalMinor).toBe(42_500);

    const checkout = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
    expect(checkout.body.status).toBe('completed');
    await drain(t);

    for (const [participant, setup] of [
      [first, soccer],
      [second, swim],
    ] as const) {
      const list = await t.http
        .get(`/v1/enrollments?participantPersonId=${participant}`)
        .set(parent.header);
      expect(list.status).toBe(200);
      const live = (list.body.items as Array<Record<string, unknown>>).filter(
        (e) => e['status'] !== 'completed',
      );
      expect(live).toEqual([
        expect.objectContaining({ status: 'confirmed', offeringId: setup.offeringId }),
      ]);
    }

    const calendar = await t.http
      .get('/v1/me/family-calendar')
      .query({ from: '2027-01-11T00:00:00Z', to: '2027-01-13T00:00:00Z' })
      .set(parent.header);
    expect(calendar.status).toBe(200);
    const items = calendar.body.items as Array<Record<string, unknown>>;
    expect(items.map((i) => [i['personId'], i['sessionId']])).toEqual(
      expect.arrayContaining([
        [first, soccerSession],
        [second, swimSession],
      ]),
    );
    expect(calendar.body.overlaps).toHaveLength(1);
    expect(calendar.body.overlaps[0].personIds).toEqual(expect.arrayContaining([first, second]));

    // a stranger reads none of it
    const strangerList = await t.http
      .get(`/v1/enrollments?participantPersonId=${first}`)
      .set(stranger.header);
    expect(strangerList.status === 404 || strangerList.body.items?.length === 0).toBe(true);
  });

  it('SPK-AT-001 / SPK-IAM-003 / §4.10: a guardian holding register but not pay builds the basket and is told PARTICIPANT_AUTHORITY_REQUIRED; others still get NOT_FOUND', async () => {
    const parent = await adult(t);
    const coGuardian = await adult(t);
    const stranger = await adult(t);
    const scheduler = await staff(t, ['scheduler']);
    const registerOnly = await child(t, [parent], ['view', 'register']);
    const full = await child(t, [parent]);
    await createRelationshipFixture(t, {
      actorPersonId: coGuardian.personId,
      subjectPersonId: registerOnly,
    });
    const setup = await offering(t, { basePriceMinor: 5_000 });
    for (const kid of [registerOnly, full]) {
      await createAcknowledgmentFixture(t, {
        subjectPersonId: kid,
        policyVersionId: setup.formPolicyVersionId,
        signedByPersonId: parent.personId,
      });
    }
    const created = await post(t, '/v1/baskets', parent.header, {
      ownerPersonId: parent.personId,
    });
    expect(created.status).toBe(201);
    const basketId = created.body.id as string;
    for (const kid of [registerOnly, full]) {
      const line = await post(t, `/v1/baskets/${basketId}/lines`, parent.header, {
        participantPersonId: kid,
        offeringId: setup.offeringId,
        intent: 'youth',
      });
      expect(line.status, JSON.stringify(line.body)).toBe(201);
    }
    expect((await t.http.get(`/v1/baskets/${basketId}`).set(parent.header)).status).toBe(200);

    const own = await post(t, '/v1/registration-quotes', parent.header, { basketId });
    expect(own.status, JSON.stringify(own.body)).toBe(403);
    expect(own.body).toMatchObject({
      code: 'PARTICIPANT_AUTHORITY_REQUIRED',
      nextAction: 'request_participant_authority',
      details: { permission: 'pay', participantPersonIds: [registerOnly] },
    });
    expect(
      await t.db
        .selectFrom('quotes')
        .select('id')
        .where('organization_id', '=', t.organizationId)
        .where('basket_id', '=', basketId)
        .execute(),
    ).toEqual([]);

    // a co-guardian holding pay, a stranger, out-of-role staff and a missing basket look the same
    for (const who of [coGuardian, stranger, scheduler]) {
      const res = await post(t, '/v1/registration-quotes', who.header, { basketId });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    const missing = await post(t, '/v1/registration-quotes', stranger.header, {
      basketId: '01900000-0000-7000-8000-000000000000',
    });
    expect(missing.status).toBe(404);

    // with pay over both children the same owner quotes
    const fullParent = await adult(t);
    const { basketId: fullBasket } = await basketFor(t, fullParent, [setup], { hold: false });
    const ok = await post(t, '/v1/registration-quotes', fullParent.header, {
      basketId: fullBasket,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.totalMinor).toBe(5_000);
  });

  it('SPK-AT-001 / SPK-IAM-003 / §4.10: a payer whose pay authority lapsed after quoting is told PARTICIPANT_AUTHORITY_REQUIRED at checkout; another adult gets NOT_FOUND', async () => {
    const parent = await adult(t);
    const stranger = await adult(t);
    const manager = await staff(t, ['general_manager']);
    const kid = await createPersonFixtureWithGrants(t, parent.personId);
    const setup = await offering(t, { basePriceMinor: 7_000 });
    const { basketId } = await basketFor(t, parent, [setup], {
      hold: false,
      participants: [kid.personId],
    });
    const quote = await quoteFor(t, parent, basketId);
    const revoked = await post(
      t,
      `/v1/access-grants/${kid.grantIds.pay as string}/revoke`,
      manager.header,
      { reason: 'custody order' },
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);

    const payment = { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed };
    const refused = await post(t, '/v1/registration-checkouts', parent.header, {
      quoteId: quote.id,
      payment,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'PARTICIPANT_AUTHORITY_REQUIRED',
      details: { permission: 'pay', participantPersonIds: [kid.personId] },
    });
    const hidden = await post(t, '/v1/registration-checkouts', stranger.header, {
      quoteId: quote.id,
      payment,
    });
    expect(hidden.status).toBe(404);
    expect(
      await t.db
        .selectFrom('checkouts')
        .select('id')
        .where('organization_id', '=', t.organizationId)
        .where('quote_id', '=', quote.id)
        .execute(),
    ).toEqual([]);
  });
});

/** A child of `actorPersonId` with every permission, returning the grant ids by permission. */
async function createPersonFixtureWithGrants(t: TestApp, actorPersonId: string) {
  const personId = await createPersonFixture(t, { kind: 'child' });
  const { grantIds } = await createRelationshipFixture(t, {
    actorPersonId,
    subjectPersonId: personId,
  });
  return { personId, grantIds };
}
