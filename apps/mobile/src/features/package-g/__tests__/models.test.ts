/**
 * Package G wording and derivations (§3.16; SPK-COND-001, SPK-COND-003, SPK-UX-009): every status
 * differs in words and glyph tone, a paid booking waiting for staff is never "Confirmed", free
 * times come only from the API's intervals, terms are read only in their approved shape, and a
 * membership says exactly what attendance it includes.
 */
import { TEST_NOW } from '../../../testing/test-app';
import {
  bookableTimes,
  bookingStatus,
  bookingTermsOf,
  cancelBasis,
  conflictsOf,
  endReasonText,
  holdPaymentOf,
  isCancellable,
  outstandingText,
  paymentText,
  type BookingStatus,
} from '../booking-model';
import {
  activeSuspension,
  attendanceText,
  inTerm,
  lastTermDay,
  membershipBookable,
  membershipBookingRefusal,
  membershipStatus,
  periodLabel,
  suspensionText,
  termText,
  usageText,
} from '../membership-model';
import { receiptStatus, returnText } from '../receipt-model';
import { bookingTerms, G, membership, rentalAvailability, suspension, ZONE } from './fixtures';

const STATUSES: BookingStatus[] = [
  'requested',
  'held',
  'awaiting_staff',
  'confirmed',
  'declined',
  'expired',
  'canceled',
  'completed',
];

describe('booking model (SPK-COND-003, ENR-13)', () => {
  it('SPK-UX-009: every booking status has its own words; awaiting staff is never "Confirmed"', () => {
    const labels = STATUSES.map((status) => bookingStatus({ status, outstanding: [] }).label);
    expect(new Set(labels).size).toBe(STATUSES.length);
    expect(bookingStatus({ status: 'awaiting_staff', outstanding: ['staffing'] })).toEqual({
      tone: 'info',
      label: 'Paid: staff still being arranged',
    });
    expect(bookingStatus({ status: 'confirmed', outstanding: [] }).tone).toBe('success');
  });

  it('names what is still outstanding as the API lists it', () => {
    expect(outstandingText(['payment', 'staffing'])).toEqual([
      'Your payment, in your basket. The booking is confirmed only when it is paid.',
      'The facility assigns the staff this booking needs. It is confirmed only when they are assigned.',
    ]);
  });

  it('cancellation follows the booking machine: what a cancel releases depends on what is held', () => {
    expect(STATUSES.filter(isCancellable)).toEqual([
      'requested',
      'held',
      'awaiting_staff',
      'confirmed',
    ]);
    expect(cancelBasis({ status: 'requested' })).toBe('request');
    expect(cancelBasis({ status: 'held' })).toBe('hold');
    expect(cancelBasis({ status: 'awaiting_staff' })).toBe('paid');
    expect(cancelBasis({ status: 'confirmed' })).toBe('paid');
    expect(cancelBasis({ status: 'completed' })).toBeNull();
    expect(endReasonText('not_decided')).toBe('The request was not decided before its start time.');
    expect(endReasonText('Moving the party')).toBe('Moving the party');
  });

  it("a held booking's basket says where its payment stands: only open or held is unpaid", () => {
    expect(holdPaymentOf('open')).toBe('unpaid');
    expect(holdPaymentOf('held')).toBe('unpaid');
    expect(holdPaymentOf('checking_out')).toBe('paying');
    // The checkout completed: never "nothing charged", even while the booking still reads held.
    expect(holdPaymentOf('fulfilled')).toBe('paid');
    expect(holdPaymentOf('partially_fulfilled')).toBe('paid');
    expect(holdPaymentOf('expired')).toBe('ended');
    expect(holdPaymentOf('released')).toBe('ended');
    expect(holdPaymentOf('abandoned')).toBe('ended');
  });

  it('free times: later than now, with at least the number of resources one booking reserves', () => {
    const one = bookableTimes(rentalAvailability(), TEST_NOW);
    expect(one.map((t) => [t.start, t.resources.map((r) => r.resourceId)])).toEqual([
      ['2026-10-24T17:00:00.000Z', [G.court1, G.court2]],
      ['2026-10-24T18:00:00.000Z', [G.court1]],
    ]);
    const two = bookableTimes(rentalAvailability({ resourceCount: 2 }), TEST_NOW);
    expect(two.map((t) => t.start)).toEqual(['2026-10-24T17:00:00.000Z']);
  });

  it('POL-040: booking terms are read only in their approved shape; nothing is filled in', () => {
    expect(bookingTermsOf(bookingTerms({ confirmationMode: 'request' }))).toEqual({
      confirmationMode: 'request',
      installmentPolicyKey: null,
      accessConditions: 'Enter by the north gate.',
      hostResponsibilities: null,
    });
    expect(bookingTermsOf(bookingTerms({ confirmationMode: 'sometimes' }))).toBeNull();
    expect(bookingTermsOf(bookingTerms({}, { kind: 'cancellation' }))).toBeNull();
    expect(paymentText({ installmentPolicyKey: 'deposit-plan' })).toMatch(/deposit is taken/);
    expect(paymentText({ installmentPolicyKey: null })).toMatch(/Paid in full at checkout/);
  });

  it('reads the conflicts of a RESOURCE_CONFLICT answer and ignores anything else', () => {
    expect(
      conflictsOf({
        conflicts: [{ occurrenceStart: '2026-10-31T17:00:00.000Z', resourceId: G.court1 }, 4],
      }),
    ).toEqual([{ occurrenceStart: '2026-10-31T17:00:00.000Z', resourceId: G.court1 }]);
    expect(conflictsOf(null)).toEqual([]);
  });
});

