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
  latestChangeForEvent,
  noticeSection,
  parseEventDetails,
  scheduleChangeOf,
  upcomingScheduleChanges,
} from '../notices';
import {
  calendarItemStatus,
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
  displayZone,
  formatRange,
  formatWhen,
  localDayKey,
  startOfLocalDay,
  zoneNotice,
} from '../time';
import {
  BOOKING_ITEM,
  calendar,
  calendarItem,
  EVENT,
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
      "Times are in this device's time zone (PDT). The facility's time zone is not provided to the app yet.",
    );
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
    expect(
      enrollmentStatus(
        { status: 'confirmed' },
        { placement: { status: 'assigned' }, teamName: 'Lions' },
      ).label,
    ).toBe('Confirmed: Lions');
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
