import { newId, type Principal } from '@sportspark/contracts';
import { isCheckViolation, json, pgConstraintName, type Db } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnitOfWork, type Trx } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import { createOrganizationPeople } from '../../identity';
import { CatalogModule } from '../catalog.module';
import { PRICING_PORT, type PricingPort } from '../catalog.ports';
import { DiscountsService, PER_PERSON_LIMIT_CONSTRAINT } from '../services/discounts.service';
import { createDiscountFixture } from '../testing/catalog-fixtures';

/**
 * CAT-04 (SPK-PAY-003, §4.7 "integrity that matters is enforced in the database"): migration 0207
 * makes the database refuse a redemption beyond the per-person limit, whoever writes it. Ledger
 * rows are written through Kysely here, bypassing the pricing service, unless a test says so.
 */
describe('per-person discount redemption guard (CAT-04)', () => {
  let t: TestApp;
  let pricing: PricingPort;
  let uow: UnitOfWork;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    pricing = t.app.get<PricingPort>(PRICING_PORT);
    uow = t.app.get(UnitOfWork);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const entry = (
    discountDefinitionId: string,
    personId: string | null,
    kind: 'redeem' | 'release' = 'redeem',
    referenceId: string = newId(),
  ) => ({
    id: newId(),
    organization_id: t.organizationId,
    discount_definition_id: discountDefinitionId,
    kind,
    reference_type: 'order',
    reference_id: referenceId,
    person_id: personId,
    amount_minor: 500,
    currency: 'USD',
    actor: json({ kind: 'system', actorLabel: 'guard-test' }),
    occurred_at: new Date('2026-10-23T12:00:00Z'),
  });
  const insert = (db: Db | Trx, row: ReturnType<typeof entry>) =>
    db.insertInto('discount_redemption_entries').values(row).execute();
  const outcome = <T>(p: Promise<T>) =>
    p.then(
      () => ({ ok: true as const, error: null }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  const refusedByGuard = (error: unknown) =>
    isCheckViolation(error) && pgConstraintName(error) === PER_PERSON_LIMIT_CONSTRAINT;
  /** Keeps the first transaction open while the second inserts (PostgreSQL only). */
  const overlap = () =>
    t.database.concurrent ? new Promise((resolve) => setTimeout(resolve, 300)) : Promise.resolve();
  const redeemedBy = async (discountDefinitionId: string, personId: string) =>
    (
      await t.db
        .selectFrom('discount_redemption_entries')
        .select('kind')
        .where('discount_definition_id', '=', discountDefinitionId)
        .where('person_id', '=', personId)
        .execute()
    ).reduce((n, r) => n + (r.kind === 'redeem' ? 1 : -1), 0);

  it('SPK-PAY-003: the database refuses a redemption beyond the per-person limit', async () => {
    const people = await createOrganizationPeople(t);
    const person = people.child.personId;
    const limited = await createDiscountFixture(t, { perPersonLimit: 2, redemptionLimit: null });
    await insert(t.db, entry(limited, person));
    await insert(t.db, entry(limited, person));
    const third = await outcome(insert(t.db, entry(limited, person)));
    expect(third.ok).toBe(false);
    expect(refusedByGuard(third.error)).toBe(true);
    expect(await redeemedBy(limited, person)).toBe(2);
    // the limit is per person: another participant still redeems
    await insert(t.db, entry(limited, people.adult.personId));
    // a redemption that names no participant is limited only by the organization-wide counter
    await insert(t.db, entry(limited, null));
    // no per-person limit: unlimited per person
    const open = await createDiscountFixture(t, { perPersonLimit: null, redemptionLimit: null });
    for (let i = 0; i < 3; i += 1) await insert(t.db, entry(open, person));
    expect(await redeemedBy(open, person)).toBe(3);
  });

  it('SPK-PAY-003: the pricing service reports the database refusal as DISCOUNT_PER_PERSON_LIMIT', async () => {
    const person = (await createOrganizationPeople(t)).adult.personId;
    const id = await createDiscountFixture(t, { perPersonLimit: 1, redemptionLimit: null });
    await insert(t.db, entry(id, person));
    // bypass the service's own early check so only the database guard stands in the way
    const early = vi
      .spyOn(
        DiscountsService.prototype as unknown as { personRedemptions: () => Promise<number> },
        'personRedemptions',
      )
      .mockResolvedValue(0);
    const actor: Principal = {
      kind: 'system',
      organizationId: t.organizationId,
      accountId: null,
      personId: null,
      staffRoles: [],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'finance.checkout',
    };
    try {
      await expect(
        uow.run(({ trx }) =>
          pricing.redeemDiscount(trx, t.organizationId, {
            discountDefinitionId: id,
            referenceType: 'order',
            referenceId: newId(),
            personId: person,
            amountMinor: 500,
            currency: 'USD',
            actor,
          }),
        ),
      ).rejects.toMatchObject({
        code: 'RESOURCE_CONFLICT',
        details: { code: 'DISCOUNT_PER_PERSON_LIMIT', discountDefinitionId: id, perPersonLimit: 1 },
      });
    } finally {
      early.mockRestore();
    }
    // the refused redemption consumed nothing
    const counter = await t.db
      .selectFrom('discount_redemptions')
      .select('redeemed_count')
      .where('discount_definition_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(counter.redeemed_count).toBe(0);
    expect(await redeemedBy(id, person)).toBe(1);
  });

  it('two concurrent redemptions of the last per-person use yield one (PGlite and TEST_DATABASE_URL)', async () => {
    const person = (await createOrganizationPeople(t)).child.personId;
    const id = await createDiscountFixture(t, { perPersonLimit: 1, redemptionLimit: null });
    let inserted!: () => void;
    const firstInserted = new Promise<void>((resolve) => (inserted = resolve));
    const first = outcome(
      t.db.transaction().execute(async (trx) => {
        await insert(trx, entry(id, person));
        inserted();
        await overlap(); // still uncommitted while the second one inserts
      }),
    );
    await firstInserted;
    const second = outcome(
      t.db.transaction().execute(async (trx) => {
        await insert(trx, entry(id, person));
      }),
    );
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(refusedByGuard(b.error)).toBe(true);
    expect(await redeemedBy(id, person)).toBe(1);

    // a burst of simultaneous writers still leaves exactly one redemption for the participant
    const burst = await createDiscountFixture(t, { perPersonLimit: 1, redemptionLimit: null });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        outcome(
          t.db.transaction().execute(async (trx) => {
            await insert(trx, entry(burst, person));
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => refusedByGuard(r.error))).toBe(true);
    expect(await redeemedBy(burst, person)).toBe(1);
  });

  it('a released redemption frees the use', async () => {
    const person = (await createOrganizationPeople(t)).child.personId;
    const id = await createDiscountFixture(t, { perPersonLimit: 1, redemptionLimit: null });
    const reference = newId();
    await insert(t.db, entry(id, person, 'redeem', reference));
    expect(refusedByGuard((await outcome(insert(t.db, entry(id, person)))).error)).toBe(true);
    // the release mirrors the redemption it reverses and is never limited itself
    await insert(t.db, entry(id, person, 'release', reference));
    await insert(t.db, entry(id, person));
    expect(await redeemedBy(id, person)).toBe(1);
    expect(refusedByGuard((await outcome(insert(t.db, entry(id, person)))).error)).toBe(true);
  });
});
