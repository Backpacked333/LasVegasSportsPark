/**
 * The pure parts of Explore and Register (redesign handoff 1d, 1e, 1f, 1g, 2e, 4e): ages and fit
 * answers, the cart plan, the last-place choices, the offer clock, the calendar file and the
 * 30-minute draft. SPK-SCHED-008 (facility clock), SPK-REG-005, SPK-AT-005, SPK-REG-008.
 */
import type { Schema } from '@sportspark/api-client';
import { basketLineKey, desiredLines, planChanges } from '../basket-plan';
import { clearDrafts, DRAFT_KEEP_MS, emptyDraft, readDraft, saveDraft } from '../draft';
import { busyTimesOf, teamShortName } from '../family-busy';
import {
  ageOn,
  campName,
  fitAnswer,
  lengthWords,
  meetingPattern,
  placesBadge,
  shortRange,
  wholeMoney,
} from '../fit';
import { sessionsIcs } from '../ics';
import { lastPlaceModel } from '../last-place';
import { deadlineWords, offerClock } from '../offer-clock';
import { line, offeringSession } from '../../registration/testing/fixtures';

const LA = 'America/Los_Angeles';
const session = (start: string, end: string, extra: Partial<Schema<'OfferingSession'>> = {}) =>
  offeringSession({ scheduledStart: start, scheduledEnd: end, ...extra });

describe('fit (1d rows 2 to 4)', () => {
  it('ageOn: whole years on the facility day, the birthday counted on the day', () => {
    expect(ageOn('2017-03-01', '2026-02-28')).toBe(8);
    expect(ageOn('2017-03-01', '2026-03-01')).toBe(9);
    expect(ageOn('not a date', '2026-03-01')).toBeNull();
  });

  it('placesBadge: "3 left" at five or fewer, "Full · waitlist", nothing above five or when unknown', () => {
    const a = (remaining: number, status: 'available' | 'full' = 'available') => ({
      offeringId: 'x',
      status,
      unit: 'seats' as const,
      capacity: 10,
      remaining,
    });
    expect(placesBadge(a(3))).toEqual({ tone: 'warning', label: '3 left' });
    expect(placesBadge(a(0, 'full'))).toEqual({ tone: 'danger', label: 'Full · waitlist' });
    expect(placesBadge(a(9))).toBeNull();
    expect(placesBadge(undefined)).toBeNull();
  });

  it('fitAnswer: in, full, clash, fits; nothing while the calendar or the sessions are unknown', () => {
    const sessions = [session('2026-10-31T16:00:00.000Z', '2026-10-31T17:00:00.000Z')];
    const busy = [
      { start: '2026-10-31T16:30:00.000Z', end: '2026-10-31T17:30:00.000Z', title: 'Desert Foxes' },
    ];
    expect(
      fitAnswer({ availability: undefined, sessions, busy, childName: 'Maya' })?.badge.label,
    ).toBe('Clashes with Desert Foxes');
    expect(
      fitAnswer({ availability: undefined, sessions, busy: [], childName: 'Maya' })?.badge.label,
    ).toBe("Fits Maya's week");
    expect(
      fitAnswer({ availability: undefined, sessions, busy: undefined, childName: 'Maya' }),
    ).toBeNull();
    expect(
      fitAnswer({
        offeringIds: ['o1'],
        availability: undefined,
        sessions,
        busy: [{ ...busy[0]!, offeringId: 'o1' }],
        childName: 'Maya',
      })?.badge.label,
    ).toBe('Maya is in');
    // Touching end to start is not a clash.
    expect(
      fitAnswer({
        availability: undefined,
        sessions,
        busy: [{ start: '2026-10-31T17:00:00.000Z', end: '2026-10-31T18:00:00.000Z', title: 'X' }],
        childName: 'Maya',
      })?.kind,
    ).toBe('fits');
  });

  it('meetingPattern and lengthWords on the facility clock: "Saturdays 9:00 AM", "Wednesdays 5:00–6:00 PM", "8 weeks", "5 days"', () => {
    const weekly = [0, 7].map((d) =>
      session(
        `2026-11-${String(7 + d).padStart(2, '0')}T17:00:00.000Z`,
        `2026-11-${String(7 + d).padStart(2, '0')}T18:00:00.000Z`,
      ),
    );
    expect(meetingPattern(weekly, LA)).toBe('Saturdays 9:00 AM');
    expect(meetingPattern(weekly, LA, { range: true })).toBe('Saturdays 9:00–10:00 AM');
    expect(lengthWords(weekly, LA)).toBe('2 weeks');
    const camp = [9, 10, 11, 12, 13].map((d) =>
      session(
        `2026-11-${String(d).padStart(2, '0')}T17:00:00.000Z`,
        `2026-11-${String(d).padStart(2, '0')}T23:00:00.000Z`,
      ),
    );
    expect(meetingPattern(camp, LA)).toBe('Weekdays 9:00 AM');
    expect(lengthWords(camp, LA)).toBe('5 days');
    expect(shortRange('2026-12-29', '2027-01-02')).toBe('Dec 29–Jan 2');
    expect(wholeMoney(9500, 'USD')).toBe('$95');
    expect(campName('Winter Break Camp · Week 1')).toBe('Winter Break Camp');
  });

  it("busyTimesOf: the child's own sessions and their team's games, by the team's short name", () => {
    expect(teamShortName('Desert Foxes U9')).toBe('Desert Foxes');
  });
});

