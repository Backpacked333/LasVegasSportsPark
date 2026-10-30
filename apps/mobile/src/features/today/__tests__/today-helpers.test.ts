/**
 * Helpers behind SCR-C-03, SCR-C-04, SCR-C-06, SCR-C-18, SCR-C-19 and SCR-C-20: facility-local
 * time (SPK-SCHED-008), the status vocabulary (SPK-UX-004, journeys.md section 3), notice
 * placement on Home (SPK-UX-003, SPK-COMMS-005, SPK-COMMS-007) and calendar windows
 * (SPK-YOUTH-007).
 */
import type { Schema } from '@sportspark/api-client';
import { STATUS_GLYPHS } from '../../../ui/StatusBadge';
import {
  calendarWindowQuery,
  groupByDay,
  mergeCalendars,
  nextActivity,
  overlapIndex,
} from '../calendar';
import { changeSummary } from '../ChangeDetails';
import {
  fixtureEntry,
  fixtureOverlaps,
  groupEntriesByDay,
  mergeEntries,
  nextEntry,
  sessionEntry,
} from '../entries';
import {
  AVAILABILITY_REQUEST_ACTION,
  fixtureRequiredAction,
  joinNames,
  mySide,
  ownResponse,
  venueLocation,
  viewerOnRoster,
} from '../fixture-model';
import {
  availabilityRequestOf,
  latestChangeForEvent,
  noticeSection,
  openAvailabilityRequest,
  parseEventDetails,
  scheduleChangeOf,
  upcomingScheduleChanges,
} from '../notices';
import {
  calendarItemStatus,
  checkoutStateOf,
  currentResult,
  enrollmentStatus,
  fixtureAcceptsRsvp,
  noticeStatus,
  readinessStatus,
  resultStatus,
  rsvpStatus,
} from '../status';
import {
  addLocalDays,
  daysInWindow,
  displayZone,
  formatRange,
  formatWhen,
  localDayKey,
  sharedZone,
  startOfLocalDay,
  zoneNotice,
  zoneOf,
} from '../time';
import {
  AWAY_ENTRY,
  BOOKING_ITEM,
  calendar,
  calendarItem,
  CHILD,
  DENVER,
  EVENT,
  FIXTURE,
  fixtureDetail,
  HOME_ENTRY,
  myTeamEntry,
  SELF,
  eventDetails,
  LA,
  notice,
  operation,
  result,
  scheduleChange,
} from './fixtures';

jest.mock('../device-time-zone', () => ({ deviceTimeZone: () => 'America/Los_Angeles' }));

type InboxItem = Schema<'InboxItem'>;
type FamilyCalendar = Schema<'FamilyCalendar'>;
const NOW = new Date('2026-10-24T12:00:00.000Z');
const asItem = (v: unknown) => v as InboxItem;

