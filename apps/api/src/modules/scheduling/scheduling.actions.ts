import { defineActions } from '../../kernel';

/**
 * Scheduling actions (specification §2.1 roles, §3.7). The scheduler owns field inventory,
 * reservations, closures and publication; the facilities operator shares closures (SPK-FAC-003/005);
 * league and program managers schedule the events their records own through the scheduling port
 * and publish fixture drafts with the normal scheduling command (SPK-FIX-005).
 */
export const SchedulingActions = defineActions({
  readInventory: {
    id: 'scheduling.read_inventory',
    description: 'View resources, configurations, conflict units, operating hours and closures',
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
    requirements: ['SPK-SCHED-001'],
  },
  manageInventory: {
    id: 'scheduling.manage_inventory',
    description: 'Create and edit resources, configurations, conflict units and operating hours',
    staffRoles: ['scheduler', 'general_manager', 'system_administrator'],
    requirements: ['SPK-SCHED-001', 'SPK-SCHED-002'],
  },
  manageClosures: {
    id: 'scheduling.manage_closures',
    description: 'Create, apply and lift closures with their impact preview',
    staffRoles: ['scheduler', 'facilities_operator', 'general_manager', 'system_administrator'],
    requirements: ['SPK-SCHED-009', 'SPK-FAC-003', 'SPK-FAC-004', 'SPK-FAC-005'],
  },
  readSchedule: {
    id: 'scheduling.read_schedule',
    description: 'View events, reservations and availability for a facility',
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
    requirements: ['SPK-SCHED-003'],
  },
  readEvent: {
    id: 'scheduling.read_event',
    description:
      'View one event: staff in scope, a committed participant, or a guardian with view permission',
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
    allowSelf: true,
    subjectPermission: 'view',
    requirements: ['SPK-SCHED-003', '§4.10'],
  },
  manageEvents: {
    id: 'scheduling.manage_events',
    description:
      'Create, move and cancel events directly for an owning record (fixtures, sessions, rentals) and series',
    staffRoles: [
      'scheduler',
      'league_manager',
      'program_manager',
      'general_manager',
      'system_administrator',
    ],
    requirements: ['SPK-SCHED-003', 'SPK-SCHED-004', 'SPK-SCHED-007', 'SPK-SCHED-008'],
  },
  manageDrafts: {
    id: 'scheduling.manage_drafts',
    description: 'Open, autosave, validate and discard schedule drafts',
    staffRoles: [
      'scheduler',
      'league_manager',
      'program_manager',
      'general_manager',
      'system_administrator',
    ],
    requirements: ['SPK-SCHED-005'],
  },
  publishSchedule: {
    id: 'scheduling.publish_schedule',
    description: 'Publish a schedule draft as one atomic publication group',
    staffRoles: ['scheduler', 'league_manager', 'general_manager', 'system_administrator'],
    requirements: ['SPK-SCHED-006', 'SPK-FIX-005'],
  },
});
