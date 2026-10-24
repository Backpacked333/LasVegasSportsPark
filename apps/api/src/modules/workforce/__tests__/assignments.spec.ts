import { newId } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at, createScheduledEvent, EventsService, personCommitment } from '../../scheduling';
import {
  createAvailabilityFixture,
  createQualificationFixture,
  createRequirementFixture,
} from '../testing/workforce-fixtures';
import {
  adultCustomer,
  competitionWorld,
  drainOutbox,
  key,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
  type ScheduledFixture,
} from './support';

describe('assignments (§4.6 Assignment machine, SPK-STAFF-001..003, §4.8 accept)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let scheduler: Actor;
  let leagueManager: Actor;
  let referee: Actor;
  let game: ScheduledFixture;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    leagueManager = world.leagueManager;
    scheduler = await staffMember(t, ['scheduler']);
    referee = await staffMember(t, ['official']);
    game = await scheduleFixture(t, world, { date: '2027-01-20' });
  });
  afterAll(async () => {
    await t.close();
  });

  const propose = (actor: Actor, body: Record<string, unknown>, k = key()) =>
    post(t, '/v1/assignments', actor, body, k);
  const refereeFor = (fixtureId: string, personId: string, extra: Record<string, unknown> = {}) => ({
    personId,
    kind: 'official',
    targetType: 'fixture',
    targetId: fixtureId,
    role: 'referee',
    ...extra,
  });

  it('SPK-STAFF-002: proposed → offered → accepted → completed, every state recorded with its fact', async () => {
    const created = await propose(scheduler, refereeFor(game.fixtureId, referee.personId));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const assignment = created.body.assignment;
    expect(assignment).toMatchObject({
      status: 'proposed',
      targetType: 'fixture',
      targetId: game.fixtureId,
      schedulingEventId: game.eventId,
      targetTitle: expect.stringContaining(' v '),
      scheduledStart: game.start,
      scheduledEnd: game.end,
      turnaroundMinutes: 30,
      slot: 1,
      access: { status: 'not_applicable', active: false },
    });
    expect(assignment.committedUntil).toBe(
      new Date(new Date(game.end).getTime() + 30 * 60_000).toISOString(),
    );

    // §4.8: accepting a proposal that was never offered is not a permitted transition
    const early = await post(t, `/v1/assignments/${assignment.id}/accept`, referee, {});
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_TRANSITION');

    const offered = await post(t, `/v1/assignments/${assignment.id}/offer`, scheduler, {
      expectedRevision: assignment.revision,
    });
    expect(offered.status, JSON.stringify(offered.body)).toBe(200);
    expect(offered.body.assignment).toMatchObject({ status: 'offered', offeredAt: expect.any(String) });

    const accepted = await post(t, `/v1/assignments/${assignment.id}/accept`, referee, {
      expectedRevision: offered.body.assignment.revision,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.assignment).toMatchObject({
      status: 'accepted',
      acceptedAt: expect.any(String),
      respondedAt: expect.any(String),
    });
    expect(accepted.body.operationId).toBeNull();

    // completion only once the game has started
    const tooSoon = await post(t, `/v1/assignments/${assignment.id}/complete`, leagueManager, {});
    expect(tooSoon.status).toBe(400);
    t.clock.set(new Date(new Date(game.start).getTime() + 30 * 60_000));
    try {
      const completed = await post(t, `/v1/assignments/${assignment.id}/complete`, leagueManager, {});
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      expect(completed.body.assignment).toMatchObject({
        status: 'completed',
        completedAt: expect.any(String),
      });
      // terminal: nothing moves a completed assignment
      const again = await post(t, `/v1/assignments/${assignment.id}/withdraw`, leagueManager, {
        reason: 'late change',
      });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INVALID_TRANSITION');
    } finally {
      t.clock.set('2027-01-16T20:00:00Z');
    }

    const audit = await t.db
      .selectFrom('audit_records')
      .select(['action', 'before_revision', 'after_revision'])
      .where('target_type', '=', 'assignment')
      .where('target_id', '=', assignment.id)
      .orderBy('occurred_at')
      .orderBy('after_revision')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'workforce.propose_assignment',
      'workforce.assignment_offered',
      'workforce.accept_assignment',
      'workforce.complete_assignment',
    ]);
    const events = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'payload'])
      .where('aggregate_type', '=', 'assignment')
      .where('aggregate_id', '=', assignment.id)
      .orderBy('occurred_at')
      .execute();
    expect(events.map((e) => (e.payload as { status: string }).status)).toEqual([
      'proposed',
      'offered',
      'accepted',
      'completed',
    ]);
  });

  it('SPK-STAFF-002: an offered assignment can be declined by the assignee and withdrawn by staff; terminal states stay put', async () => {
    const other = await scheduleFixture(t, world, { date: '2027-01-21' });
    const a = await propose(scheduler, refereeFor(other.fixtureId, referee.personId, { offer: true }));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body.assignment.status).toBe('offered');
    const declined = await post(t, `/v1/assignments/${a.body.assignment.id}/decline`, referee, {
      reason: 'family event',
    });
    expect(declined.status).toBe(200);
    expect(declined.body.assignment).toMatchObject({
      status: 'declined',
      declineReason: 'family event',
    });
    // outside the escalation window (kickoff in 5 days): no uncovered escalation
    expect(declined.body.uncovered).toBeNull();
    const reoffer = await post(t, `/v1/assignments/${a.body.assignment.id}/offer`, scheduler, {});
    expect(reoffer.body.code).toBe('INVALID_TRANSITION');

    const b = await propose(scheduler, refereeFor(other.fixtureId, referee.personId));
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const withdrawn = await post(t, `/v1/assignments/${b.body.assignment.id}/withdraw`, leagueManager, {
      reason: 'not needed',
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.assignment).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'not needed',
    });
  });

  it('§4.8: only the assignee accepts; staff get an authority error, other people and other organizations NOT_FOUND', async () => {
    const other = await scheduleFixture(t, world, { date: '2027-01-22' });
    const created = await propose(
      scheduler,
      refereeFor(other.fixtureId, referee.personId, { offer: true }),
    );
    const id = created.body.assignment.id as string;
    const byManager = await post(t, `/v1/assignments/${id}/accept`, leagueManager, {});
    expect(byManager.status).toBe(403);
    expect(byManager.body.code).toBe('PARTICIPANT_AUTHORITY_REQUIRED');
    const stranger = await adultCustomer(t);
    const byStranger = await post(t, `/v1/assignments/${id}/accept`, stranger, {});
    expect(byStranger.status).toBe(404);
    const readByStranger = await t.http.get(`/v1/assignments/${id}`).set(stranger.header);
    expect(readByStranger.status).toBe(404);
    const otherOrg = await t.database.db
      .insertInto('organizations')
      .values({ id: newId(), slug: `other-${key()}`, name: 'Other' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const foreignStaff = await staffMember(t, ['league_manager', 'official'], {
      organizationId: otherOrg.id,
    });
    const crossOrg = await t.http.get(`/v1/assignments/${id}`).set(foreignStaff.header);
    expect(crossOrg.status).toBe(404);
    const crossAccept = await post(t, `/v1/assignments/${id}/accept`, foreignStaff, {});
    expect(crossAccept.status).toBe(404);
    // the assignee reads and accepts
    const own = await t.http.get(`/v1/assignments/${id}`).set(referee.header);
    expect(own.status).toBe(200);
  });

  it('§4.9: accepting replays under the same idempotency key, conflicts with different content, and refuses a stale revision', async () => {
    const other = await scheduleFixture(t, world, { date: '2027-01-23' });
    const created = await propose(
      scheduler,
      refereeFor(other.fixtureId, referee.personId, { offer: true }),
    );
    const id = created.body.assignment.id as string;
    const stale = await post(t, `/v1/assignments/${id}/accept`, referee, { expectedRevision: 1 + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const k = key();
    const first = await post(t, `/v1/assignments/${id}/accept`, referee, {}, k);
    expect(first.status).toBe(200);
    const replay = await post(t, `/v1/assignments/${id}/accept`, referee, {}, k);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const conflict = await post(t, `/v1/assignments/${id}/accept`, referee, { reason: 'x' }, k);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const accepted = await t.db
      .selectFrom('assignments')
      .select(['status', 'revision'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(accepted).toEqual({ status: 'accepted', revision: 2 });
  });

  it('SPK-STAFF-003: overlapping commitments and required turnaround are refused with the conflicting records named', async () => {
    const official = await staffMember(t, ['official']);
    const first = await scheduleFixture(t, world, {
      date: '2027-01-24',
      from: '10:00',
      to: '11:00',
      resourceId: world.pitch.northHalfId,
    });
    const overlapping = await scheduleFixture(t, world, {
      date: '2027-01-24',
      from: '10:30',
      to: '11:30',
      resourceId: world.pitch.southHalfId,
    });
    const tooClose = await scheduleFixture(t, world, {
      date: '2027-01-24',
      from: '11:15',
      to: '12:15',
      resourceId: world.pitch.northHalfId,
    });
    const afterTurnaround = await scheduleFixture(t, world, {
      date: '2027-01-24',
      from: '12:30',
      to: '13:30',
      resourceId: world.pitch.southHalfId,
    });
    const a = await propose(scheduler, refereeFor(first.fixtureId, official.personId, { offer: true }));
    const accepted = await post(t, `/v1/assignments/${a.body.assignment.id}/accept`, official, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const clash = await propose(scheduler, refereeFor(overlapping.fixtureId, official.personId));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('RESOURCE_CONFLICT');
    expect(clash.body.details.conflicts[0]).toMatchObject({
      code: 'assignment_overlap',
      assignmentIds: [a.body.assignment.id],
    });
    const close = await propose(scheduler, refereeFor(tooClose.fixtureId, official.personId));
    expect(close.status).toBe(409);
    expect(close.body.details.conflicts[0]).toMatchObject({ code: 'insufficient_turnaround' });
    // 30 minutes after the first game's end (the proposed official turnaround) is fine
    const fine = await propose(scheduler, refereeFor(afterTurnaround.fixtureId, official.personId));
    expect(fine.status, JSON.stringify(fine.body)).toBe(201);
  });

  it('SPK-STAFF-003: a person committed to an overlapping scheduling event is refused through scheduling’s commitments', async () => {
    const coach = await staffMember(t, ['coach', 'official']);
    const events = t.app.get(EventsService);
    const session = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [world.pitch.northHalfId],
      start: at('2027-01-25', '17:30'),
      end: at('2027-01-25', '18:30'),
      kind: 'practice',
      commitments: [personCommitment(coach.personId, 'coach')],
    });
    const game2 = await scheduleFixture(t, world, {
      date: '2027-01-25',
      resourceId: world.pitch.southHalfId,
    });
    const res = await propose(scheduler, refereeFor(game2.fixtureId, coach.personId));
    expect(res.status).toBe(409);
    expect(res.body.details.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'party_overlap', conflictingEventIds: [session.id] }),
      ]),
    );
  });

  it('SPK-STAFF-001: required qualifications and declared unavailability are checked before an offer', async () => {
    const official = await staffMember(t, ['official']);
    const other = await scheduleFixture(t, world, { date: '2027-01-26' });
    await createRequirementFixture(t, {
      targetType: 'fixture',
      targetId: other.fixtureId,
      role: 'referee',
      requiredQualifications: ['referee_grade_7'],
    });
    const unqualified = await propose(scheduler, refereeFor(other.fixtureId, official.personId));
    expect(unqualified.status).toBe(422);
    expect(unqualified.body.code).toBe('ELIGIBILITY_FAILED');
    expect(unqualified.body.details.reasons).toEqual([
      { code: 'qualification_missing', kind: 'referee_grade_7', qualificationIds: [] },
    ]);
    const pending = await createQualificationFixture(t, {
      personId: official.personId,
      kind: 'referee_grade_7',
      status: 'pending_verification',
    });
    const stillNot = await propose(scheduler, refereeFor(other.fixtureId, official.personId));
    expect(stillNot.body.details.reasons[0]).toMatchObject({
      code: 'qualification_unverified',
      qualificationIds: [pending],
    });
    await createQualificationFixture(t, { personId: official.personId, kind: 'referee_grade_7' });
    await createAvailabilityFixture(t, {
      personId: official.personId,
      start: at('2027-01-26', '12:00'),
      end: at('2027-01-26', '22:00'),
      kind: 'unavailable',
    });
    const unavailable = await propose(scheduler, refereeFor(other.fixtureId, official.personId));
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.details.conflicts[0]).toMatchObject({ code: 'person_unavailable' });
    const free = await staffMember(t, ['official']);
    await createQualificationFixture(t, { personId: free.personId, kind: 'referee_grade_7' });
    const ok = await propose(scheduler, refereeFor(other.fixtureId, free.personId));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('staff role matrix: front desk cannot propose, schedulers propose but cannot create substitute work, finance cannot read assignments', async () => {
    const frontDesk = await staffMember(t, ['front_desk']);
    const finance = await staffMember(t, ['finance_operator']);
    const other = await scheduleFixture(t, world, { date: '2027-01-27' });
    const byDesk = await propose(frontDesk, refereeFor(other.fixtureId, referee.personId));
    expect(byDesk.status).toBe(403);
    expect(byDesk.body.code).toBe('ACCESS_DENIED');
    const substitute = await propose(
      scheduler,
      refereeFor(other.fixtureId, referee.personId, { engagement: 'substitute' }),
    );
    expect(substitute.status).toBe(403);
    const byManager = await propose(
      leagueManager,
      refereeFor(other.fixtureId, referee.personId, { engagement: 'substitute' }),
    );
    expect(byManager.status, JSON.stringify(byManager.body)).toBe(201);
    const read = await t.http
      .get(`/v1/assignments/${byManager.body.assignment.id}`)
      .set(finance.header);
    expect(read.status).toBe(404);
    const listed = await t.http
      .get(`/v1/assignments?targetType=fixture&targetId=${other.fixtureId}`)
      .set(frontDesk.header);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    const listByFinance = await t.http
      .get(`/v1/assignments?targetType=fixture&targetId=${other.fixtureId}`)
      .set(finance.header);
    expect(listByFinance.status).toBe(403);
  });

  it('follows the fixture: a rescheduled game retimes its assignments, a canceled one withdraws them', async () => {
    const official = await staffMember(t, ['official']);
    const other = await scheduleFixture(t, world, { date: '2027-01-28' });
    const created = await propose(
      scheduler,
      refereeFor(other.fixtureId, official.personId, { offer: true }),
    );
    const id = created.body.assignment.id as string;
    await post(t, `/v1/assignments/${id}/accept`, official, {});
    const fixture = await t.http.get(`/v1/fixtures/${other.fixtureId}`).set(leagueManager.header);
    const moved = await t.http
      .patch(`/v1/fixtures/${other.fixtureId}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: fixture.body.revision,
        reason: 'pitch swap',
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [world.pitch.pitchId],
          scheduledStart: at('2027-01-28', '20:00'),
          scheduledEnd: at('2027-01-28', '21:00'),
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await drainOutbox(t);
    const retimed = await t.http.get(`/v1/assignments/${id}`).set(official.header);
    expect(retimed.body).toMatchObject({
      status: 'accepted',
      scheduledStart: at('2027-01-28', '20:00'),
      scheduledEnd: at('2027-01-28', '21:00'),
    });
    const refreshed = await t.http.get(`/v1/fixtures/${other.fixtureId}`).set(leagueManager.header);
    const canceled = await t.http
      .patch(`/v1/fixtures/${other.fixtureId}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({ action: 'cancel', expectedRevision: refreshed.body.revision, reason: 'weather' });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await drainOutbox(t);
    await drainOutbox(t);
    const after = await t.http.get(`/v1/assignments/${id}`).set(official.header);
    expect(after.body).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'The fixture was canceled.',
    });
  });
});