describe('SPK-SCHED-008 facility-local time', () => {
  it('renders an instant on the facility clock with its zone, and says "to" between times', () => {
    expect(formatWhen('2026-10-24T17:00:00.000Z', LA)).toBe('Sat, Oct 24, 10:00 AM PDT');
    expect(formatRange('2026-10-24T17:00:00.000Z', '2026-10-24T18:30:00.000Z', LA)).toBe(
      'Sat, Oct 24, 10:00 AM to 11:30 AM PDT',
    );
    expect(
      formatRange('2026-10-24T17:00:00.000Z', '2026-10-24T18:30:00.000Z', 'Europe/Berlin'),
    ).toBe('Sat, Oct 24, 7:00 PM to 8:30 PM GMT+2');
  });

  it('names both days when a range crosses local midnight', () => {
    expect(formatRange('2026-10-25T06:00:00.000Z', '2026-10-25T08:00:00.000Z', LA)).toBe(
      'Sat, Oct 24, 11:00 PM to Sun, Oct 25, 1:00 AM PDT',
    );
  });

  it('finds local midnight across a daylight-saving change', () => {
    expect(startOfLocalDay(NOW, LA).toISOString()).toBe('2026-10-24T07:00:00.000Z');
    // 1 November 2026 is the end of daylight saving time in Los Angeles.
    const later = addLocalDays(startOfLocalDay(NOW, LA), 28, LA);
    expect(later.toISOString()).toBe('2026-11-21T08:00:00.000Z');
    expect(localDayKey('2026-10-25T06:59:00.000Z', LA)).toBe('2026-10-24');
    expect(localDayKey('2026-10-25T07:00:00.000Z', LA)).toBe('2026-10-25');
  });

  it('uses the facility zone when the API states one, otherwise the device zone and says so', () => {
    expect(displayZone(LA)).toEqual({ zone: LA, facility: true });
    expect(displayZone('Not/AZone')).toEqual({ zone: LA, facility: false });
    expect(zoneNotice(displayZone(LA), NOW)).toBeNull();
    expect(zoneNotice(displayZone(null), NOW)).toBe(
      "Times are in this device's time zone (PDT). The facility's time zone was not given for this.",
    );
  });

  it('takes the first facility zone the API gives, in order of preference', () => {
    expect(zoneOf(null, undefined, DENVER, LA)).toEqual({ zone: DENVER, facility: true });
    expect(zoneOf('Bad/Zone', LA)).toEqual({ zone: LA, facility: true });
    expect(zoneOf(null, undefined)).toEqual({ zone: LA, facility: false });
    expect(sharedZone([LA, LA, null])).toBe(LA);
    expect(sharedZone([LA, DENVER])).toBeNull();
    expect(sharedZone([])).toBeNull();
  });

  it('lays out the local days a window touches, one more when it was cut on another clock', () => {
    const from = new Date('2026-10-24T07:00:00.000Z');
    const to = new Date('2026-10-31T07:00:00.000Z');
    expect(daysInWindow(from, to, LA).map((d) => localDayKey(d, LA))).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
    ]);
    // Cut at Los Angeles midnight, laid out on the Denver clock: Oct 24 01:00 MDT to Oct 31 01:00.
    const denver = daysInWindow(from, to, DENVER).map((d) => localDayKey(d, DENVER));
    expect(denver[0]).toBe('2026-10-24');
    expect(denver.at(-1)).toBe('2026-10-31');
    expect(denver).toHaveLength(8);
  });
});

