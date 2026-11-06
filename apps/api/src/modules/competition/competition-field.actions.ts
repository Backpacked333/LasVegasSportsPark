import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** League administration (§2.1 "League manager: divisions, entries, rosters, fixtures, results"). */
const LEAGUE_ADMINS: readonly StaffRole[] = [
  'league_manager',
  'general_manager',
  'system_administrator',
];

/**
 * Competition actions for placement and field-side work (migrations 0464 to 0466). Player
 * profiles are staff-only (SPK-PLACE-005: no public profiles, operator-mediated placement): no
 * customer basis reads or writes them. Attendance is recorded at the field by league staff, an
 * official holding an accepted assignment for the fixture (checked by the service through
 * ASSIGNMENT_CHECK_PORT, SPK-STAFF-002), or a captain for their own side.
 */
export const FieldActions = defineActions({
  readPlayerProfiles: {
    id: 'competition.read_player_profiles',
    description:
      'Read staff player profiles (position, skill rating) and team balance for placement (staff only)',
    staffRoles: [...LEAGUE_ADMINS, 'program_manager'],
    requirements: ['SPK-PLACE-002', 'SPK-PLACE-005'],
  },
  recordPlayerProfile: {
    id: 'competition.record_player_profile',
    description: 'Record or change a player’s staff position and skill rating for a season',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-PLACE-002', 'SPK-PLACE-005', '§4.9'],
  },
  readFixtureAttendance: {
    id: 'competition.read_fixture_attendance',
    description:
      'Read player check-in of a fixture (league staff, an accepted official, or a captain of the side)',
    staffRoles: [...LEAGUE_ADMINS, 'official'],
    teamRole: 'captain',
    requirements: ['SPK-UX-007', 'SPK-STAFF-005'],
  },
  recordFixtureAttendance: {
    id: 'competition.record_fixture_attendance',
    description:
      'Mark a rostered player present or absent at the field (league staff, an accepted official, or a captain of the side)',
    staffRoles: [...LEAGUE_ADMINS, 'official'],
    teamRole: 'captain',
    requirements: ['SPK-UX-007', 'SPK-STAFF-005', 'SPK-CAP-003'],
  },
  readResultsAwaiting: {
    id: 'competition.read_results_awaiting',
    description: 'Read fixtures played without a result, with suggested forfeits (league staff)',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-RESULT-001', 'SPK-RESULT-002', 'SPK-UX-006'],
  },
  remindResult: {
    id: 'competition.remind_result',
    description: 'Remind the captains of a fixture that its result is missing (league staff)',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-RESULT-001', 'SPK-UX-006'],
  },
});
