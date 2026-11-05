import { newId, type Principal } from '@sportspark/contracts';
import type { Response } from 'supertest';
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
import {
  createDiscountFixture,
  createOfferingFixture,
  createProgramFixture,
} from '../testing/catalog-fixtures';

type Auth = { Authorization: string };

/**
 * §4.3, §4.14 (object-level authorization, least privilege), §4.10 and SPK-IAM-001/003: catalog
 * reads that list or price offerings decide staff power at each offering's facility through the
 * kernel, never from `principal.kind` or role names (R4-AUTHZ-TARGETS-03, R4-AUTHZ-TARGETS-04).
 */
describe('catalog facility-scoped reads (§4.14, R4-AUTHZ-TARGETS-03/04)', () => {
  let t: TestApp;
  let managerPersonId: string;
  let frontDesk: Auth;
  let eastFrontDesk: Auth;
  let eastCoach: Auth;
  let eastFrontDeskOfficialEverywhere: Auth;
  let official: Auth;
  let customer: Auth;
  let customerPersonId: string;
  let eastManager: Auth;
  let eastFacilityId: string;
  let programId: string;
  let mainDraft: string;
  let mainOpen: string;
  let eastDraft: string;
  let eastOpen: string;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [CatalogModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    eastFacilityId = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: eastFacilityId,
        organization_id: t.organizationId,
        slug: 'east',
        name: 'East complex',
        timezone: 'America/Los_Angeles',
        address: null,
      })
      .execute();
    const staff = async (
      roles: Parameters<typeof createStaffMemberFixture>[1]['roles'],
      facilityIds?: string[],
    ) =>
      authHeaderForPerson(t, (await createStaffMemberFixture(t, { roles, facilityIds })).personId);
    managerPersonId = (await createStaffMemberFixture(t, { roles: ['program_manager'] })).personId;
    frontDesk = await staff(['front_desk']);
    eastFrontDesk = await staff(['front_desk'], [eastFacilityId]);
    eastCoach = await staff(['coach'], [eastFacilityId]);
    official = await staff(['official']);
    // identity-05: an organization-wide role that does not read the catalog widens nothing
    const mixed = await createStaffMemberFixture(t, {
      roles: ['front_desk'],
      facilityIds: [eastFacilityId],
    });
    await createStaffMemberFixture(t, { roles: ['official'], personId: mixed.personId });
    eastFrontDeskOfficialEverywhere = await authHeaderForPerson(t, mixed.personId);
    customerPersonId = (await createOrganizationPeople(t)).adult.personId;
    customer = await authHeaderForPerson(t, customerPersonId);
    eastManager = await staff(['program_manager'], [eastFacilityId]);

    programId = await createProgramFixture(t);
    const offering = async (facilityId: string, publicationState: 'draft' | 'registration_open') =>
      (
        await createOfferingFixture(t, {
          responsibleManagerPersonId: managerPersonId,
          programId,
          facilityId,
          publicationState,
          basePriceMinor: 22_200,
        })
      ).offeringId;
    mainDraft = await offering(t.facilityId, 'draft');
    mainOpen = await offering(t.facilityId, 'registration_open');
    eastDraft = await offering(eastFacilityId, 'draft');
    eastOpen = await offering(eastFacilityId, 'registration_open');
  });
  afterAll(async () => {
    await t.close();
  });

  const programOfferings = async (auth: Auth) => {
    const res = await t.http.get(`/v1/programs/${programId}/offerings`).set(auth);
    expect(res.status).toBe(200);
    return (res.body.items as { id: string; facilityId: string; staff: unknown }[]).map(
      (o) => o.id,
    );
  };

  it('§4.14 R4-AUTHZ-TARGETS-03: a program’s offering list shows a facility-scoped reader only the facilities its reading roles cover', async () => {
    // an organization-wide reader sees every facility's offerings in every state
    expect((await programOfferings(frontDesk)).sort()).toEqual(
      [mainDraft, mainOpen, eastDraft, eastOpen].sort(),
    );
    // a reader scoped to the east complex sees the east rows only, like GET /offerings/{id}
    for (const reader of [eastFrontDesk, eastCoach, eastFrontDeskOfficialEverywhere]) {
      expect((await programOfferings(reader)).sort()).toEqual([eastDraft, eastOpen].sort());
      expect((await t.http.get(`/v1/offerings/${mainDraft}`).set(reader)).status).toBe(404);
    }
    // a page filter cannot reach past the scope
    const drafts = await t.http
      .get(`/v1/programs/${programId}/offerings?publicationState=draft`)
      .set(eastFrontDesk);
    expect(drafts.body.items.map((o: { id: string }) => o.id)).toEqual([eastDraft]);
    // without a catalog-reading role the list stays refused
    expect((await t.http.get(`/v1/programs/${programId}/offerings`).set(official)).status).toBe(
      403,
    );
  });

  const evaluate = (auth: Auth, offeringId: string, at?: string) =>
    t.http
      .post('/v1/discounts/evaluate')
      .set(auth)
      .send({ currency: 'USD', ...(at ? { at } : {}), lines: [{ lineId: 'a', offeringId }] });
  const AT = '2026-10-24T00:00:00Z';

  it('SPK-IAM-001/003 R4-AUTHZ-TARGETS-04: a staff member whose roles do not evaluate discounts previews their own basket like any customer', async () => {
    for (const person of [customer, official]) {
      const res = await evaluate(person, mainOpen);
      expect(res.status).toBe(200);
      expect(res.body.lines).toEqual([
        { lineId: 'a', baseAmountMinor: 22_200, discountMinor: 0, netAmountMinor: 22_200 },
      ]);
      // ...and gets a customer's limits: the current instant and discoverable offerings only
      const at = await evaluate(person, mainOpen, AT);
      expect(at.status).toBe(403);
      expect(at.body.code).toBe('ACCESS_DENIED');
      expect((await evaluate(person, mainDraft)).status).toBe(404);
    }
  });

  it('§4.14 §4.10 R4-AUTHZ-TARGETS-04: a facility-scoped reader prices unpublished offerings and other instants only at its own facilities', async () => {
    for (const reader of [eastCoach, eastFrontDesk, eastFrontDeskOfficialEverywhere]) {
      // another facility's draft does not exist for them, as GET /offerings/{id} says
      const hidden = await evaluate(reader, mainDraft);
      expect(hidden.status).toBe(404);
      expect(hidden.body.code).toBe('NOT_FOUND');
      // ...whether or not another instant is asked for: the same answer as an unknown id
      expect((await evaluate(reader, mainDraft, AT)).status).toBe(404);
      expect((await evaluate(reader, newId(), AT)).status).toBe(404);
      // another facility's published offering is priced now, like any customer's preview
      expect((await evaluate(reader, mainOpen)).status).toBe(200);
      const at = await evaluate(reader, mainOpen, AT);
      expect(at.status).toBe(403);
      expect(at.body.code).toBe('ACCESS_DENIED');
      // their own facility's draft and another instant are staff previews they may make
      const own = await evaluate(reader, eastDraft, AT);
      expect(own.status).toBe(200);
      expect(own.body.lines[0].baseAmountMinor).toBe(22_200);
      expect((await evaluate(reader, eastOpen, AT)).status).toBe(200);
    }
    // a basket that mixes covered and uncovered facilities is not a staff preview at another instant
    const mixed = await t.http
      .post('/v1/discounts/evaluate')
      .set(eastCoach)
      .send({
        currency: 'USD',
        at: AT,
        lines: [
          { lineId: 'a', offeringId: eastDraft },
          { lineId: 'b', offeringId: mainOpen },
        ],
      });
    expect(mixed.status).toBe(403);
    // an organization-wide reader previews any facility's draft at any instant
    expect((await evaluate(frontDesk, mainDraft, AT)).status).toBe(200);
  });

  /** What a caller can tell from an error: its status, code and message (never ids or timing). */
  const answer = (res: Response) => ({
    status: res.status,
    code: res.body.code as string,
    message: res.body.message as string,
  });

  it('SPK-IAM-003 §4.10 R4-AUTHZ-TARGETS-04 follow-up: a preview names only participants the caller may register, so it is no oracle on another household’s discount use', async () => {
    const pricing = t.app.get<PricingPort>(PRICING_PORT);
    const uow = t.app.get(UnitOfWork);
    const household = await createOrganizationPeople(t);
    const guardian = await authHeaderForPerson(t, household.adult.personId);
    const child = household.child.personId;
    // a guardian who may only view their child does not register them
    const viewOnly = await createOrganizationPeople(t, { guardianPermissions: ['view'] });
    const viewer = await authHeaderForPerson(t, viewOnly.adult.personId);
    const aidAt = async (facilityId: string) =>
      (
        await createOfferingFixture(t, {
          responsibleManagerPersonId: managerPersonId,
          programId,
          facilityId,
          publicationState: 'registration_open',
          basePriceMinor: 22_200,
        })
      ).offeringId;
    const mainAid = await aidAt(t.facilityId);
    const eastAid = await aidAt(eastFacilityId);
    const aid = await createDiscountFixture(t, {
      code: null,
      name: 'Hardship aid',
      perPersonLimit: 1,
      eligibilityRules: { offeringIds: [mainAid, eastAid] },
    });
    const preview = (auth: Auth, offeringId: string, participantPersonId: string) =>
      t.http
        .post('/v1/discounts/evaluate')
        .set(auth)
        .send({
          currency: 'USD',
          lines: [{ lineId: 'a', offeringId, participantPersonId }],
        });
    const applied = (res: Response) =>
      (res.body.discounts as { discountDefinitionId: string; applied: boolean }[]).find(
        (d) => d.discountDefinitionId === aid,
      )?.applied;

    // Every refused caller, before and after the child's redemption, and for a person id that
    // names nobody: the answers must not move.
    const refused = async () => ({
      stranger: answer(await preview(customer, mainAid, child)),
      strangerUnknownPerson: answer(await preview(customer, mainAid, newId())),
      official: answer(await preview(official, mainAid, child)),
      viewer: answer(await preview(viewer, mainAid, child)),
      eastReaderElsewhere: answer(await preview(eastFrontDesk, mainAid, child)),
      eastReaderOfficialElsewhere: answer(
        await preview(eastFrontDeskOfficialEverywhere, mainAid, child),
      ),
    });
    const before = await refused();
    for (const key of ['stranger', 'official', 'viewer'] as const) {
      expect(before[key]).toEqual({
        status: 403,
        code: 'PARTICIPANT_AUTHORITY_REQUIRED',
        message: expect.any(String),
      });
    }
    expect(before.strangerUnknownPerson).toEqual(before.stranger);
    expect(before.eastReaderElsewhere).toMatchObject({ status: 403, code: 'ACCESS_DENIED' });
    expect(before.eastReaderOfficialElsewhere).toEqual(before.eastReaderElsewhere);
    // the people who may see the child's counts see the discount still available
    expect(applied(await preview(guardian, mainAid, child))).toBe(true);
    expect(applied(await preview(frontDesk, mainAid, child))).toBe(true);
    expect(applied(await preview(eastFrontDesk, eastAid, child))).toBe(true);
    // naming oneself is the self basis, for a customer and for a staff member without the role
    expect((await preview(customer, mainAid, customerPersonId)).status).toBe(200);

    const system: Principal = {
      kind: 'system',
      organizationId: t.organizationId,
      accountId: null,
      personId: null,
      staffRoles: [],
      facilityIds: [],
      sessionId: null,
      actorLabel: 'test',
    };
    await uow.run(({ trx }) =>
      pricing.redeemDiscount(trx, t.organizationId, {
        discountDefinitionId: aid,
        referenceType: 'order',
        referenceId: newId(),
        personId: child,
        amountMinor: 2_220,
        currency: 'USD',
        actor: system,
      }),
    );

    expect(await refused()).toEqual(before);
    for (const allowed of [
      await preview(guardian, mainAid, child),
      await preview(frontDesk, mainAid, child),
      await preview(eastFrontDesk, eastAid, child),
    ]) {
      expect(allowed.status).toBe(200);
      expect(applied(allowed)).toBe(false);
    }
  });

  it('§4.10 §4.14 R4-AUTHZ-TARGETS-04 follow-up: the staff reads of one offering answer for a draft the caller cannot see exactly as for an unknown id', async () => {
    const read = async (auth: Auth, path: string) => answer(await t.http.get(path).set(auth));
    const priceRules = (id: string) => `/v1/offerings/${id}/price-rules`;
    const check = (id: string) => `/v1/offerings/${id}/publication-check`;
    for (const route of [priceRules, check]) {
      for (const caller of [customer, eastFrontDesk, eastManager, eastCoach]) {
        const unknown = await read(caller, route(newId()));
        expect(unknown).toMatchObject({ status: 404, code: 'NOT_FOUND' });
        // another facility's draft: the same answer as GET /offerings/{id} and an unknown id
        expect(await read(caller, route(mainDraft))).toEqual(unknown);
        expect((await t.http.get(`/v1/offerings/${mainDraft}`).set(caller)).status).toBe(404);
      }
    }
    // an offering the caller can see may be refused the staff read (it reveals nothing new)
    for (const caller of [customer, eastFrontDesk]) {
      expect(await read(caller, priceRules(mainOpen))).toMatchObject({
        status: 403,
        code: 'ACCESS_DENIED',
      });
    }
    expect(await read(eastManager, check(mainOpen))).toMatchObject({
      status: 403,
      code: 'ACCESS_DENIED',
    });
    // a desk reader at the east complex reads its rules, but may not check publication there
    expect((await t.http.get(priceRules(eastDraft)).set(eastFrontDesk)).status).toBe(200);
    expect(await read(eastFrontDesk, check(eastDraft))).toMatchObject({
      status: 403,
      code: 'ACCESS_DENIED',
    });
    // the east manager may check publication of its own facility's draft
    expect((await t.http.get(check(eastDraft)).set(eastManager)).status).toBe(200);
    // an organization-wide reader reads every facility's rules
    expect((await t.http.get(priceRules(mainDraft)).set(frontDesk)).status).toBe(200);
  });
});
