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
  viewCapabilities: {
    id: 'core.view_capabilities',
    description: "Read the organization's capability switches and their applicability decisions",
    staffRoles: ['general_manager', 'system_administrator'],
    requirements: ['§1.6', '§6.5', 'DEC-016'],
  },
  manageCapabilities: {
    id: 'core.manage_capabilities',
    description:
      'Enable or disable a capability for the organization, naming its applicability decision',
    staffRoles: ['system_administrator'],
    requirements: ['§1.6', '§6.5', 'DEC-016'],
  },
});
