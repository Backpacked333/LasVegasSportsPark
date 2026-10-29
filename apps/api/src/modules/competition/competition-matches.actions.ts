import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';
import { DISCIPLINE_MANAGER_ROLES } from './competition-matches.policy';

/** League administration (§2.1 "League manager: divisions, entries, rosters, fixtures, results"). */
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
/** Discipline records are restricted (SPK-DISC-004): league management only. */
const DISCIPLINE_MANAGERS = DISCIPLINE_MANAGER_ROLES;

/**
 * Competition actions, part 2 (§3.8, §3.9, §3.11, §3.12, §4.4 Matches and Discipline). Result
 * publication is the only path to an official result (§4.7 invariant 8): the static roles below
 * are the proposed default (DEC-065) and the season's rule set adds its `approveRoles` at call
 * time, so the authorization decision still runs through the kernel's single path.
 */
export const MatchActions = defineActions({
  submitResult: {
    id: 'competition.submit_result',
    description:
      'Submit a result revision: scores, classification, cards, incidents, abandonment (assigned official or league administration)',
    staffRoles: ['official', ...LEAGUE_ADMINS],
    requirements: ['SPK-STAFF-005', 'SPK-RESULT-001', 'SPK-RESULT-002', '§4.8'],
  },
  reviewResult: {
    id: 'competition.review_result',
    description: 'Return a submitted result for correction',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-RESULT-001'],
  },
  publishResult: {
    id: 'competition.publish_result',
    description:
      'Make an approved result official (publication authority: league manager plus the rule set approval roles)',
    staffRoles: ['league_manager'],
    requirements: ['SPK-RESULT-001', 'SPK-RESULT-004', '§4.7 (8)', 'SPK-AT-014', 'DEC-065'],
  },
  readResults: {
    id: 'competition.read_results',
    description: 'Read result revisions: staff, a roster player or a guardian with view',
    staffRoles: COMPETITION_READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-RESULT-001', '§4.10'],
  },
  readStandings: {
    id: 'competition.read_standings',
    description: 'Read official standings',
    staffRoles: COMPETITION_READERS,
    allowSelf: true,
    requirements: ['SPK-RESULT-001', 'SPK-RESULT-003'],
  },
  manageBrackets: {
    id: 'competition.manage_brackets',
    description: 'Create and publish bracket nodes',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['§4.4 Matches', 'SPK-RESULT-004'],
  },
  readBrackets: {
    id: 'competition.read_brackets',
    description: 'Read bracket nodes',
    staffRoles: COMPETITION_READERS,
    allowSelf: true,
    requirements: ['§4.4 Matches'],
  },
  manageFixtureSpecifications: {
    id: 'competition.manage_fixture_specifications',
    description: 'Define fixture specifications for a division',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-FIX-001', 'SPK-FIX-003'],
  },
  generateFixtures: {
    id: 'competition.generate_fixtures',
    description: 'Run the fixture generator and open the proposal as a scheduling draft',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-FIX-002', 'SPK-FIX-004', 'SPK-FIX-005', 'SPK-AT-010', 'SPK-AT-011'],
  },
  readReadiness: {
    id: 'competition.read_readiness',
    description:
      'Read the readiness assessment of a fixture (staff, roster players, guardians with view)',
    staffRoles: COMPETITION_READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-READY-001', 'SPK-READY-003', '§4.8'],
  },
  submitDispute: {
    id: 'competition.submit_dispute',
    description:
      'Submit a dispute on a fixture result (captain of a competing entry or league administration)',
    staffRoles: LEAGUE_ADMINS,
    teamRole: 'captain',
    requirements: ['SPK-RESULT-005'],
  },
  reviewDispute: {
    id: 'competition.review_dispute',
    description: 'Review, decide or withdraw a dispute',
    staffRoles: LEAGUE_ADMINS,
    requirements: ['SPK-RESULT-005'],
  },
  readDispute: {
    id: 'competition.read_dispute',
    description:
      'Read a dispute: league administration, support, or the captain of the submitting entry',
    staffRoles: [...LEAGUE_ADMINS, 'support_operator'],
    teamRole: 'captain',
    requirements: ['SPK-RESULT-005', '§4.10'],
  },
  reportIncident: {
    id: 'competition.report_incident',
    description: 'Record a restricted incident (officials and league management)',
    staffRoles: ['official', ...DISCIPLINE_MANAGERS],
    requirements: ['SPK-DISC-001', 'SPK-DISC-005', 'SPK-STAFF-005'],
  },
  readDiscipline: {
    id: 'competition.read_discipline',
    description: 'Read incidents with narratives, decisions, suspensions and appeals (restricted)',
    staffRoles: DISCIPLINE_MANAGERS,
    requirements: ['SPK-DISC-001', 'SPK-DISC-004'],
  },
  manageDiscipline: {
    id: 'competition.manage_discipline',
    description:
      'Issue decisions, propose/approve/overturn suspensions, review incidents and decide appeals',
    staffRoles: DISCIPLINE_MANAGERS,
    requirements: ['SPK-DISC-002', 'SPK-DISC-003', 'SPK-AT-013'],
  },
  readOwnDiscipline: {
    id: 'competition.read_own_discipline',
    description:
      'Read a decision, suspension or appeal about oneself or a child with view (no narratives)',
    staffRoles: DISCIPLINE_MANAGERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-DISC-002', '§4.10'],
  },
  /**
   * CMP-06 (SPK-UX-007, SPK-STAFF-002/005, §4.14): the field-limited match sheet. An official also
   * needs an accepted assignment for the fixture (proposed or offered ones do not count); a captain
   * of either side sees names and numbers only.
   */
  readMatchSheet: {
    id: 'competition.read_match_sheet',
    description:
      'Read the field-limited match sheet (league staff, an accepted official, or a captain of either side)',
    staffRoles: [...LEAGUE_ADMINS, 'official'],
    teamRole: 'captain',
    requirements: ['SPK-UX-007', 'SPK-STAFF-002', 'SPK-STAFF-005', '§4.14'],
  },
  /** CMP-12 (SPK-RESULT-005): the submitter, or a captain of the submitting entry, withdraws. */
  withdrawDispute: {
    id: 'competition.withdraw_dispute',
    description: 'Withdraw a dispute (its submitter or a captain of the submitting entry)',
    staffRoles: [],
    allowSelf: true,
    teamRole: 'captain',
    requirements: ['SPK-RESULT-005', '§4.6'],
  },
  /**
   * CMP-15 (§3.16 Tournaments): create pools and place or remove their entries. New pool
   * commitments need the organization's `tournaments` capability (DEC-016, DEC-078); reads and
   * seeding from existing pools are never gated.
   */
  managePools: {
    id: 'competition.manage_pools',
    description: 'Create tournament pools and change their entries (league administration)',
    staffRoles: LEAGUE_ADMINS,
    capability: 'tournaments',
    requirements: ['§3.16', 'SPK-COMP-001', 'DEC-078'],
  },
  submitAppeal: {
    id: 'competition.submit_appeal',
    description:
      'Appeal a decision, suspension or dispute outcome (the subject, a guardian with register, or league management)',
    staffRoles: DISCIPLINE_MANAGERS,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-DISC-002', 'SPK-RESULT-005'],
  },
});
