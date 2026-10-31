import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMPORT_ENTITY_TYPES, newId } from '@sportspark/contracts';
import { seedOrganization } from '@sportspark/db';
import { createTestApp, type TestApp } from '../../../testing';
import { DOMAIN_MODULES } from '../../index';
import { createProgramFixture } from '../../catalog';
import {
  addRosterMemberFixture,
  createCompetitionFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import { createPersonFixture } from '../../identity';
import { at, createScheduledEvent, EventsService, seedPitchWithHalves } from '../../scheduling';
import { AUTHORITY_GUARD_PORT, type AuthorityGuardPort } from '../migration.ports';
import { applicationRouteFacts } from '../../../openapi-document';
import {
  AUTHORITY_EXEMPT_ROUTES,
  classifyWriteRoutes,
  toRouteFactPath,
} from '../services/authority-routes';
import { createAuthorityAssignmentFixture } from '../testing/migration-fixtures';
import { customer, get, key, migrationTestApp, post, staff, type Actor } from './support';

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

function fullApp(): Promise<TestApp> {
  return createTestApp({
    imports: DOMAIN_MODULES,
    principalResolver: 'module',
    clockStart: '2027-01-16T17:00:00.000Z',
  });
}

function patch(t: TestApp, path: string, actor: Actor, body: object) {
  return t.http.patch(path).set(actor.header).set('Idempotency-Key', key()).send(body);
}

async function seasonName(t: TestApp, seasonId: string) {
  return t.db
    .selectFrom('seasons')
    .select(['name', 'revision'])
    .where('id', '=', seasonId)
    .executeTakeFirstOrThrow();
}

describe('AuthorityWriteInterceptor scope (§4.8, §5.6, §4.7 invariant 11)', () => {
  let t: TestApp;
  let gm: Actor;

  beforeAll(async () => {
    t = await fullApp();
    gm = await staff(t, ['general_manager']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('§4.8 / §5.6: a programId added to the body cannot widen what the caller may write', async () => {
    const migrated = await createProgramFixture(t, { name: 'Already migrated' });
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'program',
      authoritativeSystem: 'legacy',
    });
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'program',
      authoritativeSystem: 'sportspark',
      programId: migrated,
    });
    const plain = await post(t, '/v1/programs', gm, { name: 'New league', activityType: 'soccer' });
    expect(plain.status).toBe(403);
    const injected = await post(t, '/v1/programs', gm, {
      name: 'Injected league',
      activityType: 'soccer',
      programId: migrated,
    });
    expect(injected.status, JSON.stringify(injected.body)).toBe(403);
    expect(injected.body.details).toMatchObject({ code: 'LEGACY_AUTHORITY' });
    const created = await t.db
      .selectFrom('programs')
      .select('id')
      .where('organization_id', '=', t.organizationId)
      .where('name', '=', 'Injected league')
      .execute();
    expect(created).toEqual([]);
    // The program the route names in its path still follows its own, narrower assignment.
    const own = await patch(t, `/v1/programs/${migrated}`, gm, {
      description: 'edited in SportsPark',
      expectedRevision: 1,
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
  });

  it('§4.7 invariant 11: a competition-scoped legacy assignment refuses path-only season writes', async () => {
    const legacyLeague = await createCompetitionFixture(t, { name: 'Legacy-only league' });
    const season = await createSeasonFixture(t, { competitionId: legacyLeague, status: 'draft' });
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'season',
      authoritativeSystem: 'legacy',
      competitionId: legacyLeague,
    });
    const before = await seasonName(t, season.seasonId);
    const update = await patch(t, `/v1/seasons/${season.seasonId}`, gm, {
      name: 'Renamed in SportsPark',
      expectedRevision: before.revision,
    });
    expect(update.status, JSON.stringify(update.body)).toBe(403);
    expect(update.body).toMatchObject({
      nextAction: 'write_in_authoritative_system',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'season', scopeResolution: 'unproven' },
    });
    expect((await seasonName(t, season.seasonId)).name).toBe(before.name);
    // A season created under the competition is scoped by its validated competitionId.
    const create = await post(t, '/v1/seasons', gm, {
      competitionId: legacyLeague,
      name: 'Spring',
      ruleSetId: season.ruleSetId,
      startsOn: '2027-03-01',
      endsOn: '2027-05-01',
    });
    expect(create.status).toBe(403);
  });

  it('§4.7 invariant 11: a competitionId added to the body cannot steer a season update', async () => {
    const league = await createCompetitionFixture(t, { name: 'League under org legacy' });
    const migratedLeague = await createCompetitionFixture(t, { name: 'Migrated league' });
    const season = await createSeasonFixture(t, { competitionId: league, status: 'draft' });
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'season',
      authoritativeSystem: 'legacy',
    });
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'season',
      authoritativeSystem: 'sportspark',
      competitionId: migratedLeague,
    });
    const before = await seasonName(t, season.seasonId);
    const injected = await patch(t, `/v1/seasons/${season.seasonId}`, gm, {
      name: 'Renamed by injection',
      expectedRevision: before.revision,
      competitionId: migratedLeague,
    });
    expect(injected.status, JSON.stringify(injected.body)).toBe(403);
    expect((await seasonName(t, season.seasonId)).name).toBe(before.name);
  });
});

