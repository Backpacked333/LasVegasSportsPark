import type { StaffRole } from '@sportspark/contracts';
import { defineActions } from '../../kernel';

/**
 * Entry actions (specification §3.14, §2.1 roles: the front desk handles arrival and attendance
 * support; coaches and officials record attendance for their assigned activities). Coach and
 * official actions are the `*Assigned` variants: the kernel checks the role and facility scope,
 * and the entry module additionally requires an accepted workforce assignment for the activity
 * (StaffScope). Records about a person (check-ins, attendance, releases) are protected: a caller
 * without authority receives NOT_FOUND (§4.10).
 */
const DESK: readonly StaffRole[] = [
  'front_desk',
  'program_manager',
  'league_manager',
  'general_manager',
];
const FIELD: readonly StaffRole[] = ['coach', 'official'];
const READERS: readonly StaffRole[] = [...DESK, 'support_operator'];
const PICKUP_DESK: readonly StaffRole[] = ['front_desk', 'program_manager', 'general_manager'];

export const EntryActions = defineActions({
  issuePass: {
    id: 'entry.issue_pass',
    description: 'Issue an opaque pass to a person (self) or a household (staff)',
    staffRoles: ['front_desk', 'program_manager', 'general_manager', 'system_administrator'],
    allowSelf: true,
    requirements: ['SPK-ENTRY-002'],
  },
  revokePass: {
    id: 'entry.revoke_pass',
    description: 'Revoke a pass (holder or staff)',
    staffRoles: ['front_desk', 'program_manager', 'general_manager', 'system_administrator'],
    allowSelf: true,
    requirements: ['SPK-ENTRY-002'],
  },
  scanPass: {
    id: 'entry.scan_pass',
    description: 'Scan a pass to open the arrival selection flow (records nobody as present)',
    staffRoles: DESK,
    requirements: ['SPK-ENTRY-002', 'SPK-ENTRY-003'],
  },
  recordArrival: {
    id: 'entry.record_arrival',
    description: 'Record facility arrivals for selected people and visitor categories',
    staffRoles: DESK,
    requirements: ['SPK-ENTRY-001', 'SPK-ENTRY-003', 'SPK-ENTRY-006'],
  },
  readVisits: {
    id: 'entry.read_visits',
    description: 'List the visits of a facility day',
    staffRoles: [...READERS, 'facilities_operator'],
    requirements: ['SPK-ENTRY-001'],
  },
  checkIn: {
    id: 'entry.check_in',
    description: 'Check a person into a session or event with actionable arrival issues',
    staffRoles: DESK,
    requirements: ['SPK-ENTRY-001', 'SPK-ENTRY-003', 'SPK-ENTRY-004', 'SPK-ENTRY-006'],
  },
  checkInAssigned: {
    id: 'entry.check_in_assigned',
    description: 'Check a person into an activity the coach or official is assigned to',
    staffRoles: FIELD,
    requirements: ['SPK-ENTRY-004', 'SPK-UX-007'],
  },
  readCheckin: {
    id: 'entry.read_checkin',
    description: 'Read a session check-in (staff, or a holder of view over the person)',
    staffRoles: READERS,
    subjectPermission: 'view',
    allowSelf: true,
    requirements: ['SPK-ENTRY-004', '§4.14'],
  },
  readAssignedCheckin: {
    id: 'entry.read_assigned_checkin',
    description: 'Read a check-in of an activity the coach or official is assigned to',
    staffRoles: FIELD,
    requirements: ['SPK-ENTRY-004', 'SPK-UX-007', '§4.14'],
  },
  recordAttendance: {
    id: 'entry.record_attendance',
    description: 'Record an attendance observation for any activity of the facility',
    staffRoles: DESK,
    requirements: ['§4.8', 'SPK-ENTRY-001', 'SPK-ENTRY-005'],
  },
  recordAssignedAttendance: {
    id: 'entry.record_assigned_attendance',
    description: 'Record attendance for an activity the coach or official is assigned to',
    staffRoles: FIELD,
    requirements: ['§4.8', 'SPK-UX-007'],
  },
  correctAttendance: {
    id: 'entry.correct_attendance',
    description: 'Correct an attendance observation (new row with actor, time and reason)',
    staffRoles: DESK,
    requirements: ['SPK-ENTRY-005', '§4.5'],
  },
  correctAssignedAttendance: {
    id: 'entry.correct_assigned_attendance',
    description: 'Correct an observation of an activity the coach or official is assigned to',
    staffRoles: FIELD,
    requirements: ['SPK-ENTRY-005'],
  },
  readAttendance: {
    id: 'entry.read_attendance',
    description: 'Read attendance (staff, or a holder of view over the person)',
    staffRoles: READERS,
    subjectPermission: 'view',
    allowSelf: true,
    requirements: ['SPK-ENTRY-005'],
  },
  readAssignedAttendance: {
    id: 'entry.read_assigned_attendance',
    description: 'Read attendance of an activity the coach or official is assigned to',
    staffRoles: FIELD,
    requirements: ['SPK-UX-007'],
  },
  recordDeparture: {
    id: 'entry.record_departure',
    description: 'Record a departure from the facility',
    staffRoles: DESK,
    requirements: ['SPK-ENTRY-001', 'SPK-ENTRY-008'],
  },
  voidVisit: {
    id: 'entry.void_visit',
    description: 'Void a mistaken arrival record (reason kept)',
    staffRoles: DESK,
    requirements: ['SPK-ENTRY-001'],
  },
  recordRelease: {
    id: 'entry.record_release',
    description: 'Record a supervised release after an online pickup authority check',
    staffRoles: PICKUP_DESK,
    requirements: ['§4.8', 'SPK-ENTRY-007', 'SPK-AT-016'],
  },
  recordAssignedRelease: {
    id: 'entry.record_assigned_release',
    description: 'Record a supervised release from an activity the coach is assigned to',
    staffRoles: ['coach'],
    requirements: ['SPK-ENTRY-007'],
  },
  readRelease: {
    id: 'entry.read_release',
    description: 'Read a release record (staff, or a holder of view over the child)',
    staffRoles: [...PICKUP_DESK, 'support_operator'],
    subjectPermission: 'view',
    requirements: ['SPK-ENTRY-007'],
  },
  syncOffline: {
    id: 'entry.sync_offline',
    description: 'Synchronize observations queued on an approved staff device',
    staffRoles: [...DESK, ...FIELD],
    requirements: ['§4.15', 'SPK-AT-018'],
  },
  readOccupancy: {
    id: 'entry.read_occupancy',
    description: 'Read arrivals, departures and occupancy status of a facility',
    staffRoles: [...READERS, 'facilities_operator', 'scheduler'],
    requirements: ['SPK-ENTRY-008'],
  },
  reconcileOccupancy: {
    id: 'entry.reconcile_occupancy',
    description: 'Record an occupancy snapshot (a physical count reconciles it)',
    staffRoles: ['front_desk', 'general_manager', 'facilities_operator'],
    requirements: ['SPK-ENTRY-008'],
  },
});

/** Desk roles: principals holding one act on any activity of their facility scope. */
export const DESK_ROLES = DESK;
