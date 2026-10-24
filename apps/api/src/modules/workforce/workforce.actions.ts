import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/**
 * Workforce actions (specification §3.10, permission matrix C.8 in
 * docs/package-a/permission-matrix.md). Customer-side authority is `allowSelf`: the person acting
 * on their own availability, evidence, assignment or fee. Assignment records are protected: a
 * caller who may not view them receives NOT_FOUND (§4.10).
 */
const ASSIGNERS: readonly StaffRole[] = [
  'league_manager',
  'program_manager',
  'scheduler',
  'general_manager',
];
const COVERAGE_READERS: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'general_manager',
  'support_operator',
];
const WORK_SUPERVISORS: readonly StaffRole[] = [
  'league_manager',
  'program_manager',
  'general_manager',
];

export const WorkforceActions = defineActions({
  manageOwnAvailability: {
    id: 'workforce.manage_own_availability',
    description: 'Maintain own availability windows',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-STAFF-001'],
  },
  manageAvailability: {
    id: 'workforce.manage_availability',
    description: 'Maintain availability windows for other people',
    staffRoles: WORK_SUPERVISORS,
    requirements: ['SPK-STAFF-001'],
  },
  readAvailability: {
    id: 'workforce.read_availability',
    description: 'Read availability windows (own, or staff planning coverage)',
    staffRoles: COVERAGE_READERS,
    allowSelf: true,
    requirements: ['SPK-STAFF-001'],
  },
  submitQualification: {
    id: 'workforce.submit_qualification',
    description: 'Submit own qualification evidence for verification',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-STAFF-001'],
  },
  manageQualification: {
    id: 'workforce.manage_qualification',
    description: 'Record, verify, reject or revoke qualification evidence',
    staffRoles: [...WORK_SUPERVISORS, 'system_administrator'],
    requirements: ['SPK-STAFF-001'],
  },
  readQualifications: {
    id: 'workforce.read_qualifications',
    description: 'Read qualification evidence (own, or staff)',
    staffRoles: [...COVERAGE_READERS, 'system_administrator'],
    allowSelf: true,
    requirements: ['SPK-STAFF-001'],
  },
  manageRequirements: {
    id: 'workforce.manage_requirements',
    description: 'Declare required roles, counts and qualifications for a target',
    staffRoles: ASSIGNERS,
    requirements: ['SPK-STAFF-001', 'SPK-STAFF-002'],
  },
  proposeAssignment: {
    id: 'workforce.propose_assignment',
    description:
      'Propose or offer an assignment, checking qualification, availability, overlapping commitments and turnaround',
    staffRoles: ASSIGNERS,
    requirements: ['SPK-STAFF-001', 'SPK-STAFF-002', 'SPK-STAFF-003'],
  },
  acceptAssignment: {
    id: 'workforce.accept_assignment',
    description: 'Accept an offered assignment (only the assignee, §4.8)',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-STAFF-002', 'SPK-STAFF-003', '§4.8'],
  },
  declineAssignment: {
    id: 'workforce.decline_assignment',
    description: 'Decline an offered assignment (only the assignee)',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-STAFF-002', 'SPK-AT-012'],
  },
  withdrawAssignment: {
    id: 'workforce.withdraw_assignment',
    description: 'Withdraw a proposed, offered or accepted assignment (staff or the assignee)',
    staffRoles: WORK_SUPERVISORS,
    allowSelf: true,
    requirements: ['SPK-STAFF-002', 'SPK-STAFF-003'],
  },
  completeAssignment: {
    id: 'workforce.complete_assignment',
    description: 'Mark accepted work completed',
    staffRoles: WORK_SUPERVISORS,
    requirements: ['SPK-STAFF-002', 'SPK-STAFF-006'],
  },
  triggerReplacement: {
    id: 'workforce.trigger_replacement',
    description: 'Find replacement candidates and offer the slot (absent official or coach)',
    // Scheduler added to the matrix proposal: it owns uncovered event and session slots.
    staffRoles: ['front_desk', ...ASSIGNERS],
    requirements: ['SPK-STAFF-003', 'SPK-AT-012'],
  },
  grantTemporaryAccess: {
    id: 'workforce.grant_temporary_access',
    description: 'Create temporary or substitute assignments that grant time-bounded staff access',
    staffRoles: ['league_manager', 'program_manager', 'system_administrator'],
    requirements: ['SPK-STAFF-004'],
  },
  viewAssignments: {
    id: 'workforce.view_assignments',
    description: 'Read assignments and coverage (staff), or own assignments (assignee)',
    staffRoles: COVERAGE_READERS,
    allowSelf: true,
    requirements: ['SPK-STAFF-002', 'SPK-UX-006', 'SPK-UX-007'],
  },
  submitFee: {
    id: 'workforce.submit_fee',
    description: 'Submit hours or a fee against own completed assignment',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-STAFF-006'],
  },
  readFees: {
    id: 'workforce.read_fees',
    description: 'Read fee submissions (finance, or the assignee)',
    staffRoles: ['finance_operator', 'general_manager'],
    allowSelf: true,
    requirements: ['SPK-STAFF-006'],
  },
  approveFee: {
    id: 'workforce.approve_fee',
    description: 'Approve, adjust or reject a fee submission (adjustments append history)',
    staffRoles: ['finance_operator', 'general_manager'],
    requirements: ['SPK-STAFF-006'],
  },
  exportFees: {
    id: 'workforce.export_fees',
    description: 'Export approved fees for payment administration (never payroll execution)',
    staffRoles: ['finance_operator'],
    requirements: ['SPK-STAFF-006', '§1.7'],
  },
});
