import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedOrganization } from '@sportspark/db';
import { createTestApp, type TestApp } from '../../../testing';
import { DOMAIN_MODULES } from '../../index';
import { createProgramFixture } from '../../catalog';
import { AUTHORITY_GUARD_PORT, type AuthorityGuardPort } from '../migration.ports';
import { AUTHORITY_ROUTES } from '../services/authority-routes';
import { customer, get, migrationTestApp, post, staff, type Actor } from './support';

const HOUR = 3_600_000;

describe('authority matrix and AuthorityGuard (§5.6, §4.7 invariant 11)', () => {
  let t: TestApp;
  let gm: Actor;
  let desk: Actor;

  beforeAll(async () => {
    t = await migrationTestApp();
    gm = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  const person = { kind: 'adult', givenName: 'Walk', familyName: 'In', contactPoints: [] };

  it('§5.6: while the legacy system is authoritative for people, SportsPark refuses to become a second writer; after the transfer it writes', async () => {
    // Default: no assignment, SportsPark is authoritative.
    expect((await post(t, '/v1/people', desk, person)).status).toBe(201);
    const legacy = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'person',
      authoritativeSystem: 'legacy',
      reason: 'Registration stays in the legacy system until cutover',
      policyReferences: ['DEC-migration-scope'],
    });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
    expect(legacy.body).toMatchObject({
      recordCategory: 'person',
      scope: { kind: 'organization' },
      authoritativeSystem: 'legacy',
      effectiveTo: null,
    });
    const refused = await post(t, '/v1/people', desk, person);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      code: 'ACCESS_DENIED',
      nextAction: 'write_in_authoritative_system',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'person', assignmentId: legacy.body.id },
    });
    // Other categories are unaffected.
    expect((await post(t, '/v1/households', desk, { name: 'Unaffected' })).status).toBe(201);

    // The port answers the same for in-process callers.
    const guard = t.app.get<AuthorityGuardPort>(AUTHORITY_GUARD_PORT);
    await expect(guard.assertSportsparkAuthority(t.organizationId, 'person')).rejects.toMatchObject(
      { code: 'ACCESS_DENIED' },
    );

    // Cutover: a transfer must name the assignment in effect with its revision (§4.9).
    t.clock.advance(HOUR);
    const unnamed = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'person',
      authoritativeSystem: 'sportspark',
      reason: 'cutover',
    });
    expect(unnamed.status).toBe(409);
    expect(unnamed.body.details).toMatchObject({
      code: 'AUTHORITY_IN_EFFECT',
      assignmentId: legacy.body.id,
    });
    const stale = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'person',
      authoritativeSystem: 'sportspark',
      reason: 'cutover',
      supersedes: { assignmentId: legacy.body.id, expectedRevision: 7 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const transfer = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'person',
      authoritativeSystem: 'sportspark',
      reason: 'Cutover: registration moves to SportsPark',
      supersedes: { assignmentId: legacy.body.id, expectedRevision: legacy.body.revision },
    });
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(201);
    expect(transfer.body.supersedesAssignmentId).toBe(legacy.body.id);
    const ended = await get(t, `/v1/authority-assignments/${legacy.body.id}`, desk);
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({
      effectiveTo: transfer.body.effectiveFrom,
      endedAt: transfer.body.effectiveFrom,
    });
    expect((await post(t, '/v1/people', desk, person)).status).toBe(201);
    await expect(
      guard.assertSportsparkAuthority(t.organizationId, 'person'),
    ).resolves.toMatchObject({ authoritativeSystem: 'sportspark', basis: 'assignment' });

    // The history of who was authoritative is kept: one hour ago the legacy system was.
    const past = new Date(t.clock.now().getTime() - HOUR / 2).toISOString();
    const matrix = await get(t, `/v1/authority-matrix?at=${encodeURIComponent(past)}`, desk);
    expect(matrix.status).toBe(200);
    expect(
      matrix.body.entries.find((e: { recordCategory: string }) => e.recordCategory === 'person'),
    ).toMatchObject({
      authoritativeSystem: 'legacy',
      assignmentId: legacy.body.id,
    });
  });

  it('§5.6: the most specific scope decides; program writes follow a program-scoped assignment', async () => {
    const program = { programId: await createProgramFixture(t, { name: 'Legacy Futsal League' }) };
    const other = { programId: await createProgramFixture(t, { name: 'Native Academy' }) };
    const scoped = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'program',
      scope: { kind: 'program', programId: program.programId },
      authoritativeSystem: 'legacy',
      reason: 'This league is still run in the legacy system',
    });
    expect(scoped.status, JSON.stringify(scoped.body)).toBe(201);
    const manager = await staff(t, ['program_manager']);
    const refused = await t.http
      .patch(`/v1/programs/${program.programId}`)
      .set(manager.header)
      .set('Idempotency-Key', `k-${program.programId}`)
      .send({ description: 'edited', expectedRevision: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body.nextAction).toBe('write_in_authoritative_system');
    const allowed = await t.http
      .patch(`/v1/programs/${other.programId}`)
      .set(manager.header)
      .set('Idempotency-Key', `k-${other.programId}`)
      .send({ description: 'edited', expectedRevision: 1 });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    const matrix = await get(t, `/v1/authority-matrix?programId=${program.programId}`, desk);
    expect(
      matrix.body.entries.find((e: { recordCategory: string }) => e.recordCategory === 'program'),
    ).toMatchObject({
      authoritativeSystem: 'legacy',
      scope: { kind: 'program', programId: program.programId },
    });
  });

  it('§5.6: schedule authority is one per organization or facility, never per program', async () => {
    const program = { programId: await createProgramFixture(t, { name: 'Schedule test' }) };
    const refused = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'future_schedule',
      scope: { kind: 'program', programId: program.programId },
      authoritativeSystem: 'legacy',
      reason: 'x',
    });
    expect(refused.status).toBe(400);
    const facility = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'future_schedule',
      scope: { kind: 'facility', facilityId: t.facilityId },
      authoritativeSystem: 'legacy',
      reason: 'The legacy booking tool owns the pitches until cutover',
    });
    expect(facility.status).toBe(201);
    const scheduler = await staff(t, ['scheduler']);
    const draft = await post(t, '/v1/schedule-drafts', scheduler, {
      facilityId: t.facilityId,
      name: 'Week 1',
    });
    expect(draft.status).toBe(403);
    expect(draft.body.details).toMatchObject({ recordCategory: 'future_schedule' });
  });

  it('§4.7 invariant 11: an overlapping assignment is refused; authority is never assigned or ended retroactively', async () => {
    const future = new Date(t.clock.now().getTime() + 24 * HOUR).toISOString();
    const planned = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'credit',
      authoritativeSystem: 'legacy',
      effectiveFrom: future,
      reason: 'credits stay in the legacy system from tomorrow',
    });
    expect(planned.status).toBe(201);
    const overlapping = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'credit',
      authoritativeSystem: 'sportspark',
      effectiveFrom: t.clock.now().toISOString(),
      reason: 'overlaps the planned assignment',
    });
    expect(overlapping.status).toBe(409);
    expect(overlapping.body.details).toMatchObject({ code: 'AUTHORITY_OVERLAP' });
    const past = new Date(t.clock.now().getTime() - HOUR).toISOString();
    const retro = await post(t, '/v1/authority-assignments', gm, {
      recordCategory: 'refund',
      authoritativeSystem: 'legacy',
      effectiveFrom: past,
      reason: 'retroactive',
    });
    expect(retro.status).toBe(400);
    const endRetro = await post(t, `/v1/authority-assignments/${planned.body.id}/end`, gm, {
      effectiveTo: past,
      reason: 'x',
      expectedRevision: planned.body.revision,
    });
    expect(endRetro.status).toBe(400);
    const end = await post(t, `/v1/authority-assignments/${planned.body.id}/end`, gm, {
      effectiveTo: new Date(t.clock.now().getTime() + 48 * HOUR).toISOString(),
      reason: 'credits move after two days',
      expectedRevision: planned.body.revision,
    });
    expect(end.status, JSON.stringify(end.body)).toBe(200);
    expect(end.body.revision).toBe(2);
    const again = await post(t, `/v1/authority-assignments/${planned.body.id}/end`, gm, {
      reason: 'twice',
      expectedRevision: end.body.revision,
    });
    expect(again.status).toBe(409);
  });

  it('§6.6: only the operator assigns writer authority; every staff role may read the matrix; other organizations see nothing', async () => {
    const sysadmin = await staff(t, ['system_administrator']);
    const parent = await customer(t);
    const body = { recordCategory: 'document', authoritativeSystem: 'legacy', reason: 'x' };
    expect((await post(t, '/v1/authority-assignments', sysadmin, body)).status).toBe(403);
    expect((await post(t, '/v1/authority-assignments', desk, body)).status).toBe(403);
    expect((await post(t, '/v1/authority-assignments', parent, body)).status).toBe(403);
    expect((await get(t, '/v1/authority-matrix', parent)).status).toBe(403);
    const coach = await staff(t, ['coach']);
    const list = await get(t, '/v1/authority-assignments', coach);
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    const other = await seedOrganization(t.db);
    const otherGm = await staff(t, ['general_manager'], { organizationId: other.organizationId });
    const foreign = await get(t, '/v1/authority-assignments', otherGm);
    expect(foreign.body.items).toEqual([]);
    const id = list.body.items[0].id as string;
    expect((await get(t, `/v1/authority-assignments/${id}`, otherGm)).status).toBe(404);
    // The other organization is not affected by this organization's legacy authority.
    const otherDesk = await staff(t, ['front_desk'], { organizationId: other.organizationId });
    expect((await post(t, '/v1/people', otherDesk, person)).status).toBe(201);
  });
});

describe('AUTHORITY_ROUTES', () => {
  it('§5.6: every guarded write route is a route the complete application serves', async () => {
    const app = await createTestApp({ imports: DOMAIN_MODULES, principalResolver: 'module' });
    try {
      const express = app.app.getHttpAdapter().getInstance() as {
        router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
        _router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      };
      const stack = (express.router ?? express._router)?.stack ?? [];
      const served = new Set<string>();
      for (const layer of stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods)) {
          served.add(`${method.toUpperCase()} ${layer.route.path.replace(/^\/v1(?=\/)/, '')}`);
        }
      }
      expect(served.size).toBeGreaterThan(100);
      const missing = AUTHORITY_ROUTES.map((r) => `${r.method} ${r.path}`).filter(
        (k) => !served.has(k),
      );
      expect(missing).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
