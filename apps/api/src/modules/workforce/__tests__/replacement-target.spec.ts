import { AsyncResource } from 'node:async_hooks';
import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OperationalExceptions } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { at, createScheduledEvent, EventsService } from '../../scheduling';
import { createAssignmentFixture } from '../testing/workforce-fixtures';
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

/**
 * The replacement workflow and acceptances act on the activity as its owning module holds it
 * now (SPK-STAFF-003/004, SPK-AT-012, §4.6): a canceled activity gets no replacement and no
 * acceptance (so no time-bounded access), and its uncovered-slot exceptions leave the queue
 * (SPK-UX-006). Escalation and resolution of one slot are serialized, so a decline racing an
 * acceptance never leaves an open exception on a covered slot. The clock starts 2027-01-16 12:00
 * in Los Angeles; the escalation window is 48 hours.
 */
describe('replacements, acceptances and uncovered slots follow the target (SPK-STAFF-003/004, SPK-AT-012, SPK-UX-006)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let lm: Actor;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    lm = world.leagueManager;
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

  async function cancelFixture(fixtureId: string) {
    const fixture = await t.http.get(`/v1/fixtures/${fixtureId}`).set(lm.header);
    const canceled = await t.http
      .patch(`/v1/fixtures/${fixtureId}`)
      .set(lm.header)
      .set('Idempotency-Key', key())
      .send({ action: 'cancel', expectedRevision: fixture.body.revision, reason: 'Weather' });
    expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
    await drainOutbox(t);
  }

  const exceptionsOf = (affectedId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['id', 'status'])
      .where('category', '=', 'workforce.uncovered_assignment')
      .where('affected_id', '=', affectedId)
      .execute();
  const membershipsOf = (personId: string) =>
    t.db.selectFrom('staff_memberships').select('id').where('person_id', '=', personId).execute();

  it('SPK-STAFF-003 / SPK-AT-012: a replacement is refused once the fixture is canceled, and its uncovered exception is closed', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-01-17' });
    await requireReferee(game);
    const declining = await staffMember(t, ['official']);
    const withdrawnRef = await staffMember(t, ['official']);
    const declinedOffer = await post(t, '/v1/assignments', lm, {
      ...referee(game.fixtureId, declining.personId),
      role: 'referee',
    });
    expect(declinedOffer.status, JSON.stringify(declinedOffer.body)).toBe(201);
    const declined = await post(
      t,
      `/v1/assignments/${declinedOffer.body.assignment.id}/decline`,
      declining,
      { reason: 'Away' },
    );
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    // an accepted referee withdrawn inside the window escalates the slot
    const accepted = await post(
      t,
      '/v1/assignments',
      lm,
      referee(game.fixtureId, withdrawnRef.personId),
    );
    expect(
      (await post(t, `/v1/assignments/${accepted.body.assignment.id}/accept`, withdrawnRef, {}))
        .status,
    ).toBe(200);
    const withdrawn = await post(t, `/v1/assignments/${accepted.body.assignment.id}/withdraw`, lm, {
      reason: 'Referee sick',
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.uncovered).not.toBeNull();
    const exceptionId = withdrawn.body.uncovered.exceptionId as string;
    const statusOf = async (id: string) =>
      (await exceptionsOf(game.fixtureId)).find((e) => e.id === id)?.status;
    expect(await statusOf(exceptionId)).toBe('open');

    await cancelFixture(game.fixtureId);
    // SPK-UX-006: the queue no longer sends managers to the replacement link of a canceled game
    expect(await statusOf(exceptionId)).toBe('closed');
    expect((await exceptionsOf(game.fixtureId)).filter((e) => e.status === 'open')).toEqual([]);
    const sub = await adultCustomer(t);
    for (const original of [declinedOffer.body.assignment.id, accepted.body.assignment.id]) {
      const replaced = await post(t, `/v1/assignments/${original}/replacements`, lm, {
        personId: sub.personId,
        reason: 'Cover the slot',
      });
      expect(replaced.status, JSON.stringify(replaced.body)).toBe(400);
      expect(replaced.body.details).toMatchObject({ code: 'target_not_scheduled' });
      const candidates = await t.http
        .get(`/v1/assignments/${original}/replacements`)
        .set(lm.header);
      expect(candidates.status).toBe(400);
    }
    const live = await t.db
      .selectFrom('assignments')
      .select('id')
      .where('target_id', '=', game.fixtureId)
      .where('status', 'in', ['proposed', 'offered', 'accepted'])
      .execute();
    expect(live).toEqual([]);
    expect(await membershipsOf(sub.personId)).toEqual([]);
    // a replayed follow-up changes nothing
    await t.db
      .updateTable('outbox_events')
      .set({ status: 'pending', locked_until: null })
      .where('event_type', '=', 'competition.fixture_changed')
      .where('aggregate_id', '=', game.fixtureId)
      .execute();
    await drainOutbox(t);
    expect(await statusOf(exceptionId)).toBe('closed');
  });

  it('SPK-STAFF-004 / §4.6: an offer left on a canceled fixture cannot be offered or accepted and grants no staff membership', async () => {
    const game = await scheduleFixture(t, world, { date: '2027-01-24' });
    await cancelFixture(game.fixtureId);
    const sub = await adultCustomer(t);
    // an offer committed after the cancellation's follow-up ran (or before this guard existed)
    const offered = await createAssignmentFixture(t, {
      targetType: 'fixture',
      targetId: game.fixtureId,
      schedulingEventId: game.eventId,
      personId: sub.personId,
      scheduledStart: game.start,
      scheduledEnd: game.end,
      status: 'offered',
      engagement: 'substitute',
    });
    const accept = await post(t, `/v1/assignments/${offered}/accept`, sub, {});
    expect(accept.status, JSON.stringify(accept.body)).toBe(400);
    expect(accept.body.details).toMatchObject({ code: 'target_not_scheduled' });
    expect(await membershipsOf(sub.personId)).toEqual([]);
    const proposed = await createAssignmentFixture(t, {
      targetType: 'fixture',
      targetId: game.fixtureId,
      schedulingEventId: game.eventId,
      personId: (await adultCustomer(t)).personId,
      scheduledStart: game.start,
      scheduledEnd: game.end,
      status: 'proposed',
      role: 'assistant_referee',
    });
    const offer = await post(t, `/v1/assignments/${proposed}/offer`, lm, {});
    expect(offer.status, JSON.stringify(offer.body)).toBe(400);
    expect(offer.body.details).toMatchObject({ code: 'target_not_scheduled' });
  });

  it('SPK-UX-006: a canceled event closes its open uncovered-slot exception', async () => {
    const events = t.app.get(EventsService);
    const practice = await createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [world.pitch.northHalfId],
      start: at('2027-01-17', '09:00'),
      end: at('2027-01-17', '10:00'),
      kind: 'practice',
      title: 'U9 practice',
    });
    const pm = await staffMember(t, ['program_manager']);
    const req = await post(t, '/v1/assignment-requirements', pm, {
      targetType: 'event',
      targetId: practice.id,
      kind: 'coach',
      role: 'head_coach',
      requiredCount: 1,
    });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    const coach = await staffMember(t, ['coach']);
    const created = await post(t, '/v1/assignments', pm, {
      personId: coach.personId,
      kind: 'coach',
      targetType: 'event',
      targetId: practice.id,
      role: 'head_coach',
      offer: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const declined = await post(t, `/v1/assignments/${created.body.assignment.id}/decline`, coach, {
      reason: 'Ill',
    });
    expect(declined.body.uncovered).not.toBeNull();
    await events.cancelEvent(systemPrincipal(t.organizationId), practice.id, {
      reason: 'Pitch flooded',
    });
    await drainOutbox(t);
    expect(await exceptionsOf(practice.id)).toEqual([
      { id: declined.body.uncovered.exceptionId, status: 'closed' },
    ]);
  });

  it('SPK-UX-006 / SPK-AT-012 under concurrency: a decline racing an acceptance of the same slot leaves no open exception on the covered slot', async () => {
    const game = await scheduleFixture(t, world, {
      date: '2027-01-17',
      from: '12:00',
      to: '13:00',
    });
    await requireReferee(game);
    const first = await staffMember(t, ['official']);
    const second = await staffMember(t, ['official']);
    const a = await post(t, '/v1/assignments', lm, referee(game.fixtureId, first.personId));
    const b = await post(t, '/v1/assignments', lm, referee(game.fixtureId, second.personId));
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.assignment.slot).toBe(a.body.assignment.slot);
    const exceptions = t.app.get(OperationalExceptions);
    const raise = exceptions.raise.bind(exceptions);
    // the acceptance is a separate request: it must not start inside the decline's async context
    const outside = AsyncResource.bind(<T>(fn: () => T): T => fn());
    let acceptance: Promise<Awaited<ReturnType<typeof post>>> | null = null;
    // The acceptance of B is sent while the decline of A is about to raise the exception: with
    // the slot serialized it waits for the decline's commit and then resolves the exception;
    // without it, it would commit first and never see the exception (PostgreSQL).
    const spy = vi.spyOn(exceptions, 'raise').mockImplementation(async (trx, input) => {
      if (input.affectedId === game.fixtureId && !acceptance) {
        acceptance = outside(async () =>
          post(t, `/v1/assignments/${b.body.assignment.id}/accept`, second, {}),
        );
        await Promise.race([acceptance, new Promise((resolve) => setTimeout(resolve, 1_500))]);
      }
      return raise(trx, input);
    });
    try {
      const declined = await post(t, `/v1/assignments/${a.body.assignment.id}/decline`, first, {
        reason: 'Injured',
      });
      expect(declined.status, JSON.stringify(declined.body)).toBe(200);
      expect(acceptance).not.toBeNull();
      const accepted = await acceptance!;
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const open = (await exceptionsOf(game.fixtureId)).filter((e) => e.status === 'open');
    expect(open).toEqual([]);
  });
});
