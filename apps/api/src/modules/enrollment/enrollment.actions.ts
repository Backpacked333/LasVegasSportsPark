import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** Staff who register, hold and review participation at the desk and in programs (§2.1). */
const REGISTRATION_STAFF: readonly StaffRole[] = [
  'front_desk',
  'program_manager',
  'league_manager',
  'general_manager',
  'system_administrator',
  'support_operator',
];
/** Program and league administration: approvals, overrides, placement, capacity (§6.6). */
const PROGRAM_ADMIN: readonly StaffRole[] = [
  'program_manager',
  'league_manager',
  'general_manager',
  'system_administrator',
];
/**
 * League administration places free agents: the roster addition goes through competition's
 * `competition.manage_roster`, which these roles hold (SPK-PLACE-002, DEC-031).
 */
const LEAGUE_ADMIN: readonly StaffRole[] = [
  'league_manager',
  'general_manager',
  'system_administrator',
];
/**
 * Staff who read participation records (never the public, SPK-PLACE-005). Coaches and officials
 * are not here: their view of participants is scoped to assignments (workforce), not the registry.
 */
const READERS: readonly StaffRole[] = [
  'front_desk',
  'program_manager',
  'league_manager',
  'scheduler',
  'finance_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
];

/**
 * Enrollment actions (specification §3.3, §3.6, §3.13, §4.14). Customer authority is always a
 * relationship permission over the participant (SPK-IAM-003): `register` to apply, hold, enroll,
 * transfer, cancel, waitlist, place and book; `view` to read. An adult acts for themselves
 * (`allowSelf`); a child never holds `pay` over themselves, which finance enforces at payment.
 */
