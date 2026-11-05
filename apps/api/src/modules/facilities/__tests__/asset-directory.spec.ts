import { newId, type Principal } from '@sportspark/contracts';
import { loadMigrationFiles, seedOrganization } from '@sportspark/db';
import { sql } from 'kysely';
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

  it('SPK-FAC-003 / SPK-COND-003 (R4-OPS-MODULES-05): with the booking intervals, equipment a future restriction names is usable outside its window and unusable inside it', async () => {
    const seed = (name: string, status?: 'in_service' | 'restricted' | 'out_of_service') =>
      seedAsset(t.db, {
        organizationId: org,
        facilityId: facility,
        resourceId: pitch.northHalfId,
        kind: 'goal',
        name,
        status,
      });
    const goal = await seed('Goal A');
    const window = { start: at('2026-11-09', '08:00'), end: at('2026-11-09', '12:00') };
    const restriction = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      assetId: goal,
      kind: 'closed',
      interval: window,
      reason: 'Goal anchors',
      approve: true,
    });
    expect(restriction.status).toBe('active');
    const today = { start: at('2026-10-19', '14:00'), end: at('2026-10-19', '15:00') };
    const inside = { start: at('2026-11-09', '11:00'), end: at('2026-11-09', '13:00') };
    const after = { start: at('2026-11-09', '12:00'), end: at('2026-11-09', '13:00') };
    const usable = async (id: string, intervals?: { start: string; end: string }[]) =>
      (await directory.describe(org, [id], undefined, intervals ? { intervals } : {})).get(id)
        ?.usable;
    // the lifecycle status is `restricted` from activation; without intervals the answer stays
    // conservative, with them it follows the restriction's approved interval (SPK-FAC-003)
    expect((await directory.describe(org, [goal])).get(goal)?.status).toBe('restricted');
    expect(await usable(goal)).toBe(false);
    expect(await usable(goal, [today])).toBe(true);
    expect(await usable(goal, [after])).toBe(true);
    expect(await usable(goal, [inside])).toBe(false);
    expect(await usable(goal, [today, inside])).toBe(false);
    // an in-service asset that an active restriction names is unusable inside the window too
    const legacy = await seed('Goal B');
    await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      assetId: legacy,
      kind: 'closed',
      interval: window,
      reason: 'Goal anchors',
      approve: true,
    });
    await t.db
      .updateTable('assets')
      .set({ status: 'in_service' })
      .where('id', '=', legacy)
      .execute();
    expect(await usable(legacy, [inside])).toBe(false);
    expect(await usable(legacy, [today])).toBe(true);
    // out of service, retired, or set restricted with no restriction behind it: never usable
    const broken = await seed('Goal C', 'out_of_service');
    const flagged = await seed('Goal D', 'restricted');
    const retired = await seed('Goal E');
    await t.db.updateTable('assets').set({ status: 'retired' }).where('id', '=', retired).execute();
    for (const id of [broken, flagged, retired]) expect(await usable(id, [today])).toBe(false);
    // a malformed interval is refused rather than read as "no interval"
    await expect(
      directory.describe(org, [goal], undefined, {
        intervals: [{ start: inside.end, end: inside.start }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('SPK-FAC-004 (R4-OPS-MODULES-05): a restricted asset returns to service only through its restriction release, never through PATCH /v1/assets', async () => {
    const goal = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.southHalfId,
      kind: 'goal',
      name: 'Goal F',
    });
    const restriction = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      assetId: goal,
      kind: 'closed',
      interval: { start: at('2026-11-12', '08:00'), end: at('2026-11-12', '12:00') },
      reason: 'Goal net hooks',
      approve: true,
    });
    // a second restriction naming the goal that is only proposed holds nothing
    const proposed = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      assetId: goal,
      kind: 'closed',
      interval: { start: at('2026-11-19', '08:00'), end: at('2026-11-19', '12:00') },
      reason: 'Goal net hooks, follow-up',
      approve: false,
    });
    const admin = await t.authHeader(staffPrincipal(org, ['system_administrator']));
    const operatorAuth = await t.authHeader(operator);
    const patchAsset = async (headers: { Authorization: string }, status: string) => {
      const current = (await t.http.get(`/v1/assets/${goal}`).set(operatorAuth)).body;
      return t.http
        .patch(`/v1/assets/${goal}`)
        .set(headers)
        .set('Idempotency-Key', `key-${newId()}`)
        .send({ status, expectedRevision: current.revision });
    };
    for (const headers of [admin, operatorAuth]) {
      const refused = await patchAsset(headers, 'in_service');
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body).toMatchObject({
        code: 'ELIGIBILITY_FAILED',
        details: {
          code: 'restriction_release_required',
          assetId: goal,
          restrictionIds: [restriction.id],
        },
      });
    }
    // `restricted` is never set by an edit: only a restriction sets it (R4-MODULE-BOUNDARIES-02)
    const manual = await patchAsset(admin, 'restricted');
    expect(manual.status, JSON.stringify(manual.body)).toBe(400);
    expect(manual.body.code).toBe('VALIDATION_FAILED');
    // the authorized release returns it; the proposed restriction does not keep it restricted
    const released = await restrictions.release(operator, restriction.id, { reason: 'fixed' });
    expect(released.status).toBe('released');
    expect((await t.http.get(`/v1/assets/${goal}`).set(operatorAuth)).body.status).toBe(
      'in_service',
    );
    // once the follow-up takes effect, the goal is restricted again by its own activation
    await restrictions.approve(operator, proposed.id);
    expect((await t.http.get(`/v1/assets/${goal}`).set(operatorAuth)).body.status).toBe(
      'restricted',
    );
  });

  it('SPK-FAC-004 / SPK-COND-003 (R4-MODULE-BOUNDARIES-02): `restricted` is set only by a restriction; a person marks an asset out of service, which a release keeps, and 0908 moves hand-set restricted assets there', async () => {
    const operatorAuth = await t.authHeader(operator);
    const send = (method: 'post' | 'patch', path: string, body: object) =>
      t.http[method](path).set(operatorAuth).set('Idempotency-Key', `key-${newId()}`).send(body);
    // creating an asset `restricted` is refused, like editing one to it
    const created = await send('post', '/v1/assets', {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'goal',
      name: 'Goal G',
      status: 'restricted',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(400);
    expect(created.body.code).toBe('VALIDATION_FAILED');
    const goal = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.northHalfId,
      kind: 'goal',
      name: 'Goal H',
    });
    const restriction = await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.northHalfId,
      assetId: goal,
      kind: 'closed',
      interval: { start: at('2026-11-26', '08:00'), end: at('2026-11-26', '12:00') },
      reason: 'Net hooks',
      approve: true,
    });
    const current = async () => (await t.http.get(`/v1/assets/${goal}`).set(operatorAuth)).body;
    const patchStatus = async (status: string) =>
      send('patch', `/v1/assets/${goal}`, { status, expectedRevision: (await current()).revision });
    // a person found it broken as well: out of service, and not back to service by an edit
    expect((await patchStatus('out_of_service')).status).toBe(200);
    expect((await patchStatus('in_service')).status).toBe(422);
    expect((await patchStatus('restricted')).status).toBe(400);
    // the release lifts the restriction's closure, not the person's out of service
    await restrictions.release(operator, restriction.id, { reason: 'hooks fixed' });
    expect((await current()).status).toBe('out_of_service');
    expect((await patchStatus('in_service')).status).toBe(200);

    // Migration 0908 (re-run here: it is idempotent): an asset set `restricted` by hand before the
    // contract refused it, with no approved or active restriction behind it, is out of service.
    const handSet = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.southHalfId,
      kind: 'goal',
      name: 'Goal I',
      status: 'restricted',
    });
    const backed = await seedAsset(t.db, {
      organizationId: org,
      facilityId: facility,
      resourceId: pitch.southHalfId,
      kind: 'goal',
      name: 'Goal J',
    });
    await restrictions.create(operator, {
      facilityId: facility,
      resourceId: pitch.southHalfId,
      assetId: backed,
      kind: 'closed',
      interval: { start: at('2026-11-27', '08:00'), end: at('2026-11-27', '12:00') },
      reason: 'Frame check',
      approve: true,
    });
    const before = await t.db
      .selectFrom('assets')
      .select(['id', 'status', 'revision'])
      .where('id', 'in', [handSet, backed])
      .execute();
    const file = (await loadMigrationFiles()).find(
      (f) => f.fileName === '0908_facilities_manual_restricted_assets.sql',
    )!;
    await sql.raw(file.sql).execute(t.db);
    const after = await t.db
      .selectFrom('assets')
      .select(['id', 'status', 'revision'])
      .where('id', 'in', [handSet, backed])
      .execute();
    const of = (rows: typeof after, id: string) => rows.find((r) => r.id === id)!;
    expect(of(after, handSet)).toMatchObject({
      status: 'out_of_service',
      revision: of(before, handSet).revision + 1,
    });
    expect(of(after, backed)).toEqual(of(before, backed));
    expect(of(after, backed).status).toBe('restricted');
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'before_revision', 'after_revision', 'details'])
      .where('target_type', '=', 'asset')
      .where('target_id', '=', handSet)
      .execute();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'facilities.asset_updated',
        after_revision: of(after, handSet).revision,
        details: expect.objectContaining({ status: 'out_of_service' }),
      }),
    ]);
  });
});
