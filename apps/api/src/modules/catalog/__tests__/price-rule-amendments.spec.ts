import { newId } from '@sportspark/contracts';
import {
  isCheckViolation,
  isForeignKeyViolation,
  json,
  seedOrganization,
  type Db,
} from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, setCapability, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import { PRICING_PORT, type PricingPort } from '../catalog.ports';
import {
  createEntitlementDefinitionFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
  createPriceRuleFixture,
} from '../testing/catalog-fixtures';

const key = () => `k-${newId()}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-02T15:00:00Z');

/**
 * Proposed amendments PA-02 (SPK-PAY-013, per-session price, capability `per_session_pricing`,
 * DEC-096 pending) and PA-04 (SPK-PAY-015, member price, capability `member_pricing`, DEC-098
 * pending) on the price rule (migration 0211). Prices and dates are test data, not policy.
 */
describe('price rule amendments (SPK-PAY-013, SPK-PAY-015; migration 0211)', () => {
  let t: TestApp;
  let db: Db;
  let managerPersonId: string;
  let finance: { Authorization: string };
  let customer: { Authorization: string };
  let pricing: PricingPort;
  let membershipDefinitionId: string;

  const draftOffering = async () =>
    (
      await createOfferingFixture(t, {
        responsibleManagerPersonId: managerPersonId,
        publicationState: 'draft',
        basePriceMinor: null,
      })
    ).offeringId;
  const createRule = (offeringId: string, body: Record<string, unknown>) =>
    t.http
      .post(`/v1/offerings/${offeringId}/price-rules`)
      .set(finance)
      .set('Idempotency-Key', key())
      .send({ effectiveFrom: '2026-11-02T15:00:00Z', currency: 'USD', ...body });

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00Z',
    });
    db = t.db;
    managerPersonId = (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId;
    const fin = await createStaffMemberFixture(t, { roles: ['finance_operator'] });
    finance = await authHeaderForPerson(t, fin.personId);
    const people = await createOrganizationPeople(t);
    customer = await authHeaderForPerson(t, people.adult.personId);
    pricing = t.app.get<PricingPort>(PRICING_PORT);
    membershipDefinitionId = await createEntitlementDefinitionFixture(t, {
      name: 'Annual membership',
      kind: 'membership_benefit',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-PAY-013 and SPK-PAY-015 with the capabilities off: the new fields are refused on write and a plain rule is written as before', async () => {
    await setCapability(db, t.organizationId, 'per_session_pricing', false);
    await setCapability(db, t.organizationId, 'member_pricing', false);
    const offeringId = await draftOffering();

    const perSession = await createRule(offeringId, {
      basePriceMinor: 2_400,
      pricingBasis: 'per_session',
    });
    expect(perSession.status).toBe(403);
    expect(perSession.body.code).toBe('ACCESS_DENIED');
    expect(perSession.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'per_session_pricing',
    });

    const member = await createRule(offeringId, {
      basePriceMinor: 30_000,
      memberPriceMinor: 25_000,
      memberEntitlementDefinitionId: membershipDefinitionId,
    });
    expect(member.status).toBe(403);
    expect(member.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'member_pricing',
    });
    // Nothing was written by either refusal.
    expect(
      await db
        .selectFrom('price_rules')
        .select('id')
        .where('offering_id', '=', offeringId)
        .execute(),
    ).toHaveLength(0);

    // Today's request (no new field) and an explicit term basis are both the behaviour before
    // the amendments.
    const plain = await createRule(offeringId, { basePriceMinor: 20_000 });
    expect(plain.status).toBe(201);
    expect(plain.body).toMatchObject({
      basePriceMinor: 20_000,
      pricingBasis: 'term',
      memberPriceMinor: null,
      memberEntitlementDefinitionId: null,
      memberEntitlementName: null,
    });
    const other = await draftOffering();
    const explicit = await createRule(other, { basePriceMinor: 20_000, pricingBasis: 'term' });
    expect(explicit.status).toBe(201);
    expect(explicit.body.pricingBasis).toBe('term');
  });

  it('SPK-PAY-013: with per-session pricing on, a price rule may be priced per session and the offering shows the per-session price with the sessions still to attend', async () => {
    await setCapability(db, t.organizationId, 'per_session_pricing', true);
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      basePriceMinor: null,
    });
    const id = offering.offeringId;
    // Ten weekly sessions; three have started, one of the remaining seven is canceled.
    const firstStart = NOW - 3 * 7 * DAY + DAY;
    const sessionIds: string[] = [];
    for (let week = 0; week < 10; week += 1) {
      sessionIds.push(
        await createOfferingSessionFixture(t, {
          offeringId: id,
          scheduledStart: new Date(firstStart + week * 7 * DAY),
          scheduledEnd: new Date(firstStart + week * 7 * DAY + HOUR),
          status: week === 9 ? 'canceled' : 'scheduled',
        }),
      );
    }

    const created = await createRule(id, { basePriceMinor: 2_400, pricingBasis: 'per_session' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ basePriceMinor: 2_400, pricingBasis: 'per_session' });
    const audit = await db
      .selectFrom('audit_records')
      .select('details')
      .where('target_type', '=', 'price_rule')
      .where('target_id', '=', created.body.id)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ pricingBasis: 'per_session', memberPriceMinor: null });

    const listed = await t.http.get(`/v1/offerings/${id}/price-rules`).set(finance);
    expect(listed.body).toEqual([expect.objectContaining({ pricingBasis: 'per_session' })]);

    const view = await t.http.get(`/v1/offerings/${id}`).set(customer);
    expect(view.status).toBe(200);
    expect(view.body.price).toMatchObject({
      basePriceMinor: 2_400,
      pricingBasis: 'per_session',
      remainingSessionCount: 6,
      remainingSessionsPriceMinor: 14_400,
      memberPrice: null,
    });

    // The port answers the sessions a quote would count: scheduled, starting strictly after the
    // instant, in start order.
    const at = new Date(NOW);
    const remaining = await pricing.remainingSessions(t.organizationId, id, at);
    expect(remaining.map((s) => s.id)).toEqual(sessionIds.slice(3, 9));
    const exactlyAtStart = new Date(firstStart + 3 * 7 * DAY);
    expect(
      (await pricing.remainingSessions(t.organizationId, id, exactlyAtStart)).map((s) => s.id),
    ).toEqual(sessionIds.slice(4, 9));
    // Another organization's offering answers nothing.
    const other = await seedOrganization(db);
    expect(await pricing.remainingSessions(other.organizationId, id, at)).toEqual([]);
  });

  it('SPK-PAY-015: with member pricing on, a price rule may carry a member price that names an active membership entitlement, and the offering shows both prices', async () => {
    await setCapability(db, t.organizationId, 'member_pricing', true);
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerPersonId,
      kind: 'camp',
      basePriceMinor: null,
    });
    const id = offering.offeringId;

    // Both or neither (request validation).
    const priceOnly = await createRule(id, { basePriceMinor: 30_000, memberPriceMinor: 25_000 });
    expect(priceOnly.status).toBe(400);
    const entitlementOnly = await createRule(id, {
      basePriceMinor: 30_000,
      memberEntitlementDefinitionId: membershipDefinitionId,
    });
    expect(entitlementOnly.status).toBe(400);
    const negative = await createRule(id, {
      basePriceMinor: 30_000,
      memberPriceMinor: -1,
      memberEntitlementDefinitionId: membershipDefinitionId,
    });
    expect(negative.status).toBe(400);

    // The entitlement is a membership benefit of this organization, and active.
    const seat = await createEntitlementDefinitionFixture(t, { kind: 'seat' });
    const notMembership = await createRule(id, {
      basePriceMinor: 30_000,
      memberPriceMinor: 25_000,
      memberEntitlementDefinitionId: seat,
    });
    expect(notMembership.status).toBe(400);
    expect(notMembership.body.details).toMatchObject({ path: 'memberEntitlementDefinitionId' });
    const archived = await createEntitlementDefinitionFixture(t, {
      kind: 'membership_benefit',
      status: 'archived',
    });
    expect(
      (
        await createRule(id, {
          basePriceMinor: 30_000,
          memberPriceMinor: 25_000,
          memberEntitlementDefinitionId: archived,
        })
      ).status,
    ).toBe(400);
    const otherOrg = await seedOrganization(db);
    const foreign = await createEntitlementDefinitionFixture(t, {
      kind: 'membership_benefit',
      organizationId: otherOrg.organizationId,
    });
    const crossOrganization = await createRule(id, {
      basePriceMinor: 30_000,
      memberPriceMinor: 25_000,
      memberEntitlementDefinitionId: foreign,
    });
    expect(crossOrganization.status).toBe(400);
    expect(crossOrganization.body.message).toBe('The membership entitlement is not known.');

    const created = await createRule(id, {
      basePriceMinor: 30_000,
      memberPriceMinor: 25_000,
      memberEntitlementDefinitionId: membershipDefinitionId,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      basePriceMinor: 30_000,
      pricingBasis: 'term',
      memberPriceMinor: 25_000,
      memberEntitlementDefinitionId: membershipDefinitionId,
      memberEntitlementName: 'Annual membership',
    });
    const effective = await pricing.effectivePriceRule(t.organizationId, id, new Date(NOW));
    expect(effective).toMatchObject({
      memberPriceMinor: 25_000,
      memberEntitlementName: 'Annual membership',
    });
    const view = await t.http.get(`/v1/offerings/${id}`).set(customer);
    expect(view.body.price).toMatchObject({
      basePriceMinor: 30_000,
      pricingBasis: 'term',
      remainingSessionCount: null,
      remainingSessionsPriceMinor: null,
      memberPrice: {
        priceMinor: 25_000,
        entitlementDefinitionId: membershipDefinitionId,
        entitlementName: 'Annual membership',
      },
    });
  });

  describe('enforced by the database (migration 0211)', () => {
    let offeringId: string;
    const insert = (values: {
      pricingBasis?: string;
      memberPriceMinor?: number | null;
      memberEntitlementDefinitionId?: string | null;
    }) =>
      db
        .insertInto('price_rules')
        .values({
          id: newId(),
          organization_id: t.organizationId,
          offering_id: offeringId,
          version: 1,
          effective_from: new Date(NOW),
          effective_to: null,
          base_price_minor: 30_000,
          currency: 'USD',
          charge_lines: json([]),
          pricing_basis: (values.pricingBasis ?? 'term') as 'term',
          member_price_minor: values.memberPriceMinor ?? null,
          member_entitlement_definition_id: values.memberEntitlementDefinitionId ?? null,
          created_by: json({ kind: 'system', actorLabel: 'schema-test' }),
        })
        .execute();

    beforeAll(async () => {
      offeringId = await draftOffering();
    });

    it('SPK-PAY-015: a member price without the entitlement it requires is refused, and an entitlement without a member price is refused', async () => {
      await expect(insert({ memberPriceMinor: 25_000 })).rejects.toSatisfy(isCheckViolation);
      await expect(
        insert({ memberEntitlementDefinitionId: membershipDefinitionId }),
      ).rejects.toSatisfy(isCheckViolation);
    });

    it('SPK-PAY-015: a negative member price is refused', async () => {
      await expect(
        insert({ memberPriceMinor: -1, memberEntitlementDefinitionId: membershipDefinitionId }),
      ).rejects.toSatisfy(isCheckViolation);
    });

    it('SPK-PAY-013: an unknown pricing basis is refused', async () => {
      await expect(insert({ pricingBasis: 'per_week' })).rejects.toSatisfy(isCheckViolation);
    });

    it("SPK-PAY-015, §4.3: a member price cannot name another organization's entitlement", async () => {
      const otherOrg = await seedOrganization(db);
      const foreign = await createEntitlementDefinitionFixture(t, {
        kind: 'membership_benefit',
        organizationId: otherOrg.organizationId,
      });
      await expect(
        insert({ memberPriceMinor: 25_000, memberEntitlementDefinitionId: foreign }),
      ).rejects.toSatisfy(isForeignKeyViolation);
    });

    it('SPK-PAY-002: the pricing basis and the member price are pricing content and never change; one rule stays effective per instant', async () => {
      const id = await createPriceRuleFixture(t, {
        offeringId,
        basePriceMinor: 2_400,
        pricingBasis: 'per_session',
        memberPriceMinor: 2_000,
        memberEntitlementDefinitionId: membershipDefinitionId,
        effectiveFrom: new Date(NOW),
      });
      const update = (set: Record<string, unknown>) =>
        db.updateTable('price_rules').set(set).where('id', '=', id).execute();
      await expect(update({ pricing_basis: 'term' })).rejects.toThrow(/immutable/);
      await expect(update({ member_price_minor: 1 })).rejects.toThrow(/immutable/);
      const second = await createEntitlementDefinitionFixture(t, { kind: 'membership_benefit' });
      await expect(update({ member_entitlement_definition_id: second })).rejects.toThrow(
        /immutable/,
      );
      // Closing the window is still the one permitted change.
      await update({ effective_to: new Date(NOW + 30 * DAY) });
      // A second rule effective in the same window is still refused (ADR-003: the price rule
      // stays the single source of an offering's price).
      await expect(
        createPriceRuleFixture(t, {
          offeringId,
          basePriceMinor: 20_000,
          effectiveFrom: new Date(NOW + DAY),
        }),
      ).rejects.toThrow(/price_rules_one_effective_per_instant/);
    });
  });
});