describe('SPK-UX-004 status vocabulary (journeys.md section 3)', () => {
  it('keeps "Payment processing", "Awaiting placement" and "Confirmed" apart in words and glyph', () => {
    const processing = enrollmentStatus(
      { status: 'pending' },
      { operation: operation('running') as never },
    );
    const awaiting = enrollmentStatus(
      { status: 'confirmed' },
      { offeringName: 'Junior Skills', placement: { status: 'unassigned' } },
    );
    const confirmed = enrollmentStatus({ status: 'confirmed' });
    expect(processing.label).toBe('Payment processing');
    expect(awaiting.label).toBe('Confirmed in Junior Skills. Awaiting placement.');
    expect(confirmed.label).toBe('Confirmed');
    const glyphs = [processing, awaiting, confirmed].map((s) => STATUS_GLYPHS[s.tone]);
    expect(new Set(glyphs).size).toBe(3);
  });

  it('names recovery and compensation as the checkout states say, never as plain failure', () => {
    expect(
      enrollmentStatus(
        { status: 'pending' },
        { operation: operation('recovery_required') as never },
      ).label,
    ).toBe('Payment received. We are completing your registration.');
    expect(
      enrollmentStatus({ status: 'pending' }, { operation: operation('compensated') as never })
        .label,
    ).toBe('Payment returned. Registration was not completed.');
    expect(enrollmentStatus({ status: 'pending' }).label).toBe('Registration pending');
    // ENR-02: the outstanding requirement is named (journeys §3 "Registration pending: <reason>").
    expect(enrollmentStatus({ status: 'pending', pendingReason: 'approval' }).label).toBe(
      'Registration pending: awaiting approval',
    );
    // "Payment outstanding" only once the basket and order were read and no checkout runs.
    expect(
      enrollmentStatus({ status: 'pending', pendingReason: 'payment' }, { checkout: null }).label,
    ).toBe('Registration pending: payment outstanding');
    expect(enrollmentStatus({ status: 'pending', pendingReason: 'forms' }).label).toBe(
      'Registration pending: a form to complete',
    );
    expect(enrollmentStatus({ status: 'pending', pendingReason: 'placement' }).label).toBe(
      'Registration pending: awaiting placement',
    );
    // A checkout in recovery still wins over a reason.
    expect(
      enrollmentStatus(
        { status: 'pending', pendingReason: 'payment' },
        { operation: operation('recovery_required') as never },
      ).label,
    ).toBe('Payment received. We are completing your registration.');
    expect(
      enrollmentStatus(
        { status: 'confirmed' },
        { placement: { status: 'assigned' }, teamName: 'Lions' },
      ).label,
    ).toBe('Confirmed: Lions');
  });

  it('SPK-PAY-007: a payment reason never reads "outstanding" while the checkout is unread, being read or unreadable', () => {
    const payment = { status: 'pending' as const, pendingReason: 'payment' as const };
    // The API's `payment` also covers a basket already checking out (a payment running).
    expect(enrollmentStatus(payment, { checkout: 'processing' }).label).toBe('Payment processing');
    expect(enrollmentStatus(payment, { checkout: 'checking' })).toEqual({
      tone: 'pending',
      label: 'Registration pending: checking payment status',
    });
    expect(enrollmentStatus(payment, { checkout: 'unknown' })).toEqual({
      tone: 'pending',
      label: 'Registration pending: payment status could not be checked',
    });
    // A caller that did not read the basket says nothing about payment.
    expect(enrollmentStatus(payment).label).toBe('Registration pending');
    // Other reasons do not depend on the checkout read.
    expect(
      enrollmentStatus({ status: 'pending', pendingReason: 'forms' }, { checkout: 'checking' })
        .label,
    ).toBe('Registration pending: a form to complete');
    // The basket's state: a read still to answer is "checking", a failed one "unknown".
    expect(checkoutStateOf(undefined, undefined, false, true)).toBe('checking');
    expect(checkoutStateOf(undefined, undefined, true, true)).toBe('unknown');
    expect(checkoutStateOf({ status: 'held', orderRef: null }, undefined, false, false)).toBeNull();
    expect(
      checkoutStateOf({ status: 'checking_out', orderRef: null }, undefined, false, true),
    ).toBe('processing');
  });

  it('labels calendar items, RSVP, readiness and results with their own words', () => {
    expect(calendarItemStatus(BOOKING_ITEM as never).label).toBe('Booking pending');
    expect(calendarItemStatus(calendarItem() as never).label).toBe('Confirmed');
    expect(rsvpStatus(null).label).toBe('No response');
    expect(rsvpStatus('tentative').label).toBe('Tentative');
    expect(readinessStatus('blocked').label).toBe('Match readiness: blocked');
    expect(fixtureAcceptsRsvp('played')).toBe(false);
    expect(fixtureAcceptsRsvp('postponed')).toBe(true);
  });

  it('shows the current official result, a correction as such, and a submitted one as provisional (SPK-RESULT-001)', () => {
    const fmt = (iso: string) => iso.slice(0, 10);
    const first = result({ revisionNo: 1, status: 'superseded' });
    const corrected = result({
      revisionNo: 2,
      status: 'official',
      supersedesRevisionId: 'r1',
      publishedAt: '2026-10-22T09:00:00.000Z',
    });
    const current = currentResult([first, corrected] as never);
    expect(current?.revisionNo).toBe(2);
    expect(resultStatus(current as never, fmt).label).toBe('Official. Corrected on 2026-10-22');
    const provisional = currentResult([
      result({ status: 'submitted' }),
      result({ status: 'draft', revisionNo: 2 }),
    ] as never);
    expect(resultStatus(provisional as never, fmt).label).toBe('Provisional');
    expect(currentResult([result({ status: 'draft' })] as never)).toBeNull();
  });

  it('labels notices Unread, Read, Acknowledged and Replaced by a newer update', () => {
    expect(noticeStatus(asItem(notice())).label).toBe('Unread');
    expect(noticeStatus(asItem(notice({ readAt: 'x' }))).label).toBe('Read');
    expect(noticeStatus(asItem(notice({ readAt: 'x', acknowledgedAt: 'y' }))).label).toBe(
      'Acknowledged',
    );
    expect(noticeStatus(asItem(notice({ supersededByNotificationId: 'n' }))).label).toBe(
      'Replaced by a newer update',
    );
  });
});

