import type { RuleSetContent, SportFormat } from '@sportspark/contracts';

/**
 * Proposed rule-set defaults per format. They exist so an operator can start from a complete,
 * valid rule set; every value is configuration pending the league manager's decision on
 * "Soccer formats and competition rules" (decision register DEC-002, policy POL-026/POL-032,
 * specification §6.6). Nothing here is hard-coded into evaluation: services read the season's
 * rule-set version (SPK-COMP-002 "Do not hard-code a universal indoor-soccer rule set").
 */
const BASE: Omit<
  RuleSetContent,
  | 'playersOnField'
  | 'rosterMin'
  | 'rosterMax'
  | 'matchLengthMinutes'
  | 'periods'
  | 'minimumPlayers'
  | 'substitutions'
  | 'cards'
  | 'forfeit'
  | 'outdoor'
  | 'indoorBoarded'
  | 'futsal'
  | 'smallSidedOther'
> = {
  eligibilityReferenceDate: { rule: 'season_start' },
  multiTeamRestrictions: {
    maxEntriesPerSeason: 2,
    allowSameDivision: false,
    allowCrossDivision: true,
  },
  scoring: { win: 3, draw: 1, loss: 0, forfeitWin: 3, forfeitLoss: 0 },
  drawsAllowed: true,
  overtime: { enabled: false, periods: null, periodLengthMinutes: null, goldenGoal: false },
  shootout: { enabled: false, kicks: null },
  abandonment: { minimumMinutesForResult: null, policy: 'league_decision' },
  tiebreakers: [
    'points',
    'head_to_head',
    'goal_difference',
    'goals_for',
    'fair_play',
    'draw_of_lots',
  ],
  protestDeadlineHours: 48,
  resultApproval: {
    submitRoles: ['official', 'league_manager'],
    approveRoles: ['league_manager'],
    captainConfirmationRequired: false,
  },
  roster: {
    guestPlayersAllowed: true,
    guestMaxConcurrent: 3,
    substitutesAllowed: true,
    guestOrSubstituteRequiresApproval: false,
    // Proposed default: a co-captain does not satisfy captain checks (kernel TEAM_AUTHORITY_PORT).
    coCaptainMayActAsCaptain: false,
  },
};

export function proposedRuleSetContent(format: SportFormat): RuleSetContent {
  switch (format) {
    case 'outdoor':
      return {
        ...BASE,
        playersOnField: 11,
        rosterMin: 11,
        rosterMax: 22,
        matchLengthMinutes: 90,
        periods: 2,
        minimumPlayers: 7,
        substitutions: { unlimited: false, maxPerMatch: 5, rolling: false, reEntryAllowed: false },
        cards: {
          yellowAccumulationThreshold: 5,
          yellowAccumulationSuspensionMatches: 1,
          redCardSuspensionMatches: 1,
          secondYellowIsRed: true,
          sinBinMinutes: null,
        },
        forfeit: { scoreFor: 3, scoreAgainst: 0, graceMinutes: 15, minimumPlayersToStart: 7 },
        outdoor: { offside: true, throwIns: true },
        indoorBoarded: null,
        futsal: null,
        smallSidedOther: null,
      };
    case 'indoor_boarded':
      return {
        ...BASE,
        playersOnField: 6,
        rosterMin: 6,
        rosterMax: 16,
        matchLengthMinutes: 50,
        periods: 2,
        minimumPlayers: 4,
        substitutions: { unlimited: true, maxPerMatch: null, rolling: true, reEntryAllowed: true },
        cards: {
          yellowAccumulationThreshold: 4,
          yellowAccumulationSuspensionMatches: 1,
          redCardSuspensionMatches: 1,
          secondYellowIsRed: true,
          sinBinMinutes: 2,
        },
        forfeit: { scoreFor: 3, scoreAgainst: 0, graceMinutes: 10, minimumPlayersToStart: 4 },
        outdoor: null,
        indoorBoarded: { wallPlayAllowed: true, ceilingOutOfPlay: true, flySubstitutions: true },
        futsal: null,
        smallSidedOther: null,
      };
    case 'futsal':
      return {
        ...BASE,
        playersOnField: 5,
        rosterMin: 5,
        rosterMax: 14,
        matchLengthMinutes: 40,
        periods: 2,
        minimumPlayers: 3,
        substitutions: { unlimited: true, maxPerMatch: null, rolling: true, reEntryAllowed: true },
        cards: {
          yellowAccumulationThreshold: 3,
          yellowAccumulationSuspensionMatches: 1,
          redCardSuspensionMatches: 1,
          secondYellowIsRed: true,
          sinBinMinutes: 2,
        },
        forfeit: { scoreFor: 5, scoreAgainst: 0, graceMinutes: 10, minimumPlayersToStart: 3 },
        outdoor: null,
        indoorBoarded: null,
        futsal: {
          accumulatedFoulsLimit: 5,
          secondPenaltySpot: true,
          kickIns: true,
          timeoutsPerHalf: 1,
        },
        smallSidedOther: null,
      };
    case 'small_sided_other':
      return {
        ...BASE,
        playersOnField: 7,
        rosterMin: 7,
        rosterMax: 16,
        matchLengthMinutes: 60,
        periods: 2,
        minimumPlayers: 5,
        substitutions: { unlimited: true, maxPerMatch: null, rolling: true, reEntryAllowed: true },
        cards: {
          yellowAccumulationThreshold: 4,
          yellowAccumulationSuspensionMatches: 1,
          redCardSuspensionMatches: 1,
          secondYellowIsRed: true,
          sinBinMinutes: 2,
        },
        forfeit: { scoreFor: 3, scoreAgainst: 0, graceMinutes: 10, minimumPlayersToStart: 5 },
        outdoor: null,
        indoorBoarded: null,
        futsal: null,
        smallSidedOther: { description: '7v7 small-sided', offside: false, boards: false },
      };
  }
}

/** Team invitation lifetime when the inviter gives none (proposed default; no messaging provider yet, §5.2). */
export const TEAM_INVITATION_DEFAULT_HOURS = 24 * 7;
/** Upcoming fixtures shown in the captain workspace. */
export const WORKSPACE_UPCOMING_FIXTURES = 20;