export const EnrollmentActions = defineActions({
  apply: {
    id: 'enrollment.apply',
    description:
      'Submit a registration application for a participant (adult self, guardian with register, or staff assisting)',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-REG-001', 'SPK-REG-002', 'SPK-REG-009', 'SPK-IAM-003'],
  },
  readApplication: {
    id: 'enrollment.read_application',
    description: 'Read an application (staff, the participant, or a guardian holding view)',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-REG-003', '§4.14'],
  },
  withdrawApplication: {
    id: 'enrollment.withdraw_application',
    description: 'Withdraw an application',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-REG-003'],
  },
  overrideEligibility: {
    id: 'enrollment.override_eligibility',
    description: 'Override a failed eligibility evaluation with a recorded reason',
    staffRoles: PROGRAM_ADMIN,
    requirements: ['SPK-REG-002'],
  },
  reviewApplication: {
    id: 'enrollment.review_application',
    description: 'Accept or decline an application awaiting human review',
    staffRoles: PROGRAM_ADMIN,
    requirements: ['SPK-REG-007', 'SPK-REG-003'],
  },
  listApplications: {
    id: 'enrollment.list_applications',
    description: 'List applications of an offering (review queue)',
    staffRoles: READERS,
    requirements: ['SPK-REG-007'],
  },
  manageBasket: {
    id: 'enrollment.manage_basket',
    description: 'Open a household basket, add and remove lines, hold, release and complete it',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-REG-004', 'SPK-REG-005', 'SPK-REG-006', 'SPK-REG-009'],
  },
  readBasket: {
    id: 'enrollment.read_basket',
    description: 'Read a basket (staff or the household it belongs to)',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-REG-004', '§4.14'],
  },
  readEnrollment: {
    id: 'enrollment.read_enrollment',
    description: 'Read an enrollment (staff, the participant, or a guardian holding view)',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-REG-003', '§4.14'],
  },
  cancelEnrollment: {
    id: 'enrollment.cancel_enrollment',
    description: 'Cancel an enrollment under its cancellation policy',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-REG-010'],
  },
  completeEnrollment: {
    id: 'enrollment.complete_enrollment',
    description: 'Mark a confirmed enrollment completed',
    staffRoles: PROGRAM_ADMIN,
    requirements: ['§4.6', 'SPK-REG-003'],
  },
  transferEnrollment: {
    id: 'enrollment.transfer_enrollment',
    description: 'Preview and commit a transfer to another offering',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-REG-010', '§4.8'],
  },
  joinWaitlist: {
    id: 'enrollment.join_waitlist',
    description: 'Join or leave a waitlist, accept or decline an offer',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-REG-008', '§4.8'],
  },
  readWaitlist: {
    id: 'enrollment.read_waitlist',
    description: 'Read waitlist entries and offers',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-REG-008'],
  },
  manageWaitlist: {
    id: 'enrollment.manage_waitlist',
    description: 'List a waitlist and set priority (staff)',
    staffRoles: PROGRAM_ADMIN,
    requirements: ['SPK-REG-008'],
  },
  requestPlacement: {
    id: 'enrollment.request_placement',
    description: 'Record approved placement information for an individual registrant',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-PLACE-001'],
  },
  readPlacement: {
    id: 'enrollment.read_placement',
    description: 'Read a placement request (staff, the participant, or a guardian holding view)',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-PLACE-005'],
  },
  managePlacement: {
    id: 'enrollment.manage_placement',
    description: 'See candidates, propose, assign and release placements (operator-mediated)',
    staffRoles: LEAGUE_ADMIN,
    requirements: ['SPK-PLACE-002', 'SPK-PLACE-003', 'SPK-PLACE-005'],
  },
  bookSession: {
    id: 'enrollment.book_session',
    description: 'Book, confirm or cancel a session seat (pickup, trial, makeup)',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-PLACE-004', 'SPK-YOUTH-003', 'SPK-YOUTH-004'],
  },
  readSessionBooking: {
    id: 'enrollment.read_session_booking',
    description: 'Read session bookings',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-PLACE-004'],
  },
  issueMakeup: {
    id: 'enrollment.issue_makeup',
    description: 'Issue or revoke a makeup entitlement',
    staffRoles: [...PROGRAM_ADMIN, 'front_desk'],
    requirements: ['SPK-YOUTH-004'],
  },
  redeemMakeup: {
    id: 'enrollment.redeem_makeup',
    description: 'Redeem a makeup entitlement into a session booking',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-YOUTH-004', 'SPK-AT-020'],
  },
  readMakeup: {
    id: 'enrollment.read_makeup',
    description: 'Read a makeup entitlement and its redemption history',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-YOUTH-004'],
  },
  recordTrial: {
    id: 'enrollment.record_trial',
    description: 'Record a trial participation, its outcome and its conversion basket',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-YOUTH-003', 'SPK-AT-019'],
  },
  readTrial: {
    id: 'enrollment.read_trial',
    description: 'Read a trial participation',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-YOUTH-003'],
  },
  manageCapacity: {
    id: 'enrollment.manage_capacity',
    description: 'Create, resize and sync capacity pools (staffing changes need a reason)',
    staffRoles: PROGRAM_ADMIN,
    requirements: ['SPK-REG-005', 'SPK-YOUTH-002'],
  },
  readCapacity: {
    id: 'enrollment.read_capacity',
    description: 'Read capacity pools and holds',
    staffRoles: READERS,
    requirements: ['SPK-REG-005'],
  },
  readFamilyCalendar: {
    id: 'enrollment.read_family_calendar',
    description: 'Read the family calendar of all authorized children',
    staffRoles: [],
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-YOUTH-007'],
  },

  // -------------------------------------------------------------------------------------------
  // Package G (§3.16; DEC-016). An action that creates a new commitment of a conditional
  // capability names it; reads, cancellations, reversals and suspensions never do. Rental and
  // party commands check `rentals` or `parties` by the offering's kind in their unit of work.
  // -------------------------------------------------------------------------------------------
  readPackageEntitlement: {
    id: 'enrollment.read_package_entitlement',
    description: 'Read session packages and their redemption history (ENR-11)',
    staffRoles: READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-COND-002'],
  },
  reversePackageRedemption: {
    id: 'enrollment.reverse_package_redemption',
    description:
      'Reverse a package redemption so its credit is returned (staff correction, never gated)',
    staffRoles: ['program_manager', 'front_desk', 'general_manager'],
    requirements: ['SPK-COND-002', 'SPK-AT-020'],
  },
  manageMembershipSuspension: {
    id: 'enrollment.manage_membership_suspension',
    description:
      'Suspend a membership for a period, end its suspension, or list its suspensions with their revisions (ENR-12, GAPS-TRIAGE-02, never gated)',
    staffRoles: ['program_manager', 'front_desk', 'general_manager'],
    requirements: ['SPK-COND-001'],
  },
  renewMembership: {
    id: 'enrollment.renew_membership',
    description: 'Add the renewal of a membership to a basket (charged only at checkout)',
    staffRoles: REGISTRATION_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    capability: 'memberships',
    requirements: ['SPK-COND-001'],
  },
  requestBooking: {
    id: 'enrollment.request_booking',
    description:
      'Request or book a rental or party with its space, equipment and staff (capability rentals or parties by kind)',
    staffRoles: ['front_desk', 'program_manager', 'scheduler', 'general_manager'],
    allowSelf: true,
    requirements: ['SPK-COND-003', 'SPK-REG-001'],
  },
  decideBooking: {
    id: 'enrollment.decide_booking',
    description:
      'Approve or decline a requested rental or party (approval mode; approval checks the capability)',
    staffRoles: ['program_manager', 'scheduler', 'general_manager'],
    requirements: ['SPK-COND-003', 'SPK-REG-007'],
  },
  readBooking: {
    id: 'enrollment.read_booking',
    description: 'Read rentals and parties (the booker, or staff in facility scope)',
    staffRoles: READERS,
    allowSelf: true,
    requirements: ['SPK-COND-003'],
  },
  manageAssessmentTemplate: {
    id: 'enrollment.manage_assessment_template',
    description: 'Draft and approve youth assessment templates (ENR-14)',
    staffRoles: ['program_manager'],
    capability: 'youth_progression',
    requirements: ['SPK-YOUTH-005'],
  },
  retireAssessmentTemplate: {
    id: 'enrollment.retire_assessment_template',
    description: 'Retire a youth assessment template (never gated)',
    staffRoles: ['program_manager'],
    requirements: ['SPK-YOUTH-005'],
  },
  authorAssessment: {
    id: 'enrollment.author_assessment',
    description:
      'Draft, edit and submit youth assessments (program managers, or a coach accepted on the offering)',
    staffRoles: ['program_manager', 'coach'],
    capability: 'youth_progression',
    requirements: ['SPK-YOUTH-005'],
  },
  withdrawAssessment: {
    id: 'enrollment.withdraw_assessment',
    description: 'Withdraw a draft or returned youth assessment (never gated)',
    staffRoles: ['program_manager', 'coach'],
    requirements: ['SPK-YOUTH-005'],
  },
  reviewAssessment: {
    id: 'enrollment.review_assessment',
    description:
      'Approve or return a submitted youth assessment (a program manager other than its author)',
    staffRoles: ['program_manager'],
    capability: 'youth_progression',
    requirements: ['SPK-YOUTH-005'],
  },
  readAssessments: {
    id: 'enrollment.read_assessments',
    description:
      "Read a participant's youth assessments (program managers in facility scope, coaches of their offerings)",
    staffRoles: ['program_manager', 'coach'],
    requirements: ['SPK-YOUTH-005'],
  },
  recommendProgression: {
    id: 'enrollment.recommend_progression',
    description:
      'Draft and share a progression recommendation (program managers, or a coach accepted on the from-offering)',
    staffRoles: ['program_manager', 'coach'],
    capability: 'youth_progression',
    requirements: ['SPK-YOUTH-006'],
  },
  withdrawRecommendation: {
    id: 'enrollment.withdraw_recommendation',
    description: 'Withdraw a progression recommendation (never gated)',
    staffRoles: ['program_manager', 'coach'],
    requirements: ['SPK-YOUTH-006'],
  },
  readYouthFeedback: {
    id: 'enrollment.read_youth_feedback',
    description:
      'Read published assessments and shared recommendations of the participants one may view',
    staffRoles: [],
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-YOUTH-005', 'SPK-YOUTH-006', 'SPK-COMMS-002'],
  },
});
