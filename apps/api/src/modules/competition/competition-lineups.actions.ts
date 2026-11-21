import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** League administration (§2.1 "League manager: divisions, entries, rosters, fixtures, results"). */
const LEAGUE_ADMINS: readonly StaffRole[] = [
  'league_manager',
  'general_manager',
  'system_administrator',
];

/**
 * The coach's team sheet (migration 0475; SPK-CAP-001 captain tools, SPK-CAP-003, SPK-UX-007,
 * SPK-RESULT-001). A side's captain (the team's coach) or league staff read the side's players
 * with their answers and minutes, keep the lineup, share it and record the side's game log. An
 * official holding an accepted assignment for the fixture (checked by the service through
 * ASSIGNMENT_CHECK_PORT, SPK-STAFF-002) reads the sides' game log scores for the match check.
 */
export const LineupActions = defineActions({
  readTeamSheet: {
    id: 'competition.read_team_sheet',
    description:
      "Read a side's players with their availability answers and season minutes, its lineup and game log (league staff or the side's captain)",
    staffRoles: LEAGUE_ADMINS,
    teamRole: 'captain',
    requirements: ['SPK-CAP-001', 'SPK-CAP-003'],
  },
  manageLineup: {
    id: 'competition.manage_lineup',
    description:
      "Save and share a side's lineup for a fixture (league staff or the side's captain)",
    staffRoles: LEAGUE_ADMINS,
    teamRole: 'captain',
    requirements: ['SPK-CAP-001', '§4.9'],
  },
  recordGameLog: {
    id: 'competition.record_game_log',
    description:
      "Record a side's game log: score, timeline and minutes played (league staff or the side's captain)",
    staffRoles: LEAGUE_ADMINS,
    teamRole: 'captain',
    requirements: ['SPK-UX-007', 'SPK-RESULT-001', '§4.9'],
  },
  readGameLogs: {
    id: 'competition.read_game_logs',
    description:
      "Read the sides' game log scores of a fixture for the match check (league staff, an accepted official, or a captain for their side)",
    staffRoles: [...LEAGUE_ADMINS, 'official'],
    teamRole: 'captain',
    requirements: ['SPK-RESULT-001', 'SPK-STAFF-005'],
  },
});
