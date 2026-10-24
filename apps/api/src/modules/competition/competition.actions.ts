import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** League administration (§2.1 "League manager: divisions, entries, rosters, fixtures"). */
const LEAGUE_ADMINS: readonly StaffRole[] = [
  'league_manager',
  'general_manager',
  'system_administrator',
];
/** Staff who read competition records while assisting customers or running operations. */
const COMPETITION_READERS: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'finance_operator',
  'facilities_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
  'coach',
  'official',
];
/** Staff who may open a team entry workspace (rosters are customer-private, SPK-CAP-002). */
const TEAM_ENTRY_READERS: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'finance_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
  'coach',
];

/**
 * Competition actions, part 1 (§3.4, §3.5, §4.4). Customer-side authority is a team role on the
 * season entry (`teamRole`), the person themselves (`allowSelf`) or an explicit guardian grant
 * (`subjectPermission`); never a label (SPK-IAM-001 "Team role").
 */
export const CompetitionActions = defineActions({
  manageCompetitions: {
    id: 'competition.manage_competitions',
    description: 'Create and edit competitions, rule-set versions, seasons and divisions',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-COMP-001', 'SPK-COMP-002', 'SPK-COMP-003'],
  },
  readCompetitions: {
    id: 'competition.read_competitions',
    description: 'Read competitions, rule sets, seasons, divisions and season fixture lists',
    staffRoles: COMPETITION_READERS,
    allowSelf: true,
    requirements: ['SPK-COMP-001', 'SPK-CAP-001'],
  },
  createTeamEntry: {
    id: 'competition.create_team_entry',
    description: 'Create a season team entry for a new team (captain or staff)',
    staffRoles: [...LEAGUE_ADMINS, 'front_desk'],
    allowSelf: true,
    requirements: ['SPK-CAP-001', 'SPK-COMP-001', 'SPK-AT-002'],
  },
  renewTeamEntry: {
    id: 'competition.renew_team_entry',
    description:
      'Renew a prior season entry into a new season (captain of the prior entry or staff)',
    staffRoles: [...LEAGUE_ADMINS, 'front_desk'],
    teamRole: 'captain',
    requirements: ['SPK-CAP-005', 'SPK-COMP-001', 'SPK-AT-003'],
  },
  approveTeamEntry: {
    id: 'competition.approve_team_entry',
    description: 'Approve, place or reject a season team entry',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-COMP-004'],
  },
  withdrawTeamEntry: {
    id: 'competition.withdraw_team_entry',
    description: 'Withdraw a season team entry (captain or staff)',
    staffRoles: LEAGUE_ADMINS,
    teamRole: 'captain',
    requirements: ['SPK-COMP-004'],
  },
  listTeamEntries: {
    id: 'competition.list_team_entries',
    description: 'List the entries of a season with what is missing and who can resolve it',
    staffRoles: TEAM_ENTRY_READERS,
    requirements: ['SPK-COMP-004'],
  },
  readTeamEntry: {
    id: 'competition.read_team_entry',
    description:
      'Open a team entry workspace: staff, a role holder, a roster player, or a guardian with view',
    staffRoles: TEAM_ENTRY_READERS,
    allowSelf: true,
    subjectPermission: 'view',
    teamRole: 'member',
    requirements: ['SPK-CAP-001', 'SPK-CAP-002', '§4.10'],
  },
  manageTeam: {
    id: 'competition.manage_team',
    description: 'Edit the continuing team identity (captain of a live entry or staff)',
    staffRoles: LEAGUE_ADMINS,
    teamRole: 'captain',
    requirements: ['§4.5', 'SPK-CAP-001'],
  },
  invitePlayer: {
    id: 'competition.invite_player',
    description: 'Invite a prospective team member (captain or staff)',
    staffRoles: [...LEAGUE_ADMINS, 'front_desk'],
    teamRole: 'captain',
    requirements: ['SPK-CAP-001', 'SPK-CAP-002', '§4.8'],
  },
  acceptTeamInvitation: {
    id: 'competition.accept_team_invitation',
    description: 'Accept a team invitation (the invited person or a guardian holding register)',
    staffRoles: [],
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-CAP-001', 'SPK-IAM-003'],
  },
  revokeTeamInvitation: {
    id: 'competition.revoke_team_invitation',
    description: 'Revoke a pending team invitation (captain or staff)',
    staffRoles: [...LEAGUE_ADMINS, 'front_desk'],
    teamRole: 'captain',
    requirements: ['SPK-CAP-001'],
  },
  requestToJoin: {
    id: 'competition.request_to_join',
    description: 'Request to join a team (the player or a guardian holding register)',
    staffRoles: ['front_desk', 'league_manager'],
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-CAP-001', 'SPK-IAM-003'],
  },
  decideJoinRequest: {
    id: 'competition.decide_join_request',
    description: 'Approve or decline a join request (captain or staff)',
    staffRoles: LEAGUE_ADMINS,
    teamRole: 'captain',
    requirements: ['SPK-CAP-001'],
  },
  manageRoster: {
    id: 'competition.manage_roster',
    description: 'Add or remove roster players with effective dates (captain or staff)',
    staffRoles: LEAGUE_ADMINS,
    teamRole: 'captain',
    requirements: ['SPK-COMP-005', 'SPK-CAP-004', 'SPK-AT-013'],
  },
  manageFixtures: {
    id: 'competition.manage_fixtures',
    description: 'Create, schedule, reschedule, postpone and cancel fixtures',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['§4.4 Matches', 'SPK-FIX-005'],
  },
  readFixture: {
    id: 'competition.read_fixture',
    description: 'Read a fixture: staff, a roster player, or a guardian with view over one',
    staffRoles: COMPETITION_READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-CAP-001', '§4.10'],
  },
  respondAvailability: {
    id: 'competition.respond_availability',
    description: 'Record an RSVP for a fixture (the player, a guardian with register, or staff)',
    staffRoles: ['front_desk', 'league_manager', 'support_operator'],
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-CAP-003', '§4.8'],
  },
});
