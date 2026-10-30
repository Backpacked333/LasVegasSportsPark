/**
 * Helpers of the team screens: status vocabulary from journeys.md section 3 (SPK-UX-004,
 * SPK-UX-010), money display and input in minor units (SPK-PAY-001), route ids (§4.14), the
 * presentation-only viewer from the workspace's `viewer` (SPK-CAP-002, CMP-02), facility time
 * zones (SPK-SCHED-008), and the development-only payment methods (DEC-019).
 */
import { DEV_CONTRIBUTION_PAYMENT_METHODS } from '../dev';
import {
  formatDateOnly,
  formatInstant,
  formatMoney,
  ordinal,
  parseMoneyInput,
  roleWords,
} from '../format';
import { teamInvitationLink } from '../InvitationIssued';
import { totalsLabel } from '../ObligationTotals';
import { currentLeaders, TEAM_ACTIONS, viewerOf } from '../queries';
import { handoverCandidates } from '../RoleHandover';
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
import { IDS, obligation, playerWorkspace, result, workspace } from '../testing/fixtures';

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

  it('SPK-SCHED-008: times in the facility’s zone when the API gives one, always named', () => {
    expect(formatInstant('2026-10-31T17:00:00.000Z', 'America/Los_Angeles')).toMatch(
      /^Sat, Oct 31, 10:00\sAM PDT$/,
    );
    // After the DST change the same zone is named PST.
    expect(formatInstant('2026-11-07T17:00:00.000Z', 'America/Los_Angeles')).toMatch(
      /9:00\sAM PST$/,
    );
    // An unknown zone falls back to the device's zone, still named, instead of failing.
    expect(formatInstant('2026-10-31T17:00:00.000Z', 'Not/AZone')).toBe(
      formatInstant('2026-10-31T17:00:00.000Z'),
    );
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
    expect(teamRoutes.pool(IDS.entry, IDS.pool)).toBe(`/team/${IDS.entry}/pools/${IDS.pool}`);
  });

  it('builds the team invitation link for the link landing', () => {
    expect(teamInvitationLink(IDS.invitation, 'tok_1234567890abcdef')).toBe(
      `sportspark://link?to=team-invitation&id=${IDS.invitation}&token=tok_1234567890abcdef`,
    );
  });
});

describe('viewer (presentation only, SPK-CAP-002, CMP-02)', () => {
  it('follows the workspace’s viewer and the roster for the signed-in person', () => {
    const ws = workspace();
    const captain = viewerOf(ws, IDS.me, NOW);
    expect(captain).toMatchObject({
      personId: IDS.me,
      captainView: true,
      actingAsCaptain: true,
      onRoster: true,
    });
    expect(captain.can(TEAM_ACTIONS.handoverRole)).toBe(true);
    const player = viewerOf(playerWorkspace(), IDS.player2, NOW);
    expect(player).toMatchObject({ captainView: false, actingAsCaptain: false, onRoster: true });
    expect(player.can(TEAM_ACTIONS.invite)).toBe(false);
    // A pending join request is not on the roster.
    expect(viewerOf(ws, IDS.player3, NOW).onRoster).toBe(false);
  });

  it('the management view follows the API, never a role record the app reads itself', () => {
    // The API says the viewer no longer acts as captain and fills no management lists.
    const ended = workspace({
      viewer: { roles: [], actingAsCaptain: false, availableActions: [] },
      pendingInvitations: null,
      pendingJoinRequests: null,
    });
    expect(viewerOf(ended, IDS.me, NOW).captainView).toBe(false);
    // A co-captain the rule set does not let act as captain still manages what the API lists.
    const coCaptain = workspace({
      viewer: { roles: ['co_captain'], actingAsCaptain: false, availableActions: [] },
    });
    expect(viewerOf(coCaptain, IDS.me, NOW).captainView).toBe(true);
    // ...but does not act as captain: what the API allows the captain only is not offered.
    expect(viewerOf(coCaptain, IDS.me, NOW).actingAsCaptain).toBe(false);
    expect(viewerOf(coCaptain, IDS.me, NOW).can(TEAM_ACTIONS.manageRoster)).toBe(false);
  });

  it('CMP-13: current leaders, and who could take a role (active roster members now)', () => {
    const ws = workspace();
    expect(currentLeaders(ws, NOW).map((r) => r.role)).toEqual(['captain']);
    expect(handoverCandidates(ws, 'captain', IDS.me, NOW).map((m) => m.displayName)).toEqual([
      'Pat Player',
      'Kim Junior',
    ]);
    const ended = workspace({
      roles: [{ ...ws.roles[0]!, effectiveTo: '2026-10-01T12:00:00.000Z' }],
    });
    expect(currentLeaders(ended, NOW)).toEqual([]);
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
