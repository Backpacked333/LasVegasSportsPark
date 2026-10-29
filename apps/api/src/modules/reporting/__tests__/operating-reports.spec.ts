import { newId, systemPrincipal } from '@sportspark/contracts';
import { json } from '@sportspark/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createAcknowledgmentFixture,
  createOfferingFixture,
  createOfferingSessionFixture,
} from '../../catalog';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
} from '../../competition';
import {
  createCapacityPoolFixture,
  createEnrollmentFixture,
  createHoldFixture,
  createSessionBookingFixture,
} from '../../enrollment';
import { createAttendanceObservationFixture, createVisitFixture } from '../../entry';
import {
  createActiveRestriction,
  FacilitiesModule,
  MaintenanceTasksService,
  reportMaintenanceTask,
  RestrictionsService,
} from '../../facilities';
import {
  createCapturedPaymentFixture,
  createCreditFixture,
  createObligationFixture,
} from '../../finance';
import { createPersonFixture } from '../../identity';
import {
  at,
  createScheduledEvent,
  EventsService,
  seedPitchWithHalves,
  seedResource,
} from '../../scheduling';
import { createRequirementFixture } from '../../workforce';
import {
  createFulfilledOrder,
  DAY,
  get,
  HOUR,
  reportingTestApp,
  staff,
  valueOf,
  type Actor,
} from './support';

const DATE = '2027-02-03';
type Row = Record<string, string | number | boolean | null>;

