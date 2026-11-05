import { newId, type Principal } from '@sportspark/contracts';
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
  /** Published offerings the previews price from their rules (SPK-PAY-001). */
  let termOffering: string;
  let campOffering: string;

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
    termOffering = (
      await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        kind: 'term',
        basePriceMinor: 15_000,
      })
    ).offeringId;
    campOffering = (
      await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        kind: 'camp',
        basePriceMinor: 30_000,
      })
    ).offeringId;
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

  it('SPK-PAY-002: a new price rule never starts in the past, even where no rule exists yet', async () => {
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'draft',
      basePriceMinor: null,
    });
    const create = (body: Record<string, unknown>) =>
      t.http
        .post(`/v1/offerings/${offering.offeringId}/price-rules`)
        .set(finance)
        .set('Idempotency-Key', key())
        .send({ basePriceMinor: 9_000, currency: 'USD', ...body });
    const retroactive = await create({ effectiveFrom: '2026-01-01T00:00:00Z' });
    expect(retroactive.status).toBe(400);
    expect(retroactive.body.details).toMatchObject({ path: 'effectiveFrom' });
    const boundedPast = await create({
      effectiveFrom: '2026-09-01T00:00:00Z',
      effectiveTo: '2027-06-01T00:00:00Z',
    });
    expect(boundedPast.status).toBe(400);
    expect(
      await pricing.effectivePriceRule(
        t.organizationId,
        offering.offeringId,
        new Date('2026-03-01T00:00:00Z'),
      ),
    ).toBeNull();
    expect((await create({ effectiveFrom: '2026-10-23T12:00:00Z' })).status).toBe(201);
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
        // SPK-PAY-001: the submitted kind and amount are ignored; the server prices each line
        lines: [
          { lineId: 'a', offeringId: termOffering, offeringKind: 'camp', baseAmountMinor: 1 },
          { lineId: 'b', offeringId: campOffering },
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
        lines: [{ lineId: 'a', offeringId: termOffering }],
      });
    expect(afterRetire.body.totalDiscountMinor).toBe(0);
    expect(afterRetire.body.unknownCodes).toEqual([]);
  });

  it('SPK-PAY-001: a discount preview prices lines from the offering and its rule, never from the client; customers preview only now and only discoverable offerings', async () => {
    const id = await createDiscountFixture(t, {
      code: null,
      amountKind: 'percentage',
      amountValue: 1000,
      stackingRule: 'stackable',
      eligibilityRules: { offeringKinds: ['camp'], minLineAmountMinor: 20_000 },
    });
    const evaluate = (body: Record<string, unknown>, headers = customer) =>
      t.http
        .post('/v1/discounts/evaluate')
        .set(headers)
        .send({ currency: 'USD', ...body });
    // a term line dressed up as an expensive camp line does not qualify
    const forged = await evaluate({
      lines: [
        {
          lineId: 'a',
          offeringId: termOffering,
          offeringKind: 'camp',
          programId: null,
          baseAmountMinor: 99_000,
        },
      ],
    });
    expect(forged.status).toBe(200);
    expect(forged.body.lines).toEqual([
      { lineId: 'a', baseAmountMinor: 15_000, discountMinor: 0, netAmountMinor: 15_000 },
    ]);
    expect(
      forged.body.discounts.find(
        (d: { discountDefinitionId: string }) => d.discountDefinitionId === id,
      )?.applied ?? false,
    ).toBe(false);
    const real = await evaluate({ lines: [{ lineId: 'b', offeringId: campOffering }] });
    expect(real.body.lines).toEqual([
      { lineId: 'b', baseAmountMinor: 30_000, discountMinor: 3_000, netAmountMinor: 27_000 },
    ]);
    // another instant is a staff preview only
    const atByCustomer = await evaluate({
      at: '2027-06-01T00:00:00Z',
      lines: [{ lineId: 'b', offeringId: campOffering }],
    });
    expect(atByCustomer.status).toBe(403);
    expect(atByCustomer.body.code).toBe('ACCESS_DENIED');
    const atByStaff = await evaluate(
      { at: '2026-10-24T00:00:00Z', lines: [{ lineId: 'b', offeringId: campOffering }] },
      finance,
    );
    expect(atByStaff.status).toBe(200);
    // a draft offering does not exist for a customer; an unknown one for anybody
    const draft = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      publicationState: 'draft',
    });
    const hidden = await evaluate({ lines: [{ lineId: 'c', offeringId: draft.offeringId }] });
    expect(hidden.status).toBe(404);
    expect(
      (await evaluate({ lines: [{ lineId: 'c', offeringId: draft.offeringId }] }, finance)).status,
    ).toBe(200);
    expect(
      (await evaluate({ lines: [{ lineId: 'd', offeringId: newId() }] }, finance)).status,
    ).toBe(404);
  });

  it('SPK-PAY-003: redemption enforces the effective window, not only the status', async () => {
    const actor = {
      kind: 'system' as const,
      organizationId: t.organizationId,
      accountId: null,
      personId: null,
      staffRoles: [],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'test',
    };
    const redeemOf = (discountDefinitionId: string) =>
      uow.run((ctx) =>
        pricing.redeemDiscount(ctx.trx, t.organizationId, {
          discountDefinitionId,
          referenceType: 'order',
          referenceId: newId(),
          actor,
        }),
      );
    const now = t.clock.now().getTime();
    const ended = await createDiscountFixture(t, {
      effectiveFrom: new Date(now - 10 * 86_400_000),
      effectiveTo: new Date(now - 86_400_000),
    });
    const upcoming = await createDiscountFixture(t, {
      effectiveFrom: new Date(now + 86_400_000),
    });
    for (const id of [ended, upcoming]) {
      await expect(redeemOf(id)).rejects.toMatchObject({
        code: 'RESOURCE_CONFLICT',
        details: { code: 'DISCOUNT_NOT_EFFECTIVE', discountDefinitionId: id },
      });
    }
    const counters = await t.db
      .selectFrom('discount_redemptions')
      .select('redeemed_count')
      .where('discount_definition_id', 'in', [ended, upcoming])
      .execute();
    expect(counters.map((c) => c.redeemed_count)).toEqual([0, 0]);
    const current = await createDiscountFixture(t, {
      effectiveFrom: new Date(now - 86_400_000),
      effectiveTo: new Date(now + 86_400_000),
    });
    await expect(redeemOf(current)).resolves.toMatchObject({ redeemedCount: 1 });
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
    // a per-person-limited discount is always redeemed for a person (migration 0208)
    await expect(redeem(ref3)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { path: 'personId', code: 'DISCOUNT_PERSON_REQUIRED' },
    });
    await expect(redeem(ref3, people.staff.personId)).rejects.toMatchObject({
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
        lines: [{ lineId: 'a', offeringId: termOffering }],
      });
    expect(exhausted.body.discounts[0]).toMatchObject({ applied: false });
    expect(exhausted.body.discounts[0].explanation.join(' ')).toMatch(/redemption limit 2 reached/);
    // releasing gives the place back, idempotently
    expect(await release(ref1)).toMatchObject({ redeemedCount: 1, replayed: false });
    expect(await release(ref1)).toMatchObject({ redeemedCount: 1, replayed: true });
    await expect(release(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await redeem(ref3, people.staff.personId)).toMatchObject({ redeemedCount: 2 });
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

  describe('per-person redemption limit (SPK-PAY-003)', () => {
    const actor = (): Principal => ({
      kind: 'staff',
      organizationId: t.organizationId,
      accountId: null,
      personId: financePersonId,
      staffRoles: ['finance_operator'],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'finance',
    });
    const input = (
      discountDefinitionId: string,
      referenceId: string,
      personId: string | null | undefined,
    ) => ({
      discountDefinitionId,
      referenceType: 'order',
      referenceId,
      personId,
      amountMinor: 500,
      currency: 'USD',
      actor: actor(),
    });
    const settle = <T>(p: Promise<T>) =>
      p.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    /** Lets the second checkout run into the lock the first one holds (PostgreSQL only). */
    const overlap = () =>
      t.database.concurrent
        ? new Promise((resolve) => setTimeout(resolve, 300))
        : Promise.resolve();
    const ledger = async (discountDefinitionId: string) => ({
      entries: await t.db
        .selectFrom('discount_redemption_entries')
        .select(['kind', 'reference_id', 'person_id', 'amount_minor', 'currency'])
        .where('organization_id', '=', t.organizationId)
        .where('discount_definition_id', '=', discountDefinitionId)
        .execute(),
      counter: (
        await t.db
          .selectFrom('discount_redemptions')
          .select('redeemed_count')
          .where('organization_id', '=', t.organizationId)
          .where('discount_definition_id', '=', discountDefinitionId)
          .executeTakeFirstOrThrow()
      ).redeemed_count,
    });

    it('SPK-PAY-003: the per-person limit holds when two checkouts for the same participant overlap', async () => {
      const id = await createDiscountFixture(t, { perPersonLimit: 1, redemptionLimit: null });
      const payer = (await createOrganizationPeople(t)).adult.personId;
      let redeemed!: () => void;
      const firstRedeemed = new Promise<void>((resolve) => (redeemed = resolve));
      const first = settle(
        uow.run(async ({ trx }) => {
          const out = await pricing.redeemDiscount(
            trx,
            t.organizationId,
            input(id, newId(), payer),
          );
          redeemed();
          await overlap(); // the first checkout is still open when the second one redeems
          return out;
        }),
      );
      await firstRedeemed;
      const second = settle(
        uow.run(({ trx }) =>
          pricing.redeemDiscount(trx, t.organizationId, input(id, newId(), payer)),
        ),
      );
      const [a, b] = await Promise.all([first, second]);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
      expect(b.ok ? null : b.error).toMatchObject({
        code: 'RESOURCE_CONFLICT',
        details: { code: 'DISCOUNT_PER_PERSON_LIMIT' },
      });
      const after = await ledger(id);
      expect(after.entries.filter((e) => e.kind === 'redeem')).toHaveLength(1);
      expect(after.counter).toBe(1);

      // a burst of simultaneous checkouts still redeems exactly once for the participant
      const burstId = await createDiscountFixture(t, { perPersonLimit: 1, redemptionLimit: null });
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          settle(
            uow.run(({ trx }) =>
              pricing.redeemDiscount(trx, t.organizationId, input(burstId, newId(), payer)),
            ),
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const burst = await ledger(burstId);
      expect(burst.entries).toHaveLength(1);
      expect(burst.counter).toBe(1);
    });

    it('SPK-PAY-003: a release restores the allowance of the participant who redeemed and mirrors the redemption', async () => {
      const id = await createDiscountFixture(t, { perPersonLimit: 1, redemptionLimit: null });
      const child = (await createOrganizationPeople(t)).child.personId;
      const ref = newId();
      const redeem = (referenceId: string, personId: string) =>
        uow.run(({ trx }) =>
          pricing.redeemDiscount(trx, t.organizationId, input(id, referenceId, personId)),
        );
      expect(await redeem(ref, child)).toMatchObject({ replayed: false });
      // the release names no participant: the allowance still goes back to the child
      expect(
        await uow.run(({ trx }) =>
          pricing.releaseDiscount(trx, t.organizationId, {
            discountDefinitionId: id,
            referenceType: 'order',
            referenceId: ref,
            actor: actor(),
          }),
        ),
      ).toMatchObject({ replayed: false });
      const { entries } = await ledger(id);
      const redeemRow = entries.find((e) => e.kind === 'redeem');
      const releaseRow = entries.find((e) => e.kind === 'release');
      expect(releaseRow).toMatchObject({
        reference_id: ref,
        person_id: child,
        amount_minor: redeemRow?.amount_minor,
        currency: redeemRow?.currency,
      });
      expect(Number(releaseRow?.amount_minor)).toBe(500);
      expect(releaseRow?.currency).toBe('USD');
      expect(await redeem(newId(), child)).toMatchObject({ replayed: false });
    });

    it('SPK-PAY-003: a release naming a different participant is refused and changes no allowance', async () => {
      const id = await createDiscountFixture(t, { perPersonLimit: 1, redemptionLimit: null });
      const people = await createOrganizationPeople(t);
      const ref = newId();
      await uow.run(({ trx }) =>
        pricing.redeemDiscount(trx, t.organizationId, input(id, ref, people.child.personId)),
      );
      await expect(
        uow.run(({ trx }) =>
          pricing.releaseDiscount(trx, t.organizationId, input(id, ref, people.adult.personId)),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { path: 'personId' } });
      const after = await ledger(id);
      expect(after.entries.map((e) => e.kind)).toEqual(['redeem']);
      expect(after.counter).toBe(1);
      // the child is still blocked; the named adult gained no extra use
      await expect(
        uow.run(({ trx }) =>
          pricing.redeemDiscount(trx, t.organizationId, input(id, newId(), people.child.personId)),
        ),
      ).rejects.toMatchObject({ details: { code: 'DISCOUNT_PER_PERSON_LIMIT' } });
      await uow.run(({ trx }) =>
        pricing.redeemDiscount(trx, t.organizationId, input(id, newId(), people.adult.personId)),
      );
      await expect(
        uow.run(({ trx }) =>
          pricing.redeemDiscount(trx, t.organizationId, input(id, newId(), people.adult.personId)),
        ),
      ).rejects.toMatchObject({ details: { code: 'DISCOUNT_PER_PERSON_LIMIT' } });
    });
  });
});
