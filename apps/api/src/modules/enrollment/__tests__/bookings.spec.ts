import {
  OfferingKindSchema,
  newId,
  systemPrincipal,
  type PolicyVersion,
} from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalExceptions, Outbox, UnitOfWork } from '../../../kernel';
import { staffPrincipal, type TestApp } from '../../../testing';
import { POLICY_PORT, createPolicyVersionFixture, type PolicyPort } from '../../catalog';
import { EventsService, createScheduledEvent, seedResource } from '../../scheduling';
import { WorkforceEvents, createAssignmentFixture } from '../../workforce';
import {
  BASKET_PORT,
  BOOKING_QUERY_PORT,
  ENROLLMENT_PORT,
  type BasketPort,
  type BookingQueryPort,
  type EnrollmentPort,
} from '../enrollment.ports';
import { BookingsService } from '../services/bookings.service';
import { BOOKING_LIFECYCLE_JOB, EnrollmentJobs } from '../services/enrollment-jobs';
import { definitionWithScope } from './package-g-support';
import { useBookingTerms } from './stage3-doubles';
import {
  CLOCK_START,
  acknowledge,
  adult,
  drain,
  enrollmentTestApp,
  offering,
  post,
  staff,
  type Actor,
  type OfferingSetup,
} from './support';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const partyKind = (OfferingKindSchema.options as readonly string[]).includes('party');