describe('AuthorityWriteInterceptor schedule scope (§5.6 shared pitches, authority matrix row 18)', () => {
  it('§5.6: a facility-scoped schedule authority refuses a fixture scheduled at that facility (schedule.facilityId)', async () => {
    const t = await fullApp();
    try {
      const gm = await staff(t, ['general_manager']);
      const pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Pitch 9',
      });
      const season = await createSeasonFixture(t, {
        status: 'active',
        startsOn: '2027-01-10',
        endsOn: '2027-04-10',
      });
      const entry = async (teamName: string) => {
        const captainPersonId = await createPersonFixture(t, { kind: 'adult' });
        const created = await createTeamEntryFixture(t, {
          seasonId: season.seasonId,
          captainPersonId,
          teamName,
        });
        await addRosterMemberFixture(t, {
          teamEntryId: created.teamEntryId,
          personId: captainPersonId,
        });
        return created.teamEntryId;
      };
      const home = await entry('Home FC');
      const away = await entry('Away FC');
      await createAuthorityAssignmentFixture(t, {
        recordCategory: 'future_schedule',
        authoritativeSystem: 'legacy',
        facilityId: t.facilityId,
      });
      const fixture = await post(t, '/v1/fixtures', gm, {
        seasonId: season.seasonId,
        homeEntryId: home,
        awayEntryId: away,
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [pitch.pitchId],
          scheduledStart: at('2027-01-20', '18:00'),
          scheduledEnd: at('2027-01-20', '19:00'),
        },
      });
      expect(fixture.status, JSON.stringify(fixture.body)).toBe(403);
      expect(fixture.body.details).toMatchObject({
        code: 'LEGACY_AUTHORITY',
        recordCategory: 'future_schedule',
      });
      const events = await t.db
        .selectFrom('events')
        .select('id')
        .where('organization_id', '=', t.organizationId)
        .where('facility_id', '=', t.facilityId)
        .execute();
      expect(events).toEqual([]);
      // A path-only schedule change cannot prove its facility: refused while any facility is legacy.
      const reschedule = await patch(t, `/v1/fixtures/${newId()}`, gm, {
        action: 'cancel',
        expectedRevision: 1,
      });
      expect(reschedule.status).toBe(403);
      expect(reschedule.body.details).toMatchObject({ scopeResolution: 'unproven' });
    } finally {
      await t.close();
    }
  });

  it('§5.6 row 18: a closure cannot cancel events on pitches the legacy booking tool still owns', async () => {
    const t = await fullApp();
    try {
      const pitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'P1',
      });
      const game = await createScheduledEvent(t.app.get(EventsService), {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        resourceIds: [pitch.pitchId],
        start: at('2027-01-20', '18:00'),
        end: at('2027-01-20', '19:00'),
        title: 'Synchronized legacy game',
      });
      const ops = await staff(t, ['facilities_operator']);
      const closureBody = {
        facilityId: t.facilityId,
        resourceId: pitch.pitchId,
        interval: { start: at('2027-01-20', '08:00'), end: at('2027-01-20', '22:00') },
        reason: 'Turf repair',
        source: 'maintenance',
      };
      // Without an assignment SportsPark owns the pitch and records the closure.
      const closure = await post(t, '/v1/closures', ops, closureBody);
      expect(closure.status, JSON.stringify(closure.body)).toBe(201);
      await createAuthorityAssignmentFixture(t, {
        recordCategory: 'future_schedule',
        authoritativeSystem: 'legacy',
      });
      const applied = await post(t, `/v1/closures/${closure.body.id}/apply`, ops, {
        mode: 'cancel_affected',
        expectedRevision: closure.body.revision,
      });
      expect(applied.status).toBe(403);
      expect(applied.body.details).toMatchObject({ code: 'LEGACY_AUTHORITY' });
      expect((await post(t, '/v1/closures', ops, closureBody)).status).toBe(403);
      const event = await t.db
        .selectFrom('events')
        .select('status')
        .where('id', '=', game.id)
        .executeTakeFirstOrThrow();
      expect(event.status).toBe('published');
    } finally {
      await t.close();
    }
  });
});