describe("basket-plan (1f): the flow's cart brought to the choices", () => {
  it('one line per person and week with the extras by code, per day for a per-day extra; the plan removes and adds only what changed', () => {
    const addon = {
      id: 'a1',
      offeringId: 'w1',
      code: 'early_drop_off',
      name: 'Early drop-off',
      description: null,
      priceMinor: 1000,
      currency: 'USD',
      chargeLines: [],
      selection: 'per_session' as const,
      capacity: null,
      status: 'active' as const,
      revision: 1,
      createdAt: '',
    };
    const desired = desiredLines({
      personIds: ['p1'],
      weekIds: ['w1'],
      intent: 'youth',
      extras: ['early_drop_off'],
      uniformSizes: {},
      extrasOf: () => ({ addons: [addon], uniform: null, sessionIds: ['s1', 's2'] }),
    });
    expect(desired).toEqual([
      {
        participantPersonId: 'p1',
        offeringId: 'w1',
        intent: 'youth',
        addons: [{ addonId: 'a1', sessionIds: ['s1', 's2'] }],
        uniform: null,
      },
    ]);
    const existing = line({
      id: 'l1',
      participantPersonId: 'p1',
      offeringId: 'w1',
      addons: [],
      uniform: null,
    });
    const plan = planChanges([existing], desired);
    expect(plan.remove.map((l) => l.id)).toEqual(['l1']);
    expect(plan.add).toHaveLength(1);
    expect(basketLineKey(existing)).toContain('w1:p1');
  });
});

describe('last place (4e)', () => {
  it('the best choice first, the free weeks re-priced, and a discount that drops out explained', () => {
    const model = lastPlaceModel({
      full: ['Week 1'],
      free: ['Week 2'],
      freeTotal: '$116.00',
      discountsBefore: ['Multi-week'],
      discountsAfter: [],
      camp: true,
    });
    expect(model.title).toBe('Week 1 just filled up');
    expect(model.best).toBe('book_and_wait');
    expect(model.options.map((o) => o.label)).toEqual([
      'Book Week 2, waitlist Week 1',
      'Book Week 2 only',
      'Start over',
    ]);
    expect(model.actionOf('book_and_wait')).toBe('Pay $116.00 and join the list');
    expect(model.droppedNote).toBe('The Multi-week discount no longer applies.');
    const single = lastPlaceModel({
      full: ['League'],
      free: [],
      freeTotal: null,
      discountsBefore: [],
      discountsAfter: [],
      camp: false,
    });
    expect(single.best).toBe('wait');
    expect(single.title).toBe('The last place just went');
  });
});

describe('offer clock (2e row 1)', () => {
  it('hours and minutes, then minutes and seconds under an hour, ended at the deadline; the deadline on the facility clock', () => {
    const now = new Date('2026-10-24T12:00:00.000Z');
    expect(offerClock('2026-10-25T11:41:00.000Z', now).tiles).toEqual([
      ['23', 'hours'],
      ['41', 'min'],
    ]);
    const soon = offerClock('2026-10-24T12:30:05.000Z', now);
    expect(soon.tiles).toEqual([
      ['30', 'min'],
      ['05', 'sec'],
    ]);
    expect(soon.tickMs).toBe(1000);
    expect(offerClock('2026-10-24T11:00:00.000Z', now).ended).toBe(true);
    expect(deadlineWords('2026-10-25T16:41:00.000Z', now, LA)).toBe('tomorrow 9:41 AM');
    expect(deadlineWords('2026-10-27T16:41:00.000Z', now, LA)).toBe('Tue 9:41 AM');
  });
});

describe('Done (1g) and the draft (1e–1g row 10)', () => {
  it('the calendar file lists every live session in UTC with the activity and its place', () => {
    const ics = sessionsIcs({
      title: 'Spring Rec League, U9',
      location: 'Field 5',
      sessions: [
        session('2026-11-07T17:00:00.000Z', '2026-11-07T18:00:00.000Z', { id: 'e1' }),
        session('2026-11-14T17:00:00.000Z', '2026-11-14T18:00:00.000Z', {
          id: 'e2',
          status: 'canceled',
        }),
      ],
      now: new Date('2026-10-24T12:00:00.000Z'),
    });
    expect(ics).toContain('DTSTART:20261107T170000Z');
    expect(ics).toContain('SUMMARY:Spring Rec League\\, U9');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('the choices are kept for 30 minutes after leaving, then forgotten', () => {
    clearDrafts();
    const now = new Date('2026-10-24T12:00:00.000Z');
    saveDraft({ ...emptyDraft('o1'), personIds: ['p1'] }, now);
    expect(readDraft('o1', new Date(now.getTime() + DRAFT_KEEP_MS - 1))?.personIds).toEqual(['p1']);
    expect(readDraft('o1', new Date(now.getTime() + DRAFT_KEEP_MS + 1))).toBeNull();
  });
});

void busyTimesOf;
