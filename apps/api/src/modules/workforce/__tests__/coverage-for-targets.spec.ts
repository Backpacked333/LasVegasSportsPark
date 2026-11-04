import { newId, type AssignmentTargetQuery } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import { coverageTargetKey, CoverageService } from '../services/coverage.service';
import { RequirementsService } from '../services/requirements.service';
import {
  competitionWorld,
  key,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type CompetitionWorld,
} from './support';

/**
 * R3-PERFORMANCE-01 (SPK-UX-006, SPK-STAFF-002): support's Today feed reads the required roles of
 * a whole facility day. `RequirementsService.listForTargets` gives every target exactly what
 * `list` gives it one at a time (requirements in force with their coverage), in two queries for
 * all targets and one authorization decision per facility, and answers `'not_permitted'` for a
 * target the caller may not read instead of failing the whole read.
 */
describe('requirements and coverage for many targets in one read (R3-PERFORMANCE-01)', () => {
  let t: TestApp;
  let world: CompetitionWorld;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
  });
  afterAll(async () => {
    await t.close();
  });

  const requirement = async (
    targetType: 'fixture' | 'event',
    targetId: string,
    role: string,
    requiredCount: number,
    kind: 'official' | 'coach' = 'official',
  ) => {
    const res = await post(t, '/v1/assignment-requirements', world.leagueManager, {
      targetType,
      targetId,
      kind,
      role,
      requiredCount,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; revision: number };
  };

  it('R3-PERFORMANCE-01 / SPK-STAFF-002: listForTargets answers each target as list does, in two queries and one decision per facility', async () => {
    const first = await scheduleFixture(t, world, {
      date: '2027-03-01',
      from: '17:00',
      to: '18:00',
    });
    const second = await scheduleFixture(t, world, {
      date: '2027-03-01',
      from: '19:00',
      to: '20:00',
    });
    const bare = await scheduleFixture(t, world, {
      date: '2027-03-01',
      from: '21:00',
      to: '22:00',
    });
    await requirement('fixture', first.fixtureId, 'referee', 1);
    await requirement('fixture', first.fixtureId, 'assistant_referee', 2);
    const retired = await requirement('fixture', second.fixtureId, 'fourth_official', 1);
    await requirement('fixture', second.fixtureId, 'referee', 1);
    await requirement('event', second.eventId, 'steward', 1, 'coach');
    // An accepted referee covers the first fixture's slot; an offered assistant is counted only.
    const referee = await staffMember(t, ['official']);
    const proposed = await post(t, '/v1/assignments', world.leagueManager, {
      personId: referee.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: first.fixtureId,
      role: 'referee',
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const offered = await post(
      t,
      `/v1/assignments/${proposed.body.assignment.id}/offer`,
      world.leagueManager,
      { expectedRevision: proposed.body.assignment.revision },
    );
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    const accepted = await t.http
      .post(`/v1/assignments/${proposed.body.assignment.id}/accept`)
      .set(referee.header)
      .set('Idempotency-Key', key())
      .send({ expectedRevision: offered.body.assignment.revision });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const assistant = await staffMember(t, ['official']);
    const assistantProposed = await post(t, '/v1/assignments', world.leagueManager, {
      personId: assistant.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: first.fixtureId,
      role: 'assistant_referee',
    });
    expect(assistantProposed.status, JSON.stringify(assistantProposed.body)).toBe(201);
    const assistantOffered = await post(
      t,
      `/v1/assignments/${assistantProposed.body.assignment.id}/offer`,
      world.leagueManager,
      { expectedRevision: assistantProposed.body.assignment.revision },
    );
    expect(assistantOffered.status, JSON.stringify(assistantOffered.body)).toBe(200);
    // A retired requirement is left out, as list leaves it out (WRK-02; retired by the owning
    // follow-ups, set directly here).
    await t.db
      .updateTable('assignment_requirements')
      .set({
        retired_at: new Date('2027-02-01T00:00:00Z'),
        retired_reason: 'Not needed for this fixture',
        retired_by: json({ kind: 'system', actorLabel: 'test' }),
      })
      .where('id', '=', retired.id)
      .execute();

    const targets: AssignmentTargetQuery[] = [
      { targetType: 'fixture', targetId: first.fixtureId },
      { targetType: 'fixture', targetId: second.fixtureId },
      { targetType: 'event', targetId: second.eventId },
      { targetType: 'fixture', targetId: bare.fixtureId },
      { targetType: 'event', targetId: newId() },
    ];
    const manager = staffPrincipal(t.organizationId, ['league_manager']);
    const service = t.app.get(RequirementsService);
    const one = new Map<string, unknown>();
    for (const target of targets) {
      one.set(
        coverageTargetKey(target.targetType, target.targetId),
        await service.list(manager, target),
      );
    }

    const decide = vi.spyOn(t.app.get(AuthorizationService), 'decide');
    const single = vi.spyOn(t.app.get(CoverageService), 'coverage');
    const many = await service.listForTargets(manager, targets);
    expect(single).not.toHaveBeenCalled();
    // One decision for the facility the requirements are at and one for the targets without any.
    expect(decide).toHaveBeenCalledTimes(2);
    decide.mockRestore();
    single.mockRestore();
    expect(new Map(many)).toEqual(one);
    const firstViews = many.get(coverageTargetKey('fixture', first.fixtureId));
    expect(firstViews).not.toBe('not_permitted');
    expect(
      (firstViews as Array<{ role: string; coverage: unknown }>).map((r) => [r.role, r.coverage]),
    ).toEqual([
      ['assistant_referee', { accepted: 0, offered: 1, proposed: 0, uncoveredSlots: [1, 2] }],
      ['referee', { accepted: 1, offered: 0, proposed: 0, uncoveredSlots: [] }],
    ]);
    expect(many.get(coverageTargetKey('fixture', bare.fixtureId))).toEqual([]);

    // Two statements whatever the number of targets: requirements, then their assignments.
    const statements: unknown[] = [];
    const counting = t.db.withPlugin({
      transformQuery: (args) => args.node,
      transformResult: (args) => {
        statements.push(args.queryId);
        return Promise.resolve(args.result);
      },
    });
    const coverage = t.app.get(CoverageService);
    await coverage.coverageForTargets(counting, t.organizationId, targets);
    expect(statements).toHaveLength(2);
    statements.length = 0;
    await coverage.coverageForTargets(counting, t.organizationId, targets.slice(0, 1));
    expect(statements).toHaveLength(2);
    statements.length = 0;
    expect(await coverage.coverageForTargets(counting, t.organizationId, [])).toEqual(new Map());
    expect(statements).toHaveLength(0);
  });

  it('§4.3, §4.14: a target at a facility outside the caller’s scope is not_permitted, never an error that hides the others', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-03-02' });
    await requirement('fixture', game.fixtureId, 'referee', 1);
    const elsewhere = staffPrincipal(t.organizationId, ['league_manager'], {
      facilityIds: [newId()],
    });
    const unrequired = { targetType: 'event' as const, targetId: newId() };
    const service = t.app.get(RequirementsService);
    await expect(
      service.list(elsewhere, { targetType: 'fixture', targetId: game.fixtureId }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const many = await service.listForTargets(elsewhere, [
      { targetType: 'fixture', targetId: game.fixtureId },
      unrequired,
    ]);
    expect(many.get(coverageTargetKey('fixture', game.fixtureId))).toBe('not_permitted');
    expect(many.get(coverageTargetKey(unrequired.targetType, unrequired.targetId))).toEqual(
      await service.list(elsewhere, unrequired),
    );
  });
});
