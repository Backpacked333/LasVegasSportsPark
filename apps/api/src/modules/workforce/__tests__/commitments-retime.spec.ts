import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { at } from '../../scheduling';
import {
  CLOCK_START,
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

/**
 * Commitments that outlive a state change (SPK-STAFF-003, SPK-AT-012, §4.7): a completed
 * assignment keeps holding its interval, a retime is checked against every commitment of the
 * person (scheduling's included) and a retime into a conflict records the activity's new time, so
 * escalation and replacement use it. The clock starts 2027-01-16 12:00 in Los Angeles; the
 * uncovered-slot escalation window is 48 hours.
 */
describe('commitments across completion and retimes (SPK-STAFF-003, SPK-AT-012)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let lm: Actor;
  let scheduler: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    lm = world.leagueManager;
    scheduler = await staffMember(t, ['scheduler']);
  });
  afterAll(async () => {
    await t.close();
  });

  const referee = (fixtureId: string, personId: string, extra: Record<string, unknown> = {}) => ({
    personId,
    kind: 'official',
    targetType: 'fixture',
    targetId: fixtureId,
    role: 'referee',
    offer: true,
    ...extra,
  });

  async function acceptedReferee(fixture: ScheduledFixture, official: Actor): Promise<string> {
    const offered = await post(
      t,
      '/v1/assignments',
      lm,
      referee(fixture.fixtureId, official.personId),
    );
    expect(offered.status, JSON.stringify(offered.body)).toBe(201);
    const accepted = await post(
      t,
      `/v1/assignments/${offered.body.assignment.id}/accept`,
      official,
      {},
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    return offered.body.assignment.id as string;
  }

  async function requireReferee(fixture: ScheduledFixture) {
    const req = await post(t, '/v1/assignment-requirements', lm, {
      targetType: 'fixture',
      targetId: fixture.fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
    });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
  }

  async function reschedule(
    fixture: ScheduledFixture,
    date: string,
    from: string,
    to: string,
    resourceId: string,
  ) {
    const current = await t.http.get(`/v1/fixtures/${fixture.fixtureId}`).set(lm.header);
    const moved = await t.http
      .patch(`/v1/fixtures/${fixture.fixtureId}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({
        action: 'reschedule',
        expectedRevision: current.body.revision,
        reason: 'Pitch swap',
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [resourceId],
          scheduledStart: at(date, from),
          scheduledEnd: at(date, to),
        },
      });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await drainOutbox(t);
  }

  const row = (id: string) =>
    t.db.selectFrom('assignments').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const uncoveredOf = (fixtureId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['id', 'status', 'deadline_at', 'details'])
      .where('category', '=', 'workforce.uncovered_assignment')
      .where('affected_id', '=', fixtureId)
      .execute();
  const uncoveredEvents = (assignmentId: string) =>
    t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'workforce.assignment_uncovered')
      .where('aggregate_id', '=', assignmentId)
      .execute();

  it('SPK-STAFF-003: completing an assignment mid-activity does not free the person (overlap and turnaround)', async () => {
    const x = await staffMember(t, ['official']);
    const y = await staffMember(t, ['official']);
    const a = await scheduleFixture(t, world, {
      date: '2027-03-01',
      from: '18:00',
      to: '19:00',
      resourceId: world.pitch.northHalfId,
    });
    const overlapping = await scheduleFixture(t, world, {
      date: '2027-03-01',
      from: '18:30',
      to: '19:30',
      resourceId: world.pitch.southHalfId,
    });
    const tooClose = await scheduleFixture(t, world, {
      date: '2027-03-01',
      from: '19:15',
      to: '20:15',
      resourceId: world.pitch.northHalfId,
    });
    const first = await acceptedReferee(a, x);
    const other = await acceptedReferee(tooClose, y);
    try {
      // 30 minutes into game A its assignment is completed (allowed once the activity started)
      t.clock.set(new Date(new Date(a.start).getTime() + 30 * 60_000));
      const done = await post(t, `/v1/assignments/${first}/complete`, lm, {});
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const clash = await post(
        t,
        '/v1/assignments',
        lm,
        referee(overlapping.fixtureId, x.personId),
      );
      expect(clash.status, JSON.stringify(clash.body)).toBe(409);
      expect(clash.body.details.conflicts[0]).toMatchObject({
        code: 'assignment_overlap',
        assignmentIds: [first],
      });
      const close = await post(t, '/v1/assignments', lm, referee(tooClose.fixtureId, x.personId));
      expect(close.status).toBe(409);
      expect(close.body.details.conflicts[0]).toMatchObject({ code: 'insufficient_turnaround' });
      // the replacement workflow explains the same: X is not an eligible replacement for game C
      const candidates = await t.http.get(`/v1/assignments/${other}/replacements`).set(lm.header);
      expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
      const candidate = (
        candidates.body.candidates as Array<{
          personId: string;
          eligible: boolean;
          reasons: Array<{ code: string; sourceIds: string[] }>;
        }>
      ).find((c) => c.personId === x.personId);
      expect(candidate?.eligible).toBe(false);
      expect(candidate?.reasons).toContainEqual(
        expect.objectContaining({ code: 'insufficient_turnaround', sourceIds: [first] }),
      );
    } finally {
      t.clock.set(CLOCK_START);
    }
  });

  it('SPK-STAFF-003 / SPK-AT-012: a game brought into the escalation window and into a conflict is withdrawn at its new time and escalated', async () => {
    const official = await staffMember(t, ['official']);
    const x = await scheduleFixture(t, world, {
      date: '2027-01-17',
      from: '18:00',
      to: '19:00',
      resourceId: world.pitch.northHalfId,
    });
    const y = await scheduleFixture(t, world, {
      date: '2027-02-20',
      resourceId: world.pitch.southHalfId,
    });
    await requireReferee(y);
    await acceptedReferee(x, official);
    const moved = await acceptedReferee(y, official);
    await reschedule(y, '2027-01-17', '18:30', '19:30', world.pitch.southHalfId);
    const after = await row(moved);
    expect(after.status).toBe('withdrawn');
    expect(new Date(after.scheduled_start).toISOString()).toBe(at('2027-01-17', '18:30'));
    expect(new Date(after.scheduled_end).toISOString()).toBe(at('2027-01-17', '19:30'));
    const exceptions = await uncoveredOf(y.fixtureId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ status: 'open' });
    expect(new Date(exceptions[0]!.deadline_at as Date).toISOString()).toBe(
      at('2027-01-17', '18:30'),
    );
    expect(exceptions[0]!.details).toMatchObject({
      cause: 'schedule_conflict',
      startsAt: at('2027-01-17', '18:30'),
    });
    expect(await uncoveredEvents(moved)).toHaveLength(1);

    // SPK-AT-012: the replacement is offered for the fixture's current time; a candidate who
    // holds an accepted game overlapping that real time is not eligible.
    const busy = await staffMember(t, ['official']);
    const busyOffer = await post(
      t,
      '/v1/assignments',
      lm,
      referee(x.fixtureId, busy.personId, { role: 'assistant_referee' }),
    );
    expect(busyOffer.status, JSON.stringify(busyOffer.body)).toBe(201);
    expect(
      (await post(t, `/v1/assignments/${busyOffer.body.assignment.id}/accept`, busy, {})).status,
    ).toBe(200);
    const candidates = await t.http.get(`/v1/assignments/${moved}/replacements`).set(lm.header);
    expect(candidates.status, JSON.stringify(candidates.body)).toBe(200);
    expect(candidates.body.scheduledStart).toBe(at('2027-01-17', '18:30'));
    const busyCandidate = (
      candidates.body.candidates as Array<{ personId: string; eligible: boolean }>
    ).find((c) => c.personId === busy.personId);
    expect(busyCandidate?.eligible).toBe(false);
    const refused = await post(t, `/v1/assignments/${moved}/replacements`, lm, {
      personId: busy.personId,
      reason: 'Original referee double-booked by the reschedule',
      offer: true,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const free = await staffMember(t, ['official']);
    const replaced = await post(t, `/v1/assignments/${moved}/replacements`, lm, {
      personId: free.personId,
      reason: 'Original referee double-booked by the reschedule',
      offer: true,
    });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    expect(replaced.body.replacement).toMatchObject({
      scheduledStart: at('2027-01-17', '18:30'),
      scheduledEnd: at('2027-01-17', '19:30'),
    });
  });

  it('SPK-STAFF-003: a game pushed out of the escalation window into a conflict is withdrawn without escalation', async () => {
    const official = await staffMember(t, ['official']);
    const x = await scheduleFixture(t, world, {
      date: '2027-02-27',
      from: '18:00',
      to: '19:00',
      resourceId: world.pitch.northHalfId,
    });
    const y = await scheduleFixture(t, world, {
      date: '2027-01-17',
      from: '20:00',
      to: '21:00',
      resourceId: world.pitch.southHalfId,
    });
    await requireReferee(y);
    await acceptedReferee(x, official);
    const moved = await acceptedReferee(y, official);
    await reschedule(y, '2027-02-27', '18:30', '19:30', world.pitch.southHalfId);
    const after = await row(moved);
    expect(after.status).toBe('withdrawn');
    expect(new Date(after.scheduled_start).toISOString()).toBe(at('2027-02-27', '18:30'));
    expect(await uncoveredOf(y.fixtureId)).toEqual([]);
  });

  it('SPK-STAFF-003: a replacement for a declined slot takes the fixture’s current time after a reschedule', async () => {
    const declining = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, {
      date: '2027-03-05',
      resourceId: world.pitch.northHalfId,
    });
    const offered = await post(
      t,
      '/v1/assignments',
      lm,
      referee(game.fixtureId, declining.personId),
    );
    expect(offered.status).toBe(201);
    const declined = await post(
      t,
      `/v1/assignments/${offered.body.assignment.id}/decline`,
      declining,
      { reason: 'Away that weekend' },
    );
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    await reschedule(game, '2027-03-12', '15:00', '16:00', world.pitch.northHalfId);
    const sub = await staffMember(t, ['official']);
    const replaced = await post(
      t,
      `/v1/assignments/${offered.body.assignment.id}/replacements`,
      lm,
      {
        personId: sub.personId,
        reason: 'Original referee declined',
        offer: true,
      },
    );
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(201);
    expect(replaced.body.replacement).toMatchObject({
      scheduledStart: at('2027-03-12', '15:00'),
      scheduledEnd: at('2027-03-12', '16:00'),
    });
  });

  it('SPK-STAFF-003 / SPK-SCHED-004: a reschedule onto a scheduling commitment of the person withdraws the assignment instead of double-booking', async () => {
    const official = await staffMember(t, ['official', 'coach']);
    const game = await scheduleFixture(t, world, {
      date: '2027-01-17',
      from: '14:00',
      to: '15:00',
      resourceId: world.pitch.southHalfId,
    });
    await requireReferee(game);
    const practice = await post(t, '/v1/event-series', scheduler, {
      facilityId: t.facilityId,
      kind: 'practice',
      title: 'Coached practice',
      recurrence: { frequency: 'daily', interval: 1, startDate: '2027-01-17', count: 1 },
      localStartTime: '16:00',
      durationMinutes: 60,
      resourceIds: [world.pitch.northHalfId],
      commitments: [{ partyType: 'person', partyId: official.personId, role: 'coach' }],
    });
    expect(practice.status, JSON.stringify(practice.body)).toBe(201);
    const assignment = await acceptedReferee(game, official);
    await reschedule(game, '2027-01-17', '16:00', '17:00', world.pitch.southHalfId);
    const after = await row(assignment);
    expect(after).toMatchObject({
      status: 'withdrawn',
      withdrawn_reason: 'The rescheduled time overlaps another commitment of the person.',
    });
    expect(new Date(after.scheduled_start).toISOString()).toBe(at('2027-01-17', '16:00'));
    const exceptions = await uncoveredOf(game.fixtureId);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]!.details).toMatchObject({ cause: 'schedule_conflict' });
  });

  const practiceFor = (personId: string, date: string, time: string, resourceId: string) => ({
    facilityId: t.facilityId,
    kind: 'practice',
    title: 'Coached practice',
    recurrence: { frequency: 'daily', interval: 1, startDate: date, count: 1 },
    localStartTime: time,
    durationMinutes: 60,
    resourceIds: [resourceId],
    commitments: [{ partyType: 'person', partyId: personId, role: 'coach' }],
  });

  it('SPK-STAFF-003 / SPK-SCHED-004: scheduling refuses to commit a person an accepted assignment holds (overlap or turnaround)', async () => {
    const official = await staffMember(t, ['official', 'coach']);
    const game = await scheduleFixture(t, world, {
      date: '2027-02-11',
      resourceId: world.pitch.southHalfId,
    });
    const assignment = await acceptedReferee(game, official);
    const overlapping = await post(
      t,
      '/v1/event-series',
      scheduler,
      practiceFor(official.personId, '2027-02-11', '18:15', world.pitch.northHalfId),
    );
    expect(overlapping.status, JSON.stringify(overlapping.body)).toBe(409);
    expect(overlapping.body.details.conflicts).toContainEqual(
      expect.objectContaining({
        code: 'party_overlap',
        party: { partyType: 'person', partyId: official.personId },
        externalCommitments: [{ source: 'workforce.assignments', id: assignment }],
      }),
    );
    // inside the official's 30-minute turnaround after the game
    const tooClose = await post(
      t,
      '/v1/event-series',
      scheduler,
      practiceFor(official.personId, '2027-02-11', '19:15', world.pitch.northHalfId),
    );
    expect(tooClose.status, JSON.stringify(tooClose.body)).toBe(409);
    // with scheduling's own person rest respected before the game, the person is free
    const free = await post(
      t,
      '/v1/event-series',
      scheduler,
      practiceFor(official.personId, '2027-02-11', '16:00', world.pitch.northHalfId),
    );
    expect(free.status, JSON.stringify(free.body)).toBe(201);
    // a withdrawn assignment holds nothing
    const other = await scheduleFixture(t, world, {
      date: '2027-02-13',
      resourceId: world.pitch.southHalfId,
    });
    const withdrawn = await acceptedReferee(other, official);
    expect(
      (await post(t, `/v1/assignments/${withdrawn}/withdraw`, lm, { reason: 'Not needed' })).status,
    ).toBe(200);
    const afterWithdrawal = await post(
      t,
      '/v1/event-series',
      scheduler,
      practiceFor(official.personId, '2027-02-13', '18:15', world.pitch.northHalfId),
    );
    expect(afterWithdrawal.status, JSON.stringify(afterWithdrawal.body)).toBe(201);
  });

  it('SPK-STAFF-003 / SPK-SCHED-004 under concurrency: an acceptance and a scheduling commitment of the same person never both commit', async () => {
    for (const date of ['2027-02-16', '2027-02-17', '2027-02-18']) {
      const official = await staffMember(t, ['official', 'coach']);
      const game = await scheduleFixture(t, world, {
        date,
        resourceId: world.pitch.southHalfId,
      });
      const offered = await post(
        t,
        '/v1/assignments',
        lm,
        referee(game.fixtureId, official.personId),
      );
      expect(offered.status, JSON.stringify(offered.body)).toBe(201);
      const [accepted, practice] = await Promise.all([
        post(t, `/v1/assignments/${offered.body.assignment.id}/accept`, official, {}),
        post(
          t,
          '/v1/event-series',
          scheduler,
          practiceFor(official.personId, date, '18:15', world.pitch.northHalfId),
        ),
      ]);
      const outcomes = [accepted.status, practice.status];
      expect(
        outcomes.filter((s) => s === 200 || s === 201),
        JSON.stringify(outcomes),
      ).toHaveLength(1);
      expect(
        outcomes.filter((s) => s === 409),
        JSON.stringify(outcomes),
      ).toHaveLength(1);
    }
  });

  it('§4.9 / SPK-STAFF-003: a turnaround below the policy needs the override authority and a reason, and is audited', async () => {
    const official = await staffMember(t, ['official']);
    const game = await scheduleFixture(t, world, {
      date: '2027-03-15',
      resourceId: world.pitch.northHalfId,
    });
    const body = referee(game.fixtureId, official.personId, { turnaroundMinutes: 0 });
    // schedulers propose with the policy turnaround only (POL-033 pending)
    const byScheduler = await post(t, '/v1/assignments', scheduler, {
      ...body,
      reason: 'Tight day',
    });
    expect(byScheduler.status, JSON.stringify(byScheduler.body)).toBe(403);
    const withoutReason = await post(t, '/v1/assignments', lm, body);
    expect(withoutReason.status, JSON.stringify(withoutReason.body)).toBe(400);
    expect(withoutReason.body.details).toMatchObject({
      code: 'turnaround_override_reason_required',
      turnaroundMinutes: 0,
      policyTurnaroundMinutes: 30,
    });
    const overridden = await post(t, '/v1/assignments', lm, {
      ...body,
      reason: 'Back-to-back games on adjacent halves',
    });
    expect(overridden.status, JSON.stringify(overridden.body)).toBe(201);
    expect(overridden.body.assignment.turnaroundMinutes).toBe(0);
    const audit = await t.db
      .selectFrom('audit_records')
      .select(['reason', 'details'])
      .where('target_id', '=', overridden.body.assignment.id)
      .where('action', '=', 'workforce.propose_assignment')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('Back-to-back games on adjacent halves');
    expect(audit.details).toMatchObject({
      turnaroundMinutes: 0,
      policyTurnaroundMinutes: 30,
      turnaroundOverride: true,
    });
    // a turnaround at or above the policy is not an override
    const longer = await post(
      t,
      '/v1/assignments',
      scheduler,
      referee(game.fixtureId, (await staffMember(t, ['official'])).personId, {
        turnaroundMinutes: 45,
      }),
    );
    expect(longer.status, JSON.stringify(longer.body)).toBe(201);
  });
});