/** ENR-13: rentals and parties (capabilities rentals and parties; DEC-016, DEC-076, DEC-077). */
describe('rental and party bookings (ENR-13, SPK-COND-003)', () => {
  let t: TestApp;
  let scheduler: Actor;
  let fields: string[];

  beforeAll(async () => {
    t = await enrollmentTestApp({ capabilities: ['rentals', 'parties'] });
    scheduler = await staff(t, ['scheduler']);
    fields = [];
    for (let i = 0; i < 3; i += 1) {
      fields.push(
        (
          await seedResource(t.db, {
            organizationId: t.organizationId,
            facilityId: t.facilityId,
            name: `Field ${i + 1}`,
          })
        ).resourceId,
      );
    }
  });
  afterAll(async () => {
    await t.close();
  });

  /** Approved booking terms with the given confirmation mode (POL-040 test values). */
  async function terms(confirmationMode: 'instant' | 'request'): Promise<PolicyVersion> {
    const id = await createPolicyVersionFixture(t, {
      kind: 'refund',
      content: {
        confirmationMode,
        installmentPolicyKey: null,
        accessConditions: 'Gate code at check-in',
        hostResponsibilities: null,
      },
    });
    const version = await t.app.get<PolicyPort>(POLICY_PORT).getPolicyVersion(t.organizationId, id);
    return version!;
  }

  async function rental(
    options: {
      mode?: 'instant' | 'request';
      staffing?: Array<Record<string, unknown>>;
      price?: number;
      resources?: string[];
    } = {},
  ): Promise<OfferingSetup> {
    const definitionId = await definitionWithScope(t, 'rental_resource', {
      resources: { resourceIds: options.resources ?? fields, count: 1 },
      staffing: options.staffing ?? [],
    });
    const setup = await offering(t, {
      kind: 'rental',
      entitlementDefinitionId: definitionId,
      basePriceMinor: options.price ?? 0,
      ageBand: { minAgeYears: 18 },
    });
    useBookingTerms(setup.offeringId, await terms(options.mode ?? 'instant'));
    return setup;
  }

  async function booker(setup: OfferingSetup): Promise<Actor> {
    const actor = await adult(t);
    await acknowledge(t, setup, actor.personId, actor.personId);
    return actor;
  }

  const counts = async () => ({
    events: Number(
      (
        await t.db
          .selectFrom('events')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('source_type', '=', 'enrollment.booking')
          .executeTakeFirstOrThrow()
      ).n,
    ),
    bookings: Number(
      (
        await t.db
          .selectFrom('bookings')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    ),
    lines: Number(
      (
        await t.db
          .selectFrom('basket_lines')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('intent', 'in', ['rental_request', 'party_request'])
          .executeTakeFirstOrThrow()
      ).n,
    ),
    holds: Number(
      (
        await t.db
          .selectFrom('holds')
          .innerJoin('capacity_pools', 'capacity_pools.id', 'holds.pool_id')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('capacity_pools.scope_type', '=', 'rental')
          .executeTakeFirstOrThrow()
      ).n,
    ),
    requirements: Number(
      (
        await t.db
          .selectFrom('assignment_requirements')
          .select((eb) => eb.fn.countAll().as('n'))
          .where('target_type', '=', 'event')
          .executeTakeFirstOrThrow()
      ).n,
    ),
  });

  const start = (days: number, hourUtc = 18) =>
    new Date(Date.parse('2026-11-10T00:00:00Z') + days * DAY + hourUtc * HOUR);

  /** Pays the booking's held basket the way finance does after payment facts (§4.11 step 8). */
  async function pay(basketId: string, enrollmentId: string): Promise<void> {
    const finance = systemPrincipal(t.organizationId, 'finance.checkout');
    await t.app.get(UnitOfWork).run(async ({ trx }) => {
      await t.app
        .get<BasketPort>(BASKET_PORT)
        .startCheckout(trx, t.organizationId, basketId, `order-${newId()}`, finance);
      await t.app
        .get<EnrollmentPort>(ENROLLMENT_PORT)
        .confirmEnrollment(trx, t.organizationId, enrollmentId, {
          actor: finance,
          orderRef: 'order-booking',
        });
      await t.app
        .get<BasketPort>(BASKET_PORT)
        .finishCheckout(trx, t.organizationId, basketId, 'fulfilled', finance);
    });
    await drain(t);
  }

  async function accept(eventId: string, role: string, kind: 'supervisor' | 'organizer') {
    const person = await staff(t, ['program_manager']);
    const assignmentId = await createAssignmentFixture(t, {
      targetType: 'event',
      targetId: eventId,
      personId: person.personId,
      scheduledStart: start(5),
      scheduledEnd: new Date(start(5).getTime() + HOUR),
      status: 'accepted',
      kind,
      role,
    });
    await t.app.get(UnitOfWork).run(({ trx }) =>
      t.app.get(Outbox).enqueue(trx, WorkforceEvents.assignmentChanged, {
        organizationId: t.organizationId,
        aggregateType: 'assignment',
        aggregateId: assignmentId,
        payload: {
          assignmentId,
          personId: person.personId,
          kind,
          targetType: 'event',
          targetId: eventId,
          facilityId: t.facilityId,
          role,
          slot: 1,
          engagement: 'regular',
          status: 'accepted',
          previousStatus: 'offered',
          scheduledStart: start(5).toISOString(),
          scheduledEnd: new Date(start(5).getTime() + HOUR).toISOString(),
          replacesAssignmentId: null,
          reason: null,
        },
      }),
    );
    await drain(t);
  }

  it('SPK-COND-003: a rental whose required staff is not yet accepted is awaiting_staff after payment, never confirmed, and its exception names the scheduler queue', async () => {
    const setup = await rental({
      price: 4_000,
      staffing: [{ kind: 'supervisor', role: 'field_supervisor', count: 1, qualifications: [] }],
    });
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(5).toISOString(),
      end: new Date(start(5).getTime() + HOUR).toISOString(),
      resourceIds: [fields[0]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body).toMatchObject({
      kind: 'rental',
      status: 'held',
      outstanding: expect.arrayContaining(['payment', 'staffing']),
    });
    expect(booked.body.occurrences[0].eventId).not.toBeNull();
    const row = await t.db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', booked.body.id)
      .executeTakeFirstOrThrow();
    await pay(row.basket_id!, row.enrollment_id!);
    const afterPayment = await t.http
      .get(`/v1/bookings/${booked.body.id as string}`)
      .set(customer.header);
    expect(afterPayment.body).toMatchObject({
      status: 'awaiting_staff',
      outstanding: ['staffing'],
    });
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'status'])
      .where('category', '=', 'enrollment.booking_awaiting_staff')
      .where('affected_id', '=', booked.body.id)
      .execute();
    expect(exceptions).toEqual([{ owner_queue: 'scheduler', status: 'open' }]);
    // Once the slot is covered by an accepted assignment the booking is confirmed.
    await accept(row.scheduling_event_ids[0]!, 'field_supervisor', 'supervisor');
    const staffed = await t.http
      .get(`/v1/bookings/${booked.body.id as string}`)
      .set(customer.header);
    expect(staffed.body).toMatchObject({ status: 'confirmed', outstanding: [] });
  });

  it.skipIf(!partyKind)(
    'SPK-COND-003: a party whose host is not yet accepted is awaiting_staff after payment, never confirmed, and its exception names the scheduler queue',
    async () => {
      const definitionId = await definitionWithScope(t, 'party_package' as never, {
        durationMinutes: 120,
        guestLimit: 12,
        resources: { resourceIds: fields, count: 1 },
        staffing: [{ kind: 'organizer', role: 'party_host', count: 1, qualifications: [] }],
        equipmentAssetIds: [],
      });
      const setup = await offering(t, {
        kind: 'party' as never,
        entitlementDefinitionId: definitionId,
        basePriceMinor: 15_000,
        ageBand: { minAgeYears: 18 },
      });
      useBookingTerms(setup.offeringId, await terms('instant'));
      const host = await booker(setup);
      const booked = await post(t, '/v1/bookings', host.header, {
        offeringId: setup.offeringId,
        start: start(6, 20).toISOString(),
        resourceIds: [fields[1]],
        guestCount: 10,
      });
      expect(booked.status, JSON.stringify(booked.body)).toBe(201);
      const row = await t.db
        .selectFrom('bookings')
        .selectAll()
        .where('id', '=', booked.body.id)
        .executeTakeFirstOrThrow();
      await pay(row.basket_id!, row.enrollment_id!);
      const after = await t.http.get(`/v1/bookings/${booked.body.id as string}`).set(host.header);
      expect(after.body.status).toBe('awaiting_staff');
      const exception = await t.db
        .selectFrom('operational_exceptions')
        .select('owner_queue')
        .where('category', '=', 'enrollment.booking_awaiting_staff')
        .where('affected_id', '=', booked.body.id)
        .executeTakeFirstOrThrow();
      expect(exception.owner_queue).toBe('scheduler');
    },
  );

  it("SPK-SCHED-007 / SPK-STAFF-002: cancelling a recurring rental after its first week withdraws only the future weeks' staffing; work already done stays accepted and can be completed", async () => {
    const setup = await rental({
      price: 4_000,
      staffing: [{ kind: 'supervisor', role: 'field_supervisor', count: 1, qualifications: [] }],
    });
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(40).toISOString(),
      end: new Date(start(40).getTime() + HOUR).toISOString(),
      recurrence: { interval: 1, count: 4 },
      resourceIds: [fields[1]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const row = await t.db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', booked.body.id)
      .executeTakeFirstOrThrow();
    expect(row.scheduling_series_id).not.toBeNull();
    await pay(row.basket_id!, row.enrollment_id!);
    const events = await t.db
      .selectFrom('events')
      .select(['id', 'scheduled_start'])
      .where('id', 'in', row.scheduling_event_ids)
      .orderBy('scheduled_start')
      .execute();
    expect(events).toHaveLength(4);
    for (const event of events) await accept(event.id, 'field_supervisor', 'supervisor');
    const staffed = await t.http
      .get(`/v1/bookings/${booked.body.id as string}`)
      .set(customer.header);
    expect(staffed.body.status).toBe('confirmed');
    const assignmentOf = async (eventId: string) =>
      t.db
        .selectFrom('assignments')
        .select(['id', 'status'])
        .where('target_type', '=', 'event')
        .where('target_id', '=', eventId)
        .executeTakeFirstOrThrow();

    // Week 1 has taken place; weeks 2 to 4 are still ahead.
    const manager = await staff(t, ['program_manager']);
    t.clock.set(new Date(events[0]!.scheduled_start.getTime() + 2 * HOUR));
    try {
      const canceled = await post(
        t,
        `/v1/bookings/${booked.body.id as string}/cancel`,
        manager.header,
        { reason: 'Team folded', expectedRevision: staffed.body.revision },
      );
      expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
      expect(canceled.body.status).toBe('canceled');
      await drain(t);
      const statuses = await t.db
        .selectFrom('events')
        .select(['id', 'status'])
        .where('id', 'in', row.scheduling_event_ids)
        .execute();
      const statusOf = new Map(statuses.map((e) => [e.id, e.status]));
      expect(statusOf.get(events[0]!.id)).not.toBe('canceled');
      for (const later of events.slice(1)) expect(statusOf.get(later.id)).toBe('canceled');
      // The past week's staffing is untouched; the cancelled weeks' assignments are withdrawn.
      const past = await assignmentOf(events[0]!.id);
      expect(past.status).toBe('accepted');
      for (const later of events.slice(1)) {
        expect((await assignmentOf(later.id)).status).toBe('withdrawn');
      }
      const retired = await t.db
        .selectFrom('assignment_requirements')
        .select(['target_id', 'retired_at'])
        .where('target_type', '=', 'event')
        .where('target_id', 'in', row.scheduling_event_ids)
        .execute();
      for (const requirement of retired) {
        if (requirement.target_id === events[0]!.id) expect(requirement.retired_at).toBeNull();
        else expect(requirement.retired_at).not.toBeNull();
      }
      // The work done can still be completed (and so paid).
      const completed = await post(t, `/v1/assignments/${past.id}/complete`, manager.header, {});
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      expect((await assignmentOf(events[0]!.id)).status).toBe('completed');
    } finally {
      t.clock.set(new Date(CLOCK_START));
    }
  });

  /** A paid rental with an accepted supervisor on each week, confirmed (fields[2], from day 70). */
  async function staffedPaidRental(weeks: number, day: number) {
    const setup = await rental({
      price: 6_000,
      staffing: [{ kind: 'supervisor', role: 'field_supervisor', count: 1, qualifications: [] }],
    });
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(day).toISOString(),
      end: new Date(start(day).getTime() + HOUR).toISOString(),
      ...(weeks > 1 ? { recurrence: { interval: 1, count: weeks } } : {}),
      resourceIds: [fields[2]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const row = await t.db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', booked.body.id)
      .executeTakeFirstOrThrow();
    await pay(row.basket_id!, row.enrollment_id!);
    const events = await t.db
      .selectFrom('events')
      .select(['id', 'scheduled_start', 'scheduled_end'])
      .where('id', 'in', row.scheduling_event_ids)
      .orderBy('scheduled_start')
      .execute();
    for (const event of events) await accept(event.id, 'field_supervisor', 'supervisor');
    const confirmed = await t.http
      .get(`/v1/bookings/${booked.body.id as string}`)
      .set(customer.header);
    expect(confirmed.body.status).toBe('confirmed');
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select(['id', 'order_ref'])
      .where('id', '=', row.enrollment_id!)
      .executeTakeFirstOrThrow();
    return { setup, customer, booking: confirmed.body, row, events, enrollment };
  }

  async function closeAndApply(from: Date, to: Date) {
    const closure = await post(t, '/v1/closures', scheduler.header, {
      facilityId: t.facilityId,
      resourceId: fields[2],
      interval: { start: from.toISOString(), end: to.toISOString() },
      reason: 'Flooded field',
      source: 'manual',
    });
    expect(closure.status, JSON.stringify(closure.body)).toBe(201);
    const applied = await post(
      t,
      `/v1/closures/${closure.body.id as string}/apply`,
      scheduler.header,
      {
        mode: 'cancel_affected',
        expectedRevision: closure.body.revision,
      },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    await drain(t);
    return closure.body as {
      impact: {
        customers: Array<{ personId: string; via: string[] }>;
        obligations: Array<{ type: string; id: string }>;
      };
    };
  }

  /**
   * One run of enrollment.booking_lifecycle at the clock's time, called directly so a run at a
   * later test time leaves no job lease behind for the tests that follow.
   */
  async function lifecycle(): Promise<void> {
    const jobs = t.app.get(EnrollmentJobs);
    let result = { processed: 0, remaining: 1 };
    for (let pass = 0; pass < 10 && result.remaining > 0; pass += 1) {
      result = await jobs.bookingLifecycle({ now: t.clock.now(), batchSize: 50 });
    }
  }

  const exceptionsOf = (bookingId: string) =>
    t.db
      .selectFrom('operational_exceptions')
      .select(['category', 'status', 'owner_queue', 'details'])
      .where('affected_type', '=', 'booking')
      .where('affected_id', '=', bookingId)
      .orderBy('category')
      .execute();

  it('SPK-SCHED-009 / SPK-COND-003: a closure that cancels a paid rental cancels the booking, names its booker and order, tells the booker and never completes it', async () => {
    const { customer, booking, row, events, enrollment } = await staffedPaidRental(1, 70);
    const closure = await closeAndApply(
      new Date(events[0]!.scheduled_start.getTime() - 3 * HOUR),
      new Date(events[0]!.scheduled_end.getTime() + 3 * HOUR),
    );
    // The preview named the booker and the order the booking was paid through.
    expect(closure.impact.customers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ personId: customer.personId, via: ['booking'] }),
      ]),
    );
    expect(closure.impact.obligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'order', id: enrollment.order_ref }),
      ]),
    );
    const after = await t.http.get(`/v1/bookings/${booking.id as string}`).set(customer.header);
    expect(after.body.status).toBe('canceled');
    // Its money has an owner; no staffing exception is left open for a booking that will not happen.
    const exceptions = await exceptionsOf(booking.id);
    const open = exceptions.filter((e) => e.status === 'open');
    expect(open.map((e) => e.category)).toEqual(['enrollment.booking_canceled_by_schedule']);
    expect(open[0]).toMatchObject({
      owner_queue: 'finance_operator',
      details: { enrollmentId: row.enrollment_id, orderRef: enrollment.order_ref },
    });
    // The booker was told.
    const notices = await t.db
      .selectFrom('notifications')
      .innerJoin(
        'notification_recipients',
        'notification_recipients.notification_id',
        'notifications.id',
      )
      .select(['notifications.kind'])
      .where('notifications.subject_id', '=', events[0]!.id)
      .where('notification_recipients.person_id', '=', customer.personId)
      .execute();
    expect(notices.map((n) => n.kind)).toContain('cancellation');
    // At its start and after its end the lifecycle job neither raises "started unstaffed" nor
    // completes it or its enrollment.
    t.clock.set(new Date(events[0]!.scheduled_end.getTime() + HOUR));
    try {
      await lifecycle();
      await drain(t);
      const later = await t.db
        .selectFrom('bookings')
        .select('status')
        .where('id', '=', booking.id)
        .executeTakeFirstOrThrow();
      expect(later.status).toBe('canceled');
      const enrollmentAfter = await t.db
        .selectFrom('enrollments')
        .select('status')
        .where('id', '=', row.enrollment_id!)
        .executeTakeFirstOrThrow();
      expect(enrollmentAfter.status).not.toBe('completed');
      expect((await exceptionsOf(booking.id)).map((e) => e.category)).not.toContain(
        'enrollment.booking_started_unstaffed',
      );
    } finally {
      t.clock.set(new Date(CLOCK_START));
    }
  });

  const requirementsOf = (eventIds: string[]) =>
    t.db
      .selectFrom('assignment_requirements')
      .select(['target_id', 'retired_at'])
      .where('target_type', '=', 'event')
      .where('target_id', 'in', eventIds)
      .execute();

  it('SPK-SCHED-009: a closure that cancels one week of a recurring rental keeps the booking confirmed and gives the lost week an owner', async () => {
    const { customer, booking, events } = await staffedPaidRental(3, 84);
    await closeAndApply(
      new Date(events[1]!.scheduled_start.getTime() - HOUR),
      new Date(events[1]!.scheduled_end.getTime() + HOUR),
    );
    const row = await t.db
      .selectFrom('bookings')
      .select(['status'])
      .where('id', '=', booking.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('confirmed');
    const open = (await exceptionsOf(booking.id)).filter((e) => e.status === 'open');
    expect(open.map((e) => e.category)).toEqual(['enrollment.booking_occurrence_canceled']);
    expect(open[0]!.details).toMatchObject({ eventId: events[1]!.id });
    // The booking reads as what still takes place: the lost week is no longer listed as booked,
    // and its times agree with its occurrences.
    const read = await t.http.get(`/v1/bookings/${booking.id as string}`).set(customer.header);
    expect(read.status).toBe(200);
    const occurrences = read.body.occurrences as Array<{
      start: string;
      end: string;
      eventId: string;
    }>;
    expect(occurrences.map((o) => o.eventId)).toEqual([events[0]!.id, events[2]!.id]);
    expect(read.body.firstStart).toBe(occurrences[0]!.start);
    expect(read.body.lastEnd).toBe(occurrences[occurrences.length - 1]!.end);
    // COMMANDS-01 / ASYNC-01: the lost week's staffing is withdrawn, the others stay in force.
    for (const requirement of await requirementsOf(events.map((e) => e.id))) {
      if (requirement.target_id === events[1]!.id) expect(requirement.retired_at).not.toBeNull();
      else expect(requirement.retired_at).toBeNull();
    }
  });

  it('ASYNC-01 / §4.12: a lost occurrence handled after its start still gets an owner and loses its staffing, and a resolved one is not raised again', async () => {
    const { booking, events } = await staffedPaidRental(3, 140);
    // The closure is applied before week 2, but its change is handled only once week 2 started
    // (a late or retried delivery).
    const closure = await post(t, '/v1/closures', scheduler.header, {
      facilityId: t.facilityId,
      resourceId: fields[2],
      interval: {
        start: new Date(events[1]!.scheduled_start.getTime() - HOUR).toISOString(),
        end: new Date(events[1]!.scheduled_end.getTime() + HOUR).toISOString(),
      },
      reason: 'Flooded field',
      source: 'manual',
    });
    expect(closure.status, JSON.stringify(closure.body)).toBe(201);
    const applied = await post(
      t,
      `/v1/closures/${closure.body.id as string}/apply`,
      scheduler.header,
      { mode: 'cancel_affected', expectedRevision: closure.body.revision },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    t.clock.set(new Date(events[1]!.scheduled_start.getTime() + 10 * 60_000));
    try {
      await drain(t);
      const lost = () =>
        exceptionsOf(booking.id).then((rows) =>
          rows.filter((e) => e.category === 'enrollment.booking_occurrence_canceled'),
        );
      const raised = await lost();
      expect(raised).toHaveLength(1);
      expect(raised[0]).toMatchObject({
        status: 'open',
        owner_queue: 'finance_operator',
        details: { eventId: events[1]!.id },
      });
      const retired = (await requirementsOf([events[1]!.id])).map((r) => r.retired_at);
      expect(retired.length).toBeGreaterThan(0);
      for (const at of retired) expect(at).not.toBeNull();
      // A finance operator decides it; a later change of the booking does not raise it again.
      const exception = await t.db
        .selectFrom('operational_exceptions')
        .select('id')
        .where('category', '=', 'enrollment.booking_occurrence_canceled')
        .where('affected_id', '=', booking.id)
        .executeTakeFirstOrThrow();
      await t.app
        .get(UnitOfWork)
        .run(({ trx }) =>
          t.app
            .get(OperationalExceptions)
            .transition(
              trx,
              systemPrincipal(t.organizationId, 'test.finance'),
              exception.id,
              'resolved',
              { reason: 'Week credited by phone' },
            ),
        );
      const third = await t.db
        .selectFrom('events')
        .select('revision')
        .where('id', '=', events[2]!.id)
        .executeTakeFirstOrThrow();
      const later = new Date(events[2]!.scheduled_start.getTime() + 30 * 60_000);
      await t.app
        .get(EventsService)
        .moveEvent(staffPrincipal(t.organizationId, ['scheduler']), events[2]!.id, {
          scheduledStart: later.toISOString(),
          scheduledEnd: new Date(later.getTime() + HOUR).toISOString(),
          expectedRevision: third.revision,
          reason: 'Later kick-off',
        });
      await drain(t);
      expect((await lost()).map((e) => e.status)).toEqual(['resolved']);
      const moved = await t.db
        .selectFrom('bookings')
        .select(['status', 'last_end'])
        .where('id', '=', booking.id)
        .executeTakeFirstOrThrow();
      expect(moved).toEqual({ status: 'confirmed', last_end: new Date(later.getTime() + HOUR) });
    } finally {
      t.clock.set(new Date(CLOCK_START));
    }
  });

  it('SPK-SCHED-009: a booking relocated through scheduling names the new field on that occurrence and audits the change', async () => {
    const { customer, booking, events } = await staffedPaidRental(2, 170);
    const first = await t.db
      .selectFrom('events')
      .select('revision')
      .where('id', '=', events[0]!.id)
      .executeTakeFirstOrThrow();
    await t.app
      .get(EventsService)
      .moveEvent(staffPrincipal(t.organizationId, ['scheduler']), events[0]!.id, {
        scheduledStart: events[0]!.scheduled_start.toISOString(),
        scheduledEnd: events[0]!.scheduled_end.toISOString(),
        resourceIds: [fields[0]!],
        expectedRevision: first.revision,
        reason: 'Field 3 resurfaced',
      });
    await drain(t);
    const read = await t.http.get(`/v1/bookings/${booking.id as string}`).set(customer.header);
    expect(read.status).toBe(200);
    const occurrences = read.body.occurrences as Array<{
      eventId: string;
      resources: Array<{ id: string; name: string | null }>;
    }>;
    expect(occurrences.map((o) => [o.eventId, o.resources.map((r) => r.id)])).toEqual([
      [events[0]!.id, [fields[0]]],
      [events[1]!.id, [fields[2]]],
    ]);
    expect(occurrences[0]!.resources[0]!.name).toBe('Field 1');
    const row = await t.db
      .selectFrom('bookings')
      .select(['resource_ids', 'revision'])
      .where('id', '=', booking.id)
      .executeTakeFirstOrThrow();
    expect([...row.resource_ids].sort()).toEqual([fields[0], fields[2]].sort());
    expect(row.revision).toBeGreaterThan(booking.revision as number);
    const audit = await t.db
      .selectFrom('audit_records')
      .select('details')
      .where('action', '=', 'enrollment.booking_follow_schedule')
      .where('target_id', '=', booking.id)
      .executeTakeFirstOrThrow();
    expect(audit.details).toMatchObject({ previousResourceIds: [fields[2]] });
  });

  it('ASYNC-01: an unpaid booking that loses a week and then expires leaves no money exception open', async () => {
    const setup = await rental({ price: 3_500 });
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(200).toISOString(),
      end: new Date(start(200).getTime() + HOUR).toISOString(),
      recurrence: { interval: 1, count: 2 },
      resourceIds: [fields[2]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.status).toBe('held');
    const second = new Date(start(207).getTime());
    await closeAndApply(new Date(second.getTime() - HOUR), new Date(second.getTime() + 2 * HOUR));
    const lost = await exceptionsOf(booked.body.id as string);
    expect(lost.map((e) => [e.category, e.status])).toEqual([
      ['enrollment.booking_occurrence_canceled', 'open'],
    ]);
    t.clock.advance(11 * 60_000);
    try {
      await drain(t);
      const expired = await t.db
        .selectFrom('bookings')
        .select('status')
        .where('id', '=', booked.body.id)
        .executeTakeFirstOrThrow();
      expect(expired.status).toBe('expired');
      const after = await exceptionsOf(booked.body.id as string);
      expect(after.filter((e) => e.status === 'open')).toEqual([]);
    } finally {
      t.clock.set(new Date(CLOCK_START));
    }
  });

  it('ASYNC-01: a booking the schedule cancels during its checkout has its money exception settled when the checkout is abandoned', async () => {
    const setup = await rental({ price: 2_000 });
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(220).toISOString(),
      end: new Date(start(220).getTime() + HOUR).toISOString(),
      resourceIds: [fields[2]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const row = await t.db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', booked.body.id)
      .executeTakeFirstOrThrow();
    const finance = systemPrincipal(t.organizationId, 'finance.checkout');
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        t.app
          .get<BasketPort>(BASKET_PORT)
          .startCheckout(trx, t.organizationId, row.basket_id!, 'order-abandoned', finance),
      );
    await closeAndApply(
      new Date(start(220).getTime() - HOUR),
      new Date(start(220).getTime() + 2 * HOUR),
    );
    const during = await exceptionsOf(row.id);
    expect(during.map((e) => [e.category, e.status])).toEqual([
      ['enrollment.booking_canceled_by_schedule', 'open'],
    ]);
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        t.app
          .get<BasketPort>(BASKET_PORT)
          .finishCheckout(trx, t.organizationId, row.basket_id!, 'abandoned', finance),
      );
    await drain(t);
    const after = await exceptionsOf(row.id);
    expect(after.map((e) => [e.category, e.status])).toEqual([
      ['enrollment.booking_canceled_by_schedule', 'resolved'],
    ]);
    const booking = await t.db
      .selectFrom('bookings')
      .select('status')
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(booking.status).toBe('canceled');
  });

  it('SPK-UX-006 / §4.12: a booking that started unstaffed raises its critical exception once, even after it is resolved', async () => {
    const setup = await rental({
      price: 4_500,
      staffing: [{ kind: 'supervisor', role: 'field_supervisor', count: 1, qualifications: [] }],
    });
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(100).toISOString(),
      end: new Date(start(100).getTime() + HOUR).toISOString(),
      recurrence: { interval: 1, count: 3 },
      resourceIds: [fields[2]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const row = await t.db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', booked.body.id)
      .executeTakeFirstOrThrow();
    await pay(row.basket_id!, row.enrollment_id!);
    t.clock.set(new Date(start(100).getTime() + 10 * 60_000));
    try {
      const started = () =>
        t.db
          .selectFrom('operational_exceptions')
          .select(['id', 'status'])
          .where('category', '=', 'enrollment.booking_started_unstaffed')
          .where('affected_id', '=', row.id)
          .execute();
      await lifecycle();
      const raised = await started();
      expect(raised).toHaveLength(1);
      // A scheduler arranges cover off-system and resolves it.
      await t.app
        .get(UnitOfWork)
        .run(({ trx }) =>
          t.app
            .get(OperationalExceptions)
            .transition(
              trx,
              systemPrincipal(t.organizationId, 'test.scheduler'),
              raised[0]!.id,
              'resolved',
              { reason: 'Cover arranged by phone' },
            ),
        );
      t.clock.advance(10 * 60_000);
      await lifecycle();
      expect(await started()).toHaveLength(1);
      // The booking is no longer due for the job until it ends.
      const due = await t.app.get(BookingsService).lifecycleDue(t.clock.now(), 50);
      expect(due.map((d) => d.id)).not.toContain(row.id);
    } finally {
      t.clock.set(new Date(CLOCK_START));
    }
  });

  it('SPK-COND-003: an instant booking whose field is taken writes nothing (no event, hold, basket line, requirement or booking)', async () => {
    const setup = await rental({
      staffing: [{ kind: 'supervisor', role: 'field_supervisor', count: 1, qualifications: [] }],
    });
    const customer = await booker(setup);
    await createScheduledEvent(t.app.get(EventsService), {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [fields[2]!],
      start: start(7).toISOString(),
      end: new Date(start(7).getTime() + 2 * HOUR).toISOString(),
    });
    const before = await counts();
    const refused = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: new Date(start(7).getTime() + 30 * 60_000).toISOString(),
      end: new Date(start(7).getTime() + 90 * 60_000).toISOString(),
      resourceIds: [fields[2]],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    expect(await counts()).toEqual(before);
  });

  it('SPK-COND-003: a recurring rental with one conflicting week is refused whole', async () => {
    const setup = await rental();
    const customer = await booker(setup);
    // Week three is taken.
    await createScheduledEvent(t.app.get(EventsService), {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [fields[0]!],
      start: new Date(start(14 + 14).getTime()).toISOString(),
      end: new Date(start(14 + 14).getTime() + HOUR).toISOString(),
    });
    const before = await counts();
    const refused = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(14).toISOString(),
      end: new Date(start(14).getTime() + HOUR).toISOString(),
      recurrence: { interval: 1, count: 4 },
      resourceIds: [fields[0]],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    expect(await counts()).toEqual(before);
    // Without the conflicting week, all four are reserved together.
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(14).toISOString(),
      end: new Date(start(14).getTime() + HOUR).toISOString(),
      recurrence: { interval: 1, count: 2 },
      resourceIds: [fields[0]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.occurrences).toHaveLength(2);
    expect(booked.body.occurrences.every((o: { eventId: string | null }) => o.eventId)).toBe(true);
  });

  it('DEC-029, POL-005: a request reserves nothing until a scheduler approves; decline ends it', async () => {
    const setup = await rental({ mode: 'request' });
    const customer = await booker(setup);
    const before = await counts();
    const requested = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(9).toISOString(),
      end: new Date(start(9).getTime() + HOUR).toISOString(),
      resourceIds: [fields[1]],
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    expect(requested.body).toMatchObject({ status: 'requested', outstanding: ['approval'] });
    const afterRequest = await counts();
    expect(afterRequest).toEqual({ ...before, bookings: before.bookings + 1 });
    const pending = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'status'])
      .where('category', '=', 'enrollment.booking_request_pending')
      .where('affected_id', '=', requested.body.id)
      .execute();
    expect(pending).toEqual([{ owner_queue: 'scheduler', status: 'open' }]);
    // The customer cannot approve their own request.
    const self = await post(
      t,
      `/v1/bookings/${requested.body.id as string}/approve`,
      customer.header,
      {
        expectedRevision: requested.body.revision,
      },
    );
    expect([403, 404]).toContain(self.status);
    const approved = await post(
      t,
      `/v1/bookings/${requested.body.id as string}/approve`,
      scheduler.header,
      { expectedRevision: requested.body.revision },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ status: 'held', outstanding: ['payment'] });
    const resolved = await t.db
      .selectFrom('operational_exceptions')
      .select('status')
      .where('category', '=', 'enrollment.booking_request_pending')
      .where('affected_id', '=', requested.body.id)
      .executeTakeFirstOrThrow();
    expect(resolved.status).toBe('resolved');

    const other = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(10).toISOString(),
      end: new Date(start(10).getTime() + HOUR).toISOString(),
      resourceIds: [fields[1]],
    });
    const declined = await post(
      t,
      `/v1/bookings/${other.body.id as string}/decline`,
      scheduler.header,
      {
        reason: 'Field reserved for maintenance',
        expectedRevision: other.body.revision,
      },
    );
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({
      status: 'declined',
      decisionReason: 'Field reserved for maintenance',
    });
  });

  it('DEC-016: creating a rental while rentals is disabled answers CAPABILITY_DISABLED; cancellation still works', async () => {
    const setup = await rental();
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(11).toISOString(),
      end: new Date(start(11).getTime() + HOUR).toISOString(),
      resourceIds: [fields[2]],
    });
    expect(booked.status).toBe(201);
    await t.disableCapability('rentals');
    try {
      const refused = await post(t, '/v1/bookings', customer.header, {
        offeringId: setup.offeringId,
        start: start(12).toISOString(),
        end: new Date(start(12).getTime() + HOUR).toISOString(),
        resourceIds: [fields[2]],
      });
      expect(refused.status).toBe(403);
      expect(refused.body.details.code).toBe('CAPABILITY_DISABLED');
      const canceled = await post(
        t,
        `/v1/bookings/${booked.body.id as string}/cancel`,
        customer.header,
        {
          reason: 'plans changed',
          expectedRevision: booked.body.revision,
        },
      );
      expect(canceled.status, JSON.stringify(canceled.body)).toBe(200);
      expect(canceled.body.status).toBe('canceled');
      const events = await t.db
        .selectFrom('events')
        .select('status')
        .where('source_id', '=', booked.body.id)
        .execute();
      expect(events.map((e) => e.status)).toEqual(['canceled']);
      const basket = await t.db
        .selectFrom('baskets')
        .select('status')
        .where('id', '=', canceled.body.basketId)
        .executeTakeFirstOrThrow();
      expect(basket.status).toBe('released');
    } finally {
      await t.enableCapability('rentals');
    }
  });

  it('§4.11, SPK-PAY-007: a held booking is not cancelled as a hold while its checkout runs or once its basket is paid', async () => {
    const setup = await rental({ price: 2_500 });
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(25).toISOString(),
      end: new Date(start(25).getTime() + HOUR).toISOString(),
      resourceIds: [fields[1]],
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(booked.body.status).toBe('held');
    const row = await t.db
      .selectFrom('bookings')
      .selectAll()
      .where('id', '=', booked.body.id)
      .executeTakeFirstOrThrow();
    const finance = systemPrincipal(t.organizationId, 'finance.checkout');
    const cancel = () =>
      post(t, `/v1/bookings/${booked.body.id as string}/cancel`, customer.header, {
        reason: 'plans changed',
        expectedRevision: booked.body.revision,
      });
    const unchanged = async () => {
      expect(
        await t.db
          .selectFrom('bookings')
          .select(['status', 'revision'])
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'held', revision: row.revision });
      const events = await t.db
        .selectFrom('events')
        .select('status')
        .where('source_id', '=', row.id)
        .execute();
      expect(events.map((e) => e.status)).not.toContain('canceled');
    };

    // While finance's checkout runs the basket is finance's: the customer cancels the checkout.
    await t.app
      .get(UnitOfWork)
      .run(({ trx }) =>
        t.app
          .get<BasketPort>(BASKET_PORT)
          .startCheckout(trx, t.organizationId, row.basket_id!, 'order-held-booking', finance),
      );
    const during = await cancel();
    expect(during.status).toBe(409);
    expect(during.body.code).toBe('RESOURCE_CONFLICT');
    expect(during.body.details).toMatchObject({
      code: 'CHECKOUT_IN_PROGRESS',
      orderRef: 'order-held-booking',
    });
    await unchanged();

    // Paid, before the enrollment confirmation moves the booking on: still not a hold to drop.
    await t.app.get(UnitOfWork).run(async ({ trx }) => {
      await t.app
        .get<EnrollmentPort>(ENROLLMENT_PORT)
        .confirmEnrollment(trx, t.organizationId, row.enrollment_id!, {
          actor: finance,
          orderRef: 'order-held-booking',
        });
      await t.app
        .get<BasketPort>(BASKET_PORT)
        .finishCheckout(trx, t.organizationId, row.basket_id!, 'fulfilled', finance);
    });
    const paid = await cancel();
    expect(paid.status).toBe(409);
    expect(paid.body.details.code).toBe('BOOKING_CONFIRMATION_PENDING');
    await unchanged();
    const basket = await t.db
      .selectFrom('baskets')
      .select('status')
      .where('id', '=', row.basket_id!)
      .executeTakeFirstOrThrow();
    expect(basket.status).toBe('fulfilled');

    // Once confirmed, the booking moves on and is cancelled through its enrollment.
    await drain(t);
    const confirmed = await t.http.get(`/v1/bookings/${row.id}`).set(customer.header);
    expect(confirmed.body.status).toBe('confirmed');
  });

  it('SPK-REG-006, POL-004: an unpaid held booking expires with its hold and releases its events', async () => {
    const setup = await rental({ price: 3_000 });
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(13).toISOString(),
      end: new Date(start(13).getTime() + HOUR).toISOString(),
      resourceIds: [fields[0]],
    });
    expect(booked.status).toBe(201);
    t.clock.advance(11 * 60_000);
    try {
      await drain(t);
      const expired = await t.http
        .get(`/v1/bookings/${booked.body.id as string}`)
        .set(customer.header);
      expect(expired.body).toMatchObject({ status: 'expired', endReason: 'hold_expired' });
      const events = await t.db
        .selectFrom('events')
        .select('status')
        .where('source_id', '=', booked.body.id)
        .execute();
      expect(events.map((e) => e.status)).toEqual(['canceled']);
    } finally {
      t.clock.set(new Date(CLOCK_START));
    }
  });

  it('reads: the booker and staff see a booking, another customer learns nothing; the availability and period port answer', async () => {
    const setup = await rental();
    const customer = await booker(setup);
    const booked = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: start(15, 17).toISOString(),
      end: new Date(start(15, 17).getTime() + HOUR).toISOString(),
      resourceIds: [fields[1]],
    });
    expect(booked.status).toBe(201);
    expect(booked.body.occurrences[0].resources).toEqual([{ id: fields[1], name: 'Field 2' }]);
    expect(booked.body.terms).toMatchObject({ accessConditions: 'Gate code at check-in' });
    const stranger = await adult(t);
    expect(
      (await t.http.get(`/v1/bookings/${booked.body.id as string}`).set(stranger.header)).status,
    ).toBe(404);
    expect(
      (await t.http.get(`/v1/bookings/${booked.body.id as string}`).set(scheduler.header)).status,
    ).toBe(200);
    const mine = await t.http.get('/v1/me/bookings').set(customer.header);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.items.map((b: { id: string }) => b.id)).toContain(booked.body.id);
    const staffList = await t.http
      .get(`/v1/bookings?facilityId=${t.facilityId}`)
      .set(scheduler.header);
    expect(staffList.status).toBe(200);
    expect(staffList.body.items.map((b: { id: string }) => b.id)).toContain(booked.body.id);
    const window = await t.http
      .get(
        `/v1/offerings/${setup.offeringId}/booking-availability?from=${start(15, 15).toISOString()}&to=${start(15, 20).toISOString()}&durationMinutes=60`,
      )
      .set(customer.header);
    expect(window.status, JSON.stringify(window.body)).toBe(200);
    expect(window.body).toMatchObject({ resourceCount: 1, durationMinutes: 60 });
    expect(window.body.resources).toHaveLength(3);
    const period = await t.app
      .get<BookingQueryPort>(BOOKING_QUERY_PORT)
      .bookingsOfPeriod(t.organizationId, {
        from: start(15, 0).toISOString(),
        to: start(16, 0).toISOString(),
        kinds: ['rental'],
      });
    expect(period.map((p) => p.bookingId)).toContain(booked.body.id);
  });

  it('enrollment.booking_lifecycle: an undecided request expires at its start', async () => {
    const setup = await rental({ mode: 'request' });
    const customer = await booker(setup);
    const requested = await post(t, '/v1/bookings', customer.header, {
      offeringId: setup.offeringId,
      start: new Date(Date.parse(CLOCK_START) + 2 * HOUR).toISOString(),
      end: new Date(Date.parse(CLOCK_START) + 3 * HOUR).toISOString(),
      resourceIds: [fields[2]],
    });
    expect(requested.status).toBe(201);
    t.clock.advance(2 * HOUR + 60_000);
    try {
      await t.runPeriodicJobs([BOOKING_LIFECYCLE_JOB]);
      const row = await t.db
        .selectFrom('bookings')
        .select(['status', 'end_reason'])
        .where('id', '=', requested.body.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: 'expired', end_reason: 'not_decided' });
    } finally {
      t.clock.set(new Date(CLOCK_START));
    }
  });

  it('§4.3: the database refuses a requested booking that reserves something, a held one without its events and a series of no organization', async () => {
    const setup = await rental();
    const customer = await booker(setup);
    const policy = await terms('instant');
    const base = {
      id: newId(),
      organization_id: t.organizationId,
      facility_id: t.facilityId,
      offering_id: setup.offeringId,
      kind: 'rental' as const,
      booker_person_id: customer.personId,
      first_start: start(20),
      last_end: new Date(start(20).getTime() + HOUR),
      occurrences: JSON.stringify([
        { start: start(20).toISOString(), end: start(21).toISOString() },
      ]),
      resource_ids: [fields[0]!],
      booking_terms_policy_version_id: policy.id,
      confirmation_mode: 'instant' as const,
      requested_by: JSON.stringify({ kind: 'system' }),
    };
    const reject = async (values: Record<string, unknown>) => {
      try {
        await t.db
          .insertInto('bookings')
          .values({ ...base, id: newId(), ...values } as never)
          .execute();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return 'accepted';
    };
    expect(await reject({ status: 'requested', scheduling_event_ids: [newId()] })).toBe('23514');
    expect(await reject({ status: 'held' })).toBe('23514');
    expect(await reject({ status: 'requested', kind: 'party' })).toBe('23514');
    // §4.3 composite references (INTEGRITY-07): a series that does not exist in this organization.
    expect(await reject({ status: 'requested', scheduling_series_id: newId() })).toBe('23503');
  });
});
