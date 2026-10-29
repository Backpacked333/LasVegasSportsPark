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
/** ENT-05: access hardware is facility equipment (proposed roles, permission matrix C.1). */
const HARDWARE: readonly StaffRole[] = ['facilities_operator', 'general_manager'];

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
  readPass: {
    id: 'entry.read_pass',
    description: 'Read passes (the holder their own; desk staff any); the reference is never shown',
    staffRoles: ['front_desk', 'program_manager', 'general_manager', 'system_administrator'],
    allowSelf: true,
    requirements: ['SPK-ENTRY-002', 'SPK-UX-002', '§4.14'],
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
  readOfflineBatch: {
    id: 'entry.read_offline_batch',
    description:
      'Read a synchronized offline batch and its per-item outcomes (desk readers; the submitter reads its own)',
    staffRoles: READERS,
    requirements: ['§4.15', 'SPK-AT-018', 'SPK-UX-008'],
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
  // -------------------------------------------------------------------------------------------
  // Access hardware (ENT-05; §3.16 Access hardware, SPK-COND-004). Registering and editing devices
  // and drafting or approving policies create new commitments of the `access_hardware` capability
  // (DEC-016, DEC-080); retirements are never gated.
  // -------------------------------------------------------------------------------------------
  registerAccessDevice: {
    id: 'entry.register_access_device',
    description: 'Register an access device (sent deny-all until a policy is approved)',
    staffRoles: HARDWARE,
    capability: 'access_hardware',
    requirements: ['§3.16', 'SPK-COND-004'],
  },
  updateAccessDevice: {
    id: 'entry.update_access_device',
    description: 'Rename an access device or set its heartbeat timeout',
    staffRoles: HARDWARE,
    capability: 'access_hardware',
    requirements: ['§3.16'],
  },
  retireAccessDevice: {
    id: 'entry.retire_access_device',
    description: 'Retire an access device',
    staffRoles: HARDWARE,
    requirements: ['§3.16'],
  },
  draftAccessPolicy: {
    id: 'entry.draft_access_policy',
    description: 'Draft an access policy for a device (approved by another person)',
    staffRoles: HARDWARE,
    capability: 'access_hardware',
    requirements: ['§3.16', 'SPK-ENTRY-002'],
  },
  approveAccessPolicy: {
    id: 'entry.approve_access_policy',
    description: "Approve another person's drafted access policy and synchronize the device",
    staffRoles: HARDWARE,
    capability: 'access_hardware',
    requirements: ['§3.16'],
  },
  retireAccessPolicy: {
    id: 'entry.retire_access_policy',
    description: 'Retire or withdraw an access policy (deny-all without a replacement)',
    staffRoles: HARDWARE,
    requirements: ['§3.16'],
  },
  readAccessDevices: {
    id: 'entry.read_access_devices',
    description: 'Read access devices, their policies and command delivery',
    staffRoles: [...HARDWARE, 'front_desk'],
    requirements: ['§3.16'],
  },
});

/** Desk roles: principals holding one act on any activity of their facility scope. */
export const DESK_ROLES = DESK;
