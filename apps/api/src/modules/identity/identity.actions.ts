import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** Staff roles that handle customer records at the desk or in program/league administration. */
const RECORD_STAFF: readonly StaffRole[] = [
  'front_desk',
  'program_manager',
  'league_manager',
  'system_administrator',
];
const SUPPORT_STAFF: readonly StaffRole[] = [...RECORD_STAFF, 'support_operator'];
const READ_STAFF: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'finance_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
];
/** Person search (ID-02, Proposed C.2): the record readers without scheduler. */
const LOOKUP_STAFF: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'finance_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
];
/** Authority, invitation and duplicate reads for staff (ID-03, ID-04, ID-05). */
const AUTHORITY_READERS: readonly StaffRole[] = [
  'front_desk',
  'program_manager',
  'league_manager',
  'support_operator',
  'general_manager',
  'system_administrator',
];
const READ_STAFF_DIRECTORY: readonly StaffRole[] = [
  'front_desk',
  'league_manager',
  'program_manager',
  'scheduler',
  'finance_operator',
  'facilities_operator',
  'general_manager',
  'system_administrator',
  'support_operator',
];
const REVIEW_DECIDERS: readonly StaffRole[] = [
  'general_manager',
  'system_administrator',
  'support_operator',
];

/**
 * Identity actions (specification §3.1, §4.14). Customer-side authority is never a role: it is
 * `allowSelf` (the person acting on their own record) or `subjectPermission` (an explicit grant).
 */