describe('SPK-UX-003 notices on Home', () => {
  it('places notices in the Home order and keeps promotional messages off Home', () => {
    const section = (o: Record<string, unknown>) => noticeSection(asItem(notice(o)), NOW);
    expect(noticeSection(asItem(scheduleChange()), NOW)).toBe('urgent');
    expect(section({ kind: 'cancellation' })).toBe('urgent');
    expect(section({ kind: 'payment_attention' })).toBe('actions');
    expect(section({ kind: 'waitlist_offer' })).toBe('invitations');
    expect(section({ kind: 'result_published' })).toBe('results');
    expect(section({ kind: 'renewal_opportunity' })).toBe('renewals');
    expect(section({ kind: 'renewal_opportunity', category: 'promotional' })).toBeNull();
    expect(section({ kind: 'payment_attention', acknowledgedAt: 'x' })).toBeNull();
    expect(section({ kind: 'payment_attention', supersededByNotificationId: 'n' })).toBeNull();
  });

  it('COM-06, SPK-UX-003: an availability request is an action until its fixture starts', () => {
    const request = asItem(
      notice({
        kind: 'availability_request',
        title: 'Lions: are you available?',
        subject: { type: 'fixture', id: FIXTURE },
        detailsAfter: {
          fixtureId: FIXTURE,
          scheduledStart: '2026-10-25T17:00:00.000Z',
          timezone: LA,
        },
      }),
    );
    expect(noticeSection(request, NOW)).toBe('actions');
    expect(availabilityRequestOf(request)).toEqual({
      fixtureId: FIXTURE,
      scheduledStart: '2026-10-25T17:00:00.000Z',
    });
    expect(noticeSection(request, new Date('2026-10-25T17:00:00.000Z'))).toBeNull();
    expect(openAvailabilityRequest([request], FIXTURE)).toBe(request);
    expect(openAvailabilityRequest([{ ...request, acknowledgedAt: 'x' }], FIXTURE)).toBeNull();
    expect(availabilityRequestOf(asItem(notice()))).toBeNull();
  });

  it('drops a change to something already over from the urgent list', () => {
    const past = scheduleChange({
      detailsAfter: eventDetails({
        scheduledStart: '2026-10-23T17:00:00.000Z',
        scheduledEnd: '2026-10-23T18:00:00.000Z',
      }),
    });
    expect(noticeSection(asItem(past), NOW)).toBeNull();
    expect(upcomingScheduleChanges([asItem(past)], NOW)).toHaveLength(0);
  });
});

describe('SPK-COMMS-005 old and new practical details', () => {
  it('reads Was and Now in the facility zone with the field names', () => {
    const change = scheduleChangeOf(asItem(scheduleChange()));
    expect(change && changeSummary(change)).toEqual({
      was: 'Sat, Oct 24, 10:00 AM to 11:00 AM PDT at Pitch 1',
      now: 'Sat, Oct 24, 11:00 AM to 12:00 PM PDT at Pitch 2',
    });
  });

  it('says "Canceled" for a cancellation and ignores malformed details', () => {
    const canceled = scheduleChangeOf(
      asItem(scheduleChange({ kind: 'cancellation', detailsAfter: null })),
    );
    expect(canceled && changeSummary(canceled).now).toBe('Canceled');
    expect(parseEventDetails({ title: 'x' })).toBeNull();
    expect(
      scheduleChangeOf(asItem(notice({ kind: 'schedule_changed', detailsBefore: 'bad' }))),
    ).toBeNull();
  });

  it('uses the newest notice about an event that has not been replaced', () => {
    const old = scheduleChange({ supersededByNotificationId: 'n2' });
    const current = scheduleChange();
    expect(latestChangeForEvent([asItem(old), asItem(current)], EVENT)?.item).toBe(current);
    expect(latestChangeForEvent([asItem(current)], 'other-event')).toBeNull();
  });
});

