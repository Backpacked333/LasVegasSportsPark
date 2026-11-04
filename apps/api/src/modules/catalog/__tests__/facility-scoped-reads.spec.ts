import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  createStaffMemberFixture,
} from '../../identity';
import { CatalogModule } from '../catalog.module';
import { createOfferingFixture, createProgramFixture } from '../testing/catalog-fixtures';

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
    customer = await authHeaderForPerson(t, (await createOrganizationPeople(t)).adult.personId);

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
});
