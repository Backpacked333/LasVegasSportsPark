import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/** Staff who assist customers (§2.1 front desk, support operator, general manager). */
const CASE_STAFF: readonly StaffRole[] = ['front_desk', 'support_operator', 'general_manager'];

/** Staff who work the Today workspace (the kernel's `exceptions.read` audience, SPK-UX-006). */
const OPERATIONS_STAFF: readonly StaffRole[] = [
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

/**
 * Support actions (specification §3.19, §2.3 SPK-UX-006). The timeline, staff case views and the
 * workspace are staff-only: no customer authority (`allowSelf`, `subjectPermission`) is granted on
 * them, so a customer — of any household — reading a timeline or a staff case receives NOT_FOUND
 * (§4.10). The one customer action is `support.request_support` (SUP-01): a customer contacts the
 * operating team about themselves, someone they view, or a team they captain, and reads only the
 * status of their own requests. Support never acts on another module's records itself; refunds,
 * resends and permission changes are the owning module's commands, run with the operator's
 * principal and that module's own authorization (SPK-SUPPORT-003).
 */
export const SupportActions = defineActions({
  readTimeline: {
    id: 'support.read_timeline',
    description:
      "Read a person's scoped customer timeline (registrations, orders, payments, changes, messages, cases)",
    staffRoles: CASE_STAFF,
    requirements: ['SPK-SUPPORT-001', 'SPK-SUPPORT-002', 'SPK-AT-026', '§4.14'],
  },
  openCase: {
    id: 'support.open_case',
    description: 'Open a support case with owner, category and related records',
    staffRoles: CASE_STAFF,
    requirements: ['SPK-SUPPORT-002'],
  },
  readCase: {
    id: 'support.read_case',
    description: 'Read support cases, their history and linked actions',
    staffRoles: CASE_STAFF,
    requirements: ['SPK-SUPPORT-002'],
  },
  workCase: {
    id: 'support.work_case',
    description: 'Edit, assign, note and move a support case through its lifecycle',
    staffRoles: CASE_STAFF,
    requirements: ['SPK-SUPPORT-002'],
  },
  linkAction: {
    id: 'support.link_action',
    description:
      'Link the outcome of an authorized command to a case, or run a helper command (resend, refund) with the operator principal',
    staffRoles: CASE_STAFF,
    requirements: ['SPK-SUPPORT-003'],
  },
  readToday: {
    id: 'support.read_today',
    description: 'Read the Today workspace feed within the viewer facility and queue scope',
    staffRoles: OPERATIONS_STAFF,
    requirements: ['SPK-UX-006', '§5.11'],
  },
  /**
   * SUP-01 (SPK-SUPPORT-002, SPK-CAP-001 "contact the operating team", SCR-C-22, SCR-C-38): a
   * customer opens a support request about themselves (self), someone they hold `view` over, or a
   * team entry they captain; staff open cases with `support.open_case` instead. Customer support
   * coverage is pending DEC-015.
   */
  requestSupport: {
    id: 'support.request_support',
    description:
      'Contact the operating team: open a support request about yourself, someone you view, or a team you captain, and read its status',
    staffRoles: [],
    allowSelf: true,
    subjectPermission: 'view',
    teamRole: 'captain',
    requirements: ['SPK-SUPPORT-002', 'SPK-CAP-001', 'SCR-C-22', 'SCR-C-38'],
  },
  manageQueues: {
    id: 'support.manage_queues',
    description: 'Define exception queues: owning roles and service levels',
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['SPK-UX-006', '§5.11'],
  },
});
