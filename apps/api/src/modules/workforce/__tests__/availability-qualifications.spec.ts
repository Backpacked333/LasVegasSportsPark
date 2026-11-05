import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import { createOfferingFixture, createProgramFixture } from '../../catalog';
import { at, createScheduledEvent, EventsService } from '../../scheduling';
import {
  adultCustomer,
  competitionWorld,
  drainOutbox,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

describe('availability, qualifications, requirements and non-fixture targets (SPK-STAFF-001)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let leagueManager: Actor;
  let coach: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    leagueManager = world.leagueManager;
    coach = await staffMember(t, ['coach']);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-STAFF-001: a person maintains their own availability; overlaps are refused; others see it only with authority', async () => {
    const created = await post(t, '/v1/availability', coach, {
      interval: { start: at('2027-02-10', '09:00'), end: at('2027-02-10', '17:00') },
      kind: 'available',
      note: 'Weekend',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      personId: coach.personId,
      kind: 'available',
      status: 'active',
      interval: { start: at('2027-02-10', '09:00'), end: at('2027-02-10', '17:00') },
    });
    const overlap = await post(t, '/v1/availability', coach, {
      interval: { start: at('2027-02-10', '16:00'), end: at('2027-02-10', '18:00') },
      kind: 'unavailable',
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.details.conflicts[0]).toMatchObject({
      code: 'availability_overlap',
      availabilityIds: [created.body.id],
    });
    const stranger = await adultCustomer(t);
    const peek = await t.http
      .get(`/v1/availability?personId=${coach.personId}`)
      .set(stranger.header);
    expect(peek.status).toBe(404);
    const forOthers = await post(t, '/v1/availability', stranger, {
      personId: coach.personId,
      interval: { start: at('2027-02-11', '09:00'), end: at('2027-02-11', '10:00') },
      kind: 'unavailable',
    });
    expect(forOthers.status).toBe(403);
    const planner = await staffMember(t, ['scheduler']);
    const seen = await t.http
      .get(`/v1/availability?personId=${coach.personId}`)
      .set(planner.header);
    expect(seen.status).toBe(200);
    expect(seen.body.map((w: { id: string }) => w.id)).toEqual([created.body.id]);
    const own = await t.http.get('/v1/availability').set(coach.header);
    expect(own.body).toHaveLength(1);

    const withdrawn = await post(t, `/v1/availability/${created.body.id}/withdraw`, coach, {
      reason: 'Plans changed',
      expectedRevision: created.body.revision,
    });
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({ status: 'withdrawn', withdrawnReason: 'Plans changed' });
    const history = await t.http.get('/v1/availability?includeWithdrawn=true').set(coach.header);
    expect(history.body).toHaveLength(1);
    const active = await t.http.get('/v1/availability').set(coach.header);
    expect(active.body).toHaveLength(0);
    // the overlapping statement is accepted once the first is withdrawn
    const retry = await post(t, '/v1/availability', coach, {
      interval: { start: at('2027-02-10', '16:00'), end: at('2027-02-10', '18:00') },
      kind: 'unavailable',
    });
    expect(retry.status).toBe(201);
  });

  it('SPK-STAFF-001: self-submitted evidence awaits verification; staff verify, nobody verifies their own, revocation keeps history', async () => {
    const submitted = await post(t, '/v1/qualifications', coach, {
      kind: 'coaching_licence_c',
      level: 'C',
      evidenceReference: 'licence-4411',
      validFrom: '2026-01-01T00:00:00Z',
      validTo: '2028-01-01T00:00:00Z',
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    expect(submitted.body).toMatchObject({ status: 'pending_verification', verifiedAt: null });
    const selfVerify = await post(t, '/v1/qualifications', coach, {
      kind: 'first_aid',
      validFrom: '2026-01-01T00:00:00Z',
      verify: true,
    });
    expect(selfVerify.status).toBe(403);
    const programManager = await staffMember(t, ['program_manager']);
    const verified = await post(
      t,
      `/v1/qualifications/${submitted.body.id}/verify`,
      programManager,
      {
        expectedRevision: submitted.body.revision,
      },
    );
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    expect(verified.body).toMatchObject({
      status: 'verified',
      verifiedBy: { personId: programManager.personId },
    });
    const revoked = await post(
      t,
      `/v1/qualifications/${submitted.body.id}/revoke`,
      programManager,
      {
        reason: 'Licence suspended by the federation',
      },
    );
    expect(revoked.body).toMatchObject({
      status: 'revoked',
      statusReason: 'Licence suspended by the federation',
    });
    const reVerify = await post(
      t,
      `/v1/qualifications/${submitted.body.id}/verify`,
      programManager,
      {},
    );
    expect(reVerify.body.code).toBe('INVALID_TRANSITION');
    const mine = await t.http.get('/v1/qualifications').set(coach.header);
    expect(mine.body.map((q: { status: string }) => q.status)).toEqual(['revoked']);
    const stranger = await adultCustomer(t);
    const theirs = await t.http
      .get(`/v1/qualifications?personId=${coach.personId}`)
      .set(stranger.header);
    expect(theirs.status).toBe(404);
    const otherVerify = await post(t, `/v1/qualifications/${submitted.body.id}/reject`, stranger, {
      reason: 'x',
    });
    expect(otherVerify.status).toBe(404);
  });

  it('requirements: one per role per target, edited with the expected revision', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-02-12' });
    const body = {
      targetType: 'fixture',
      targetId: game.fixtureId,
      kind: 'official',
      role: 'assistant_referee',
      requiredCount: 2,
    };
    const created = await post(t, '/v1/assignment-requirements', leagueManager, body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.coverage.uncoveredSlots).toEqual([1, 2]);
    const duplicate = await post(t, '/v1/assignment-requirements', leagueManager, body);
    expect(duplicate.status).toBe(409);
    const desk = await staffMember(t, ['front_desk']);
    const byDesk = await post(t, '/v1/assignment-requirements', desk, { ...body, role: 'steward' });
    expect(byDesk.status).toBe(403);
    const stale = await t.http
      .patch(`/v1/assignment-requirements/${created.body.id}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', `k-${created.body.id}-1`)
      .send({ requiredCount: 1, expectedRevision: 9 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_REVISION');
    const updated = await t.http
      .patch(`/v1/assignment-requirements/${created.body.id}`)
      .set(leagueManager.header)
      .set('Idempotency-Key', `k-${created.body.id}-2`)
      .send({ requiredCount: 1, expectedRevision: created.body.revision });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({ requiredCount: 1, coverage: { uncoveredSlots: [1] } });
    // slots beyond the requirement are refused
    const official = await staffMember(t, ['official']);
    const overSlot = await post(t, '/v1/assignments', leagueManager, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: game.fixtureId,
      role: 'assistant_referee',
      slot: 2,
    });
    expect(overSlot.status).toBe(400);
  });

  it('event and session targets: coaches are assigned to scheduling events and catalog sessions; cancellations withdraw them', async () => {
    const events = t.app.get(EventsService);
    const practice = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [world.pitch.northHalfId],
      start: at('2027-02-14', '09:00'),
      end: at('2027-02-14', '10:30'),
      kind: 'practice',
      title: 'U10 practice',
    });
    const programManager = await staffMember(t, ['program_manager']);
    const toEvent = await post(t, '/v1/assignments', programManager, {
      personId: coach.personId,
      kind: 'coach',
      targetType: 'event',
      targetId: practice.id,
      role: 'head_coach',
      offer: true,
    });
    expect(toEvent.status, JSON.stringify(toEvent.body)).toBe(201);
    expect(toEvent.body.assignment).toMatchObject({
      targetTitle: 'U10 practice',
      schedulingEventId: practice.id,
      turnaroundMinutes: 15,
    });
    await post(t, `/v1/assignments/${toEvent.body.assignment.id}/accept`, coach, {});

    const programId = await createProgramFixture(t);
    const offering = await createOfferingFixture(t, {
      programId,
      responsibleManagerPersonId: programManager.personId,
    });
    const sessions = await t.http
      .post(`/v1/offerings/${offering.offeringId}/sessions`)
      .set(programManager.header)
      .set('Idempotency-Key', `k-${offering.offeringId}`)
      .send({ scheduledStart: at('2027-02-15', '16:00'), scheduledEnd: at('2027-02-15', '17:00') });
    expect(sessions.status, JSON.stringify(sessions.body)).toBe(201);
    const sessionId = sessions.body.id as string;
    const missingOffering = await post(t, '/v1/assignments', programManager, {
      personId: coach.personId,
      kind: 'coach',
      targetType: 'session',
      targetId: sessionId,
      role: 'instructor',
    });
    expect(missingOffering.status).toBe(400);
    const toSession = await post(t, '/v1/assignments', programManager, {
      personId: coach.personId,
      kind: 'coach',
      targetType: 'session',
      targetId: sessionId,
      offeringId: offering.offeringId,
      role: 'instructor',
      offer: true,
    });
    expect(toSession.status, JSON.stringify(toSession.body)).toBe(201);
    expect(toSession.body.assignment).toMatchObject({
      targetType: 'session',
      offeringId: offering.offeringId,
      scheduledStart: at('2027-02-15', '16:00'),
    });

    // scheduling cancels the practice: the coach's accepted assignment is withdrawn (not deleted)
    await events.cancelEvent(systemPrincipal(t.organizationId), practice.id, {
      reason: 'Pitch flooded',
    });
    await drainOutbox(t);
    const afterCancel = await t.http
      .get(`/v1/assignments/${toEvent.body.assignment.id}`)
      .set(coach.header);
    expect(afterCancel.body).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'The event was canceled.',
    });
    // catalog cancels the session
    const canceled = await t.http
      .post(`/v1/sessions/${sessionId}/cancel`)
      .set(programManager.header)
      .set('Idempotency-Key', `k-cancel-${sessionId}`)
      .send({ reason: 'Instructor course' });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await drainOutbox(t);
    const sessionAssignment = await t.http
      .get(`/v1/assignments/${toSession.body.assignment.id}`)
      .set(coach.header);
    expect(sessionAssignment.body.status).toBe('withdrawn');
  });
});