describe('operating reports (SPK-REPORT-002) and demand (SPK-REPORT-006)', () => {
  let t: TestApp;
  let gm: Actor;
  let offeringId: string;
  let sessionId: string;
  let fixtureEventId: string;
  let periodStart: string;
  let periodEnd: string;

  const facility = () => ({ facilityId: t.facilityId });
  const view = (path: string, query: Record<string, string>) =>
    get(t, `/v1/reports/${path}`, gm, query);

  beforeAll(async () => {
    t = await reportingTestApp({ imports: [FacilitiesModule] });
    gm = await staff(t, ['general_manager']);
    const org = t.organizationId;
    const events = t.app.get(EventsService);
    const system = systemPrincipal(org, 'tests');
    const managerId = (await staff(t, ['program_manager'])).personId;
    const start = t.clock.now();
    periodStart = new Date(start.getTime() - HOUR).toISOString();
    periodEnd = new Date(start.getTime() + DAY).toISOString();

    // A youth term with one session on DATE; demand one week earlier feeds the forecast baseline.
    const offering = await createOfferingFixture(t, {
      responsibleManagerPersonId: managerId,
      kind: 'term',
      startsOn: DATE,
      endsOn: '2027-03-31',
      basePriceMinor: 9_000,
    });
    offeringId = offering.offeringId;
    sessionId = await createOfferingSessionFixture(t, {
      offeringId,
      scheduledStart: new Date(at(DATE, '17:00')),
      scheduledEnd: new Date(at(DATE, '18:00')),
    });
    t.clock.set(new Date(start.getTime() - 7 * DAY));
    await createEnrollmentFixture(t, {
      offeringId,
      participantPersonId: await createPersonFixture(t, { kind: 'child' }),
      status: 'canceled',
    });
    const earlyEnrollment = await createPersonFixture(t, { kind: 'child' });
    await createEnrollmentFixture(t, {
      offeringId,
      participantPersonId: earlyEnrollment,
      status: 'completed',
    });
    t.clock.set(start);

    const child = await createPersonFixture(t, { kind: 'child' });
    const adult = await createPersonFixture(t, { kind: 'adult' });
    const booker = await createPersonFixture(t, { kind: 'adult' });
    const walkIn = await createPersonFixture(t, { kind: 'adult' });
    await createEnrollmentFixture(t, { offeringId, participantPersonId: child });
    await createEnrollmentFixture(t, { offeringId, participantPersonId: adult });
    await createSessionBookingFixture(t, {
      offeringId,
      sessionId,
      participantPersonId: booker,
      scheduledStart: new Date(at(DATE, '17:00')),
      scheduledEnd: new Date(at(DATE, '18:00')),
    });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: child,
      policyVersionId: offering.formPolicyVersionId,
      signedByPersonId: adult,
    });
    await createAcknowledgmentFixture(t, {
      subjectPersonId: earlyEnrollment,
      policyVersionId: offering.formPolicyVersionId,
      signedByPersonId: adult,
    });
    const poolId = await createCapacityPoolFixture(t, { offeringId, capacity: 10 });
    await createHoldFixture(t, { poolId });
    await t.db
      .insertInto('waitlist_entries')
      .values({
        id: newId(),
        organization_id: org,
        offering_id: offeringId,
        pool_id: poolId,
        session_id: null,
        participant_person_id: await createPersonFixture(t, { kind: 'child' }),
        intent: 'youth',
        joined_at: start,
        queued_at: start,
        requested_by: json({ kind: 'system' }),
        requested_by_person_id: null,
        payer_person_id: null,
        accepted_enrollment_id: null,
        withdrawn_at: null,
        removed_at: null,
        removal_reason: null,
      })
      .execute();

    // Attendance: the enrolled child and a walk-in were present; one desk arrival.
    await createAttendanceObservationFixture(t, {
      personId: child,
      activity: { type: 'session', offeringId, sessionId },
    });
    await createAttendanceObservationFixture(t, {
      personId: walkIn,
      activity: { type: 'session', offeringId, sessionId },
    });
    await createVisitFixture(t, { personId: adult, arrivedAt: new Date(at(DATE, '16:50')) });

    // A league fixture on DATE with two rostered sides and a required official.
    const room = await seedResource(t.db, {
      organizationId: org,
      facilityId: t.facilityId,
      name: 'Indoor court',
    });
    const pitch = await seedPitchWithHalves(t.db, {
      organizationId: org,
      facilityId: t.facilityId,
      name: 'Pitch 9',
    });
    const season = await createSeasonFixture(t, { name: 'Winter league' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      facilityId: t.facilityId,
    });
    const home = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      captainPersonId: await createPersonFixture(t, { kind: 'adult' }),
    });
    const away = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      captainPersonId: await createPersonFixture(t, { kind: 'adult' }),
    });
    for (const entry of [home, away]) {
      for (let i = 0; i < 2; i += 1) {
        await addRosterMemberFixture(t, {
          teamEntryId: entry.teamEntryId,
          personId: await createPersonFixture(t, { kind: 'adult' }),
          effectiveFrom: new Date(start.getTime() - DAY),
        });
      }
    }
    const game = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [room.resourceId],
      start: at(DATE, '19:00'),
      end: at(DATE, '20:00'),
      kind: 'game',
    });
    fixtureEventId = game.id;
    const fixtureId = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      homeEntryId: home.teamEntryId,
      awayEntryId: away.teamEntryId,
      status: 'scheduled',
      schedulingEventId: game.id,
      scheduledStart: at(DATE, '19:00'),
      scheduledEnd: at(DATE, '20:00'),
    });
    await createRequirementFixture(t, {
      targetType: 'fixture',
      targetId: fixtureId,
      kind: 'official',
      role: 'referee',
      requiredCount: 1,
      facilityId: t.facilityId,
    });

    // Other events of the day: a draft, a maintenance block and a published event later canceled.
    await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [room.resourceId],
      start: at(DATE, '12:00'),
      end: at(DATE, '13:00'),
      kind: 'practice',
      status: 'draft',
    });
    await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [pitch.pitchId],
      start: at(DATE, '06:00'),
      end: at(DATE, '07:00'),
      kind: 'maintenance',
    });
    const canceled = await createScheduledEvent(events, {
      organizationId: org,
      facilityId: t.facilityId,
      resourceIds: [room.resourceId],
      start: at(DATE, '09:00'),
      end: at(DATE, '10:00'),
      kind: 'rental',
    });
    await events.cancelEvent(system, canceled.id, { reason: 'Renter canceled' });

    // Money: an aged balance, a balance not yet due, a credit, a captured payment and a sale.
    const debtor = await createPersonFixture(t, { kind: 'adult' });
    await createObligationFixture(t, {
      debtorPersonId: debtor,
      amountMinor: 5_000,
      dueAt: new Date(start.getTime() - 40 * DAY),
    });
    await createObligationFixture(t, {
      debtorPersonId: debtor,
      amountMinor: 2_500,
      dueAt: new Date(start.getTime() + 10 * DAY),
    });
    await createCreditFixture(t, { ownerPersonId: debtor, amountMinor: 2_000 });
    await createCapturedPaymentFixture(t, { payerPersonId: debtor, amountMinor: 7_000 });
    await createFulfilledOrder(t, {
      payerPersonId: debtor,
      fulfilledAt: start,
      lines: [
        {
          offeringId,
          participantPersonId: child,
          priceRuleId: offering.priceRuleId!,
          amountMinor: 9_000,
        },
      ],
    });

    // Facilities: a restriction starting in half an hour and a task due in an hour.
    await createActiveRestriction(t.app.get(RestrictionsService), {
      organizationId: org,
      facilityId: t.facilityId,
      resourceId: pitch.northHalfId,
      start: new Date(start.getTime() + 30 * 60_000).toISOString(),
      end: new Date(start.getTime() + 2 * DAY).toISOString(),
    });
    await reportMaintenanceTask(t.app.get(MaintenanceTasksService), {
      organizationId: org,
      facilityId: t.facilityId,
      resourceId: pitch.southHalfId,
      dueAt: new Date(start.getTime() + HOUR).toISOString(),
      severity: 'medium',
    });

    // Communications: a failed operational notice, an unknown delivery and a revoked recipient.
    const recipientPerson = await createPersonFixture(t, { kind: 'adult' });
    const notify = async (status: 'failed' | 'unknown', revoke: boolean) => {
      const notificationId = newId();
      await t.db
        .insertInto('notifications')
        .values({
          id: notificationId,
          organization_id: org,
          facility_id: t.facilityId,
          kind: 'cancellation',
          category: 'operational',
          subject_type: null,
          subject_id: null,
          audience: json({}),
          title: 'Session canceled',
          body: 'Tonight is canceled.',
          details_before: null,
          details_after: null,
          protected: false,
          created_by: json({ kind: 'system' }),
          created_by_person_id: null,
          source_event_id: null,
          scheduled_for: null,
          status: 'dispatched',
          supersedes_notification_id: null,
          superseded_by_notification_id: null,
          suppression_reason: null,
          queued_at: start,
          dispatched_at: start,
          suppressed_at: null,
          correlation_id: null,
          operation_id: null,
        })
        .execute();
      const recipientId = newId();
      await t.db
        .insertInto('notification_recipients')
        .values({
          id: recipientId,
          organization_id: org,
          notification_id: notificationId,
          person_id: recipientPerson,
          resolved_basis: 'self',
          basis_detail: null,
          resolved_at: start,
          status: revoke ? 'revoked' : 'authorized',
          authorized_at: revoke ? null : start,
          revoked_at: revoke ? start : null,
          revocation_reason: revoke ? 'authority revoked' : null,
        })
        .execute();
      await t.db
        .insertInto('delivery_attempts')
        .values({
          id: newId(),
          organization_id: org,
          notification_id: notificationId,
          recipient_id: recipientId,
          channel: 'email',
          provider: 'fake-messaging',
          provider_message_id: null,
          status,
          queued_at: start,
          ready_at: null,
          locked_until: null,
          attempted_at: start,
          accepted_at: null,
          delivered_at: null,
          failed_at: status === 'failed' ? start : null,
          read_at: null,
          acknowledged_at: null,
          provider_response: null,
          failure_code: status === 'failed' ? 'PROVIDER_ERROR' : null,
          error: null,
        })
        .execute();
    };
    await notify('failed', false);
    await notify('unknown', true);

    t.clock.advance(2 * HOUR);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-002 daily schedule: published, changed or canceled, unpublished and unavailability', async () => {
    const res = await view('daily-schedule', { ...facility(), date: DATE });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(valueOf(res.body, 'MET-001', 'Scheduled activities')).toBe(1);
    expect(valueOf(res.body, 'MET-002', 'Changed or canceled after publication')).toBe(1);
    expect(valueOf(res.body, 'MET-003')).toBe(1);
    expect(valueOf(res.body, 'MET-001', 'Unavailability events (maintenance, block)')).toBe(1);
    expect((res.body.rows as Row[]).map((r) => r.status).sort()).toEqual([
      'canceled',
      'draft',
      'published',
      'published',
    ]);
  });

  it('SPK-REPORT-002 expected arrivals: enrollments, bookings and rosters; supervised releases for children', async () => {
    const res = await view('expected-arrivals', { ...facility(), date: DATE });
    expect(res.status).toBe(200);
    const rows = res.body.rows as Row[];
    const session = rows.find((r) => r.activityType === 'session')!;
    // Two confirmed enrollments plus the completed one, and one booking; the canceled one is not expected.
    expect(session).toMatchObject({
      expected: 4,
      children: 2,
      adults: 2,
      byBooking: 1,
      supervisedReleasesExpected: 2,
    });
    const fixture = rows.find((r) => r.activityType === 'fixture')!;
    expect(fixture).toMatchObject({ expected: 4, byRoster: 4 });
    expect(valueOf(res.body, 'MET-004', 'Expected arrivals')).toBe(8);
    expect(valueOf(res.body, 'MET-006')).toBe(2);
    expect(JSON.stringify(res.body.rows)).not.toMatch(/Child\d|Adult\d/);
  });

  it('SPK-REPORT-002 attendance: attended after corrections, walk-ins, rate, arrivals beside check-ins', async () => {
    const res = await view('attendance', { ...facility(), from: DATE, to: DATE });
    expect(res.status).toBe(200);
    const session = (res.body.rows as Row[]).find((r) => r.activityId === sessionId)!;
    expect(session).toMatchObject({
      expected: 4,
      attended: 2,
      expectedAttended: 1,
      walkIns: 1,
      attendanceRate: 0.25,
    });
    expect(valueOf(res.body, 'MET-009', 'Facility arrivals (people)')).toBe(1);
    expect(valueOf(res.body, 'MET-009', 'Session check-ins admitted')).toBe(0);
    const fixture = (res.body.rows as Row[]).find((r) => r.activityId === fixtureEventId)!;
    expect(fixture).toMatchObject({ expected: 4, attended: 0, attendanceRate: 0 });
  });

  it('SPK-REPORT-002 match readiness: every fixture in the window is evaluated live by the competition rules', async () => {
    const res = await view('match-readiness', { ...facility(), from: DATE, to: DATE });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    const total =
      (valueOf(res.body, 'MET-013', 'Fixtures ready (no blocking issue)') ?? 0) +
      (valueOf(res.body, 'MET-013', 'Fixtures blocked') ?? 0) +
      (valueOf(res.body, 'MET-013', 'Fixtures with unknown readiness') ?? 0);
    expect(total).toBe(1);
    expect(['ready', 'warning', 'blocked', 'unknown']).toContain(res.body.rows[0].status);
  });

  it('SPK-REPORT-002 uncovered assignments: a required referee without an accepted assignment', async () => {
    const res = await view('uncovered-assignments', { ...facility(), from: DATE, to: DATE });
    expect(res.status).toBe(200);
    expect(valueOf(res.body, 'MET-017')).toBe(1);
    expect(valueOf(res.body, 'MET-018')).toBe(0);
    expect(res.body.rows[0]).toMatchObject({
      role: 'referee',
      required: 1,
      accepted: 0,
      uncovered: 1,
    });
  });

  it('SPK-REPORT-002 waitlist demand, registration funnel and enrollment completeness', async () => {
    const range = { ...facility(), from: '2027-02-01', to: '2027-02-07' };
    const waitlist = await view('waitlist-demand', range);
    expect(waitlist.status).toBe(200);
    expect(valueOf(waitlist.body, 'MET-021')).toBe(1);
    expect(valueOf(waitlist.body, 'MET-023')).toBeNull();

    const funnel = await view('registration-funnel', range);
    expect(funnel.status).toBe(200);
    expect(valueOf(funnel.body, 'MET-025', 'Holds acquired')).toBe(1);
    expect(valueOf(funnel.body, 'MET-025', 'Enrollments confirmed')).toBe(2);
    expect(valueOf(funnel.body, 'MET-026')).toBeNull();

    const completeness = await view('enrollment-completeness', facility());
    expect(completeness.status).toBe(200);
    expect(valueOf(completeness.body, 'MET-033')).toBeCloseTo(0.1, 4);
    expect(valueOf(completeness.body, 'MET-034', 'Approved team entries')).toBe(2);
    // The adult enrolled without signing the required form.
    expect(
      valueOf(completeness.body, 'MET-037', 'Confirmed enrollments missing a required form'),
    ).toBe(1);
    const entries = (completeness.body.rows as Row[]).filter((r) => r.section === 'team_entry');
    expect(entries.every((r) => r.rosterSize === 2)).toBe(true);
  });

  it('SPK-REPORT-002 outstanding obligations: per currency, by aging band, never mixed', async () => {
    const res = await view('outstanding-obligations', {});
    expect(res.status).toBe(200);
    expect(valueOf(res.body, 'MET-039', 'Outstanding balance', 'USD')).toBe(7_500);
    expect(valueOf(res.body, 'MET-043', 'Credits outstanding', 'USD')).toBe(2_000);
    const bands = (res.body.rows as Row[]).map((r) => [r.agingBand, r.remainingMinor]);
    expect(bands).toEqual(
      expect.arrayContaining([
        ['31-60', 5_000],
        ['not_due', 2_500],
      ]),
    );
  });

  it('SPK-REPORT-002 payment and refund reconciliation: attempts by state; receipts beside sales, never combined', async () => {
    const res = await view('payment-reconciliation', { periodStart, periodEnd });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(valueOf(res.body, 'MET-045', 'Succeeded payment attempts', 'USD')).toBe(7_000);
    expect(valueOf(res.body, 'MET-046', 'Unknown payment outcomes')).toBe(0);
    expect(valueOf(res.body, 'MET-050', 'Customer receipts', 'USD')).toBe(7_000);
    expect(valueOf(res.body, 'MET-050', 'Recognised sales (fulfilled order lines)', 'USD')).toBe(
      9_000,
    );
    // MET-045: attempts never submitted have no submission instant to fall in the period; they are
    // counted over all time at the request instant and say so, never as if of the period.
    const never = 'Attempts never submitted to a provider (all time, at the request instant)';
    const notSubmitted = res.body.values.find((v: { label: string }) => v.label === never);
    expect(notSubmitted).toMatchObject({ metric: 'MET-045', dimensions: { window: 'all_time' } });
    const earlier = await view('payment-reconciliation', {
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2026-02-01T00:00:00.000Z',
    });
    expect(earlier.status, JSON.stringify(earlier.body)).toBe(200);
    expect(valueOf(earlier.body, 'MET-045', never)).toBe(notSubmitted.value);
    expect((res.body.disclosures as string[]).join(' ')).toContain('never submitted');
  });

  it('SPK-REPORT-002 maintenance restrictions: active restriction and overdue task', async () => {
    const res = await view('maintenance-restrictions', facility());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(valueOf(res.body, 'MET-054')).toBe(1);
    expect(valueOf(res.body, 'MET-056', 'Overdue maintenance tasks')).toBe(1);
    expect(valueOf(res.body, 'MET-057')).toBe(0);
  });

  it('SPK-REPORT-002 communication failures: failed essential notices, withheld recipients, stale unknown deliveries', async () => {
    const res = await view('communication-failures', { periodStart, periodEnd });
    expect(res.status).toBe(200);
    expect(valueOf(res.body, 'MET-059', 'Delivery attempts')).toBe(2);
    expect(valueOf(res.body, 'MET-060', 'Failed essential notices')).toBe(1);
    expect(valueOf(res.body, 'MET-061')).toBe(1);
    expect(valueOf(res.body, 'MET-062')).toBe(1);
  });

  it('SPK-REPORT-006: observed demand by day, time, age band, format and program; any forecast is a separate series', async () => {
    const range = { ...facility(), from: '2027-02-01', to: '2027-02-07' };
    const observed = await view('demand', range);
    expect(observed.status, JSON.stringify(observed.body)).toBe(200);
    const rows = observed.body.rows as Row[];
    const confirmed = rows.find((r) => r.signal === 'enrollment_confirmed')!;
    expect(confirmed).toMatchObject({
      dayOfWeek: 'wednesday',
      startBand: '17:00-18:00',
      ageBand: '6-12',
      observed: 2,
      forecast: null,
    });
    expect(rows.find((r) => r.signal === 'hold_acquired')).toMatchObject({ observed: 1 });
    expect(rows.find((r) => r.signal === 'waitlist_joined')).toMatchObject({ observed: 1 });
    expect(rows.find((r) => r.signal === 'session_booking_confirmed')).toMatchObject({
      observed: 1,
    });
    const forecastNone = observed.body.values.find(
      (v: { metric: string }) => v.metric === 'MET-089',
    );
    expect(forecastNone.value).toBeNull();

    const forecast = await view('demand', {
      ...range,
      forecastMethod: 'trailing_mean',
      forecastPeriods: '2',
    });
    expect(forecast.status).toBe(200);
    const withForecast = (forecast.body.rows as Row[]).find(
      (r) => r.signal === 'enrollment_confirmed',
    )!;
    // The observed column is unchanged; the forecast (one confirmation a week earlier, none before) is its own column.
    expect(withForecast).toMatchObject({
      observed: 2,
      forecast: 0.5,
      forecastMethod: 'trailing_mean',
    });
    const series = forecast.body.values.find((v: { metric: string }) => v.metric === 'MET-089');
    expect(series.dimensions).toMatchObject({
      series: 'forecast',
      method: 'trailing_mean',
      inputPeriods: '2',
    });
  });
});