export const IdentityActions = defineActions({
  createPerson: {
    id: 'identity.create_person',
    description: 'Create a person record for the organization',
    staffRoles: RECORD_STAFF,
    requirements: ['SPK-IAM-001', 'SPK-IAM-002'],
  },
  createChildSelfService: {
    id: 'identity.create_child_self_service',
    description: 'An adult customer creates a child record they will be guardian of',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-IAM-001'],
  },
  readPerson: {
    id: 'identity.read_person',
    description: 'Read a person (self, guardians holding view, staff)',
    staffRoles: READ_STAFF,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-IAM-002', 'SPK-IAM-003'],
  },
  updatePerson: {
    id: 'identity.update_person',
    description: 'Update a person record (self, guardians holding register, staff)',
    staffRoles: SUPPORT_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-IAM-001', '§4.9'],
  },
  addContactPoint: {
    id: 'identity.add_contact_point',
    description: 'Add a contact point to a person',
    staffRoles: SUPPORT_STAFF,
    allowSelf: true,
    subjectPermission: 'register',
    requirements: ['SPK-IAM-001'],
  },
  manageAccount: {
    id: 'identity.manage_account',
    description: 'Provision, recover or disable login accounts',
    staffRoles: ['system_administrator', 'support_operator'],
    requirements: ['SPK-IAM-002', 'SPK-AT-025'],
  },
  createHousehold: {
    id: 'identity.create_household',
    description: 'Create a household grouping (never authority)',
    staffRoles: SUPPORT_STAFF,
    allowSelf: true,
    requirements: ['SPK-IAM-001', '§4.5'],
  },
  addHouseholdMember: {
    id: 'identity.add_household_member',
    description: 'Add a person to a household (staff, or a member holding view over the person)',
    staffRoles: SUPPORT_STAFF,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-IAM-001', '§4.5'],
  },
  createRelationship: {
    id: 'identity.create_relationship',
    description: 'Create a relationship and grants between two people',
    staffRoles: SUPPORT_STAFF,
    requirements: ['SPK-IAM-001', 'SPK-IAM-003'],
  },
  createRelationshipSelfService: {
    id: 'identity.create_relationship_self_service',
    description: 'An adult becomes guardian of a child record they created themselves',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-IAM-001', 'SPK-IAM-003'],
  },
  grantAccess: {
    id: 'identity.grant_access',
    description: 'Grant one permission on an existing relationship',
    staffRoles: SUPPORT_STAFF,
    requirements: ['SPK-IAM-003'],
  },
  revokeAccess: {
    id: 'identity.revoke_access',
    description:
      'Revoke a grant (staff, the grant holder, or the creator-guardian for a delegate they invited)',
    staffRoles: [
      'program_manager',
      'league_manager',
      'general_manager',
      'system_administrator',
      'support_operator',
    ],
    allowSelf: true,
    requirements: ['SPK-IAM-006'],
  },
  createInvitation: {
    id: 'identity.create_invitation',
    description:
      'Invite someone to hold permissions over a person or household (staff, or a guardian)',
    staffRoles: SUPPORT_STAFF,
    subjectPermission: 'view',
    requirements: ['SPK-IAM-004'],
  },
  acceptInvitation: {
    id: 'identity.accept_invitation',
    description: 'Accept an invitation addressed to oneself',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-IAM-004'],
  },
  revokeInvitation: {
    id: 'identity.revoke_invitation',
    description: 'Revoke a pending invitation (staff or the inviter)',
    staffRoles: SUPPORT_STAFF,
    allowSelf: true,
    requirements: ['SPK-IAM-004'],
  },
  issueClaim: {
    id: 'identity.issue_claim',
    description: 'Issue a claim token for a staff-created participant',
    staffRoles: SUPPORT_STAFF,
    requirements: ['SPK-IAM-002'],
  },
  revokeClaim: {
    id: 'identity.revoke_claim',
    description: 'Revoke a pending claim token (leaked, misdelivered or issued in error)',
    staffRoles: SUPPORT_STAFF,
    requirements: ['SPK-IAM-002', 'SPK-IAM-006'],
  },
  acceptClaim: {
    id: 'identity.accept_claim',
    description: 'Claim a staff-created participant with a verified account',
    staffRoles: [],
    requirements: ['SPK-IAM-002'],
  },
  manageStaffMembership: {
    id: 'identity.manage_staff_membership',
    description: 'Create, change or end staff role assignments',
    staffRoles: ['system_administrator'],
    requirements: ['§2.1', '§4.14'],
  },
  openAccessReview: {
    id: 'identity.open_access_review',
    description: 'Open a disputed-access review about a person',
    staffRoles: [...READ_STAFF],
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-IAM-005'],
  },
  readAccessReview: {
    id: 'identity.read_access_review',
    description: 'Read a disputed-access review',
    staffRoles: REVIEW_DECIDERS,
    requirements: ['SPK-IAM-005'],
  },
  decideAccessReview: {
    id: 'identity.decide_access_review',
    description: 'Record restrictions, escalation or decisions on an access review',
    staffRoles: REVIEW_DECIDERS,
    requirements: ['SPK-IAM-005'],
  },
  flagDuplicate: {
    id: 'identity.flag_duplicate',
    description: 'Flag two people as duplicate candidates',
    staffRoles: SUPPORT_STAFF,
    requirements: ['SPK-IAM-007'],
  },
  mergePersons: {
    id: 'identity.merge_persons',
    description: 'Merge a duplicate candidate pair',
    staffRoles: ['system_administrator'],
    requirements: ['SPK-IAM-007'],
  },
  dismissDuplicate: {
    id: 'identity.dismiss_duplicate',
    description: 'Dismiss a duplicate candidate',
    staffRoles: ['general_manager', 'system_administrator', 'support_operator'],
    requirements: ['SPK-IAM-007'],
  },
  // ------------------------------------------------------------------------------------------
  // Stage 3 reads and commands (ID-02..ID-08). Role sets are Proposed (permission matrix C.2).
  // ------------------------------------------------------------------------------------------
  lookupPerson: {
    id: 'identity.lookup_person',
    description: 'Search people by name prefix or exact contact (names only, never dates of birth)',
    staffRoles: LOOKUP_STAFF,
    requirements: ['SPK-IAM-002', 'SPK-IAM-003', '§4.14'],
  },
  readInvitations: {
    id: 'identity.read_invitations',
    description: "List a person's invitations for staff (the token is never returned)",
    staffRoles: AUTHORITY_READERS,
    requirements: ['SPK-IAM-004', '§4.10'],
  },
  declineInvitation: {
    id: 'identity.decline_invitation',
    description: 'Decline an invitation addressed to oneself',
    staffRoles: [],
    allowSelf: true,
    requirements: ['SPK-IAM-004'],
  },
  readAuthority: {
    id: 'identity.read_authority',
    description:
      "Read a person's relationships, grants, households, pending invitations and claims (staff)",
    staffRoles: AUTHORITY_READERS,
    requirements: ['SPK-IAM-001', 'SPK-IAM-003', 'SPK-IAM-005', 'SPK-IAM-006'],
  },
  readStaffMembership: {
    id: 'identity.read_staff_membership',
    description: 'List and read staff memberships (role assignments)',
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['§2.1', '§4.14'],
  },
  readStaffDirectory: {
    id: 'identity.read_staff_directory',
    description:
      'Read the staff directory: names, roles and facility scopes in effect (no contacts)',
    staffRoles: READ_STAFF_DIRECTORY,
    requirements: ['§2.1', '§4.14', 'SPK-UX-005'],
  },
  readWorkforceDirectory: {
    id: 'identity.read_workforce_directory',
    description: 'Include coaches and officials in the staff directory (staffing screens)',
    staffRoles: [
      'scheduler',
      'league_manager',
      'program_manager',
      'general_manager',
      'system_administrator',
    ],
    requirements: ['§2.1', '§4.14'],
  },
  readDuplicates: {
    id: 'identity.read_duplicates',
    description: 'List and read duplicate candidates with both names and detection signals',
    staffRoles: AUTHORITY_READERS,
    requirements: ['SPK-IAM-007'],
  },
  /** System-only (ID-07): the background sweep records an invitation's expiry. */
  expireInvitation: {
    id: 'identity.expire_invitation',
    description: 'Record that a pending invitation passed its expiry (background sweep)',
    staffRoles: [],
    requirements: ['SPK-IAM-004', '§4.12'],
  },
  /** System-only (ID-07): the background sweep records a claim's expiry. */
  expireClaim: {
    id: 'identity.expire_claim',
    description: 'Record that a pending claim passed its expiry (background sweep)',
    staffRoles: [],
    requirements: ['SPK-IAM-002', '§4.12'],
  },
  /** System-only (ID-08): a time-bounded restriction's window ended. */
  endRestrictionWindow: {
    id: 'identity.end_restriction_window',
    description: 'Record the end of a time-bounded access restriction when its window passes',
    staffRoles: [],
    requirements: ['SPK-IAM-005', '§4.6'],
  },
});
