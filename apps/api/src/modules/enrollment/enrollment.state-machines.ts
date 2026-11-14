import { defineStateMachine } from '@sportspark/contracts';

/**
 * Package G lifecycles owned by enrollment (ENR-10; §4.6, §3.16). They are module-local
 * (DEC-093 proposes keeping capability-specific machines with their owning module until the
 * capability is adopted); the database check constraints and transition guards of migrations
 * 0506 to 0509 list the same states. Services call `Machine.next(from, event)` and never set a
 * state the machine does not allow.
 */

// ---------------------------------------------------------------------------------------------
// Session package entitlement (SPK-COND-002): redeem and reverse are applied by the redemption
// trigger (package_redemptions_apply); expiry and revocation by the service.
// ---------------------------------------------------------------------------------------------
export type PackageEntitlementState = 'active' | 'exhausted' | 'expired' | 'revoked';
export type PackageEntitlementEvent = 'redeem_last' | 'reverse' | 'expire' | 'revoke';
export const PackageEntitlementMachine = defineStateMachine<
  PackageEntitlementState,
  PackageEntitlementEvent
>({
  name: 'PackageEntitlement',
  initial: 'active',
  states: ['active', 'exhausted', 'expired', 'revoked'],
  terminal: ['expired', 'revoked'],
  transitions: {
    active: { redeem_last: 'exhausted', expire: 'expired', revoke: 'revoked' },
    exhausted: { reverse: 'active', revoke: 'revoked' },
    expired: {},
    revoked: {},
  },
});

// ---------------------------------------------------------------------------------------------
// Membership suspension (SPK-COND-001)
// ---------------------------------------------------------------------------------------------
export type MembershipSuspensionState = 'active' | 'ended';
export type MembershipSuspensionEvent = 'end';
export const MembershipSuspensionMachine = defineStateMachine<
  MembershipSuspensionState,
  MembershipSuspensionEvent
>({
  name: 'MembershipSuspension',
  initial: 'active',
  states: ['active', 'ended'],
  terminal: ['ended'],
  transitions: { active: { end: 'ended' }, ended: {} },
});

// ---------------------------------------------------------------------------------------------
// Rental and party booking (SPK-COND-003): requested (approval mode, nothing reserved) → held
// (events, staffing requirements, basket line and hold) → confirmed when paid and every mandatory
// staff slot is covered, else awaiting_staff; never confirmed while a slot is uncovered.
// ---------------------------------------------------------------------------------------------
export type BookingState =
  | 'requested'
  | 'held'
  | 'awaiting_staff'
  | 'confirmed'
  | 'declined'
  | 'expired'
  | 'canceled'
  | 'completed';
export type BookingEvent =
  | 'approve'
  | 'decline'
  | 'cancel'
  | 'expire'
  | 'pay_covered'
  | 'pay_uncovered'
  | 'cover'
  | 'uncover'
  | 'complete';
export const BookingMachine = defineStateMachine<BookingState, BookingEvent>({
  name: 'Booking',
  initial: 'requested',
  states: [
    'requested',
    'held',
    'awaiting_staff',
    'confirmed',
    'declined',
    'expired',
    'canceled',
    'completed',
  ],
  terminal: ['declined', 'expired', 'canceled', 'completed'],
  transitions: {
    requested: { approve: 'held', decline: 'declined', cancel: 'canceled', expire: 'expired' },
    held: {
      pay_covered: 'confirmed',
      pay_uncovered: 'awaiting_staff',
      expire: 'expired',
      cancel: 'canceled',
    },
    awaiting_staff: { cover: 'confirmed', cancel: 'canceled', complete: 'completed' },
    confirmed: { uncover: 'awaiting_staff', cancel: 'canceled', complete: 'completed' },
    declined: {},
    expired: {},
    canceled: {},
    completed: {},
  },
});

