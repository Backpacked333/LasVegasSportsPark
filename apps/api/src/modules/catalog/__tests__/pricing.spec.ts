import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import { PRICING_PORT, type PricingPort } from '../catalog.ports';
import { createDiscountFixture, createOfferingFixture } from '../testing/catalog-fixtures';

const key = () => `k-${newId()}`;

describe('price rules and discounts (SPK-PAY-001..003, §4.5, §4.7 invariant 7)', () => {
  let t: TestApp;
  let managerPersonId: string;
  let pm: { Authorization: string };
  let finance: { Authorization: string };
  let financePersonId: string;
  let customer: { Authorization: string };
  let pricing: PricingPort;
  let uow: UnitOfWork;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    const manager = await createStaffMemberFixture(t, { roles: ['program_manager'] });
    managerPersonId = manager.personId;
    pm = await authHeaderForPerson(t, manager.personId);
    const fin = await createStaffMemberFixture(t, { roles: ['finance_operator'] });
    financePersonId = fin.personId;
    finance = await authHeaderForPerson(t, fin.personId);
    const people = await createOrganizationPeople(t);
    customer = await authHeaderForPerson(t, people.adult.personId);
    pricing = t.app.get<PricingPort>(PRICING_PORT);
    uow = t.app.get(UnitOfWork);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-001/002: price rules are versioned; a new version closes the current one and history is never rewritten', async () => {
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'draft',
      basePriceMinor: null,
    });
    const id = offering.offeringId;
    const create = (auth: { Authorization: string }, body: Record<string, unknown>) =>
      t.http
        .post(`/v1/offerings/${id}/price-rules`)
        .set(auth)
        .set('Idempotency-Key', key())
        .send(body);

    expect(
      (
        await create(pm, {
          effectiveFrom: '2026-10-23T12:00:00Z',
          basePriceMinor: 1,
          currency: 'USD',
        })
      ).status,
    ).toBe(403);
    const v1 = await create(finance, {
      effectiveFrom: '2026-10-23T12:00:00Z',
      basePriceMinor: 15_000,
      currency: 'USD',
      chargeLines: [{ code: 'facility', label: 'Facility fee', kind: 'fee', amountMinor: 500 }],
    });
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, effectiveTo: null, basePriceMinor: 15_000 });

    const v2 = await create(finance, {
      effectiveFrom: '2026-12-01T00:00:00Z',
      basePriceMinor: 17_000,
      currency: 'USD',
    });
    expect(v2.status).toBe(201);
    expect(v2.body.version).toBe(2);
    const listed = await t.http.get(`/v1/offerings/${id}/price-rules`).set(finance);
    expect(
      listed.body.map((r: { version: number; effectiveTo: string | null }) => [
        r.version,
        r.effectiveTo,
      ]),
    ).toEqual([
      [1, '2026-12-01T00:00:00.000Z'],
      [2, null],
    ]);
    const priceEvents = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'catalog.price_rule_created')
      .where('aggregate_id', '=', id)
      .execute();
    const supersede = priceEvents.find((e) => (e.payload as { version: number }).version === 2);
    expect(supersede?.payload).toMatchObject({ version: 2, supersededPriceRuleId: v1.body.id });

    // a rule starting in the past would rewrite the price basis of past quotes
    const retroactive = await create(finance, {
      effectiveFrom: '2026-11-01T00:00:00Z',
      basePriceMinor: 1,
      currency: 'USD',
    });
    expect(retroactive.status).toBe(409);
    expect(retroactive.body.code).toBe('RESOURCE_CONFLICT');
    // a bounded window inside the open-ended v2 is a conflict too
    const inside = await create(finance, {
      effectiveFrom: '2027-01-01T00:00:00Z',
      effectiveTo: '2027-02-01T00:00:00Z',
      basePriceMinor: 1,
      currency: 'USD',
    });
    expect(inside.status).toBe(409);

    expect(
      (await pricing.effectivePriceRule(t.organizationId, id, new Date('2026-11-15T00:00:00Z')))
        ?.version,
    ).toBe(1);
    expect(
      (await pricing.effectivePriceRule(t.organizationId, id, new Date('2026-12-15T00:00:00Z')))
        ?.version,
    ).toBe(2);
    expect(
      await pricing.effectivePriceRule(t.organizationId, id, new Date('2026-10-01T00:00:00Z')),
    ).toBeNull();
    expect(await pricing.effectivePriceRule(newId(), id, t.clock.now())).toBeNull();

    // the public price follows the clock
    const published = await t.http
      .patch(`/v1/offerings/${id}`)
      .set(pm)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, name: 'Priced term' });
    expect(published.status).toBe(200);
    expect(published.body.price).toMatchObject({
      basePriceMinor: 15_000,
      chargeLines: [{ code: 'facility', amountMinor: 500 }],
    });
    t.clock.set('2026-12-02T00:00:00Z');
    expect((await t.http.get(`/v1/offerings/${id}`).set(pm)).body.price).toMatchObject({
      basePriceMinor: 17_000,
    });
    t.clock.set('2026-10-23T12:00:00Z');
  });

  it('SPK-PAY-003: finance defines discounts; codes are unique; revisions and lifecycle are enforced', async () => {
    const code = `SPRING${newId().slice(-4).toUpperCase()}`;
    const denied = await t.http.post('/v1/discounts').set(pm).set('Idempotency-Key', key()).send({
      code,
      name: 'Spring',
      amountKind: 'percentage',
      amountValue: 1000,
      effectiveFrom: '2026-10-01T00:00:00Z',
    });
    expect(denied.status).toBe(403);
    const created = await t.http
      .post('/v1/discounts')
      .set(finance)
      .set('Idempotency-Key', key())
      .send({
        code,
        name: 'Spring 10%',
        amountKind: 'percentage',
        amountValue: 1000,
        redemptionLimit: 2,
        capMinor: 2_000,
        rounding: 'half_even',
        effectiveFrom: '2026-10-01T00:00:00Z',
        policyReferences: ['POL-011'],
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      code,
      kind: 'promo_code',
      status: 'draft',
      redeemedCount: 0,
      redemptionLimit: 2,
    });
    const id = created.body.id as string;
    const dup = await t.http.post('/v1/discounts').set(finance).set('Idempotency-Key', key()).send({
      code: code.toLowerCase(),
      name: 'Dup',
      amountKind: 'percentage',
      amountValue: 500,
      effectiveFrom: '2026-10-01T00:00:00Z',
    });
    expect(dup.status).toBe(400);
    const badFixed = await t.http
      .post('/v1/discounts')
      .set(finance)
      .set('Idempotency-Key', key())
      .send({
        name: 'No currency',
        amountKind: 'fixed',
        amountValue: 500,
        effectiveFrom: '2026-10-01T00:00:00Z',
      });
    expect(badFixed.status).toBe(400);

    const activated = await t.http
      .patch(`/v1/discounts/${id}`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, status: 'active' });
    expect(activated.status).toBe(200);
    expect(activated.body).toMatchObject({ status: 'active', revision: 2 });
    const stale = await t.http
      .patch(`/v1/discounts/${id}`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 1, name: 'Stale' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const listed = await t.http.get(`/v1/discounts?code=${code.toLowerCase()}`).set(pm);
    expect(listed.body.items.map((d: { id: string }) => d.id)).toEqual([id]);

    // evaluation explains the outcome for a customer's own basket
    const evaluation = await t.http
      .post('/v1/discounts/evaluate')
      .set(customer)
      .send({
        currency: 'USD',
        codes: [code.toLowerCase(), 'NOSUCHCODE'],
        lines: [
          { lineId: 'a', offeringId: newId(), offeringKind: 'term', baseAmountMinor: 15_000 },
          { lineId: 'b', offeringId: newId(), offeringKind: 'camp', baseAmountMinor: 30_000 },
        ],
      });
    expect(evaluation.status).toBe(200);
    expect(evaluation.body).toMatchObject({
      totalBaseMinor: 45_000,
      totalDiscountMinor: 2_000,
      totalNetMinor: 43_000,
      unknownCodes: ['NOSUCHCODE'],
    });
    expect(evaluation.body.discounts[0]).toMatchObject({
      discountDefinitionId: id,
      applied: true,
      amountMinor: 2_000,
    });
    expect(evaluation.body.discounts[0].explanation).toContain('capped at 2000 minor units');
    expect(evaluation.body.lines).toEqual([
      { lineId: 'a', baseAmountMinor: 15_000, discountMinor: 667, netAmountMinor: 14_333 },
      { lineId: 'b', baseAmountMinor: 30_000, discountMinor: 1_333, netAmountMinor: 28_667 },
    ]);

    // redemption limit cannot drop below what was redeemed; retirement is final
    await uow.run((ctx) =>
      pricing.redeemDiscount(ctx.trx, t.organizationId, {
        discountDefinitionId: id,
        referenceType: 'order_line',
        referenceId: newId(),
        actor: {
          kind: 'system',
          organizationId: t.organizationId,
          accountId: null,
          personId: null,
          staffRoles: [],
          facilityIds: [],
          sessionId: null,
          actorLabel: 'test',
        },
      }),
    );
    const tooLow = await t.http
      .patch(`/v1/discounts/${id}`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 2, redemptionLimit: 0 });
    expect(tooLow.status).toBe(400);
    const retired = await t.http
      .post(`/v1/discounts/${id}/retire`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({ reason: 'Campaign over', expectedRevision: 2 });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ status: 'retired', redeemedCount: 1 });
    const editRetired = await t.http
      .patch(`/v1/discounts/${id}`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: 3, name: 'Zombie' });
    expect(editRetired.status).toBe(409);
    const afterRetire = await t.http
      .post('/v1/discounts/evaluate')
      .set(customer)
      .send({
        currency: 'USD',
        codes: [code],
        lines: [{ lineId: 'a', offeringId: newId(), offeringKind: 'term', baseAmountMinor: 1_000 }],
      });
    expect(afterRetire.body.totalDiscountMinor).toBe(0);
    expect(afterRetire.body.unknownCodes).toEqual([]);
  });

  it('§4.7 invariant 7: redemptions are counted in the database, replay-safe and bounded by the limit', async () => {
    const id = await createDiscountFixture(t, { redemptionLimit: 2, perPersonLimit: 1 });
    const actor = {
      kind: 'staff' as const,
      organizationId: t.organizationId,
      accountId: null,
      personId: financePersonId,
      staffRoles: ['finance_operator' as const],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'finance',
    };
    const people = await createOrganizationPeople(t);
    const redeem = (referenceId: string, personId: string | null = null) =>
      uow.run((ctx) =>
        pricing.redeemDiscount(ctx.trx, t.organizationId, {
          discountDefinitionId: id,
          referenceType: 'order_line',
          referenceId,
          personId,
          amountMinor: 500,
          currency: 'USD',
          actor,
        }),
      );
    const release = (referenceId: string) =>
      uow.run((ctx) =>
        pricing.releaseDiscount(ctx.trx, t.organizationId, {
          discountDefinitionId: id,
          referenceType: 'order_line',
          referenceId,
          actor,
        }),
      );
    const ref1 = newId();
    const ref2 = newId();
    const ref3 = newId();
    expect(await redeem(ref1, people.child.personId)).toMatchObject({
      redeemedCount: 1,
      redemptionLimit: 2,
      replayed: false,
    });
    expect(await redeem(ref1, people.child.personId)).toMatchObject({
      redeemedCount: 1,
      replayed: true,
    });
    await expect(redeem(newId(), people.child.personId)).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'DISCOUNT_PER_PERSON_LIMIT' },
    });
    expect(await redeem(ref2, people.adult.personId)).toMatchObject({
      redeemedCount: 2,
      replayed: false,
    });
    await expect(redeem(ref3)).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: { code: 'DISCOUNT_REDEMPTION_LIMIT' },
    });
    // the failed redemption left nothing behind
    const entries = await t.db
      .selectFrom('discount_redemption_entries')
      .select('reference_id')
      .where('discount_definition_id', '=', id)
      .execute();
    expect(entries.map((e) => e.reference_id).sort()).toEqual([ref1, ref2].sort());
    const code = (await t.http.get(`/v1/discounts/${id}`).set(pm)).body.code as string;
    const exhausted = await t.http
      .post('/v1/discounts/evaluate')
      .set(pm)
      .send({
        currency: 'USD',
        codes: [code],
        lines: [{ lineId: 'a', offeringId: newId(), offeringKind: 'term', baseAmountMinor: 1_000 }],
      });
    expect(exhausted.body.discounts[0]).toMatchObject({ applied: false });
    expect(exhausted.body.discounts[0].explanation.join(' ')).toMatch(/redemption limit 2 reached/);
    // releasing gives the place back, idempotently
    expect(await release(ref1)).toMatchObject({ redeemedCount: 1, replayed: false });
    expect(await release(ref1)).toMatchObject({ redeemedCount: 1, replayed: true });
    await expect(release(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await redeem(ref3)).toMatchObject({ redeemedCount: 2 });
    const events = await t.db
      .selectFrom('outbox_events')
      .select('event_type')
      .where('aggregate_id', '=', id)
      .execute();
    expect(events.map((e) => e.event_type).sort()).toEqual([
      'catalog.discount_redeemed',
      'catalog.discount_redeemed',
      'catalog.discount_redeemed',
      'catalog.discount_released',
    ]);
  });
});