describe('SPK-YOUTH-007 calendar windows', () => {
  it('asks for consecutive windows from local midnight', () => {
    expect(calendarWindowQuery(NOW, 0, 28, LA)).toEqual({
      from: '2026-10-24T07:00:00.000Z',
      to: '2026-11-21T08:00:00.000Z',
    });
    expect(calendarWindowQuery(NOW, -1, 7, LA)).toEqual({
      from: '2026-10-17T07:00:00.000Z',
      to: '2026-10-24T07:00:00.000Z',
    });
  });

  it('merges windows without duplicates, groups by local day and indexes overlaps', () => {
    const a = calendarItem();
    const b = BOOKING_ITEM;
    const merged = mergeCalendars([
      calendar([a]) as FamilyCalendar,
      calendar([a, b], {
        overlaps: [{ itemIds: [a.id, b.id], personIds: [], start: a.start, end: a.end }],
      }) as FamilyCalendar,
    ]);
    expect(merged?.items.map((i) => i.id)).toEqual([a.id, b.id]);
    const groups = groupByDay(merged?.items ?? [], LA);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBe('Sat, Oct 24');
    expect(overlapIndex(merged as FamilyCalendar).get(a.id as string)).toEqual([b.id]);
    expect(nextActivity(merged?.items ?? [], new Date('2026-10-24T17:30:00.000Z'))?.id).toBe(a.id);
    expect(nextActivity(merged?.items ?? [], new Date('2026-10-25T03:00:00.000Z'))).toBeNull();
  });
});

type FixtureDetail = Schema<'FixtureDetail'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;
type FamilyCalendarItem = Schema<'FamilyCalendarItem'>;
const asFixture = (v: unknown) => v as FixtureDetail;
const asTeams = (v: unknown[]) => v as MyTeamEntry[];

describe('CMP-02 / SPK-SCHED-008 sessions and fixtures in one list', () => {
  const game = asFixture(
    fixtureDetail({
      scheduledStart: '2026-10-24T17:30:00.000Z',
      scheduledEnd: '2026-10-24T19:00:00.000Z',
      venue: { facilityId: 'f', facilityName: 'North Complex', timezone: DENVER, resources: [] },
    }),
  );
  const item = calendarItem() as FamilyCalendarItem;
  const teams = asTeams([myTeamEntry({ members: [CHILD] })]);

  it('orders sessions and fixtures by time, each on its own facility clock', () => {
    const entries = mergeEntries(
      [item, item],
      [game, asFixture(fixtureDetail({ scheduledStart: null, scheduledEnd: null }))],
    );
    expect(entries.map((e) => e.type)).toEqual(['session', 'fixture']);
    expect(entries[0]?.zone).toEqual({ zone: LA, facility: true });
    expect(entries[1]?.zone).toEqual({ zone: DENVER, facility: true });
    expect(fixtureEntry(asFixture(fixtureDetail({ scheduledStart: null })))).toBeNull();
    expect(sessionEntry(calendarItem({ timezone: null }) as FamilyCalendarItem).zone.facility).toBe(
      false,
    );
  });

  it('the next entry skips what ended and fixtures that will not be played', () => {
    const canceled = asFixture(
      fixtureDetail({
        status: 'canceled',
        scheduledStart: '2026-10-24T13:00:00.000Z',
        scheduledEnd: '2026-10-24T14:00:00.000Z',
      }),
    );
    const entries = mergeEntries([item], [canceled, game]);
    expect(nextEntry(entries, NOW)?.type).toBe('session');
    expect(nextEntry(entries, new Date('2026-10-24T18:30:00.000Z'))?.type).toBe('fixture');
    expect(nextEntry(entries, new Date('2026-10-25T00:00:00.000Z'))).toBeNull();
  });

  it('groups by local day on each facility clock', () => {
    const late = asFixture(
      fixtureDetail({
        // 11:30 PM Saturday in Los Angeles is Sunday 00:30 in Denver.
        scheduledStart: '2026-10-25T06:30:00.000Z',
        scheduledEnd: '2026-10-25T07:30:00.000Z',
        venue: { facilityId: 'f', facilityName: 'North Complex', timezone: DENVER, resources: [] },
      }),
    );
    const days = groupEntriesByDay(mergeEntries([item], [late]));
    expect(days.map((d) => [d.key, d.heading])).toEqual([
      ['2026-10-24', 'Sat, Oct 24'],
      ['2026-10-25', 'Sun, Oct 25'],
    ]);
  });

  it('compares instants as times, not strings (contracts Instant: offsets and optional fractions)', () => {
    // The session ends at 18:00Z, written with fractions; the fixture starts then, written
    // without them and as an offset: it touches the session, it does not overlap it.
    const touching = asFixture(
      fixtureDetail({
        scheduledStart: '2026-10-24T11:00:00-07:00',
        scheduledEnd: '2026-10-24T19:00:00Z',
      }),
    );
    const entries = mergeEntries([item], [touching]);
    expect(entries.map((e) => e.type)).toEqual(['session', 'fixture']);
    expect(fixtureOverlaps(entries, teams)).toEqual([]);
    // 18:20 at +01:00 is 17:20Z: it comes before 17:45Z although its string sorts after.
    const early = asFixture(
      fixtureDetail({
        id: '0192f1a0-0000-7000-8000-00000000f102',
        scheduledStart: '2026-10-24T18:20:00+01:00',
        scheduledEnd: '2026-10-24T18:40:00+01:00',
      }),
    );
    const later = asFixture(
      fixtureDetail({
        scheduledStart: '2026-10-24T17:45:00Z',
        scheduledEnd: '2026-10-24T18:30:00Z',
      }),
    );
    expect(mergeEntries([], [later, early]).map((e) => e.start)).toEqual([
      '2026-10-24T18:20:00+01:00',
      '2026-10-24T17:45:00Z',
    ]);
  });

  it('SPK-YOUTH-007: marks a fixture overlapping another commitment of the same person only', () => {
    const entries = mergeEntries([item], [game]);
    expect(fixtureOverlaps(entries, teams)).toEqual([
      { ids: [entries[0]?.id, entries[1]?.id], personIds: [CHILD] },
    ]);
    // The adult's team plays at the same time as the child's session: not the same person.
    expect(fixtureOverlaps(entries, asTeams([myTeamEntry({ members: [SELF] })]))).toEqual([]);
  });
});

