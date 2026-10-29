import { defineStateMachine } from '@sportspark/contracts';
import type {
  AccessReviewDecisionKind,
  AccessReviewStatus,
  ClaimStatus,
  DuplicateCandidateStatus,
  InvitationStatus,
  RelationshipStatus,
  StaffMembershipStatus,
} from '@sportspark/db';

/**
 * Identity lifecycles (§4.6). The database check constraints in migrations 0100 and 0104 list
 * exactly these states; services only move through `Machine.next`.
 */
export type InvitationEvent = 'accept' | 'decline' | 'revoke' | 'expire';
/** ID-03 (SPK-IAM-004): `declined` is terminal (state set Proposed, DEC-093; migration 0104). */
export const InvitationMachine = defineStateMachine<InvitationStatus, InvitationEvent>({
  name: 'Invitation',
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

/** Claims keep the original invitation lifecycle (a claim is never declined; migration 0100). */
export type ClaimEvent = Exclude<InvitationEvent, 'decline'>;
export const ClaimMachine = defineStateMachine<ClaimStatus, ClaimEvent>({
  name: 'Claim',
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

/** Decision kinds in the order clients offer them (AccessReviewDecisionKindSchema). */
const REVIEW_DECISION_ORDER: readonly AccessReviewDecisionKind[] = [
  'restrict',
  'lift',
  'escalate',
  'decide',
  'close',
  'note',
  'reassign',
];

/**
 * ID-05 (SPK-IAM-005): the decisions a review in `status` accepts now. `escalate`, `decide` and
 * `close` move the review and follow AccessReviewMachine; `restrict`, `note` and `reassign` are
 * recorded while it is not closed; `lift` is always accepted, because closing never lifts the
 * restrictions a review left in force (AccessReviewsService.decide applies the same rule).
 */
export function allowedReviewDecisions(status: AccessReviewStatus): AccessReviewDecisionKind[] {
  return REVIEW_DECISION_ORDER.filter((kind) => {
    if (kind === 'lift') return true;
    if (kind === 'escalate' || kind === 'decide' || kind === 'close') {
      return AccessReviewMachine.can(status, kind);
    }
    return status !== 'closed';
  });
}

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
