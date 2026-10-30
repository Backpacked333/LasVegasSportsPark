import {
  OfferingKindSchema,
  newId,
  systemPrincipal,
  type PolicyVersion,
} from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, UnitOfWork } from '../../../kernel';
import type { TestApp } from '../../../testing';
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
import { BOOKING_LIFECYCLE_JOB } from '../services/enrollment-jobs';
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
