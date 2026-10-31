import type {
  AccessDevice,
  AccessPolicy,
  AccessScheduleWindow,
  DeviceCommand,
} from '@sportspark/contracts';
import type { AccessDevicesTable, AccessPoliciesTable, DeviceCommandsTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import { actorOf, iso, isoOrNull } from './entry.shared';

/**
 * Access hardware rows and their API shapes (ENT-05; §3.16 Access hardware). Pass references are
 * never stored: a revocation command names the pass and is sent the reference's hash only.
 */
export type AccessDeviceRow = Selectable<AccessDevicesTable>;
export type AccessPolicyRow = Selectable<AccessPoliciesTable>;
export type DeviceCommandRow = Selectable<DeviceCommandsTable>;

/** Exceptions the hardware work raises (owner: the facilities operator queue). */
export const DEVICE_OFFLINE = 'entry.device_offline';
export const DEVICE_COMMAND_UNDELIVERED = 'entry.device_command_undelivered';
export const UNREGISTERED_ACCESS_DEVICE = 'entry.unregistered_access_device';
export const HARDWARE_QUEUE = 'facilities_operator';

/** Periodic jobs (K-06, IF-24). */
export const DELIVER_DEVICE_COMMANDS_JOB = 'entry.deliver_device_commands';
export const DETECT_DEVICE_OUTAGES_JOB = 'entry.detect_device_outages';

/** The policy as a device receives it: what it admits and when, in the facility's local time. */
export interface PolicySnapshot {
  policyId: string;
  allowedHolderKinds: Array<'person' | 'household'>;
  allowedPassStatuses: Array<'active'>;
  schedule: AccessScheduleWindow[];
  timezone: string;
}

export function toAccessDevice(row: AccessDeviceRow, activePolicyId: string | null): AccessDevice {
  return {
    id: row.id,
    facilityId: row.facility_id,
    kind: row.kind,
    name: row.name,
    providerDeviceRef: row.provider_device_ref,
    status: row.status,
    health: row.health,
    heartbeatTimeoutSeconds: row.heartbeat_timeout_seconds,
    lastHeartbeatAt: isoOrNull(row.last_heartbeat_at),
    registeredAt: iso(row.registered_at),
    retiredAt: isoOrNull(row.retired_at),
    retiredReason: row.retired_reason,
    activePolicyId,
    registeredBy: actorOf(row.registered_by),
    revision: row.revision,
  };
}

export function toAccessPolicy(row: AccessPolicyRow): AccessPolicy {
  return {
    id: row.id,
    deviceId: row.device_id,
    facilityId: row.facility_id,
    allowedHolderKinds: [...row.allowed_holder_kinds],
    allowedPassStatuses: [...row.allowed_pass_statuses],
    schedule: row.schedule as AccessScheduleWindow[],
    status: row.status,
    authoredByPersonId: row.authored_by_person_id,
    approvedByPersonId: row.approved_by_person_id,
    approvedAt: isoOrNull(row.approved_at),
    retiredAt: isoOrNull(row.retired_at),
    retiredReason: row.retired_reason,
    createdAt: iso(row.created_at),
    revision: row.revision,
  };
}

export function toDeviceCommand(row: DeviceCommandRow): DeviceCommand {
  return {
    id: row.id,
    deviceId: row.device_id,
    kind: row.kind,
    passId: row.pass_id,
    policyId: row.policy_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    lastAttemptAt: isoOrNull(row.last_attempt_at),
    deliveredAt: isoOrNull(row.delivered_at),
    createdAt: iso(row.created_at),
    revision: row.revision,
  };
}
