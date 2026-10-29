import {
  defineStateMachine,
  type DeliveryStatusValue,
  type NotificationStatusValue,
  type PushDeviceStatusValue,
} from '@sportspark/contracts';

/**
 * Communications lifecycles (§4.6 "each command must define its allowed source state"). The database
 * check constraints in migration 1000 list exactly these states; services only move through
 * `Machine.next`, so independent facts never overwrite one another (§4.6).
 */

// Notification: composed → queued → dispatched; composed/queued → suppressed (SPK-COMMS-005, invariant 10)
export type NotificationState = NotificationStatusValue;
export type NotificationEvent = 'queue' | 'dispatch' | 'suppress';
export const NotificationMachine = defineStateMachine<NotificationState, NotificationEvent>({
  name: 'Notification',
  initial: 'composed',
  states: ['composed', 'queued', 'dispatched', 'suppressed'],
  terminal: ['dispatched', 'suppressed'],
  transitions: {
    composed: { queue: 'queued', suppress: 'suppressed' },
    queued: { dispatch: 'dispatched', suppress: 'suppressed' },
    dispatched: {},
    suppressed: {},
  },
});

// Recipient: pending → authorized (at dispatch) | revoked; authorized → revoked only while nothing
// has been handed to an external channel (SPK-COMMS-003, SPK-AT-017).
export type RecipientState = 'pending' | 'authorized' | 'revoked';
export type RecipientEvent = 'authorize' | 'revoke';
export const RecipientMachine = defineStateMachine<RecipientState, RecipientEvent>({
  name: 'NotificationRecipient',
  initial: 'pending',
  states: ['pending', 'authorized', 'revoked'],
  terminal: ['revoked'],
  transitions: {
    pending: { authorize: 'authorized', revoke: 'revoked' },
    authorized: { revoke: 'revoked' },
    revoked: {},
  },
});

/**
 * Delivery attempt (SPK-COMMS-004): queued, provider accepted, delivered where confirmed, failed,
 * unknown, read, acknowledged. `deliver` is applied only by the platform for the in-app channel or by
 * a provider receipt: a push is never marked delivered on acceptance alone. `unknown` is resolved
 * only by a later receipt, never by the worker guessing.
 */
export type DeliveryState = DeliveryStatusValue;
export type DeliveryEvent = 'accept' | 'deliver' | 'fail' | 'lose_track' | 'read' | 'acknowledge';
export const DeliveryAttemptMachine = defineStateMachine<DeliveryState, DeliveryEvent>({
  name: 'DeliveryAttempt',
  initial: 'queued',
  states: ['queued', 'provider_accepted', 'delivered', 'failed', 'unknown', 'read', 'acknowledged'],
  terminal: ['failed', 'acknowledged'],
  transitions: {
    queued: {
      accept: 'provider_accepted',
      deliver: 'delivered',
      fail: 'failed',
      lose_track: 'unknown',
    },
    provider_accepted: { deliver: 'delivered', fail: 'failed', lose_track: 'unknown' },
    unknown: { accept: 'provider_accepted', deliver: 'delivered', fail: 'failed' },
    delivered: { read: 'read', acknowledge: 'acknowledged' },
    read: { acknowledge: 'acknowledged' },
    failed: {},
    acknowledged: {},
  },
});

/**
 * Push device registration (SPK-UX-001, COM-01; migration 1004 lists the same states): active
 * until the person revokes it, the token moves to another account ('reregistered') or the
 * account is recovered ('account_relinked', SPK-AT-025). A revoked device is never reactivated:
 * registering the token again creates a new registration.
 */
export type PushDeviceState = PushDeviceStatusValue;
export type PushDeviceEvent = 'revoke';
export const PushDeviceMachine = defineStateMachine<PushDeviceState, PushDeviceEvent>({
  name: 'PushDevice',
  initial: 'active',
  states: ['active', 'revoked'],
  terminal: ['revoked'],
  transitions: {
    active: { revoke: 'revoked' },
    revoked: {},
  },
});

export const COMMUNICATIONS_STATE_MACHINES = [
  NotificationMachine,
  RecipientMachine,
  DeliveryAttemptMachine,
  PushDeviceMachine,
] as const;
