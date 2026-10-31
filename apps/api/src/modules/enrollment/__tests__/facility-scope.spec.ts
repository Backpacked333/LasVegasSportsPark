import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingFixture } from '../../catalog';
import { authHeaderForPerson, createStaffMemberFixture } from '../../identity';
import {
  acknowledge,
  adult,
  basketWith,
  child,
  enrollmentTestApp,
  offering,
  post,
  type Actor,
  type OfferingSetup,
} from './support';

/**
 * §4.3 facility boundaries, §4.14 least privilege and object-level authorization: every enrollment
 * record hangs off an offering, and an offering belongs to one facility. Staff whose memberships
 * are scoped to some facilities list, read and change only those facilities' registrations; an
 * organization-wide role keeps seeing every facility, and a staff member who is also a guardian
 * keeps their own authority over their child everywhere (SPK-IAM-001/003).
 */
describe('enrollment records follow their offering’s facility (§4.3, §4.14)', () => {
  let t: TestApp;
  let parent: Actor;
  let facilityB: string;
  let atA: OfferingSetup;
  let atB: OfferingSetup;
  let enrolledA: { kid: string; enrollmentId: string; applicationId: string };
  let enrolledB: { kid: string; enrollmentId: string; applicationId: string };

  const scopedStaff = async (
    roles: Parameters<typeof createStaffMemberFixture>[1]['roles'],
    facilityIds?: string[],
  ) => {
    const member = await createStaffMemberFixture(t, { roles, facilityIds });
    return {
      personId: member.personId,
      accountId: member.accountId,
      header: await authHeaderForPerson(t, member.personId),
    } satisfies Actor;
  };

  async function heldIn(setup: OfferingSetup, guardians: Actor[] = [parent]) {
    const kid = await child(t, guardians);
    await acknowledge(t, setup, kid, parent.personId);
    const basket = await basketWith(t, parent, [
      { participantPersonId: kid, offeringId: setup.offeringId },
    ]);
    const held = await post(t, `/v1/baskets/${basket.id}/hold`, parent.header, {});
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const line = held.body.lines[0] as { enrollmentId: string; applicationId: string };
    return { kid, enrollmentId: line.enrollmentId, applicationId: line.applicationId };
  }

  beforeAll(async () => {
    t = await enrollmentTestApp();
    parent = await adult(t);
    facilityB = newId();
    await t.db
      .insertInto('facilities')
      .values({
        id: facilityB,
        organization_id: t.organizationId,
        slug: `annex-${facilityB.slice(0, 8)}`,
        name: 'Annex',
        timezone: 'America/Los_Angeles',
      })
      .execute();
    atA = await offering(t);
    const managerPersonId = (await createStaffMemberFixture(t, { roles: ['program_manager'] }))
      .personId;
    atB = {
      ...(await createOfferingFixture(t, {
        facilityId: facilityB,
        programId: atA.programId,
        responsibleManagerPersonId: managerPersonId,
        kind: 'term',
        capacityUnits: [{ unit: 'seats', limit: 20 }],
        basePriceMinor: 15_000,
      })),
      managerPersonId,
    };
    expect(atB.facilityId).toBe(facilityB);
    enrolledA = await heldIn(atA);
    enrolledB = await heldIn(atB);
  });
  afterAll(async () => {
    await t.close();
  });

  const ids = (body: { items?: Array<{ id: string }> } | Array<{ id: string }>) =>
    (Array.isArray(body) ? body : (body.items ?? [])).map((r) => r.id);

  it('§4.14: facility-scoped staff list and read only their facilities’ registrations', async () => {
    const deskA = await scopedStaff(['front_desk'], [t.facilityId]);
    const deskB = await scopedStaff(['front_desk'], [facilityB]);
    const deskEverywhere = await scopedStaff(['front_desk']);

    // enrollments: list, list by a foreign offering, read by id
    const listA = await t.http.get('/v1/enrollments').set(deskA.header);
    expect(listA.status).toBe(200);
    expect(ids(listA.body)).toContain(enrolledA.enrollmentId);
    expect(ids(listA.body)).not.toContain(enrolledB.enrollmentId);
    const listB = await t.http.get('/v1/enrollments').set(deskB.header);
    expect(ids(listB.body)).toContain(enrolledB.enrollmentId);
    expect(ids(listB.body)).not.toContain(enrolledA.enrollmentId);
    const everywhere = await t.http.get('/v1/enrollments').set(deskEverywhere.header);
    expect(ids(everywhere.body)).toEqual(
      expect.arrayContaining([enrolledA.enrollmentId, enrolledB.enrollmentId]),
    );
    const foreignOffering = await t.http
      .get(`/v1/enrollments?offeringId=${atB.offeringId}`)
      .set(deskA.header);
    expect(foreignOffering.status).toBe(403);
    expect(foreignOffering.body.code).toBe('ACCESS_DENIED');
    expect(
      (await t.http.get(`/v1/enrollments/${enrolledB.enrollmentId}`).set(deskA.header)).status,
    ).toBe(404);
    expect(
      (await t.http.get(`/v1/enrollments/${enrolledB.enrollmentId}`).set(deskB.header)).status,
    ).toBe(200);
    expect(
      (
        await t.http
          .get(`/v1/enrollments/${enrolledB.enrollmentId}/cancellation-preview`)
          .set(deskA.header)
      ).status,
    ).toBe(404);

    // applications
    const applications = await t.http.get('/v1/applications').set(deskA.header);
    expect(applications.status).toBe(200);
    expect(ids(applications.body)).toContain(enrolledA.applicationId);
    expect(ids(applications.body)).not.toContain(enrolledB.applicationId);
    expect(
      (await t.http.get(`/v1/applications/${enrolledB.applicationId}`).set(deskA.header)).status,
    ).toBe(404);

    // capacity pools: the foreign offering's pools are not listed
    const pools = await t.http.get('/v1/capacity-pools').set(deskA.header);
    expect(pools.status).toBe(200);
    const offeringsOf = (body: Array<{ offeringId: string | null }>) =>
      new Set(body.map((p) => p.offeringId));
    expect(offeringsOf(pools.body).has(atA.offeringId)).toBe(true);
    expect(offeringsOf(pools.body).has(atB.offeringId)).toBe(false);
    expect(
      (await t.http.get(`/v1/capacity-pools?offeringId=${atB.offeringId}`).set(deskA.header))
        .status,
    ).toBe(403);
    const allPools = await t.http.get('/v1/capacity-pools').set(deskEverywhere.header);
    expect(offeringsOf(allPools.body).has(atB.offeringId)).toBe(true);

    // a foreign offering's waitlist queue
    expect(
      (await t.http.get(`/v1/waitlist-entries?offeringId=${atB.offeringId}`).set(deskA.header))
        .status,
    ).toBe(403);
  });

  it('§4.14: facility-scoped staff cannot cancel or resize capacity at another facility; staff of that facility can', async () => {
    const target = await heldIn(atB);
    const deskA = await scopedStaff(['front_desk'], [t.facilityId]);
    const managerA = await scopedStaff(['program_manager'], [t.facilityId]);
    const current = await t.http.get(`/v1/enrollments/${target.enrollmentId}`).set(parent.header);
    expect(current.status).toBe(200);
    const refused = await post(t, `/v1/enrollments/${target.enrollmentId}/cancel`, deskA.header, {
      reason: 'Wrong facility',
      expectedRevision: current.body.revision,
    });
    expect(refused.status).toBe(404);
    const unchanged = await t.db
      .selectFrom('enrollments')
      .select('status')
      .where('id', '=', target.enrollmentId)
      .executeTakeFirstOrThrow();
    expect(unchanged.status).toBe(current.body.status);

    const pool = await t.db
      .selectFrom('capacity_pools')
      .select(['id', 'revision', 'capacity'])
      .where('offering_id', '=', atB.offeringId)
      .where('constraint_kind', '=', 'commercial')
      .executeTakeFirstOrThrow();
    const resize = await post(t, `/v1/capacity-pools/${pool.id}/adjust`, managerA.header, {
      capacity: pool.capacity + 5,
      reason: 'More seats',
      expectedRevision: pool.revision,
    });
    expect(resize.status).toBe(403);
    expect(resize.body.code).toBe('ACCESS_DENIED');

    // Staff of the record's own facility keep their authority.
    const deskB = await scopedStaff(['front_desk'], [facilityB]);
    const canceled = await post(t, `/v1/enrollments/${target.enrollmentId}/cancel`, deskB.header, {
      reason: 'Family asked',
      expectedRevision: current.body.revision,
    });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    expect(canceled.body.status).toBe('canceled');
  });

  it('SPK-IAM-001/003: a facility-scoped staff member who is also a guardian still reads their own child’s registration at another facility', async () => {
    const deskA = await scopedStaff(['front_desk'], [t.facilityId]);
    const own = await heldIn(atB, [parent, deskA]);
    const list = await t.http
      .get(`/v1/enrollments?participantPersonId=${own.kid}`)
      .set(deskA.header);
    expect(list.status).toBe(200);
    expect(ids(list.body)).toEqual([own.enrollmentId]);
    expect((await t.http.get(`/v1/enrollments/${own.enrollmentId}`).set(deskA.header)).status).toBe(
      200,
    );
    // ...but no other family's registration at that facility.
    const other = await t.http
      .get(`/v1/enrollments?participantPersonId=${enrolledB.kid}`)
      .set(deskA.header);
    expect(other.status).toBe(200);
    expect(ids(other.body)).toEqual([]);
  });
});
