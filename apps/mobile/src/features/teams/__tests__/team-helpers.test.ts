/**
 * Helpers of the team screens: status vocabulary from journeys.md section 3 (SPK-UX-004,
 * SPK-UX-010), money display and input in minor units (SPK-PAY-001), route ids (§4.14), the
 * presentation-only viewer (SPK-CAP-002), the session list of opened teams, and the
 * development-only payment methods (DEC-019).
 */
import { DEV_CONTRIBUTION_PAYMENT_METHODS } from '../dev';
import { formatDateOnly, formatMoney, ordinal, parseMoneyInput, roleWords } from '../format';
import { teamInvitationLink } from '../InvitationIssued';
import { totalsLabel } from '../ObligationTotals';
import {
  forgetTeamEntry,
  openedTeamEntries,
  rememberTeamEntry,
  resetOpenedTeamEntries,
} from '../opened-teams';
import { respondableChildren, viewerOf } from '../queries';
import { idParam, teamRoutes } from '../routes';
import {
  availabilitySummaryText,
  contributionStatus,
  disputeStatus,
  eligibilityIndicatorStatus,
  fixtureStatus,
  invitationStatus,
  paymentStatus,
  resultStatus,
  rsvpStatus,
  teamEntryStatus,
} from '../status';
import { IDS, me, obligation, result, workspace } from '../testing/fixtures';

const NOW = new Date('2026-10-24T12:00:00.000Z');

describe('team status vocabulary (journeys.md section 3)', () => {
  it('SPK-COMP-004: team entry states, "Approved" never meaning paid or complete', () => {
    expect(teamEntryStatus({ status: 'applied', rejectionReason: null }).label).toBe(
      'Team entry awaiting approval',
    );
    expect(teamEntryStatus({ status: 'approved', rejectionReason: null }).label).toBe(
      'Team entry approved',
    );
    expect(teamEntryStatus({ status: 'rejected', rejectionReason: 'Division full' }).label).toBe(
      'Not approved: Division full',
    );
    expect(teamEntryStatus({ status: 'withdrawn', rejectionReason: null }).label).toBe('Withdrawn');
  });

  it('SPK-CAP-003: RSVP labels; a null answer is "No response"', () => {
    expect(rsvpStatus('available').label).toBe('Available');
    expect(rsvpStatus('tentative').label).toBe('Tentative');
    expect(rsvpStatus(null).label).toBe('No response');
    expect(
      availabilitySummaryText({ available: 2, unavailable: 0, tentative: 0, noResponse: 5 }),
    ).toBe('Available 2, Unavailable 0, No response 5');
    expect(
      availabilitySummaryText({ available: 2, unavailable: 0, tentative: 1, noResponse: 4 }),
    ).toBe('Available 2, Unavailable 0, Tentative 1, No response 4');
  });

  it('fixture states, never readiness', () => {
    expect(fixtureStatus({ status: 'unscheduled', scheduledStart: null }).label).toBe(
      'Not yet scheduled',
    );
    expect(fixtureStatus({ status: 'played', scheduledStart: null }).label).toBe('Final');
    expect(fixtureStatus({ status: 'postponed', scheduledStart: null }).label).toBe('Postponed');
  });

  it('SPK-RESULT-001, SPK-RESULT-004: Provisional, Official, Corrected on <date>, replaced', () => {
    expect(resultStatus(result({ status: 'submitted' })).label).toBe('Provisional');
    expect(resultStatus(result()).label).toBe('Official');
    expect(resultStatus(result({ supersedesRevisionId: IDS.supersededResult })).label).toBe(
      'Corrected on Oct 23, 2026',
    );
    expect(
      resultStatus(result({ status: 'superseded', supersededAt: '2026-10-23T10:00:00.000Z' }))
        .label,
    ).toBe('Replaced by a correction on Oct 23, 2026');
  });

  it('SPK-RESULT-005: dispute states', () => {
    expect(disputeStatus({ status: 'submitted', decision: null }).label).toBe(
      'Disputed: under review',
    );
    expect(disputeStatus({ status: 'decided', decision: 'upheld' }).label).toBe('Dispute upheld');
  });

  it('invitations: "Open until <date>", never a membership', () => {
    expect(
      invitationStatus({ status: 'pending', expiresAt: '2026-10-31T12:00:00.000Z' }).label,
    ).toMatch(/^Open until /);
    expect(
      invitationStatus({ status: 'revoked', expiresAt: '2026-10-31T12:00:00.000Z' }).label,
    ).toBe('Revoked');
  });

  it('SPK-CAP-002: eligibility indicators read as reason codes in words only', () => {
    expect(
      eligibilityIndicatorStatus({
        status: 'ineligible',
        blocking: 1,
        warnings: 0,
        codes: ['suspended', 'roster_full'],
      })?.label,
    ).toBe('Not eligible: suspended, roster limit reached');
    expect(eligibilityIndicatorStatus(null)).toBeNull();
  });

  it('SPK-PAY-007: processing and unknown are never "paid" or "failed"', () => {
    expect(paymentStatus('processing').label).toBe('Payment processing');
    expect(paymentStatus('unknown').label).toBe(
      'Payment outcome being confirmed. Do not pay again.',
    );
    expect(paymentStatus('succeeded').label).toBe('Paid');
    expect(contributionStatus({ status: 'paid', paidAt: '2026-10-20T12:00:00.000Z' }).label).toBe(
      'Paid on Oct 20, 2026',
    );
  });

  it('every status has a distinct glyph tone, so it never relies on colour alone', () => {
    const tones = new Set([
      rsvpStatus('available').tone,
      rsvpStatus('unavailable').tone,
      rsvpStatus('tentative').tone,
      rsvpStatus(null).tone,
    ]);
    expect(tones.size).toBe(4);
  });
});