// ---------------------------------------------------------------------------------------------
// Youth progression (SPK-YOUTH-005, SPK-YOUTH-006; DEC-003, DEC-054)
// ---------------------------------------------------------------------------------------------
export type AssessmentTemplateState = 'draft' | 'approved' | 'retired';
export type AssessmentTemplateEvent = 'approve' | 'retire';
export const AssessmentTemplateMachine = defineStateMachine<
  AssessmentTemplateState,
  AssessmentTemplateEvent
>({
  name: 'AssessmentTemplate',
  initial: 'draft',
  states: ['draft', 'approved', 'retired'],
  terminal: ['retired'],
  transitions: {
    draft: { approve: 'approved', retire: 'retired' },
    approved: { retire: 'retired' },
    retired: {},
  },
});

export type AssessmentState =
  'draft' | 'submitted' | 'returned' | 'published' | 'recorded' | 'withdrawn';
export type AssessmentEvent =
  'submit' | 'withdraw' | 'approve_family' | 'approve_internal' | 'return' | 'resubmit';
export const AssessmentMachine = defineStateMachine<AssessmentState, AssessmentEvent>({
  name: 'Assessment',
  initial: 'draft',
  states: ['draft', 'submitted', 'returned', 'published', 'recorded', 'withdrawn'],
  terminal: ['published', 'recorded', 'withdrawn'],
  transitions: {
    draft: { submit: 'submitted', withdraw: 'withdrawn' },
    submitted: { approve_family: 'published', approve_internal: 'recorded', return: 'returned' },
    returned: { resubmit: 'submitted', withdraw: 'withdrawn' },
    published: {},
    recorded: {},
    withdrawn: {},
  },
});

export type ProgressionRecommendationState = 'draft' | 'shared' | 'withdrawn';
export type ProgressionRecommendationEvent = 'share' | 'withdraw';
export const ProgressionRecommendationMachine = defineStateMachine<
  ProgressionRecommendationState,
  ProgressionRecommendationEvent
>({
  name: 'ProgressionRecommendation',
  initial: 'draft',
  states: ['draft', 'shared', 'withdrawn'],
  terminal: ['withdrawn'],
  transitions: {
    draft: { share: 'shared', withdraw: 'withdrawn' },
    shared: { withdraw: 'withdrawn' },
    withdrawn: {},
  },
});

// ---------------------------------------------------------------------------------------------
// Rental-group roster (SPK-COND-005, proposed amendment PA-09; migration 0530). A roster row is
// invited (it has an open invitation), joined, or removed; an invitation is pending until it is
// accepted, declined, revoked or expires. The transition guards of 0530 list the same moves.
// ---------------------------------------------------------------------------------------------
export type BookingRosterMemberState = 'invited' | 'joined' | 'removed';
export type BookingRosterMemberEvent = 'join' | 'remove';
export const BookingRosterMemberMachine = defineStateMachine<
  BookingRosterMemberState,
  BookingRosterMemberEvent
>({
  name: 'BookingRosterMember',
  initial: 'invited',
  states: ['invited', 'joined', 'removed'],
  terminal: ['removed'],
  transitions: {
    invited: { join: 'joined', remove: 'removed' },
    joined: { remove: 'removed' },
    removed: {},
  },
});

export type BookingRosterInvitationState =
  'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
export type BookingRosterInvitationEvent = 'accept' | 'decline' | 'revoke' | 'expire';
export const BookingRosterInvitationMachine = defineStateMachine<
  BookingRosterInvitationState,
  BookingRosterInvitationEvent
>({
  name: 'BookingRosterInvitation',
  initial: 'pending',
  states: ['pending', 'accepted', 'declined', 'revoked', 'expired'],
  terminal: ['accepted', 'declined', 'revoked', 'expired'],
  transitions: {
    pending: { accept: 'accepted', decline: 'declined', revoke: 'revoked', expire: 'expired' },
    accepted: {},
    declined: {},
    revoked: {},
    expired: {},
  },
});
