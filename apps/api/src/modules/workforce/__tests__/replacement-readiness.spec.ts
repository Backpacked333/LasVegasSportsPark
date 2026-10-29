import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { ASSIGNMENT_CHECK_PORT, type AssignmentCheckPort } from '../../competition';
import { at } from '../../scheduling';
import {
  createAssignmentFixture,
  createAvailabilityFixture,
  createQualificationFixture,
} from '../testing/workforce-fixtures';
import { REQUIRED_OFFICIALS_CHECK } from '../workforce.policy';
import {
  competitionWorld,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
  type ScheduledFixture,
} from './support';

interface ReadinessBody {
  status: string;
  checks: Array<{ name: string; status: string; issueCount: number }>;
  issues: Array<{ code: string; severity: string; source: { type: string; id: string | null } }>;
}

describe('SPK-AT-012: referee declines shortly before kickoff — uncovered assignment, replacement workflow, readiness update', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let leagueManager: Actor;
  let game: ScheduledFixture;
  let referee: Actor;
  let substitute: Actor;
  let unqualified: Actor;
  let unavailable: Actor;
  let busy: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    leagueManager = world.leagueManager;
    // Kickoff 18:00 local on 2027-01-16; the clock stands at 12:00 local the same day.
    game = await scheduleFixture(t, world, { date: '2027-01-16' });
    referee = await staffMember(t, ['official']);
    substitute = await staffMember(t, ['official']);
    unqualified = await staffMember(t, ['official']);
    unavailable = await staffMember(t, ['official']);
    busy = await staffMember(t, ['official']);
    for (const person of [referee, substitute, unavailable, busy]) {
      await createQualificationFixture(t, { personId: person.personId, kind: 'referee_grade_7' });
    }
    await createAvailabilityFixture(t, {
      personId: substitute.personId,
      start: at('2027-01-16', '08:00'),
      end: at('2027-01-16', '23:00'),
      kind: 'available',
    });
    await createAvailabilityFixture(t, {
      personId: unavailable.personId,
      start: at('2027-01-16', '17:00'),
      end: at('2027-01-16', '20:00'),
      kind: 'unavailable',
    });
    // `busy` already holds an accepted assignment (match observer on the game's event) at that time
    await createAssignmentFixture(t, {
      personId: busy.personId,
      targetType: 'event',
      targetId: game.eventId,
      scheduledStart: game.start,
      scheduledEnd: game.end,
      status: 'accepted',
      role: 'match_observer',
      kind: 'official',
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const readiness = async (): Promise<ReadinessBody> => {
    const res = await t.http
      .get(`/v1/fixtures/${game.fixtureId}/readiness`)
      .set(leagueManager.header);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as ReadinessBody;
  };
  const officialsCheck = (body: ReadinessBody) =>
    body.checks.find((c) => c.name === REQUIRED_OFFICIALS_CHECK);

  it('walks the whole journey', async () => {
    // 0. Without a declared requirement the officials check is informational, never "unknown".
    let body = await readiness();
    expect(officialsCheck(body)).toMatchObject({ status: 'ready' });
    expect(body.issues.map((i) => i.code)).toContain('officials_not_required');
    expect(body.issues.map((i) => i.code)).not.toContain('officials_unknown');

    // 1. The league requires one accepted, qualified referee.
    const requirement = await post(t, '/v1/assignment-requirements', leagueManager, {
      targetType: 'fixture',
      targetId: game.fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
      requiredQualifications: ['referee_grade_7'],
    });
    expect(requirement.status, JSON.stringify(requirement.body)).toBe(201);
    expect(requirement.body.coverage).toEqual({
      accepted: 0,
      offered: 0,
      proposed: 0,
      uncoveredSlots: [1],
    });
    body = await readiness();
    expect(officialsCheck(body)).toMatchObject({ status: 'blocked' });

    // 2. SPK-STAFF-002: a proposed assignment does not satisfy the check; neither does an offer.
    const proposed = await post(t, '/v1/assignments', leagueManager, {
      personId: referee.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: game.fixtureId,
      role: 'referee',
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const refereeAssignmentId = proposed.body.assignment.id as string;
    body = await readiness();
    expect(officialsCheck(body)).toMatchObject({ status: 'blocked' });
    expect(body.issues.find((i) => i.code === 'required_officials_not_accepted')).toMatchObject({
      severity: 'blocking',
      source: { type: 'assignment_requirement', id: requirement.body.id },
    });
    await post(t, `/v1/assignments/${refereeAssignmentId}/offer`, leagueManager, {});
    body = await readiness();
    expect(officialsCheck(body)).toMatchObject({ status: 'blocked' });

    // 3. Acceptance makes the officials check ready; the accepted official may submit results.
    const accepted = await post(t, `/v1/assignments/${refereeAssignmentId}/accept`, referee, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    body = await readiness();
    expect(officialsCheck(body)).toMatchObject({ status: 'ready', issueCount: 0 });
    const assignmentCheck = t.app.get<AssignmentCheckPort>(ASSIGNMENT_CHECK_PORT, {
      strict: false,
    });
    expect(
      await assignmentCheck.isAcceptedOfficial(t.organizationId, game.fixtureId, referee.personId),
    ).toBe(true);
    expect(
      await assignmentCheck.isAcceptedOfficial(
        t.organizationId,
        game.fixtureId,
        substitute.personId,
      ),
    ).toBe(false);

    // 4. Six hours before kickoff the referee pulls out: uncovered, escalated, readiness blocked.
    const withdrawn = await post(t, `/v1/assignments/${refereeAssignmentId}/withdraw`, referee, {
      reason: 'Sick',
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.uncovered).toMatchObject({
      role: 'referee',
      slot: 1,
      startsAt: game.start,
      exceptionId: expect.any(String),
    });
    const exception = await t.db
      .selectFrom('operational_exceptions')
      .selectAll()
      .where('id', '=', withdrawn.body.uncovered.exceptionId)
      .executeTakeFirstOrThrow();
    expect(exception).toMatchObject({
      category: 'workforce.uncovered_assignment',
      owner_queue: 'league_manager',
      status: 'open',
      affected_type: 'fixture',
      affected_id: game.fixtureId,
      severity: 'high',
    });
    expect(new Date(exception.deadline_at as Date).toISOString()).toBe(game.start);
    const uncoveredEvents = await t.db
      .selectFrom('outbox_events')
      .select(['payload'])
      .where('event_type', '=', 'workforce.assignment_uncovered')
      .execute();
    expect(uncoveredEvents).toHaveLength(1);
    expect(uncoveredEvents[0]?.payload).toMatchObject({
      assignmentId: refereeAssignmentId,
      cause: 'withdrawn',
      exceptionId: exception.id,
    });
    body = await readiness();
    expect(officialsCheck(body)).toMatchObject({ status: 'blocked' });
    expect(
      await assignmentCheck.isAcceptedOfficial(t.organizationId, game.fixtureId, referee.personId),
    ).toBe(false);

    // 5. Replacement candidates are explained.
    const candidates = await t.http
      .get(`/v1/assignments/${refereeAssignmentId}/replacements`)
      .set(leagueManager.header);
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body.requiredQualifications).toEqual(['referee_grade_7']);
    const byPerson = new Map(
      (
        candidates.body.candidates as Array<{
          personId: string;
          eligible: boolean;
          reasons: Array<{ code: string; severity: string }>;
        }>
      ).map((c) => [c.personId, c]),
    );
    expect(byPerson.has(referee.personId)).toBe(false);
    expect(candidates.body.candidates[0].personId).toBe(substitute.personId);
    expect(byPerson.get(substitute.personId)).toMatchObject({ eligible: true });
    expect(byPerson.get(substitute.personId)?.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['qualified', 'declared_available', 'no_conflicts']),
    );
    const codesOf = (personId: string) =>
      byPerson
        .get(personId)
        ?.reasons.filter((r) => r.severity === 'blocking')
        .map((r) => r.code);
    expect(byPerson.get(unqualified.personId)?.eligible).toBe(false);
    expect(codesOf(unqualified.personId)).toEqual(['qualification_missing']);
    expect(codesOf(unavailable.personId)).toEqual(['declared_unavailable']);
    expect(codesOf(busy.personId)).toEqual(['assignment_overlap']);

    // 6. The slot is offered to the substitute (time-bounded access on acceptance).
    const replaced = await post(
      t,
      `/v1/assignments/${refereeAssignmentId}/replacements`,
      leagueManager,
      {
        personId: substitute.personId,
        reason: 'Referee sick',
      },
    );
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    expect(replaced.body.replacement).toMatchObject({
      status: 'offered',
      engagement: 'substitute',
      replacesAssignmentId: refereeAssignmentId,
      role: 'referee',
      slot: 1,
    });
    const operation = await t.http
      .get(`/v1/operations/${replaced.body.operationId}`)
      .set(leagueManager.header);
    expect(operation.body).toMatchObject({
      kind: 'workforce.replace_assignment',
      status: 'succeeded',
      result: { originalId: refereeAssignmentId, replacementId: replaced.body.replacement.id },
    });
    body = await readiness();
    expect(officialsCheck(body)).toMatchObject({ status: 'blocked' });

    const subAccepted = await post(
      t,
      `/v1/assignments/${replaced.body.replacement.id}/accept`,
      substitute,
      {},
    );
    expect(subAccepted.status, JSON.stringify(subAccepted.body)).toBe(200);
    expect(subAccepted.body.assignment.access).toMatchObject({
      status: 'granted',
      active: true,
      staffMembershipId: expect.any(String),
    });

    // 7. Readiness flips back; the escalation is resolved (not deleted).
    body = await readiness();
    expect(officialsCheck(body)).toMatchObject({ status: 'ready' });
    const resolved = await t.db
      .selectFrom('operational_exceptions')
      .select(['status', 'resolution'])
      .where('id', '=', exception.id)
      .executeTakeFirstOrThrow();
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolution: { coveredByAssignmentId: replaced.body.replacement.id },
    });
    // 8. SPK-STAFF-005: the accepted substitute (time-bounded official role) submits the result;
    //    the withdrawn referee no longer may.
    //    A played result waits for kickoff (CMP-12, SPK-RESULT-001): the clock moves to the start
    //    of the game for the submission and back afterwards.
    const result = { classification: 'completed', homeScore: 1, awayScore: 0 };
    const toKickoff = new Date(game.start).getTime() - t.clock.now().getTime();
    t.clock.advance(toKickoff);
    try {
      const byWithdrawn = await post(t, `/v1/fixtures/${game.fixtureId}/results`, referee, result);
      expect(byWithdrawn.status).toBe(403);
      const bySubstitute = await post(
        t,
        `/v1/fixtures/${game.fixtureId}/results`,
        substitute,
        result,
      );
      expect(bySubstitute.status, JSON.stringify(bySubstitute.body)).toBe(201);
    } finally {
      t.clock.advance(-toKickoff);
    }

    const coverage = await t.http
      .get(`/v1/assignment-requirements?targetType=fixture&targetId=${game.fixtureId}`)
      .set(leagueManager.header);
    expect(coverage.body[0].coverage).toEqual({
      accepted: 1,
      offered: 0,
      proposed: 0,
      uncoveredSlots: [],
    });
  });

  it('SPK-AT-012: an offered referee declining inside the window escalates; the same decline days ahead does not', async () => {
    const late = await scheduleFixture(t, world, {
      date: '2027-01-16',
      from: '20:00',
      to: '21:00',
    });
    await post(t, '/v1/assignment-requirements', leagueManager, {
      targetType: 'fixture',
      targetId: late.fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
    });
    const official = await staffMember(t, ['official']);
    const offer = await post(t, '/v1/assignments', leagueManager, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: late.fixtureId,
      role: 'referee',
      offer: true,
    });
    const declined = await post(
      t,
      `/v1/assignments/${offer.body.assignment.id}/decline`,
      official,
      {
        reason: 'cannot make it',
      },
    );
    expect(declined.status).toBe(200);
    expect(declined.body.uncovered).toMatchObject({ role: 'referee', slot: 1 });

    const later = await scheduleFixture(t, world, { date: '2027-01-30' });
    await post(t, '/v1/assignment-requirements', leagueManager, {
      targetType: 'fixture',
      targetId: later.fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
    });
    const offer2 = await post(t, '/v1/assignments', leagueManager, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: later.fixtureId,
      role: 'referee',
      offer: true,
    });
    const declined2 = await post(
      t,
      `/v1/assignments/${offer2.body.assignment.id}/decline`,
      official,
      {},
    );
    expect(declined2.body.uncovered).toBeNull();
  });

  it('a replacement for a live assignment requires withdrawing the original in the same command', async () => {
    const g = await scheduleFixture(t, world, { date: '2027-01-17' });
    const official = await staffMember(t, ['official']);
    const other = await staffMember(t, ['official']);
    const created = await post(t, '/v1/assignments', leagueManager, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: g.fixtureId,
      role: 'referee',
      offer: true,
    });
    await post(t, `/v1/assignments/${created.body.assignment.id}/accept`, official, {});
    const refused = await post(
      t,
      `/v1/assignments/${created.body.assignment.id}/replacements`,
      leagueManager,
      {
        personId: other.personId,
        reason: 'swap',
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    const swapped = await post(
      t,
      `/v1/assignments/${created.body.assignment.id}/replacements`,
      leagueManager,
      {
        personId: other.personId,
        reason: 'Absent official',
        withdrawOriginal: true,
        engagement: 'regular',
      },
    );
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    expect(swapped.body.original).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'Absent official',
    });
    expect(swapped.body.replacement).toMatchObject({ status: 'offered', engagement: 'regular' });
  });
});
