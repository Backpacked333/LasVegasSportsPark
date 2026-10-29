import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createProgramFixture,
} from '../../modules/catalog';
import { BOOKING_LIFECYCLE_JOB } from '../../modules/enrollment/services/enrollment-jobs';
import { FakePaymentTokens } from '../../modules/finance';
import { EventsService, createScheduledEvent, seedResource } from '../../modules/scheduling';
import {
  adult,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  staff,
  type Actor,
} from './support';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;

interface Booking {
  id: string;
  status: string;
  outstanding: string[];
  revision: number;
  basketId: string | null;
  enrollmentId: string | null;
  endReason: string | null;
  occurrences: Array<{ start: string; end: string; eventId: string | null }>;
}

/**
 * SPK-COND-003 rentals (§3.16, §6.5 Package G; DEC-016 and DEC-076 pending; request mode DEC-029,
 * POL-005; deposits POL-040, DEC-073): request-mode approval and a recurring rental with a deposit,
 * across enrollment, scheduling, workforce, catalog and finance, through HTTP. Every value (prices,
 * deposit counts, intervals) is test data.
 */
describe('SPK-COND-003: rentals in request mode and recurring with a deposit (assembled application)', () => {
  let t: TestApp;
  let pm: Actor;
  let finance: Actor;
  let scheduler: Actor;
  let fieldA: string;
  let fieldB: string;
  let programId: string;

  beforeAll(async () => {
    // 08:00 local (America/Los_Angeles), Monday 9 November 2026
    t = await journeyApp({ clockStart: '2026-11-09T16:00:00Z' });
    const admin = await staff(t, ['system_administrator']);
    pm = await staff(t, ['program_manager']);
    finance = await staff(t, ['finance_operator']);
    scheduler = await staff(t, ['scheduler']);
    await enableCapability(t, admin, 'rentals', 'DEC-076');
    fieldA = (
      await seedResource(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Field A',
      })
    ).resourceId;
    fieldB = (
      await seedResource(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Field B',
      })
    ).resourceId;
    programId = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
  });
  afterAll(async () => {
    await t?.close();
  });

  async function approvedPolicy(kind: string, key: string, content: Record<string, unknown>) {
    const version = await ok<{ id: string }>(
      post(t, '/v1/policy-versions', pm.header, {
        kind,
        key,
        title: `${kind} ${key}`,
        content,
        effectiveFrom: '2026-10-01T00:00:00Z',
      }),
      201,
    );
    await ok(post(t, `/v1/policy-versions/${version.id}/approve`, finance.header, {}));
    return version.id;
  }

  /** A published rental offering of fields A and B under approved terms. */
  async function rentalOffering(options: {
    mode: 'instant' | 'request';
    staffing?: Array<Record<string, unknown>>;
    installmentPolicyKey?: string | null;
    priceMinor: number;
  }) {
    const definition = await ok<{ id: string }>(
      post(t, '/v1/entitlement-definitions', pm.header, {
        name: `Field rental ${Date.now()}-${Math.random()}`,
        kind: 'rental_resource',
        scope: {
          resources: { resourceIds: [fieldA, fieldB], count: 1 },
          staffing: options.staffing ?? [],
        },
        equivalenceScope: 'none',
      }),
      201,
    );
    const termsKey = `rental-terms-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await approvedPolicy('booking_terms', termsKey, {
      confirmationMode: options.mode,
      installmentPolicyKey: options.installmentPolicyKey ?? null,
      accessConditions: 'Gate code at the front desk',
      hostResponsibilities: null,
    });
    const fixture = await createOfferingFixture(t, {
      responsibleManagerPersonId: pm.personId,
      programId,
      kind: 'rental',
      publicationState: 'draft',
      entitlementDefinitionId: definition.id,
      bookingTermsKey: termsKey,
      basePriceMinor: options.priceMinor,
    });
    await ok(post(t, `/v1/offerings/${fixture.offeringId}/publish`, pm.header, {}));
    await ok(post(t, `/v1/offerings/${fixture.offeringId}/registration/open`, pm.header, {}));
    return fixture;
  }

  async function customerFor(fixture: { formPolicyVersionId: string }): Promise<Actor> {
    const person = await adult(t);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: person.personId,
      policyVersionId: fixture.formPolicyVersionId,
      signedByPersonId: person.personId,
    });
    return person;
  }

  const bookingFootprint = async (bookingId: string) => ({
    events: (
      await t.db.selectFrom('events').select('id').where('source_id', '=', bookingId).execute()
    ).length,
    lines: (
      await t.db
        .selectFrom('basket_lines')
        .innerJoin('bookings', 'bookings.basket_line_id', 'basket_lines.id')
        .select('basket_lines.id')
        .where('bookings.id', '=', bookingId)
        .execute()
    ).length,
  });

  it('DEC-029, POL-005: a request holds nothing and raises a scheduler exception; approval reserves, staffs, adds the line and holds in one transaction', async () => {
    const offering = await rentalOffering({
      mode: 'request',
      priceMinor: 5_000,
      staffing: [{ kind: 'supervisor', role: 'field_supervisor', count: 1, qualifications: [] }],
    });
    const customer = await customerFor(offering);
    const requirementsBefore = (
      await t.db.selectFrom('assignment_requirements').select('id').execute()
    ).length;
    const start = new Date(Date.parse('2026-11-12T02:00:00Z'));
    const requested = await ok<Booking>(
      post(t, '/v1/bookings', customer.header, {
        offeringId: offering.offeringId,
        start: start.toISOString(),
        end: new Date(start.getTime() + HOUR).toISOString(),
        resourceIds: [fieldA],
      }),
      201,
    );
    expect(requested).toMatchObject({
      status: 'requested',
      outstanding: ['approval'],
      basketId: null,
      enrollmentId: null,
    });
    expect(requested.occurrences.every((o) => o.eventId === null)).toBe(true);
    expect(await bookingFootprint(requested.id)).toEqual({ events: 0, lines: 0 });
    const pending = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'status'])
      .where('category', '=', 'enrollment.booking_request_pending')
      .where('affected_id', '=', requested.id)
      .execute();
    expect(pending).toEqual([{ owner_queue: 'scheduler', status: 'open' }]);

    const approved = await ok<Booking>(
      post(t, `/v1/bookings/${requested.id}/approve`, scheduler.header, {
        expectedRevision: requested.revision,
      }),
    );
    expect(approved).toMatchObject({ status: 'held', outstanding: ['payment', 'staffing'] });
    expect(approved.basketId).not.toBeNull();
    expect(await bookingFootprint(requested.id)).toEqual({ events: 1, lines: 1 });
    const requirements = await t.db
      .selectFrom('assignment_requirements')
      .select(['role', 'target_id'])
      .where('target_id', '=', approved.occurrences[0]!.eventId!)
      .execute();
    expect(requirements).toEqual([
      { role: 'field_supervisor', target_id: approved.occurrences[0]!.eventId },
    ]);
    expect((await t.db.selectFrom('assignment_requirements').select('id').execute()).length).toBe(
      requirementsBefore + 1,
    );
    const holds = await t.db
      .selectFrom('holds')
      .select('status')
      .where('basket_id', '=', approved.basketId!)
      .execute();
    expect(holds.map((h) => h.status)).toEqual(['active']);
    const resolved = await t.db
      .selectFrom('operational_exceptions')
      .select('status')
      .where('category', '=', 'enrollment.booking_request_pending')
      .where('affected_id', '=', requested.id)
      .execute();
    expect(resolved.map((r) => r.status)).toEqual(['resolved']);
  });

  it('a slot taken before approval leaves the request requested with RESOURCE_CONFLICT; an undecided request expires at its start', async () => {
    const offering = await rentalOffering({ mode: 'request', priceMinor: 5_000 });
    const customer = await customerFor(offering);
    const start = new Date(Date.parse('2026-11-13T03:00:00Z'));
    const requested = await ok<Booking>(
      post(t, '/v1/bookings', customer.header, {
        offeringId: offering.offeringId,
        start: start.toISOString(),
        end: new Date(start.getTime() + HOUR).toISOString(),
        resourceIds: [fieldB],
      }),
      201,
    );
    // the field is booked by staff before anyone decides the request
    await createScheduledEvent(t.app.get(EventsService), {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [fieldB],
      start: new Date(start.getTime() - 30 * MINUTE).toISOString(),
      end: new Date(start.getTime() + 30 * MINUTE).toISOString(),
    });
    const refused = await post(t, `/v1/bookings/${requested.id}/approve`, scheduler.header, {
      expectedRevision: requested.revision,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    const still = await ok<Booking>(get(t, `/v1/bookings/${requested.id}`, customer.header));
    expect(still).toMatchObject({ status: 'requested', revision: requested.revision });
    expect(await bookingFootprint(requested.id)).toEqual({ events: 0, lines: 0 });

    // a request nobody decides expires at its start (enrollment.booking_lifecycle)
    const soon = new Date(t.clock.now().getTime() + 2 * HOUR);
    const undecided = await ok<Booking>(
      post(t, '/v1/bookings', customer.header, {
        offeringId: offering.offeringId,
        start: soon.toISOString(),
        end: new Date(soon.getTime() + HOUR).toISOString(),
        resourceIds: [fieldA],
      }),
      201,
    );
    t.clock.advance(2 * HOUR + MINUTE);
    try {
      await t.runPeriodicJobs([BOOKING_LIFECYCLE_JOB]);
      const expired = await ok<Booking>(get(t, `/v1/bookings/${undecided.id}`, customer.header));
      expect(expired).toMatchObject({ status: 'expired', endReason: 'not_decided' });
      const exception = await t.db
        .selectFrom('operational_exceptions')
        .select('status')
        .where('category', '=', 'enrollment.booking_request_pending')
        .where('affected_id', '=', undecided.id)
        .executeTakeFirstOrThrow();
      expect(exception.status).toBe('resolved');
    } finally {
      t.clock.advance(-(2 * HOUR + MINUTE));
    }
  });

  it('POL-040: 8 weekly occurrences under terms naming an approved deposit plan; one taken week refuses the whole series naming it; otherwise all are reserved, the first installment is charged and the balance is an obligation', async () => {
    const depositKey = `rental-deposit-${Date.now()}`;
    await approvedPolicy('installment', depositKey, { installments: 2, intervalDays: 14 });
    const offering = await rentalOffering({
      mode: 'instant',
      priceMinor: 40_000,
      installmentPolicyKey: depositKey,
    });
    const customer = await customerFor(offering);
    // Tuesdays 18:00 local from 1 December 2026
    const first = new Date(Date.parse('2026-12-02T02:00:00Z'));
    const takenWeek = new Date(first.getTime() + 2 * WEEK);
    await createScheduledEvent(t.app.get(EventsService), {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceIds: [fieldB],
      start: takenWeek.toISOString(),
      end: new Date(takenWeek.getTime() + HOUR).toISOString(),
    });
    const eventsBefore = (
      await t.db
        .selectFrom('events')
        .select('id')
        .where('source_type', '=', 'enrollment.booking')
        .execute()
    ).length;
    const refused = await post(t, '/v1/bookings', customer.header, {
      offeringId: offering.offeringId,
      start: first.toISOString(),
      end: new Date(first.getTime() + HOUR).toISOString(),
      recurrence: { interval: 1, count: 8 },
      resourceIds: [fieldB],
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe('RESOURCE_CONFLICT');
    expect(JSON.stringify(refused.body.details)).toContain(takenWeek.toISOString());
    expect(
      (
        await t.db
          .selectFrom('events')
          .select('id')
          .where('source_type', '=', 'enrollment.booking')
          .execute()
      ).length,
    ).toBe(eventsBefore);

    const booked = await ok<Booking>(
      post(t, '/v1/bookings', customer.header, {
        offeringId: offering.offeringId,
        start: first.toISOString(),
        end: new Date(first.getTime() + HOUR).toISOString(),
        recurrence: { interval: 1, count: 8 },
        resourceIds: [fieldA],
      }),
      201,
    );
    expect(booked.status).toBe('held');
    expect(booked.occurrences).toHaveLength(8);
    expect(booked.occurrences.every((o) => o.eventId)).toBe(true);
    const reservations = await t.db
      .selectFrom('reservations')
      .select('status')
      .where(
        'event_id',
        'in',
        booked.occurrences.map((o) => o.eventId!),
      )
      .execute();
    expect(reservations.filter((r) => r.status === 'active')).toHaveLength(8);

    // the quote follows the terms' deposit plan: two installments of 20 000, the first due now
    const quote = await ok<{
      id: string;
      totalMinor: number;
      dueNowMinor: number;
      paymentPlan: string;
      futureObligations: Array<{ amountMinor: number; dueAt: string }>;
    }>(post(t, '/v1/registration-quotes', customer.header, { basketId: booked.basketId }), 201);
    expect(quote).toMatchObject({ totalMinor: 40_000, dueNowMinor: 20_000 });
    expect(quote.futureObligations.map((o) => o.amountMinor)).toEqual([20_000]);
    const otherCount = await post(t, '/v1/registration-quotes', customer.header, {
      basketId: booked.basketId,
      paymentPlan: { kind: 'installments', count: 4 },
    });
    expect(otherCount.status).toBe(400);
    expect(otherCount.body.details).toMatchObject({ code: 'BOOKING_DEPOSIT_PLAN_FIXED' });
    const checkout = await ok<{ status: string; orderId: string }>(
      post(t, '/v1/registration-checkouts', customer.header, {
        quoteId: quote.id,
        payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
        // SPK-PAY-006: the customer authorizes the scheduled balance explicitly
        authorizeFutureInstallments: true,
      }),
      201,
    );
    expect(checkout.status).toBe('completed');
    await drain(t);
    const confirmed = await ok<Booking>(get(t, `/v1/bookings/${booked.id}`, customer.header));
    expect(confirmed).toMatchObject({ status: 'confirmed', outstanding: [] });
    const obligations = await t.db
      .selectFrom('obligations')
      .select(['amount_minor', 'status', 'due_at', 'source_kind'])
      .where('order_id', '=', checkout.orderId)
      .orderBy('due_at')
      .execute();
    expect(obligations.map((o) => [o.source_kind, Number(o.amount_minor)])).toEqual([
      ['installment', 20_000],
      ['installment', 20_000],
    ]);
    expect(obligations[0]!.status).not.toBe('open');
    expect(obligations[1]!.status).toBe('open');
    expect(new Date(obligations[1]!.due_at).getTime() - t.clock.now().getTime()).toBe(
      14 * 24 * HOUR,
    );
  });
});
