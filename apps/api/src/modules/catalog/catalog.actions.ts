import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** Roles that configure programs, offerings and sessions (§2.1 program manager, league manager). */
const CATALOG_MANAGERS: readonly StaffRole[] = [
  'program_manager',
  'league_manager',
  'general_manager',
  'system_administrator',
];
/** Roles that read the catalog including drafts and staff details. */
const CATALOG_READERS: readonly StaffRole[] = [
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
];
/** Prices, taxes, discounts and rounding belong to finance (§6.6 "Prices, taxes, discounts, rounding"). */
const FINANCE: readonly StaffRole[] = [
  'finance_operator',
  'general_manager',
  'system_administrator',
];
/** Roles that may draft a policy version of any kind; approval is per kind (see policy actions). */
const POLICY_AUTHORS: readonly StaffRole[] = [
  'program_manager',
  'league_manager',
  'finance_operator',
  'general_manager',
  'system_administrator',
];
/** Staff who record assisted acknowledgments at the desk (SPK-REG-009); never as the signer. */
const ACKNOWLEDGMENT_STAFF: readonly StaffRole[] = [
  'front_desk',
  'program_manager',
  'league_manager',
  'system_administrator',
  'support_operator',
];

/**
 * Catalog actions (specification §3.2, §3.15, §4.4, §4.14). Customer-side authority appears only
 * on acknowledgments: `allowSelf` (an adult acknowledging for themselves) or `subjectPermission`
 * (a guardian holding `complete_forms` over the participant).
 */
export const CatalogActions = defineActions({
  managePrograms: {
    id: 'catalog.manage_programs',
    description: 'Create and update reusable program definitions',
    staffRoles: CATALOG_MANAGERS,
    requirements: ['SPK-CAT-001', 'SPK-YOUTH-001'],
  },
  readCatalog: {
    id: 'catalog.read_catalog',
    description: 'Read programs, offerings in any state, sessions, policies and prices (staff)',
    staffRoles: CATALOG_READERS,
    requirements: ['SPK-CAT-001', '§4.14'],
  },
  manageOfferings: {
    id: 'catalog.manage_offerings',
    description: 'Create, update, copy and archive offerings',
    staffRoles: CATALOG_MANAGERS,
    requirements: ['SPK-CAT-001', 'SPK-CAT-002', 'SPK-CAT-003', 'SPK-YOUTH-002'],
  },
  publishOffering: {
    id: 'catalog.publish_offering',
    description: 'Publish an offering after validating its required configuration',
    staffRoles: CATALOG_MANAGERS,
    requirements: ['SPK-CAT-004'],
  },
  manageRegistrationWindow: {
    id: 'catalog.manage_registration_window',
    description: 'Open, pause, resume and close registration (distinct from publication)',
    staffRoles: CATALOG_MANAGERS,
    requirements: ['SPK-CAT-004'],
  },
  manageSessions: {
    id: 'catalog.manage_sessions',
    description: 'Add and cancel offering sessions',
    staffRoles: [...CATALOG_MANAGERS, 'scheduler'],
    requirements: ['SPK-CAT-001', 'SPK-CAT-002'],
  },
  manageEntitlementDefinitions: {
    id: 'catalog.manage_entitlement_definitions',
    description: 'Define what participation a purchase grants',
    staffRoles: CATALOG_MANAGERS,
    requirements: ['§4.4', '§4.7 invariant 2'],
  },
  createPolicyVersion: {
    id: 'catalog.create_policy_version',
    description: 'Draft a new policy version',
    staffRoles: POLICY_AUTHORS,
    requirements: ['SPK-REG-002', 'SPK-PAY-003', '§4.4'],
  },
  approveParticipationPolicy: {
    id: 'catalog.approve_participation_policy',
    description: 'Approve or retire eligibility, waitlist, hold, approval and form policies',
    staffRoles: ['program_manager', 'league_manager'],
    requirements: ['SPK-REG-002', '§4.4', '§6.6'],
  },
  approveFinancialPolicy: {
    id: 'catalog.approve_financial_policy',
    description:
      'Approve or retire cancellation, refund, discount, overpayment, installment, booking terms and tax or fee policies',
    staffRoles: ['finance_operator'],
    requirements: ['SPK-PAY-003', 'SPK-COND-003', '§4.4', '§6.6'],
  },
  recordAcknowledgment: {
    id: 'catalog.record_acknowledgment',
    description:
      'Record a policy acknowledgment: the adult subject, a guardian holding complete_forms, or staff recording a named signer',
    staffRoles: ACKNOWLEDGMENT_STAFF,
    allowSelf: true,
    subjectPermission: 'complete_forms',
    requirements: ['SPK-REG-009', 'SPK-IAM-003', '§4.4'],
  },
  withdrawAcknowledgment: {
    id: 'catalog.withdraw_acknowledgment',
    description: 'Withdraw an acknowledgment (staff or the signer)',
    staffRoles: ACKNOWLEDGMENT_STAFF,
    allowSelf: true,
    requirements: ['SPK-REG-009'],
  },
  readAcknowledgments: {
    id: 'catalog.read_acknowledgments',
    description: 'Read the acknowledgments recorded for a participant',
    staffRoles: CATALOG_READERS,
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-IAM-003', '§4.14'],
  },
  managePriceRules: {
    id: 'catalog.manage_price_rules',
    description: 'Create price rule versions for an offering',
    staffRoles: FINANCE,
    requirements: ['SPK-PAY-001', 'SPK-PAY-002', '§4.5'],
  },
  manageDiscounts: {
    id: 'catalog.manage_discounts',
    description: 'Create, update and retire discount definitions',
    staffRoles: FINANCE,
    requirements: ['SPK-PAY-003'],
  },
  evaluateDiscounts: {
    id: 'catalog.evaluate_discounts',
    description: 'Explain the discounts a basket would receive (no redemption)',
    staffRoles: CATALOG_READERS,
    allowSelf: true,
    requirements: ['SPK-PAY-002', 'SPK-PAY-003'],
  },
});