describe('AUTHORITY_ROUTES and K-11 decorators (deny-by-default classification, MIG-00)', () => {
  let t: TestApp;
  const served = new Set<string>();
  const facts = applicationRouteFacts();
  const report = classifyWriteRoutes(facts);

  beforeAll(async () => {
    t = await fullApp();
    const express = t.app.getHttpAdapter().getInstance() as {
      router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
      _router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> };
    };
    const stack = (express.router ?? express._router)?.stack ?? [];
    for (const layer of stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        served.add(
          `${method.toUpperCase()} ${toRouteFactPath(layer.route.path.replace(/^\/v1(?=\/)/, ''))}`,
        );
      }
    }
  });
  afterAll(async () => {
    await t.close();
  });

  it('§5.6: every served write route is classified exactly once — by its decorator or one list entry, guarded with a scope source or exempt with a reason', () => {
    expect(served.size).toBeGreaterThan(100);
    // The route facts the check reads are the routes the application serves (K-02).
    const writes = [...served].filter((k) => /^(POST|PATCH|PUT|DELETE) /.test(k));
    const factKeys = new Set(facts.map((f) => `${f.method} ${f.path}`));
    expect(writes.filter((k) => !factKeys.has(k)).sort()).toEqual([]);
    expect(report.unclassified).toEqual([]);
    expect(report.classifiedTwice).toEqual([]);
    expect(report.listedNotServed).toEqual([]);
    for (const route of report.guarded) {
      expect(IMPORT_ENTITY_TYPES, `${route.method} ${route.path}`).toContain(route.category);
      const scope = route.scope;
      const valid =
        scope === 'organization' ||
        scope === 'unproven' ||
        (typeof scope === 'object' && scope !== null && Object.keys(scope).length > 0);
      expect(valid, `${route.method} ${route.path} declares its scope source`).toBe(true);
    }
    for (const route of AUTHORITY_EXEMPT_ROUTES) {
      expect(route.reason.length, `${route.method} ${route.path}`).toBeGreaterThan(10);
    }
    for (const fact of facts) {
      if (fact.recordAuthority?.kind === 'exempt') {
        expect(fact.recordAuthority.reason.length, `${fact.method} ${fact.path}`).toBeGreaterThan(
          10,
        );
      }
    }
  });

  it('§4.7 invariant 11: every guarded route — listed or decorated — is refused while its category is legacy-authoritative, and only then', async () => {
    const gm = await staff(t, ['general_manager']);
    const guarded = report.guarded;
    expect(guarded.some((r) => r.source === 'decorator')).toBe(true);
    const sendGuarded = (route: (typeof guarded)[number]) => {
      const path = `/v1${route.path.replace(/\{[A-Za-z]+\}/g, () => newId())}`;
      const method = route.method.toLowerCase() as 'post' | 'patch' | 'put' | 'delete';
      return t.http[method](path).set(gm.header).set('Idempotency-Key', key()).send({});
    };
    // Without any assignment SportsPark is authoritative: the guard never answers.
    for (const route of guarded) {
      const res = await sendGuarded(route);
      expect(res.body?.details?.code, `${route.method} ${route.path}`).not.toBe('LEGACY_AUTHORITY');
    }
    for (const recordCategory of IMPORT_ENTITY_TYPES) {
      await createAuthorityAssignmentFixture(t, { recordCategory, authoritativeSystem: 'legacy' });
    }
    for (const route of guarded) {
      const res = await sendGuarded(route);
      expect(res.status, `${route.method} ${route.path} (${route.source})`).toBe(403);
      expect(res.body.details, `${route.method} ${route.path}`).toMatchObject({
        code: 'LEGACY_AUTHORITY',
        recordCategory: route.category,
      });
    }
  });

  it('§5.6 row 1: merging two people is refused while the legacy system writes people', async () => {
    const other = await seedOrganization(t.db);
    const sysadmin = await staff(t, ['system_administrator'], {
      organizationId: other.organizationId,
    });
    const support = await staff(t, ['support_operator'], { organizationId: other.organizationId });
    const a = await createPersonFixture(t, { kind: 'adult', organizationId: other.organizationId });
    const b = await createPersonFixture(t, { kind: 'adult', organizationId: other.organizationId });
    const candidate = await post(t, '/v1/duplicate-candidates', support, {
      personAId: a,
      personBId: b,
      reasons: ['same name and date of birth'],
    });
    expect(candidate.status, JSON.stringify(candidate.body)).toBe(201);
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'person',
      authoritativeSystem: 'legacy',
      organizationId: other.organizationId,
    });
    const merge = await post(t, `/v1/duplicate-candidates/${candidate.body.id}/merge`, sysadmin, {
      survivorPersonId: a,
      reason: 'duplicate',
      expectedRevision: candidate.body.revision,
    });
    expect(merge.status).toBe(403);
    expect(merge.body.details).toMatchObject({
      code: 'LEGACY_AUTHORITY',
      recordCategory: 'person',
    });
    const merged = await t.db
      .selectFrom('persons')
      .select('status')
      .where('id', '=', b)
      .executeTakeFirstOrThrow();
    expect(merged.status).not.toBe('merged');
  });
});
