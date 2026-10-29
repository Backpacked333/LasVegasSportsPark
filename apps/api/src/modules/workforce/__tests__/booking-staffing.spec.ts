import { systemPrincipal, type Event } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import { createOfferingFixture, createProgramFixture } from '../../catalog';
import { at, createScheduledEvent, EventsService } from '../../scheduling';
import {
  ASSIGNMENT_COVERAGE_PORT,
  WORKFORCE_STAFFING_PORT,
  type AssignmentCoveragePort,
  type WorkforceStaffingPort,
} from '../ports';
import { UNCOVERED_ASSIGNMENT } from '../workforce.policy';
import { createAssignmentFixture, createRequirementFixture } from '../testing/workforce-fixtures';
import {
  competitionWorld,
  expectPgError,
  key,
  post,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

/**
 * Booking staffing through WORKFORCE_STAFFING_PORT (WRK-02, IF-32; SPK-COND-003, SPK-STAFF-001/002)
 * with recorded retirement of requirements (migration 0704), and the offering-level accepted
 * check of ASSIGNMENT_COVERAGE_PORT (WRK-03, IF-34; SPK-UX-007, SPK-YOUTH-005).
 */
describe('booking staffing and requirement retirement (WRK-02, WRK-03)', () => {
  let t: TestApp;
  let world: CompetitionWorld;
  let scheduler: Actor;
  let staffing: WorkforceStaffingPort;
  let coverage: AssignmentCoveragePort;
  let uow: UnitOfWork;
  let events: EventsService;
  let booking: ReturnType<typeof systemPrincipal>;
  let parties = 0;

  beforeAll(async () => {
    t = await workforceTestApp();
    world = await competitionWorld(t);
    scheduler = await staffMember(t, ['scheduler']);
    staffing = t.app.get<WorkforceStaffingPort>(WORKFORCE_STAFFING_PORT);
    coverage = t.app.get<AssignmentCoveragePort>(ASSIGNMENT_COVERAGE_PORT);
    uow = t.app.get(UnitOfWork);
    events = t.app.get(EventsService);
    booking = systemPrincipal(t.organizationId, 'enrollment.booking');
  });
  afterAll(async () => {
    await t.close();
  });

  /** A party event booked on its own pitch half at 10:00-12:00 local on `date`. */
  async function party(date: string): Promise<Event> {
    parties += 1;
    return createScheduledEvent(events, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [parties % 2 === 0 ? world.pitch.northHalfId : world.pitch.southHalfId],
      start: at(date, parties % 2 === 0 ? '10:00' : '13:00'),
      end: at(date, parties % 2 === 0 ? '12:00' : '15:00'),
      kind: 'party',
      title: `Birthday party ${parties}`,
      sourceType: 'enrollment.booking',
    });
  }

  const staffingOf = (event: Event, requiredCount = 1) => ({
    targetType: 'event' as const,
    targetId: event.id,
    facilityId: t.facilityId,
    targetTitle: event.title,
    requirements: [
      {
        kind: 'supervisor' as const,
        role: 'front_desk' as const,
        requiredCount,
        requiredQualifications: [],
      },
      {
        kind: 'organizer' as const,
        role: 'program_manager' as const,
        requiredCount: 1,
        requiredQualifications: ['first_aid'],
      },
    ],
  });

  const requirementRows = (eventId: string) =>
    t.db
      .selectFrom('assignment_requirements')
      .selectAll()
      .where('target_type', '=', 'event')
      .where('target_id', '=', eventId)
      .orderBy('role')
      .execute();

  async function offerHost(event: Event, host: Actor, slot: number) {
    const res = await post(t, '/v1/assignments', scheduler, {
      personId: host.personId,
      kind: 'supervisor',
      targetType: 'event',
      targetId: event.id,
      role: 'front_desk',
      slot,
      offer: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.assignment as { id: string; revision: number };
  }

  it('declareRequirements twice for one event creates each requirement once', async () => {
    const event = await party('2027-02-06');
    const first = await uow.run(() => staffing.declareRequirements(booking, staffingOf(event)));
    const second = await uow.run(() => staffing.declareRequirements(booking, staffingOf(event)));
    expect(first.requirementIds).toHaveLength(2);
    expect(second.requirementIds).toEqual(first.requirementIds);
    const rows = await requirementRows(event.id);
    expect(rows).toHaveLength(2);
    expect(
      rows.map((r) => [r.kind, r.role, r.must_be_accepted, r.required_qualifications]),
    ).toEqual([
      ['supervisor', 'front_desk', true, []],
      ['organizer', 'program_manager', true, ['first_aid']],
    ]);
    expect(rows.every((r) => r.retired_at === null && r.scheduling_event_id === event.id)).toBe(
      true,
    );
    const listed = await t.http
      .get(`/v1/assignment-requirements?targetType=event&targetId=${event.id}`)
      .set(scheduler.header);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toHaveLength(2);
    expect(listed.body[0]).toMatchObject({
      mustBeAccepted: true,
      coverage: { uncoveredSlots: [1] },
    });

    // The port joins the caller's unit of work: a caller that rolls back keeps nothing.
    const other = await party('2027-02-06');
    await expect(
      uow.run(async () => {
        await staffing.declareRequirements(booking, staffingOf(other));
        throw new Error('booking failed later');
      }),
    ).rejects.toThrow('booking failed later');
    expect(await requirementRows(other.id)).toEqual([]);

    // Only enrollment bookings (or staff managing requirements) declare staffing.
    await expect(
      staffing.declareRequirements(
        systemPrincipal(t.organizationId, 'automation'),
        staffingOf(other),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(
      staffing.declareRequirements(
        staffPrincipal(t.organizationId, ['front_desk']),
        staffingOf(other),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    // staff managing requirements may declare as well
    const declaredByScheduler = await staffing.declareRequirements(
      staffPrincipal(t.organizationId, ['scheduler']),
      staffingOf(other),
    );
    expect(declaredByScheduler.requirementIds).toHaveLength(2);
    // The event must be at the stated facility.
    await expect(
      staffing.declareRequirements(booking, {
        ...staffingOf(other),
        facilityId: world.pitch.pitchId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('the database refuses un-retiring a requirement and assigning to a retired one', async () => {
    const event = await party('2027-02-07');
    const declared = await uow.run(() => staffing.declareRequirements(booking, staffingOf(event)));
    const host = await staffMember(t, ['front_desk']);
    const offered = await offerHost(event, host, 1);
    const withdrawn = await uow.run(() =>
      staffing.withdrawRequirements(booking, {
        targetType: 'event',
        targetId: event.id,
        reason: 'Booking canceled',
      }),
    );
    expect(withdrawn.retiredRequirementIds.sort()).toEqual([...declared.requirementIds].sort());
    expect(withdrawn.withdrawnAssignmentIds).toEqual([offered.id]);
    const [supervisor] = (await requirementRows(event.id)).filter((r) => r.role === 'front_desk');
    expect(supervisor).toMatchObject({
      retired_reason: 'Booking canceled',
      retired_by: expect.objectContaining({ actorLabel: 'enrollment.booking' }),
    });
    expect(supervisor?.retired_at).not.toBeNull();

    // a retired requirement is final: neither un-retired nor changed
    await expectPgError(
      t.db
        .updateTable('assignment_requirements')
        .set({ retired_at: null, retired_reason: null, retired_by: null })
        .where('id', '=', supervisor!.id)
        .execute(),
      '23001',
    );
    await expectPgError(
      t.db
        .updateTable('assignment_requirements')
        .set({ required_count: 3 })
        .where('id', '=', supervisor!.id)
        .execute(),
      '23001',
    );
    // no assignment is proposed, offered or accepted against it (the database decides)
    await expectPgError(
      createAssignmentFixture(t, {
        targetType: 'event',
        targetId: event.id,
        personId: host.personId,
        kind: 'supervisor',
        role: 'front_desk',
        slot: 2,
        status: 'proposed',
        scheduledStart: event.scheduledStart,
        scheduledEnd: event.scheduledEnd,
      }),
      '23001',
    );
    // and the API answers with the reason
    const again = await post(t, '/v1/assignments', scheduler, {
      personId: host.personId,
      kind: 'supervisor',
      targetType: 'event',
      targetId: event.id,
      role: 'front_desk',
      slot: 2,
    });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.details.conflicts).toEqual([
      { code: 'requirement_retired', role: 'front_desk' },
    ]);
    const patch = await t.http
      .patch(`/v1/assignment-requirements/${supervisor!.id}`)
      .set(scheduler.header)
      .set('Idempotency-Key', key())
      .send({ requiredCount: 2, expectedRevision: supervisor!.revision });
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect(patch.body.code).toBe('INVALID_TRANSITION');
    // retired requirements no longer appear in a target's requirements
    const listed = await t.http
      .get(`/v1/assignment-requirements?targetType=event&targetId=${event.id}`)
      .set(scheduler.header);
    expect(listed.body).toEqual([]);
    // a repeat retires and withdraws nothing
    const repeat = await uow.run(() =>
      staffing.withdrawRequirements(booking, {
        targetType: 'event',
        targetId: event.id,
        reason: 'Booking canceled',
      }),
    );
    expect(repeat).toEqual({ withdrawnAssignmentIds: [], retiredRequirementIds: [] });

    // retirement facts come together: when, why and by whom
    const fresh = await party('2027-02-07');
    const id = await createRequirementFixture(t, {
      targetType: 'event',
      targetId: fresh.id,
      kind: 'supervisor',
      role: 'front_desk',
    });
    await expectPgError(
      t.db
        .updateTable('assignment_requirements')
        .set({ retired_at: new Date() })
        .where('id', '=', id)
        .execute(),
      '23514',
    );
  });

  it('SPK-STAFF-002: an offered host does not cover the requirement; an accepted one does', async () => {
    // inside the 48-hour escalation window the tests configure
    const event = await party('2027-01-17');
    await uow.run(() => staffing.declareRequirements(booking, staffingOf(event, 2)));
    const host = await staffMember(t, ['front_desk']);
    const second = await staffMember(t, ['front_desk']);
    const offered = await offerHost(event, host, 1);
    const roleCoverage = async () =>
      (await coverage.coverage(t.organizationId, 'event', event.id)).find(
        (c) => c.role === 'front_desk',
      );
    expect(await roleCoverage()).toMatchObject({
      mustBeAccepted: true,
      acceptedPersonIds: [],
      offered: 1,
      uncoveredSlots: [1, 2],
    });
    expect(await coverage.acceptedAssignees(t.organizationId, 'event', event.id)).toEqual([]);

    const accepted = await post(t, `/v1/assignments/${offered.id}/accept`, host, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await roleCoverage()).toMatchObject({
      acceptedPersonIds: [host.personId],
      offered: 0,
      uncoveredSlots: [2],
    });
    expect(await coverage.acceptedAssignees(t.organizationId, 'event', event.id)).toEqual([
      host.personId,
    ]);

    // slot 2 is offered and declined: an uncovered-slot exception is open
    const toDecline = await offerHost(event, second, 2);
    const declined = await post(t, `/v1/assignments/${toDecline.id}/decline`, second, {});
    expect(declined.status, JSON.stringify(declined.body)).toBe(200);
    const exceptionId = declined.body.uncovered.exceptionId as string;

    // the booking ends: requirements retire, the accepted host is withdrawn (one change event),
    // nothing is escalated, and the open exception is resolved
    const result = await uow.run(() =>
      staffing.withdrawRequirements(booking, {
        targetType: 'event',
        targetId: event.id,
        reason: 'Party canceled by the family',
      }),
    );
    expect(result.withdrawnAssignmentIds).toEqual([offered.id]);
    const hostView = await t.http.get(`/v1/assignments/${offered.id}`).set(host.header);
    expect(hostView.body).toMatchObject({
      status: 'withdrawn',
      withdrawnReason: 'Party canceled by the family',
    });
    const changes = await t.db
      .selectFrom('outbox_events')
      .select('payload')
      .where('event_type', '=', 'workforce.assignment_changed')
      .where('aggregate_id', '=', offered.id)
      .execute();
    expect(
      changes.filter((c) => (c.payload as { status: string }).status === 'withdrawn'),
    ).toHaveLength(1);
    expect(await coverage.coverage(t.organizationId, 'event', event.id)).toEqual([]);
    expect(await coverage.acceptedAssignees(t.organizationId, 'event', event.id)).toEqual([]);
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select(['id', 'status', 'resolution'])
      .where('category', '=', UNCOVERED_ASSIGNMENT)
      .where('affected_id', '=', event.id)
      .execute();
    expect(exceptions).toEqual([
      expect.objectContaining({
        id: exceptionId,
        status: 'resolved',
        resolution: { retiredRequirementIds: expect.arrayContaining(result.retiredRequirementIds) },
      }),
    ]);
  });

  it('WRK-02: an acceptance racing a retirement never leaves a live assignment on a retired requirement', async () => {
    for (const date of ['2027-02-14', '2027-02-15', '2027-02-16']) {
      const event = await party(date);
      await uow.run(() => staffing.declareRequirements(booking, staffingOf(event)));
      const host = await staffMember(t, ['front_desk']);
      const offered = await offerHost(event, host, 1);
      await Promise.allSettled([
        post(t, `/v1/assignments/${offered.id}/accept`, host, {}),
        uow.run(() =>
          staffing.withdrawRequirements(booking, {
            targetType: 'event',
            targetId: event.id,
            reason: 'Booking canceled',
          }),
        ),
      ]);
      const live = await t.db
        .selectFrom('assignments')
        .select(['id', 'status'])
        .where('target_id', '=', event.id)
        .where('status', 'in', ['proposed', 'offered', 'accepted'])
        .execute();
      const active = (await requirementRows(event.id)).filter((r) => r.retired_at === null);
      // either the retirement committed (and withdrew whatever it found) or nothing changed
      if (active.length === 0) expect(live).toEqual([]);
      else expect(live).toHaveLength(1);
    }
  });

  it('an accepted coach on one session of an offering passes; an offered one does not', async () => {
    const programManager = await staffMember(t, ['program_manager']);
    const programId = await createProgramFixture(t);
    const offering = await createOfferingFixture(t, {
      programId,
      responsibleManagerPersonId: programManager.personId,
    });
    const other = await createOfferingFixture(t, {
      programId,
      responsibleManagerPersonId: programManager.personId,
    });
    const session = async (date: string) => {
      const res = await post(t, `/v1/offerings/${offering.offeringId}/sessions`, programManager, {
        scheduledStart: at(date, '16:00'),
        scheduledEnd: at(date, '17:00'),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.id as string;
    };
    const first = await session('2027-03-01');
    const secondSession = await session('2027-03-08');
    const acceptedCoach = await staffMember(t, ['coach']);
    const offeredCoach = await staffMember(t, ['coach']);
    const assign = async (coach: Actor, sessionId: string) => {
      const res = await post(t, '/v1/assignments', programManager, {
        personId: coach.personId,
        kind: 'coach',
        targetType: 'session',
        targetId: sessionId,
        offeringId: offering.offeringId,
        role: 'instructor',
        offer: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.assignment.id as string;
    };
    const acceptedId = await assign(acceptedCoach, first);
    await assign(offeredCoach, secondSession);
    const accepted = await post(t, `/v1/assignments/${acceptedId}/accept`, acceptedCoach, {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);

    const check = (personId: string, offeringId = offering.offeringId, kind = 'coach' as const) =>
      coverage.isAcceptedOnOffering(t.organizationId, offeringId, personId, kind);
    expect(await check(acceptedCoach.personId)).toBe(true);
    expect(await check(offeredCoach.personId)).toBe(false);
    expect(await check(acceptedCoach.personId, other.offeringId)).toBe(false);
    expect(
      await coverage.isAcceptedOnOffering(
        t.organizationId,
        offering.offeringId,
        acceptedCoach.personId,
        'official',
      ),
    ).toBe(false);
    // reads through the caller's transaction
    expect(
      await uow.run(({ trx }) =>
        coverage.isAcceptedOnOffering(
          t.organizationId,
          offering.offeringId,
          acceptedCoach.personId,
          'coach',
          trx,
        ),
      ),
    ).toBe(true);

    // WRK-02: an assignment of a retired requirement no longer counts
    const requirementId = await createRequirementFixture(t, {
      targetType: 'session',
      targetId: first,
      offeringId: offering.offeringId,
      kind: 'coach',
      role: 'instructor',
    });
    await t.db
      .updateTable('assignment_requirements')
      .set({
        retired_at: t.clock.now(),
        retired_reason: 'Session moved to another program',
        retired_by: json({ kind: 'system', actorLabel: 'fixtures' }),
      })
      .where('id', '=', requirementId)
      .execute();
    expect(await check(acceptedCoach.personId)).toBe(false);
  });
});