describe('SCR-C-04 fixture card helpers (CMP-02, CMP-04)', () => {
  it("finds the viewer's side from their team entries", () => {
    const fixture = asFixture(fixtureDetail());
    expect(
      mySide(fixture, asTeams([myTeamEntry({ entryId: AWAY_ENTRY, teamName: 'Tigers' })]))?.side,
    ).toBe('away');
    expect(mySide(fixture, asTeams([myTeamEntry({ entryId: HOME_ENTRY })]))?.side).toBe('home');
    expect(mySide(fixture, asTeams([]))).toBeNull();
    expect(mySide(fixture, undefined)).toBeNull();
  });

  it("names the venue and pitches, the viewer's own answer and whether they are on a roster", () => {
    const fixture = asFixture(
      fixtureDetail({
        responses: [
          { personId: CHILD, state: 'unavailable', revision: 1, respondedAt: null },
          { personId: SELF, state: 'available', revision: 3, respondedAt: null },
        ],
      }),
    );
    expect(venueLocation(fixture.venue)).toBe('Main Park, Pitch 3');
    expect(venueLocation(fixture.venue, ['Pitch 2'])).toBe('Main Park, Pitch 2');
    expect(venueLocation(null)).toBeNull();
    expect(ownResponse(fixture, SELF)?.revision).toBe(3);
    expect(ownResponse(fixture, null)).toBeNull();
    expect(viewerOnRoster(fixture)).toBe(true);
    expect(viewerOnRoster(asFixture(fixtureDetail({ rosterStatus: null })))).toBe(false);
    expect(viewerOnRoster(asFixture({ ...fixtureDetail(), rosterStatus: undefined }))).toBeNull();
    expect(joinNames(['You'])).toBe('You');
    expect(joinNames(['You', 'Sam', 'Jo'])).toBe('You, Sam and Jo');
  });

  it('SCR-C-04 required action: an open availability request the viewer on a roster has not answered', () => {
    const request = { kind: 'availability_request' };
    const unanswered = asFixture(fixtureDetail());
    expect(fixtureRequiredAction(unanswered, SELF, request)).toBe(AVAILABILITY_REQUEST_ACTION);
    expect(fixtureRequiredAction(unanswered, SELF, null)).toBeNull();
    const answered = asFixture(
      fixtureDetail({
        responses: [{ personId: SELF, state: 'available', revision: 2, respondedAt: null }],
      }),
    );
    expect(fixtureRequiredAction(answered, SELF, request)).toBeNull();
    // A guardian on no roster is told by the RSVP control instead (DEC-090).
    expect(
      fixtureRequiredAction(asFixture(fixtureDetail({ rosterStatus: null })), SELF, request),
    ).toBeNull();
    // A fixture that takes no answers asks for nothing.
    expect(
      fixtureRequiredAction(asFixture(fixtureDetail({ status: 'played' })), SELF, request),
    ).toBeNull();
  });
});
