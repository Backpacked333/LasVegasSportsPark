import { describe, expect, it } from 'vitest';
import {
  AccessReviewMachine,
  ClaimMachine,
  DuplicateCandidateMachine,
  InvitationMachine,
  RelationshipMachine,
  StaffMembershipMachine,
  allowedReviewDecisions,
} from './identity.machines';

describe('identity state machines (§4.6)', () => {
  it('invitations and claims leave pending exactly once', () => {
    for (const machine of [InvitationMachine, ClaimMachine]) {
      expect(machine.next('pending', 'accept')).toBe('accepted');
      expect(machine.next('pending', 'expire')).toBe('expired');
      expect(() => machine.next('accepted', 'revoke')).toThrow(/cannot revoke from accepted/);
      expect(() => machine.next('expired', 'accept')).toThrow(/cannot accept from expired/);
    }
    expect(ClaimMachine.eventsFrom('pending').sort()).toEqual(['accept', 'expire', 'revoke']);
  });

  it('SPK-IAM-004: a declined invitation is terminal and can no longer be accepted (ID-03)', () => {
    expect(InvitationMachine.eventsFrom('pending').sort()).toEqual([
      'accept',
      'decline',
      'expire',
      'revoke',
    ]);
    expect(InvitationMachine.next('pending', 'decline')).toBe('declined');
    expect(InvitationMachine.isTerminal('declined')).toBe(true);
    expect(() => InvitationMachine.next('declined', 'accept')).toThrow(
      /cannot accept from declined/,
    );
    expect(() => InvitationMachine.next('expired', 'decline')).toThrow(
      /cannot decline from expired/,
    );
  });

  it('SPK-IAM-005: a review publishes the decisions its state allows (ID-05)', () => {
    expect(allowedReviewDecisions('open')).toEqual([
      'restrict',
      'lift',
      'escalate',
      'decide',
      'close',
      'note',
      'reassign',
    ]);
    expect(allowedReviewDecisions('escalated')).not.toContain('escalate');
    expect(allowedReviewDecisions('decided')).toEqual([
      'restrict',
      'lift',
      'close',
      'note',
      'reassign',
    ]);
    // Closing never lifts silently: a closed review still takes a lift, and nothing else.
    expect(allowedReviewDecisions('closed')).toEqual(['lift']);
  });

  it('relationships can be suspended and reinstated but never leave ended', () => {
    expect(RelationshipMachine.next('active', 'suspend')).toBe('suspended');
    expect(RelationshipMachine.next('suspended', 'reinstate')).toBe('active');
    expect(RelationshipMachine.next('suspended', 'end')).toBe('ended');
    expect(RelationshipMachine.can('ended', 'reinstate')).toBe(false);
  });

  it('staff memberships, access reviews and duplicate candidates have the documented terminal states', () => {
    expect(StaffMembershipMachine.next('active', 'end')).toBe('ended');
    expect(StaffMembershipMachine.isTerminal('ended')).toBe(true);
    expect(AccessReviewMachine.next('open', 'escalate')).toBe('escalated');
    expect(AccessReviewMachine.next('escalated', 'decide')).toBe('decided');
    expect(AccessReviewMachine.next('decided', 'close')).toBe('closed');
    expect(AccessReviewMachine.can('decided', 'escalate')).toBe(false);
    expect(AccessReviewMachine.eventsFrom('closed')).toEqual([]);
    expect(DuplicateCandidateMachine.next('open', 'merge')).toBe('merged');
    expect(DuplicateCandidateMachine.can('merged', 'dismiss')).toBe(false);
  });
});
