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
 * Support actions (specification §3.19, §2.3 SPK-UX-006). Support is staff-only: no customer
 * authority (`allowSelf`, `subjectPermission`) is granted, so a customer — of any household —
 * reading a timeline or case receives NOT_FOUND (§4.10). Support never acts on another module's
 * records itself; refunds, resends and permission changes are the owning module's commands, run
 * with the operator's principal and that module's own authorization (SPK-SUPPORT-003).
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
  manageQueues: {
    id: 'support.manage_queues',
    description: 'Define exception queues: owning roles and service levels',
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['SPK-UX-006', '§5.11'],
  },
});
