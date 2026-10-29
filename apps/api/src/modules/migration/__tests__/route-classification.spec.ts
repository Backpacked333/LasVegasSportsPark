import { Body, Controller, HttpCode, Module, Param, Post } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@sportspark/contracts';
import { createTestApp, type TestApp } from '../../../testing';
import {
  collectRouteFacts,
  Idempotent,
  NoRecordAuthority,
  RECORD_AUTHORITY_PORT,
  RecordAuthority,
  type RecordAuthorityPort,
} from '../../../kernel';
import { createProgramFixture } from '../../catalog';
import { MigrationModule } from '../migration.module';
import {
  AUTHORITY_EXEMPT_ROUTES,
  AUTHORITY_ROUTES,
  classifyWriteRoutes,
} from '../services/authority-routes';
import { createAuthorityAssignmentFixture } from '../testing/migration-fixtures';
import { CLOCK_START, key, staff, type Actor } from './support';

/**
 * MIG-00 (§5.6 "a synchronized copy never becomes an independent writer", §4.7 invariant 11,
 * IF-41, IF-42): a write route classifies itself with the kernel's `@RecordAuthority` /
 * `@NoRecordAuthority` decorators; AuthorityWriteInterceptor reads the decorator first and falls
 * back to the static lists, and the classification check counts both.
 */
@Controller('mig00-probe')
class ProbeController {
  @Post('people')
  @Idempotent()
  @RecordAuthority('person', 'organization')
  createPerson(): { ok: true } {
    return { ok: true };
  }

  @Post('slots')
  @Idempotent()
  @RecordAuthority('future_schedule', { facilityId: 'body.facilityId' })
  slot(@Body() body: { facilityId?: string }): { facilityId: string | null } {
    return { facilityId: body.facilityId ?? null };
  }

  @Post('programs/:id/notes')
  @HttpCode(200)
  @Idempotent()
  @RecordAuthority('program')
  programNote(@Param('id') id: string): { id: string } {
    return { id };
  }

  @Post('notes')
  @Idempotent()
  @NoRecordAuthority('Not a §5.3 record category: a probe note')
  note(): { ok: true } {
    return { ok: true };
  }

