import { defineActions } from '../../kernel';

/**
 * Facilities actions (specification §2.1 roles, §3.17, docs/package-a/permission-matrix.md C.10).
 * Any staff member may report an issue; the facilities operator owns assignment, restrictions,
 * inspections and releases, with the general manager as the second release authority
 * (SPK-FAC-004 "authorized release"). Customers hold no facilities authority.
 */
export const FacilitiesActions = defineActions({
  manageAsset: {
    id: 'facilities.manage_asset',
    description: 'Register, edit and retire maintainable assets',
    staffRoles: ['facilities_operator', 'system_administrator'],
    requirements: ['SPK-FAC-001'],
  },
  reportIssue: {
    id: 'facilities.report_issue',
    description: 'Report a maintenance issue with severity and supporting evidence (any staff)',
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
      'coach',
      'official',
    ],
    requirements: ['SPK-FAC-002'],
  },
  manageMaintenanceTask: {
    id: 'facilities.manage_maintenance_task',
    description: 'Assign an owner, set due dates, start, resolve and close maintenance tasks',
    staffRoles: ['facilities_operator', 'general_manager'],
    requirements: ['SPK-FAC-002', 'SPK-FAC-004'],
  },
  applyRestriction: {
    id: 'facilities.apply_restriction',
    description:
      'Propose and approve an operating restriction that closes the affected area through the scheduling authority',
    staffRoles: ['facilities_operator', 'general_manager'],
    requirements: ['SPK-FAC-003', 'SPK-AT-021'],
  },
  recordInspection: {
    id: 'facilities.record_inspection',
    description: 'Record an inspection outcome for a maintenance task',
    staffRoles: ['facilities_operator'],
    requirements: ['SPK-FAC-002', 'SPK-FAC-004'],
  },
  releaseToService: {
    id: 'facilities.release_to_service',
    description: 'Authorized release of a restricted area back to service (lifts the closure)',
    staffRoles: ['facilities_operator', 'general_manager'],
    requirements: ['SPK-FAC-004', 'SPK-AT-021'],
  },
  schedulePreventiveMaintenance: {
    id: 'facilities.schedule_preventive_maintenance',
    description:
      'Create preventive maintenance schedules that materialize future tasks and restrictions',
    staffRoles: ['scheduler', 'facilities_operator'],
    requirements: ['SPK-FAC-005'],
  },
  viewMaintenance: {
    id: 'facilities.view_maintenance',
    description: 'View assets, maintenance tasks, inspections, restrictions and operating status',
    staffRoles: [
      'front_desk',
      'league_manager',
      'program_manager',
      'scheduler',
      'facilities_operator',
      'general_manager',
      'system_administrator',
      'support_operator',
    ],
    requirements: ['SPK-FAC-002', 'SPK-UX-006'],
  },
});
