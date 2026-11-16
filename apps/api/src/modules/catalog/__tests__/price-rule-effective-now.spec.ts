import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { authHeaderForPerson, createStaffMemberFixture } from '../../identity';
import { CatalogModule } from '../catalog.module';
import { PRICE_EFFECTIVE_NOW_TOLERANCE_MS } from '../catalog.policy';
import { PRICING_PORT, type PricingPort } from '../catalog.ports';
import { createOfferingFixture } from '../testing/catalog-fixtures';

/**
 * SPK-PAY-002: a price can be made effective now. The caller's "now" is always behind the
 * instant the command runs at, so every test here moves the clock between the two, as a real
 * clock does. Prices are test data, not policy.
 */
describe('a price rule that takes effect now (SPK-PAY-002)', () => {
  let t: TestApp;
  let finance: { Authorization: string };
  let managerPersonId: string;
  let pricing: PricingPort;
  let keys = 0;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-11-02T15:00:00.000Z',
    });
    managerPersonId = (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId;
    const staff = await createStaffMemberFixture(t, { roles: ['finance_operator'] });
    finance = await authHeaderForPerson(t, staff.personId);
    pricing = t.app.get<PricingPort>(PRICING_PORT);
  });
  afterAll(async () => {
    await t.close();
  });

  const unpricedOffering = async (): Promise<string> =>
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
      .set('Idempotency-Key', `price-now-${(keys += 1)}`)
      .send({ currency: 'USD', basePriceMinor: 12_000, ...body });

  const rulesOf = (offeringId: string) =>
    t.db
      .selectFrom('price_rules')
      .select(['version', 'effective_from', 'effective_to', 'base_price_minor'])
      .where('offering_id', '=', offeringId)
      .orderBy('version')
      .execute();

  it("SPK-PAY-002: a price sent with the caller's own current instant takes effect now although the clock has moved on, and is stored with the server's instant", async () => {
    const offeringId = await unpricedOffering();
    const callersNow = t.clock.now();
    // the request travels: the server's clock is 400 ms further when the command runs
    t.clock.advance(400);
    const serversNow = t.clock.now();

    const res = await createRule(offeringId, { effectiveFrom: callersNow.toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.effectiveFrom).toBe(serversNow.toISOString());
    expect(await rulesOf(offeringId)).toEqual([
      { version: 1, effective_from: serversNow, effective_to: null, base_price_minor: 12_000 },
    ]);
    // In effect at once: the instant the command ran at is priced, the caller's earlier one is not.
    expect((await pricing.effectivePriceRule(t.organizationId, offeringId, serversNow))?.id).toBe(
      res.body.id,
    );
    expect(await pricing.effectivePriceRule(t.organizationId, offeringId, callersNow)).toBeNull();
  });

  it("SPK-PAY-002: a price without effectiveFrom starts at the server's instant", async () => {
    const offeringId = await unpricedOffering();
    t.clock.advance(1_250);
    const serversNow = t.clock.now();
    const res = await createRule(offeringId, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.effectiveFrom).toBe(serversNow.toISOString());
    expect((await rulesOf(offeringId))[0]?.effective_from).toEqual(serversNow);
  });

  it('SPK-PAY-002: the tolerance is small and exact: an instant 60 seconds behind the clock still means now, one millisecond more is a price for the past and is refused with nothing stored', async () => {
    expect(PRICE_EFFECTIVE_NOW_TOLERANCE_MS).toBe(60_000);
    const atEdge = await unpricedOffering();
    const callersNow = t.clock.now();
    t.clock.advance(PRICE_EFFECTIVE_NOW_TOLERANCE_MS);
    const accepted = await createRule(atEdge, { effectiveFrom: callersNow.toISOString() });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.effectiveFrom).toBe(t.clock.now().toISOString());

    const past = await unpricedOffering();
    const earlier = t.clock.now();
    t.clock.advance(PRICE_EFFECTIVE_NOW_TOLERANCE_MS + 1);
    const refused = await createRule(past, { effectiveFrom: earlier.toISOString() });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { path: 'effectiveFrom' },
    });
    expect(await rulesOf(past)).toEqual([]);
  });

  it('SPK-PAY-002: a future instant is stored exactly as given', async () => {
    const offeringId = await unpricedOffering();
    const future = new Date(t.clock.now().getTime() + 3_600_000);
    t.clock.advance(400);
    const res = await createRule(offeringId, { effectiveFrom: future.toISOString() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.effectiveFrom).toBe(future.toISOString());
  });

  it("SPK-PAY-002: a successor that starts now closes the open rule at the server's instant, so exactly one rule is in effect at every instant and no stored rule is rewritten", async () => {
    const offeringId = await unpricedOffering();
    const first = await createRule(offeringId, {});
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const firstFrom = t.clock.now();

    t.clock.advance(5_000);
    const callersNow = t.clock.now();
    t.clock.advance(300);
    const serversNow = t.clock.now();
    const second = await createRule(offeringId, {
      effectiveFrom: callersNow.toISOString(),
      basePriceMinor: 15_000,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(await rulesOf(offeringId)).toEqual([
      { version: 1, effective_from: firstFrom, effective_to: serversNow, base_price_minor: 12_000 },
      { version: 2, effective_from: serversNow, effective_to: null, base_price_minor: 15_000 },
    ]);
    // the caller's instant, which lies before the hand-over, is still priced by the first rule
    expect((await pricing.effectivePriceRule(t.organizationId, offeringId, callersNow))?.id).toBe(
      first.body.id,
    );
    expect((await pricing.effectivePriceRule(t.organizationId, offeringId, serversNow))?.id).toBe(
      second.body.id,
    );
  });

  it('SPK-PAY-002: a rule that starts now cannot end before it starts: the window is checked against the stored instant', async () => {
    const offeringId = await unpricedOffering();
    const callersNow = t.clock.now();
    // ends 200 ms after the caller's instant, which the contract accepts
    const effectiveTo = new Date(callersNow.getTime() + 200);
    t.clock.advance(400);
    const refused = await createRule(offeringId, {
      effectiveFrom: callersNow.toISOString(),
      effectiveTo: effectiveTo.toISOString(),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { path: 'effectiveTo' },
    });
    expect(await rulesOf(offeringId)).toEqual([]);
  });
});