  /** Neither decorated nor listed: the classification check must report it. */
  @Post('unclassified')
  @Idempotent()
  unclassified(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const send = (t: TestApp, path: string, actor: Actor, body: object = {}) =>
  t.http.post(path).set(actor.header).set('Idempotency-Key', key()).send(body);

describe('route classification by decorator (MIG-00, §5.6, IF-41)', () => {
  const probeFacts = collectRouteFacts([ProbeModule]);

  it('a route both listed and decorated fails the classification test', () => {
    const report = classifyWriteRoutes(probeFacts, {
      guarded: [
        ...AUTHORITY_ROUTES,
        { method: 'POST', path: '/mig00-probe/people', category: 'person', scope: 'organization' },
      ],
      exempt: [
        ...AUTHORITY_EXEMPT_ROUTES,
        { method: 'POST', path: '/mig00-probe/notes', reason: 'listed and decorated' },
      ],
    });
    expect(report.classifiedTwice).toEqual(['POST /mig00-probe/notes', 'POST /mig00-probe/people']);
    // The two entries are counted once each from the lists and once from the decorators.
    const once = classifyWriteRoutes(probeFacts, { guarded: [], exempt: [] });
    expect(once.classifiedTwice).toEqual([]);
  });

  it('an unclassified new write route fails the classification test', () => {
    const report = classifyWriteRoutes(probeFacts, { guarded: [], exempt: [] });
    expect(report.unclassified).toEqual(['POST /mig00-probe/unclassified']);
    const byPath = [...report.guarded].sort((a, b) => a.path.localeCompare(b.path));
    expect(byPath).toEqual([
      {
        method: 'POST',
        path: '/mig00-probe/people',
        category: 'person',
        scope: 'organization',
        source: 'decorator',
      },
      {
        method: 'POST',
        path: '/mig00-probe/programs/{id}/notes',
        category: 'program',
        scope: 'unproven',
        source: 'decorator',
      },
      {
        method: 'POST',
        path: '/mig00-probe/slots',
        category: 'future_schedule',
        scope: { facilityId: 'body.facilityId' },
        source: 'decorator',
      },
    ]);
    // A list entry no served route matches is reported as stale.
    const stale = classifyWriteRoutes(probeFacts, {
      guarded: [{ method: 'POST', path: '/mig00-probe/gone', category: 'team', scope: 'unproven' }],
      exempt: [],
    });
    expect(stale.listedNotServed).toEqual(['POST /mig00-probe/gone']);
  });
});

describe('decorator-guarded routes at run time (MIG-00, §5.6, §4.7 invariant 11)', () => {
  let t: TestApp;
  let gm: Actor;
  let desk: Actor;

  beforeAll(async () => {
    t = await createTestApp({
      imports: [MigrationModule, ProbeModule],
      principalResolver: 'module',
      clockStart: CLOCK_START,
    });
    gm = await staff(t, ['general_manager']);
    desk = await staff(t, ['front_desk']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('§5.6: a route classified by decorator is guarded exactly like a listed one', async () => {
    const person = { kind: 'adult', givenName: 'Probe', familyName: 'Person', contactPoints: [] };
    // Without an assignment SportsPark is authoritative: both are served.
    const first = await send(t, '/v1/people', desk, person);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await send(t, '/v1/mig00-probe/people', gm)).status).toBe(201);
    const assignmentId = await createAuthorityAssignmentFixture(t, {
      recordCategory: 'person',
      authoritativeSystem: 'legacy',
    });
    const listed = await send(t, '/v1/people', desk, person);
    const decorated = await send(t, '/v1/mig00-probe/people', gm);
    expect(listed.status).toBe(403);
    expect(decorated.status).toBe(403);
    const refusal = (body: Record<string, unknown>) => ({
      code: body['code'],
      nextAction: body['nextAction'],
      details: body['details'],
    });
    expect(refusal(decorated.body)).toEqual(refusal(listed.body));
    expect(decorated.body).toMatchObject({
      code: 'ACCESS_DENIED',
      nextAction: 'write_in_authoritative_system',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'person', assignmentId },
    });
    // @NoRecordAuthority is never guarded.
    expect((await send(t, '/v1/mig00-probe/notes', gm)).status).toBe(201);
  });

  it('§4.8 / §5.6: a decorator-declared scope is read from the validated field only', async () => {
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'future_schedule',
      authoritativeSystem: 'legacy',
      facilityId: t.facilityId,
    });
    const legacy = await send(t, '/v1/mig00-probe/slots', gm, { facilityId: t.facilityId });
    expect(legacy.status).toBe(403);
    expect(legacy.body.details).toMatchObject({
      code: 'LEGACY_AUTHORITY',
      recordCategory: 'future_schedule',
    });
    // Another facility has no assignment: SportsPark is authoritative there.
    const other = await send(t, '/v1/mig00-probe/slots', gm, { facilityId: newId() });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
  });

  it('§4.7 invariant 11: an unproven decorated route is refused while any scope of its category is legacy', async () => {
    const legacyProgram = await createProgramFixture(t, { name: 'Legacy-run league' });
    const migrated = await createProgramFixture(t, { name: 'Migrated academy' });
    expect((await send(t, `/v1/mig00-probe/programs/${migrated}/notes`, gm)).status).toBe(200);
    await createAuthorityAssignmentFixture(t, {
      recordCategory: 'program',
      authoritativeSystem: 'legacy',
      programId: legacyProgram,
    });
    const refused = await send(t, `/v1/mig00-probe/programs/${migrated}/notes`, gm);
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({
      code: 'LEGACY_AUTHORITY',
      recordCategory: 'program',
      scopeResolution: 'unproven',
    });
  });

  it('IF-42: the kernel RECORD_AUTHORITY_PORT answers from the authority matrix (most specific scope; any legacy scope without one)', async () => {
    const port = t.app.get<RecordAuthorityPort>(RECORD_AUTHORITY_PORT);
    // future_schedule is legacy for the test facility only (previous test).
    await expect(
      port.assertNoLegacyAuthority(t.organizationId, 'future_schedule', {
        facilityId: t.facilityId,
      }),
    ).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
      nextAction: 'write_in_authoritative_system',
      details: { code: 'LEGACY_AUTHORITY', recordCategory: 'future_schedule' },
    });
    await expect(
      port.assertNoLegacyAuthority(t.organizationId, 'future_schedule', { facilityId: newId() }),
    ).resolves.toBeUndefined();
    await expect(
      port.assertNoLegacyAuthority(t.organizationId, 'future_schedule'),
    ).rejects.toMatchObject({ details: { code: 'LEGACY_AUTHORITY', scopeResolution: 'unproven' } });
    // A category with no assignment at all: SportsPark is authoritative.
    await expect(port.assertNoLegacyAuthority(t.organizationId, 'credit')).resolves.toBeUndefined();
  });
});
