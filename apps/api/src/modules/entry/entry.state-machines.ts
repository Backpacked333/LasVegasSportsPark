import { defineStateMachine } from '@sportspark/contracts';

/**
 * Entry lifecycles (§4.6 asks every command to define its allowed source state). The database
 * guards in migration 0800 (`passes_guard`, `visits_guard`, `session_checkins_guard`) refuse the
 * same transitions these machines refuse. Observations, departures, releases, offline batches and
 * occupancy snapshots are append-only facts and have no lifecycle.
 */

export type PassState = 'active' | 'revoked';
export type PassEvent = 'revoke';
export const PassMachine = defineStateMachine<PassState, PassEvent>({
  name: 'Pass',
  initial: 'active',
  states: ['active', 'revoked'],
  terminal: ['revoked'],
  transitions: { active: { revoke: 'revoked' }, revoked: {} },
});

export type VisitState = 'on_site' | 'departed' | 'voided';
export type VisitEvent = 'depart' | 'void';
export const VisitMachine = defineStateMachine<VisitState, VisitEvent>({
  name: 'Visit',
  initial: 'on_site',
  states: ['on_site', 'departed', 'voided'],
  terminal: ['departed', 'voided'],
  transitions: {
    on_site: { depart: 'departed', void: 'voided' },
    departed: {},
    voided: {},
  },
});

/**
 * A check-in starts `held` (blocking issues) or `admitted` (none). A held check-in is re-evaluated
 * until it is admitted or withdrawn; an admitted one can only be withdrawn.
 */
export type SessionCheckinState = 'held' | 'admitted' | 'withdrawn';
export type SessionCheckinEvent = 'admit' | 'reevaluate' | 'withdraw';
export const SessionCheckinMachine = defineStateMachine<SessionCheckinState, SessionCheckinEvent>({
  name: 'SessionCheckin',
  initial: 'held',
  states: ['held', 'admitted', 'withdrawn'],
  terminal: ['withdrawn'],
  transitions: {
    held: { admit: 'admitted', reevaluate: 'held', withdraw: 'withdrawn' },
    admitted: { withdraw: 'withdrawn' },
    withdrawn: {},
  },
});

// ---------------------------------------------------------------------------------------------
// Access hardware (ENT-05, migration 0805: `access_devices_guard`, `access_policies_guard`,
// `device_commands_guard` refuse the same transitions)
// ---------------------------------------------------------------------------------------------

export type AccessDeviceState = 'active' | 'retired';
export type AccessDeviceEvent = 'retire';
export const AccessDeviceMachine = defineStateMachine<AccessDeviceState, AccessDeviceEvent>({
  name: 'AccessDevice',
  initial: 'active',
  states: ['active', 'retired'],
  terminal: ['retired'],
  transitions: { active: { retire: 'retired' }, retired: {} },
});

/** A draft is approved (by someone other than its author) or withdrawn; an active one retires. */
export type AccessPolicyState = 'draft' | 'active' | 'retired';
export type AccessPolicyEvent = 'approve' | 'withdraw' | 'retire';
export const AccessPolicyMachine = defineStateMachine<AccessPolicyState, AccessPolicyEvent>({
  name: 'AccessPolicy',
  initial: 'draft',
  states: ['draft', 'active', 'retired'],
  terminal: ['retired'],
  transitions: {
    draft: { approve: 'active', withdraw: 'retired' },
    active: { retire: 'retired' },
    retired: {},
  },
});

/**
 * A device command is delivered, refused (`failed`) or lost (`unknown`: no answer, the device may
 * have applied it); failed and unknown commands are retried, and the device's receipt settles a
 * pending or unknown one. `supersede` (engineering addition to the ENT-05 plan) retires an
 * undelivered policy synchronization once a newer one is queued for the same device, so a retried
 * older sync never overwrites the newer policy.
 */
export type DeviceCommandState = 'pending' | 'delivered' | 'failed' | 'unknown' | 'superseded';
export type DeviceCommandEvent = 'deliver' | 'fail' | 'lose' | 'retry' | 'supersede';
export const DeviceCommandMachine = defineStateMachine<DeviceCommandState, DeviceCommandEvent>({
  name: 'DeviceCommand',
  initial: 'pending',
  states: ['pending', 'delivered', 'failed', 'unknown', 'superseded'],
  terminal: ['delivered', 'superseded'],
  transitions: {
    pending: { deliver: 'delivered', fail: 'failed', lose: 'unknown', supersede: 'superseded' },
    unknown: { deliver: 'delivered', fail: 'failed', retry: 'pending', supersede: 'superseded' },
    failed: { retry: 'pending', supersede: 'superseded' },
    delivered: {},
    superseded: {},
  },
});