describe('money and formatting (SPK-PAY-001)', () => {
  it('formats minor units with the currency', () => {
    expect(formatMoney(12550, 'USD')).toBe('$125.50');
    expect(formatMoney(500, 'JPY')).toBe('¥500');
    expect(totalsLabel(obligation().totals)).toBe(
      'Team total $900.00, received $300.00, allocated $300.00, remaining $600.00',
    );
  });

  it('parses typed amounts into minor units, rejecting extra decimals and zero', () => {
    expect(parseMoneyInput('25', 'USD')).toBe(2500);
    expect(parseMoneyInput('25.5', 'USD')).toBe(2550);
    expect(parseMoneyInput('$25.50', 'USD')).toBe(2550);
    expect(parseMoneyInput('25.555', 'USD')).toBeNull();
    expect(parseMoneyInput('0', 'USD')).toBeNull();
    expect(parseMoneyInput('abc', 'USD')).toBeNull();
    expect(parseMoneyInput('500', 'JPY')).toBe(500);
    expect(parseMoneyInput('5.5', 'JPY')).toBeNull();
  });

  it('dates, positions and role words', () => {
    expect(formatDateOnly('2026-11-02')).toBe('Nov 2, 2026');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
    ]);
    expect(roleWords('league_manager')).toBe('League manager');
    expect(roleWords('unknown_role')).toBe('unknown role');
  });
});

describe('routes (§4.14)', () => {
  it('accept only record ids; nothing else reaches the API', () => {
    expect(idParam(IDS.entry.toUpperCase())).toBe(IDS.entry);
    expect(idParam([IDS.entry, 'x'])).toBe(IDS.entry);
    expect(idParam('Kim Junior')).toBeNull();
    expect(idParam(undefined)).toBeNull();
    expect(teamRoutes.renewEntry(IDS.entry)).toBe(`/team/new?renewFrom=${IDS.entry}`);
    expect(teamRoutes.dispute(IDS.entry, IDS.fixture)).toBe(
      `/team/${IDS.entry}/disputes/${IDS.fixture}`,
    );
  });

  it('builds the team invitation link for the link landing', () => {
    expect(teamInvitationLink(IDS.invitation, 'tok_1234567890abcdef')).toBe(
      `sportspark://link?to=team-invitation&id=${IDS.invitation}&token=tok_1234567890abcdef`,
    );
  });
});

describe('viewer (presentation only, SPK-CAP-002)', () => {
  it('follows the API role records and roster for the signed-in person', () => {
    const ws = workspace();
    expect(viewerOf(ws, IDS.me, NOW)).toEqual({
      personId: IDS.me,
      captainView: true,
      onRoster: true,
    });
    expect(viewerOf(ws, IDS.player2, NOW)).toEqual({
      personId: IDS.player2,
      captainView: false,
      onRoster: true,
    });
    // A pending join request is not on the roster.
    expect(viewerOf(ws, IDS.player3, NOW).onRoster).toBe(false);
    expect(viewerOf(ws, null, NOW).captainView).toBe(false);
  });

  it('an ended captain role no longer shows captain tools', () => {
    const ws = workspace({
      roles: [
        {
          id: IDS.operation,
          teamEntryId: IDS.entry,
          personId: IDS.me,
          role: 'captain',
          effectiveFrom: '2026-09-01T12:00:00.000Z',
          effectiveTo: '2026-10-01T12:00:00.000Z',
        },
      ],
    });
    expect(viewerOf(ws, IDS.me, NOW).captainView).toBe(false);
  });

  it('a guardian may answer only for children on the roster they hold register over', () => {
    const ws = workspace();
    expect(respondableChildren(ws, me(), NOW)).toEqual([]);
    expect(
      respondableChildren(
        ws,
        me({ authorities: [{ subjectPersonId: IDS.child, permissions: ['view'] }] }),
        NOW,
      ),
    ).toEqual([]);
    expect(
      respondableChildren(
        ws,
        me({ authorities: [{ subjectPersonId: IDS.child, permissions: ['register'] }] }),
        NOW,
      ).map((m) => m.personId),
    ).toEqual([IDS.child]);
  });
});

describe('opened teams (session list, SCR-C-21)', () => {
  beforeEach(() => resetOpenedTeamEntries());

  it('keeps ids per account, most recent first, and forgets on request', () => {
    rememberTeamEntry('account-a', IDS.entry);
    rememberTeamEntry('account-a', IDS.priorEntry);
    expect(openedTeamEntries('account-a')).toEqual([IDS.priorEntry, IDS.entry]);
    rememberTeamEntry('account-a', IDS.entry);
    expect(openedTeamEntries('account-a')).toEqual([IDS.entry, IDS.priorEntry]);
    rememberTeamEntry('account-b', IDS.newEntry);
    // Another account never sees these entries.
    expect(openedTeamEntries('account-b')).toEqual([IDS.newEntry]);
    forgetTeamEntry('account-a', IDS.priorEntry);
    forgetTeamEntry('account-a', IDS.priorEntry);
    expect(openedTeamEntries('account-a')).toEqual([IDS.entry]);
    // The same list object is returned while nothing changes (stable snapshot).
    expect(openedTeamEntries('account-a')).toBe(openedTeamEntries('account-a'));
  });
});

describe('development payment methods (DEC-019)', () => {
  // The release half is verified by scripts/check-release-bundle.mjs on the exported bundle
  // ("pm_fake_" and "Development payment:" must be absent).
  it('are offered in development builds', () => {
    expect(__DEV__).toBe(true);
    expect(DEV_CONTRIBUTION_PAYMENT_METHODS?.map((m) => m.token)).toContain('pm_fake_visa');
  });
});
