import { defineStateMachine } from '@sportspark/contracts';
import type {
  AccessReviewStatus,
  DuplicateCandidateStatus,
  InvitationStatus,
  RelationshipStatus,
  StaffMembershipStatus,
} from '@sportspark/db';

/**
 * Identity lifecycles (§4.6). The database check constraints in migration 0100 list exactly
 * these states; services only move through `Machine.next`.
 */
export type InvitationEvent = 'accept' | 'revoke' | 'expire';
export const InvitationMachine = defineStateMachine<InvitationStatus, InvitationEvent>({
  name: 'Invitation',
  initial: 'pending',
  states: ['pending', 'accepted', 'revoked', 'expired'],
  terminal: ['accepted', 'revoked', 'expired'],
  transitions: {
    pending: { accept: 'accepted', revoke: 'revoked', expire: 'expired' },
    accepted: {},
    revoked: {},
    expired: {},
  },
});

/** Claims share the invitation lifecycle. */
export const ClaimMachine = defineStateMachine<InvitationStatus, InvitationEvent>({
  ...InvitationMachine,
  name: 'Claim',
});

export type RelationshipEvent = 'suspend' | 'reinstate' | 'end';
export const RelationshipMachine = defineStateMachine<RelationshipStatus, RelationshipEvent>({
  name: 'Relationship',
  initial: 'active',
  states: ['active', 'suspended', 'ended'],
  terminal: ['ended'],
  transitions: {
    active: { suspend: 'suspended', end: 'ended' },
    suspended: { reinstate: 'active', end: 'ended' },
    ended: {},
  },
});

export type StaffMembershipEvent = 'end';
export const StaffMembershipMachine = defineStateMachine<
  StaffMembershipStatus,
  StaffMembershipEvent
>({
  name: 'StaffMembership',
  initial: 'active',
  states: ['active', 'ended'],
  terminal: ['ended'],
  transitions: { active: { end: 'ended' }, ended: {} },
});

export type AccessReviewEvent = 'escalate' | 'decide' | 'close';
export const AccessReviewMachine = defineStateMachine<AccessReviewStatus, AccessReviewEvent>({
  name: 'AccessReview',
  initial: 'open',
  states: ['open', 'escalated', 'decided', 'closed'],
  terminal: ['closed'],
  transitions: {
    open: { escalate: 'escalated', decide: 'decided', close: 'closed' },
    escalated: { decide: 'decided', close: 'closed' },
    decided: { close: 'closed' },
    closed: {},
  },
});

export type DuplicateCandidateEvent = 'merge' | 'dismiss';
export const DuplicateCandidateMachine = defineStateMachine<
  DuplicateCandidateStatus,
  DuplicateCandidateEvent
>({
  name: 'DuplicateCandidate',
  initial: 'open',
  states: ['open', 'merged', 'dismissed'],
  terminal: ['merged', 'dismissed'],
  transitions: { open: { merge: 'merged', dismiss: 'dismissed' }, merged: {}, dismissed: {} },
});
