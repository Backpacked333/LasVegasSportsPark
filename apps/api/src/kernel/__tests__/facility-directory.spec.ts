import { newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { customerPrincipal, staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { UnitOfWork } from '../database/unit-of-work';
import { FacilityDirectory } from '../facilities/facility-directory';

describe('facility directory (K-04, SPK-SCHED-008, §4.3)', () => {
  let t: TestApp;
  let secondFacility: string;
  let archived: string;
  let otherOrganization: { organizationId: string; facilityId: string };

  beforeAll(async () => {
    t = await createTestApp();
    secondFacility = newId();
    archived = newId();
    await t.db
      .insertInto('facilities')
      .values([
        {
          id: secondFacility,
          organization_id: t.organizationId,
          slug: 'east',
          name: 'East fields',
          timezone: 'America/New_York',
          address: null,
          status: 'closed',
        },
        {
          id: archived,
          organization_id: t.organizationId,
          slug: 'old',
          name: 'Old dome',
          timezone: 'America/Chicago',
          address: null,
          status: 'archived',
        },
      ])
      .execute();
    otherOrganization = await seedOrganization(t.db, { timezone: 'Europe/London' });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("SPK-SCHED-008: the facility directory gives customers and staff each facility's IANA time zone", async () => {
    const customer = await t.authHeader(customerPrincipal(t.organizationId));
    const res = await t.http.get('/v1/facilities').set(customer);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        id: secondFacility,
        slug: 'east',
        name: 'East fields',
        timezone: 'America/New_York',
        status: 'closed',
        address: null,
        inStaffScope: null,
      },
      {
        id: t.facilityId,
        slug: 'main',
        name: 'Main complex',
        timezone: 'America/Los_Angeles',
        status: 'active',
        address: null,
        inStaffScope: null,
      },
    ]);

    // A desk scoped to the main complex sees both, marked by its scope.
    const desk = await t.authHeader(
      staffPrincipal(t.organizationId, ['front_desk'], { facilityIds: [t.facilityId] }),
    );
    const staffView = await t.http.get('/v1/facilities').set(desk);
    expect(
      staffView.body.items.map((f: { id: string; timezone: string; inStaffScope: boolean }) => [
        f.id,
        f.timezone,
        f.inStaffScope,
      ]),
    ).toEqual([
      [secondFacility, 'America/New_York', false],
      [t.facilityId, 'America/Los_Angeles', true],
    ]);

    // The status filter (archived is hidden by default).
    const all = await t.http.get('/v1/facilities?status=active,closed,archived').set(desk);
    expect(all.body.items).toHaveLength(3);
    const one = await t.http.get(`/v1/facilities/${archived}`).set(customer);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      id: archived,
      status: 'archived',
      timezone: 'America/Chicago',
    });
    expect((await t.http.get('/v1/facilities?status=open').set(desk)).status).toBe(400);
    // Anonymous callers are asked to authenticate.
    expect((await t.http.get('/v1/facilities')).status).toBe(401);
  });

  it("another organization's facility answers NOT_FOUND", async () => {
    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['general_manager']));
    const res = await t.http.get(`/v1/facilities/${otherOrganization.facilityId}`).set(desk);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    const listed = await t.http.get('/v1/facilities?status=active,closed,archived').set(desk);
    expect(listed.body.items.map((f: { id: string }) => f.id)).not.toContain(
      otherOrganization.facilityId,
    );
  });

  it('describe omits unknown and other-organization ids and reads through the active transaction', async () => {
    const directory = t.app.get(FacilityDirectory);
    const found = await directory.describe(t.organizationId, [
      t.facilityId,
      otherOrganization.facilityId,
      newId(),
    ]);
    expect([...found.keys()]).toEqual([t.facilityId]);
    const inserted = newId();
    await expect(
      t.app.get(UnitOfWork).run(async ({ trx }) => {
        await trx
          .insertInto('facilities')
          .values({
            id: inserted,
            organization_id: t.organizationId,
            slug: 'uncommitted',
            name: 'Uncommitted',
            timezone: 'UTC',
            address: null,
          })
          .execute();
        // The directory sees the command's own uncommitted write (executorFor).
        expect((await directory.describe(t.organizationId, [inserted])).has(inserted)).toBe(true);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect((await directory.describe(t.organizationId, [inserted])).size).toBe(0);
  });

  it('GET /v1/admin/settings is read only and for the general manager and system administration', async () => {
    const gm = await t.authHeader(staffPrincipal(t.organizationId, ['general_manager']));
    const res = await t.http.get('/v1/admin/settings').set(gm);
    expect(res.status).toBe(200);
    expect(res.body.organization).toMatchObject({
      id: t.organizationId,
      revision: 1,
      settings: {},
    });
    expect(res.body.facilities).toHaveLength(3);
    expect(res.body.facilities[0]).toMatchObject({ revision: 1, settings: {} });
    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    expect((await t.http.get('/v1/admin/settings').set(desk)).status).toBe(403);
    const customer = await t.authHeader(customerPrincipal(t.organizationId));
    expect((await t.http.get('/v1/admin/settings').set(customer)).status).toBe(403);
  });
});
