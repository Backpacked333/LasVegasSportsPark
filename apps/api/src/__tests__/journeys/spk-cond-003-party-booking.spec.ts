import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createProgramFixture,
} from '../../modules/catalog';
import { FakePaymentTokens } from '../../modules/finance';
import { seedPitchWithHalves, type PitchFixture } from '../../modules/scheduling';
import {
  adult,
  drain,
  enableCapability,
  get,
  journeyApp,
  ok,
  post,
  staff,
  together,
  type Actor,
} from './support';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Booking {
  id: string;
  status: string;
  outstanding: string[];
  revision: number;
  basketId: string | null;
  enrollmentId: string | null;
  occurrences: Array<{ start: string; end: string; eventId: string | null }>;
}

/**
 * SPK-COND-003 (§3.16, §6.5 Package G): an instant party booking across enrollment, scheduling,
 * workforce, facilities, finance, catalog and the kernel, through HTTP only. Whether the complex
 * offers parties is pending (DEC-016, DEC-077); the switch is turned on here by a system
 * administrator. Prices, durations, guest limits and terms are test data, not policy.
 * Runs on PGlite and on PostgreSQL (TEST_DATABASE_URL): the competing bookings overlap there.
 */
describe('SPK-COND-003: instant party booking (assembled application)', () => {
  let t: TestApp;
  let admin: Actor;
  let pm: Actor;
  let finance: Actor;
  let scheduler: Actor;
  let pitch: PitchFixture;
  let goals: string[];
  let offeringId: string;
  let formPolicyVersionId: string;

  beforeAll(async () => {
    // 08:00 in the facility zone (America/Los_Angeles) on Tuesday 10 November 2026.
    t = await journeyApp({ clockStart: '2026-11-10T16:00:00Z' });
    admin = await staff(t, ['system_administrator']);
    pm = await staff(t, ['program_manager']);
    finance = await staff(t, ['finance_operator']);
    scheduler = await staff(t, ['scheduler']);
    const facilities = await staff(t, ['facilities_operator']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: `Party pitch ${Date.now()}`,
    });
    goals = [];
    for (const name of ['Goal north', 'Goal south']) {
      const asset = await ok<{ id: string }>(
        post(t, '/v1/assets', facilities.header, {
          facilityId: t.facilityId,
          resourceId: pitch.pitchId,
          kind: 'goal',
          name,
        }),
        201,
      );
      goals.push(asset.id);
    }
  });
  afterAll(async () => {
    await t?.close();
  });

  async function customer(): Promise<Actor> {
    const person = await adult(t);
    await createAcknowledgmentFixture(t, {
      subjectPersonId: person.personId,
      policyVersionId: formPolicyVersionId,
      signedByPersonId: person.personId,
    });
    return person;
  }

  const counts = async (bookingIds: string[]) => {
    const events = await t.db
      .selectFrom('events')
      .select(['id', 'status'])
      .where('source_type', '=', 'enrollment.booking')
      .execute();
    const eventIds = events.map((e) => e.id);
    const none = ['00000000-0000-7000-8000-000000000000'];
    return {
      events: events.length,
      reservations: (
        await t.db
          .selectFrom('reservations')
          .select('id')
          .where('event_id', 'in', eventIds.length > 0 ? eventIds : none)
          .execute()
      ).length,
      commitments: (
        await t.db
          .selectFrom('event_commitments')
          .select('id')
          .where('event_id', 'in', eventIds.length > 0 ? eventIds : none)
          .execute()
      ).length,
      requirements: (
        await t.db
          .selectFrom('assignment_requirements')
          .select('id')
          .where('target_type', '=', 'event')
          .execute()
      ).length,
      lines: (
        await t.db
          .selectFrom('basket_lines')
          .select('id')
          .where('intent', '=', 'party_request')
          .execute()
      ).length,
      holds: (
        await t.db
          .selectFrom('holds')
          .innerJoin('capacity_pools', 'capacity_pools.id', 'holds.pool_id')
          .select('holds.id')
          .where('capacity_pools.scope_type', '=', 'rental')
          .execute()
      ).length,
      bookings: (await t.db.selectFrom('bookings').select('id').execute()).length,
      known: bookingIds.length,
    };
  };

  it('a disabled capability refuses the party offering; an administrator enables parties under DEC-077', async () => {
    const programId = await createProgramFixture(t, { ageBand: { minAgeYears: 18 } });
    const refused = await post(t, '/v1/offerings', pm.header, {
      programId,
      name: 'Birthday party',
      kind: 'party',
      facilityId: t.facilityId,
      startsOn: '2026-11-01',
      endsOn: '2027-06-30',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.details).toMatchObject({
      code: 'CAPABILITY_DISABLED',
      capability: 'parties',
    });
    // DEC-057 (taxes) is not a decision about parties: refused
    const wrong = await post(t, '/v1/admin/capabilities/parties/enable', admin.header, {
      decisionReference: 'DEC-057',
      reason: 'wrong record',
    });
    expect(wrong.status).toBe(400);
    // only a system administrator changes a switch
    const byPm = await post(t, '/v1/admin/capabilities/parties/enable', pm.header, {
      decisionReference: 'DEC-077',
      reason: 'not mine to decide',
    });
    expect(byPm.status).toBe(403);
    await enableCapability(t, admin, 'parties', 'DEC-077');

    // the party package names the pitch, both goals and a host (test values, POL-040)
    const definition = await ok<{ id: string }>(
      post(t, '/v1/entitlement-definitions', pm.header, {
        name: 'Two-hour party package',
        kind: 'party_package',
        scope: {
          durationMinutes: 120,
          guestLimit: 12,
          resources: { resourceIds: [pitch.pitchId], count: 1 },
          staffing: [{ kind: 'organizer', role: 'party_host', count: 1, qualifications: [] }],
          equipmentAssetIds: goals,
        },
        equivalenceScope: 'none',
      }),
      201,
    );
    const termsKey = `party-terms-${Date.now()}`;
    const terms = await ok<{ id: string }>(
      post(t, '/v1/policy-versions', pm.header, {
        kind: 'booking_terms',
        key: termsKey,
        title: 'Party booking terms',
        content: {
          confirmationMode: 'instant',
          installmentPolicyKey: null,
          accessConditions: 'Check in at the front desk',
          hostResponsibilities: 'An adult host stays for the whole party',
        },
        effectiveFrom: '2026-10-01T00:00:00Z',
      }),
      201,
    );
    // booking terms are financial: the finance operator approves them, not the author
    expect((await post(t, `/v1/policy-versions/${terms.id}/approve`, pm.header, {})).status).toBe(
      403,
    );
    await ok(post(t, `/v1/policy-versions/${terms.id}/approve`, finance.header, {}));

    const fixture = await createOfferingFixture(t, {
      responsibleManagerPersonId: pm.personId,
      programId,
      kind: 'party',
      publicationState: 'draft',
      entitlementDefinitionId: definition.id,
      bookingTermsKey: termsKey,
      basePriceMinor: 20_000,
    });
    offeringId = fixture.offeringId;
    formPolicyVersionId = fixture.formPolicyVersionId;
    const check = await ok<{ publishable: boolean; problems: unknown[] }>(
      get(t, `/v1/offerings/${offeringId}/publication-check`, pm.header),
    );
    expect(check.problems).toEqual([]);
    expect(check.publishable).toBe(true);
    await ok(post(t, `/v1/offerings/${offeringId}/publish`, pm.header, {}));
    await ok(post(t, `/v1/offerings/${offeringId}/registration/open`, pm.header, {}));
  });

  let paid: Booking;
  let hostAssignmentId: string;

  it('a customer reads free intervals and books field, goals and host in one transaction; a competing booking writes nothing', async () => {
    const booker = await customer();
    const from = '2026-11-14T16:00:00Z';
    const to = '2026-11-15T04:00:00Z';
    const availability = await ok<{
      durationMinutes: number;
      resourceCount: number;
      resources: Array<{
        resourceId: string;
        freeIntervals: Array<{ start: string; end: string }>;
      }>;
    }>(
      get(
        t,
        `/v1/offerings/${offeringId}/booking-availability?from=${from}&to=${to}&durationMinutes=120`,
        booker.header,
      ),
    );
    expect(availability).toMatchObject({ durationMinutes: 120, resourceCount: 1 });
    const free = availability.resources.find((r) => r.resourceId === pitch.pitchId);
    expect(free?.freeIntervals.length).toBeGreaterThan(0);
    // Saturday 10:00 local
    const start = '2026-11-14T18:00:00.000Z';
    expect(
      free!.freeIntervals.some(
        (i) =>
          Date.parse(i.start) <= Date.parse(start) &&
          Date.parse(i.end) >= Date.parse(start) + 2 * HOUR,
      ),
    ).toBe(true);
    const before = await counts([]);
    const booked = await ok<Booking>(
      post(t, '/v1/bookings', booker.header, {
        offeringId,
        start,
        resourceIds: [pitch.pitchId],
        guestCount: 10,
      }),
      201,
    );
    expect(booked).toMatchObject({
      status: 'held',
      outstanding: ['payment', 'staffing'],
      equipmentAssetIds: goals,
    });
    const eventId = booked.occurrences[0]!.eventId!;
    expect(eventId).toBeTruthy();
    // one unit of work wrote the event and its reservation, both goal commitments, the host
    // requirement, the basket line and its hold
    const after = await counts([booked.id]);
    expect(after).toMatchObject({
      events: before.events + 1,
      lines: before.lines + 1,
      holds: before.holds + 1,
      requirements: before.requirements + 1,
      bookings: before.bookings + 1,
    });
    expect(after.reservations).toBeGreaterThan(before.reservations);
    const commitments = await t.db
      .selectFrom('event_commitments')
      .select(['party_type', 'party_id', 'status'])
      .where('event_id', '=', eventId)
      .execute();
    expect(
      commitments
        .filter((c) => c.party_type === 'equipment')
        .map((c) => c.party_id)
        .sort(),
    ).toEqual([...goals].sort());
    const requirement = await t.db
      .selectFrom('assignment_requirements')
      .select(['role', 'must_be_accepted', 'retired_at'])
      .where('target_id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(requirement).toEqual({ role: 'party_host', must_be_accepted: true, retired_at: null });

    // a competing booking of the same pitch and goals writes nothing
    const rival = await customer();
    const competing = await post(t, '/v1/bookings', rival.header, {
      offeringId,
      start: '2026-11-14T19:00:00.000Z',
      resourceIds: [pitch.pitchId],
      guestCount: 8,
    });
    expect(competing.status, JSON.stringify(competing.body)).toBe(409);
    expect(competing.body.code).toBe('RESOURCE_CONFLICT');
    expect(await counts([booked.id])).toEqual(after);

    // two customers racing for one free slot: one booking, the other writes nothing
    const [a, b] = [await customer(), await customer()];
    const slot = '2026-11-21T18:00:00.000Z';
    const race = await together(
      () =>
        post(t, '/v1/bookings', a.header, {
          offeringId,
          start: slot,
          resourceIds: [pitch.pitchId],
          guestCount: 6,
        }),
      () =>
        post(t, '/v1/bookings', b.header, {
          offeringId,
          start: slot,
          resourceIds: [pitch.pitchId],
          guestCount: 6,
        }),
    );
    const statuses = race.map((r) => r.status).sort();
    expect(statuses, JSON.stringify(race.map((r) => r.body))).toEqual([201, 409]);
    const raced = await counts([booked.id]);
    expect(raced.events).toBe(after.events + 1);
    expect(raced.lines).toBe(after.lines + 1);
    expect(raced.holds).toBe(after.holds + 1);
    expect(raced.bookings).toBe(after.bookings + 1);

    // checkout: the booking is paid and waits for its host (never confirmed without one)
    const quote = await ok<{ id: string; totalMinor: number }>(
      post(t, '/v1/registration-quotes', booker.header, { basketId: booked.basketId }),
      201,
    );
    expect(quote.totalMinor).toBe(20_000);
    const checkout = await ok<{ status: string }>(
      post(t, '/v1/registration-checkouts', booker.header, {
        quoteId: quote.id,
        payment: { method: 'provider', paymentMethodToken: FakePaymentTokens.succeed },
      }),
      201,
    );
    expect(checkout.status).toBe('completed');
    await drain(t);
    paid = await ok<Booking>(get(t, `/v1/bookings/${booked.id}`, booker.header));
    expect(paid).toMatchObject({ status: 'awaiting_staff', outstanding: ['staffing'] });
    const exceptions = await t.db
      .selectFrom('operational_exceptions')
      .select(['owner_queue', 'status'])
      .where('category', '=', 'enrollment.booking_awaiting_staff')
      .where('affected_id', '=', booked.id)
      .execute();
    expect(exceptions).toEqual([{ owner_queue: 'scheduler', status: 'open' }]);
    const queue = await ok<{
      items: Array<{ category: string; affected: { type: string; id: string } }>;
    }>(get(t, '/v1/exceptions?queue=scheduler&status=open', scheduler.header));
    expect(
      queue.items.some(
        (e) => e.category === 'enrollment.booking_awaiting_staff' && e.affected.id === booked.id,
      ),
    ).toBe(true);

    // the host accepts: confirmed, the exception resolved
    const host = await staff(t, ['coach']);
    const offered = await ok<{ assignment: { id: string } }>(
      post(t, '/v1/assignments', scheduler.header, {
        personId: host.personId,
        kind: 'organizer',
        targetType: 'event',
        targetId: eventId,
        role: 'party_host',
        offer: true,
      }),
      201,
    );
    hostAssignmentId = offered.assignment.id;
    await ok(post(t, `/v1/assignments/${hostAssignmentId}/accept`, host.header, {}));
    await drain(t);
    const staffed = await ok<Booking>(get(t, `/v1/bookings/${booked.id}`, booker.header));
    expect(staffed).toMatchObject({ status: 'confirmed', outstanding: [] });
    const resolved = await t.db
      .selectFrom('operational_exceptions')
      .select('status')
      .where('category', '=', 'enrollment.booking_awaiting_staff')
      .where('affected_id', '=', booked.id)
      .execute();
    expect(resolved.map((r) => r.status)).toEqual(['resolved']);

    // the host withdraws: the booking waits for staff again, with a new open exception
    await ok(
      post(t, `/v1/assignments/${hostAssignmentId}/withdraw`, host.header, {
        reason: 'I cannot host on Saturday after all',
      }),
    );
    await drain(t);
    paid = await ok<Booking>(get(t, `/v1/bookings/${booked.id}`, booker.header));
    expect(paid).toMatchObject({ status: 'awaiting_staff', outstanding: ['staffing'] });
    const reopened = await t.db
      .selectFrom('operational_exceptions')
      .select('status')
      .where('category', '=', 'enrollment.booking_awaiting_staff')
      .where('affected_id', '=', booked.id)
      .execute();
    expect(reopened.map((r) => r.status).sort()).toEqual(['open', 'resolved']);

    // cancel applies the consequence the customer previewed and accepted
    const preview = await ok<{
      permitted: boolean;
      financialConsequence: { kind: string; amountMinor: number | null; currency: string | null };
    }>(get(t, `/v1/enrollments/${paid.enrollmentId}/cancellation-preview`, booker.header));
    expect(preview.permitted).toBe(true);
    const consequence = preview.financialConsequence;
    if (consequence.kind !== 'none') {
      const unaccepted = await post(t, `/v1/bookings/${booked.id}/cancel`, booker.header, {
        reason: 'The party moved to another venue',
        expectedRevision: paid.revision,
      });
      expect(unaccepted.status).toBe(409);
      expect(unaccepted.body.details.code).toBe('CONSEQUENCE_ACCEPTANCE_REQUIRED');
    }
    const canceled = await ok<Booking>(
      post(t, `/v1/bookings/${booked.id}/cancel`, booker.header, {
        reason: 'The party moved to another venue',
        expectedRevision: paid.revision,
        acceptedConsequence: {
          kind: consequence.kind,
          amountMinor: consequence.amountMinor,
          currency: consequence.currency,
        },
      }),
    );
    expect(canceled.status).toBe('canceled');
    await drain(t);
    const enrollment = await t.db
      .selectFrom('enrollments')
      .select(['status', 'cancellation_consequence'])
      .where('id', '=', paid.enrollmentId!)
      .executeTakeFirstOrThrow();
    expect(enrollment.status).toBe('canceled');
    expect(enrollment.cancellation_consequence).toMatchObject({
      kind: consequence.kind,
      amountMinor: consequence.amountMinor,
    });
    const event = await t.db
      .selectFrom('events')
      .select('status')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(event.status).toBe('canceled');
    const retired = await t.db
      .selectFrom('assignment_requirements')
      .select('retired_at')
      .where('target_id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(retired.retired_at).not.toBeNull();
    const awaiting = await t.db
      .selectFrom('operational_exceptions')
      .select('status')
      .where('category', '=', 'enrollment.booking_awaiting_staff')
      .where('affected_id', '=', booked.id)
      .execute();
    expect(awaiting.every((e) => e.status === 'resolved')).toBe(true);
  });

  it('SPK-REG-006: the hold of an unpaid booking expires and releases everything; its retired requirement leaves Today and reporting', async () => {
    const booker = await customer();
    // 14:00 local today, so the host requirement is one of today's activities
    const start = '2026-11-10T22:00:00.000Z';
    const booked = await ok<Booking>(
      post(t, '/v1/bookings', booker.header, {
        offeringId,
        start,
        resourceIds: [pitch.pitchId],
        guestCount: 9,
      }),
      201,
    );
    const eventId = booked.occurrences[0]!.eventId!;
    const today = async () =>
      ok<{ items: Array<{ group: string; subjectId?: string | null; targetId?: string | null }> }>(
        get(t, `/v1/today?facilityId=${t.facilityId}`, scheduler.header),
      );
    const mentions = (feed: unknown) => JSON.stringify(feed).includes(eventId);
    expect(mentions(await today())).toBe(true);
    const report = async () =>
      ok<unknown>(
        get(
          t,
          `/v1/reports/uncovered-assignments?facilityId=${t.facilityId}&from=2026-11-10&to=2026-11-10`,
          scheduler.header,
        ),
      );
    expect(mentions(await report())).toBe(true);

    t.clock.advance(11 * MINUTE);
    await drain(t);
    const expired = await ok<Booking>(get(t, `/v1/bookings/${booked.id}`, booker.header));
    expect(expired).toMatchObject({ status: 'expired' });
    const event = await t.db
      .selectFrom('events')
      .select('status')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(event.status).toBe('canceled');
    const holds = await t.db
      .selectFrom('reservations')
      .select('status')
      .where('event_id', '=', eventId)
      .execute();
    expect(holds.every((h) => h.status !== 'active')).toBe(true);
    const commitments = await t.db
      .selectFrom('event_commitments')
      .select('status')
      .where('event_id', '=', eventId)
      .execute();
    expect(commitments.every((c) => c.status !== 'active')).toBe(true);
    const basket = await t.db
      .selectFrom('holds')
      .select('status')
      .where('basket_id', '=', booked.basketId!)
      .execute();
    expect(basket.every((h) => h.status !== 'active')).toBe(true);
    const requirement = await t.db
      .selectFrom('assignment_requirements')
      .select('retired_at')
      .where('target_id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(requirement.retired_at).not.toBeNull();
    expect(mentions(await today())).toBe(false);
    expect(mentions(await report())).toBe(false);
    // the goals and the pitch are bookable again at that time
    const again = await customer();
    await ok(
      post(t, '/v1/bookings', again.header, {
        offeringId,
        start,
        resourceIds: [pitch.pitchId],
        guestCount: 9,
      }),
      201,
    );
  });
});