describe('membership model (SPK-COND-001, ENR-12)', () => {
  it('SPK-COND-001: attendance is exactly what the entitlement states, never assumed unlimited', () => {
    expect(attendanceText(membership().attendance)).toBe('8 sessions each month');
    expect(
      attendanceText({
        mode: 'unlimited',
        limit: null,
        appliesTo: { offeringIds: [], programIds: [] },
      }),
    ).toBe('Unlimited sessions');
    expect(attendanceText({ mode: 'none', limit: null, appliesTo: null })).toBe(
      'No sessions included',
    );
    expect(attendanceText(null)).toMatch(/cannot be shown right now/);
  });

  it('usage periods in words', () => {
    expect(periodLabel('month:2026-10')).toBe('October 2026');
    expect(periodLabel('week:2026-10-19')).toBe('the week of Oct 19, 2026');
    expect(periodLabel('term')).toBe('this membership term');
    expect(periodLabel('other')).toBe('other');
    expect(usageText({ periodKey: 'month:2026-10', usedCount: 3, limitCount: 8 })).toBe(
      '3 of 8 sessions used in October 2026',
    );
  });

  it('a suspension in force makes the membership read "suspended", in the facility zone', () => {
    const suspended = membership({ suspensions: [suspension()] });
    expect(activeSuspension(suspended, TEST_NOW)?.id).toBe(G.suspension);
    expect(membershipStatus(suspended, TEST_NOW, ZONE)).toEqual({
      tone: 'warning',
      label: 'Membership suspended',
    });
    expect(membershipStatus(membership(), TEST_NOW, ZONE).label).toBe('Membership active');
    expect(suspensionText(suspension(), ZONE)).toBe(
      'Suspended from Oct 20, 2026 until Nov 3, 2026',
    );
    expect(suspensionText(suspension({ until: null }), ZONE)).toBe(
      'Suspended from Oct 20, 2026 until the front desk ends it',
    );
  });
});

