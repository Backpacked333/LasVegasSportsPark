import { newId, type Principal } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, staffPrincipal, type TestApp } from '../../../testing';
import { at, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { FacilitiesModule } from '../facilities.module';
import { ASSET_DIRECTORY_IMPL, ASSET_DIRECTORY_PORT, type AssetDirectoryPort } from '../ports';
import { AssetDirectoryService } from '../services/asset-directory.service';
import { RestrictionsService } from '../services/restrictions.service';
import { seedAsset } from '../testing/facilities-fixtures';
import { keepFakePrincipals } from './support';

/**
 * FAC-02 (IF-33; SPK-COND-003 "equipment reserved with the booking", §4.2): bookings read assets
 * through ASSET_DIRECTORY_PORT, which facilities provides; scheduling commitments keep using the
 * asset id as the party id.
 */
describe('asset directory port (FAC-02, IF-33, SPK-COND-003)', () => {
  let t: TestApp;
  let directory: AssetDirectoryPort;
  let restrictions: RestrictionsService;
  let org: string;
  let facility: string;
  let pitch: PitchFixture;
  let operator: Principal;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [FacilitiesModule],
      clockStart: '2026-10-19T12:00:00Z',
      configure: keepFakePrincipals(() => t),
    });
    directory = t.app.get<AssetDirectoryPort>(ASSET_DIRECTORY_PORT);
    restrictions = t.app.get(RestrictionsService);
    org = t.organizationId;
    facility = t.facilityId;
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: facility,
      name: 'Pitch E',
    });
    operator = staffPrincipal(org, ['facilities_operator']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('is provided by facilities: the port resolves to AssetDirectoryService', async () => {
    expect(t.app.get(ASSET_DIRECTORY_IMPL)).toBe(t.app.get(AssetDirectoryService));
    const goal = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'goal',
      name: 'Portable goal 1',
    });
    const described = await directory.describe(org, [goal]);
    expect(described.get(goal)).toEqual({
      id: goal,
      facilityId: facility,
      kind: 'goal',
      name: 'Portable goal 1',
      status: 'in_service',
      usable: true,
    });
  });

  it('a retired or restricted asset reads as not usable', async () => {
    const seed = (name: string, status?: 'in_service' | 'out_of_service') =>
      seedAsset(t.db, {
        organizationId: org,
        facilityId: facility,
        resourceId: pitch.southHalfId,
        kind: 'equipment',
        name,
        status,
      });
    const usable = await seed('Ball cart');
    const retired = await seed('Old scoreboard');
    await t.db.updateTable('assets').set({ status: 'retired' }).where('id', '=', retired).execute();
    const outOfService = await seed('Broken net', 'out_of_service');
    // an active restriction makes its in-service asset `restricted` (SPK-FAC-003)
    const restricted = await seed('Divider curtain');
    const restriction = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      assetId: restricted,
      kind: 'closed',
      interval: { start: at('2026-11-02', '08:00'), end: at('2026-11-02', '12:00') },
      reason: 'Curtain motor repair',
      approve: true,
    });
    expect(restriction.status).toBe('active');
    // an asset in service whose active restriction is in force right now is not usable either
    const inForce = await seed('Lighting tower', 'out_of_service');
    const now = t.clock.now();
    const current = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      assetId: inForce,
      kind: 'closed',
      interval: {
        start: new Date(now.getTime() - 3_600_000).toISOString(),
        end: new Date(now.getTime() + 3_600_000).toISOString(),
      },
      reason: 'Lamp replacement',
      approve: true,
    });
    expect(current.status).toBe('active');
    await t.db
      .updateTable('assets')
      .set({ status: 'in_service' })
      .where('id', '=', inForce)
      .execute();

    const described = await directory.describe(org, [
      usable,
      retired,
      outOfService,
      restricted,
      inForce,
    ]);
    const view = (id: string) => {
      const entry = described.get(id);
      return entry && { status: entry.status, usable: entry.usable };
    };
    expect(view(usable)).toEqual({ status: 'in_service', usable: true });
    expect(view(retired)).toEqual({ status: 'retired', usable: false });
    expect(view(outOfService)).toEqual({ status: 'out_of_service', usable: false });
    expect(view(restricted)).toEqual({ status: 'restricted', usable: false });
    expect(view(inForce)).toEqual({ status: 'in_service', usable: false });
    // once the restriction's interval has passed at the clock instant, the in-service asset is usable
    t.clock.advance(2 * 3_600_000);
    expect((await directory.describe(org, [inForce])).get(inForce)?.usable).toBe(true);
  });

  it("another organization's asset is omitted", async () => {
    const mine = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      kind: 'net',
      name: 'Spare net',
    });
    const other = await seedOrganization(t.db);
    const theirs = await seedAsset(t.db, {
      organizationId: other.organizationId,
      facilityId: other.facilityId,
      kind: 'net',
      name: 'Their net',
    });
    const described = await directory.describe(org, [mine, theirs, newId(), 'not-a-uuid', mine]);
    expect([...described.keys()]).toEqual([mine]);
    expect((await directory.describe(other.organizationId, [mine])).size).toBe(0);
    expect((await directory.describe(org, [])).size).toBe(0);
  });

  it('reads through the passed or active transaction (a booking sees its own uncommitted writes)', async () => {
    const uow = t.app.get(UnitOfWork);
    const id = newId();
    const seen = await uow.run(async ({ trx }) => {
      await trx
        .insertInto('assets')
        .values({
          id,
          organization_id: org,
          facility_id: facility,
          resource_id: null,
          kind: 'equipment',
          name: 'Uncommitted cones',
          identifier: null,
        })
        .execute();
      const passed = await directory.describe(org, [id], trx);
      const active = await directory.describe(org, [id]);
      return { passed: passed.get(id)?.usable, active: active.get(id)?.usable };
    });
    expect(seen).toEqual({ passed: true, active: true });
  });
});
