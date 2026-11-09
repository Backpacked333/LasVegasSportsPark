import { defineActions } from './actions';

/**
 * The kernel's own actions (K-04, K-08, K-09, K-12). Role assignments are Proposed (permission
 * matrix C.1): reading settings, the audit log, the integration register and the capability
 * switches is for the general manager and system administration; provider events also for the
 * finance operator (reconciliation); changing a capability only for system administration.
 */
export const CoreActions = defineActions({
  viewSettings: {
    id: 'core.view_settings',
    description: 'Read the organization and facility settings with their revisions (read only)',
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['SPK-UX-005', '§2.1'],
  },
  viewAudit: {
    id: 'core.view_audit',
    description: 'Read audited privileged actions (the read is itself audited)',
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['§4.14'],
  },
  viewProviderEvents: {
    id: 'core.view_provider_events',
    description: 'Read provider events received by the inbox (never their payloads)',
    staffRoles: ['finance_operator', 'general_manager', 'system_administrator'],
    requirements: ['§4.12', '§4.14'],
  },
  viewIntegrations: {
    id: 'core.view_integrations',
    description: 'Read the integration register: provider gates, decisions and registered adapters',
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['§5.1', '§5.2'],
  },
  viewMetrics: {
    id: 'core.view_metrics',
    description:
      "Read the organization's operational signal snapshot: queue backlog, dead letters, job health, open exceptions",
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['§5.11', '§4.12'],
  },
  viewCapabilities: {
    id: 'core.view_capabilities',
    description: "Read the organization's capability switches and their applicability decisions",
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['§1.6', '§6.5', 'DEC-016'],
  },
  /**
   * R3-OPERATIONS-03 (§5.11 supported resolution actions, §4.12): re-run a dead-lettered outbox or
   * provider event once its cause is fixed. The general manager and system administration for any
   * queue; `replayOwnDeadLetter` for the queue of one's own staff role.
   */
  replayDeadLetter: {
    id: 'core.replay_dead_letter',
    description:
      'Replay a dead-lettered outbox or provider event once its cause is fixed (any queue; audited)',
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['§5.11', '§4.12', 'SPK-UX-006'],
  },
  /**
   * Allowed only when the principal holds the staff role the dead letter's failure owner names
   * (narrowed to that role, like `exceptions.manage_own_queue`).
   */
  replayOwnDeadLetter: {
    id: 'core.replay_own_dead_letter',
    description: "Replay a dead-lettered event in the queue of one's own staff role (audited)",
    staffRoles: [
      'front_desk',
      'league_manager',
      'program_manager',
      'scheduler',
      'finance_operator',
      'facilities_operator',
      'general_manager',
      'system_administrator',
      'support_operator',
    ],
    requirements: ['§5.11', '§4.12', 'SPK-UX-006'],
  },
  setDefaultCurrency: {
    id: 'core.set_default_currency',
    description:
      'Set the organization default currency screens use before a record names one (no record is converted)',
    staffRoles: ['system_administrator'],
    requirements: ['SPK-PAY-001', '§2.1'],
  },
  manageCapabilities: {
    id: 'core.manage_capabilities',
    description:
      'Enable or disable a capability for the organization, naming its applicability decision',
    staffRoles: ['system_administrator'],
    requirements: ['§1.6', '§6.5', 'DEC-016'],
  },
});