describe('membership term (SPK-COND-001, POL-038)', () => {
  it("the term's end is the last local day it includes: the API's termEndsAt is exclusive", () => {
    // Offering 2026-01-01 to 2026-12-31: the API stores the local midnight after Dec 31.
    expect(termText(membership(), ZONE)).toBe('Jan 1, 2026 to Dec 31, 2026');
    expect(lastTermDay('2027-01-01T08:00:00.000Z', ZONE)).toBe('Dec 31, 2026');
    // A term counted from confirmation ends at that instant: its day is still included.
    expect(lastTermDay('2026-10-31T21:23:00.000Z', ZONE)).toBe('Oct 31, 2026');
    expect(termText(membership({ termStartsAt: null, termEndsAt: null }), ZONE)).toBe(
      'Not available',
    );
    expect(
      termText(membership({ status: 'pending', termStartsAt: null, termEndsAt: null }), ZONE),
    ).toBe('Set when the membership is confirmed');
    expect(inTerm(membership(), '2026-12-31T23:00:00.000Z')).toBe(true);
    expect(inTerm(membership(), '2027-01-01T08:00:00.000Z')).toBe(false);
  });

  it('"Membership active" only inside the term; no term, not started and ended each say so', () => {
    const labels = [
      membershipStatus(membership(), TEST_NOW, ZONE),
      membershipStatus(membership({ termStartsAt: null, termEndsAt: null }), TEST_NOW, ZONE),
      membershipStatus(
        membership({
          termStartsAt: '2027-01-01T08:00:00.000Z',
          termEndsAt: '2028-01-01T08:00:00.000Z',
        }),
        TEST_NOW,
        ZONE,
      ),
      membershipStatus(
        membership({
          termStartsAt: '2025-01-01T08:00:00.000Z',
          termEndsAt: '2026-01-01T08:00:00.000Z',
        }),
        TEST_NOW,
        ZONE,
      ),
    ];
    expect(labels).toEqual([
      { tone: 'success', label: 'Membership active' },
      { tone: 'warning', label: 'Term not available: ask the front desk' },
      { tone: 'info', label: 'Starts Jan 1, 2027' },
      { tone: 'neutral', label: 'Term ended' },
    ]);
  });

  it('ENR-12: booking with a membership is offered only inside its term, unsuspended, with named activities', () => {
    expect(membershipBookable(membership(), TEST_NOW)).toBe(true);
    expect(membershipBookable(membership({ suspensions: [suspension()] }), TEST_NOW)).toBe(false);
    expect(membershipBookable(membership({ termStartsAt: null }), TEST_NOW)).toBe(false);
    expect(membershipBookable(membership({ status: 'pending' }), TEST_NOW)).toBe(false);
    expect(membershipBookable(membership({ attendance: null }), TEST_NOW)).toBe(false);
    expect(
      membershipBookable(
        membership({ attendance: { mode: 'none', limit: null, appliesTo: null } }),
        TEST_NOW,
      ),
    ).toBe(false);
    expect(
      membershipBookable(
        membership({
          attendance: {
            mode: 'unlimited',
            limit: null,
            appliesTo: { offeringIds: [], programIds: [] },
          },
        }),
        TEST_NOW,
      ),
    ).toBe(false);
    expect(membershipBookingRefusal('MEMBERSHIP_SESSIONS_USED')).toBe(
      'Not available: every session this membership includes for that period is used',
    );
    expect(membershipBookingRefusal('OUTSIDE_MEMBERSHIP_TERM')).toMatch(/outside the membership/);
    expect(membershipBookingRefusal('SOMETHING_ELSE')).toBeNull();
  });
});

describe('point-of-sale receipt model (SPK-PAY-008)', () => {
  it('a card return never reads as refunded; statuses differ in words', () => {
    expect(returnText('card')).toMatch(/does not show whether it has arrived/);
    expect(returnText('cash')).toBe('Refunded in cash at the desk');
    const labels = (['paid', 'partially_returned', 'returned', 'voided', 'open'] as const).map(
      (s) => receiptStatus(s).label,
    );
    expect(new Set(labels).size).toBe(5);
    expect(receiptStatus('open').label).toBe('Not paid yet');
  });
});
