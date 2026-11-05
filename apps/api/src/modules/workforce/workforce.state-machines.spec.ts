import { AssignmentMachine } from '@sportspark/contracts';
import { describe, expect, it } from 'vitest';
import {
  AvailabilityMachine,
  FeeSubmissionMachine,
  QualificationMachine,
} from './workforce.state-machines';

describe('workforce lifecycles', () => {
  it('§4.6 / SPK-STAFF-002: a proposal must be offered before it can be accepted; declined, withdrawn and completed are terminal', () => {
    expect(AssignmentMachine.can('proposed', 'accept')).toBe(false);
    expect(AssignmentMachine.next('proposed', 'offer')).toBe('offered');
    expect(AssignmentMachine.next('offered', 'accept')).toBe('accepted');
    expect(AssignmentMachine.next('offered', 'decline')).toBe('declined');
    expect(AssignmentMachine.next('accepted', 'withdraw')).toBe('withdrawn');
    expect(AssignmentMachine.next('accepted', 'complete')).toBe('completed');
    expect(AssignmentMachine.can('accepted', 'decline')).toBe(false);
    for (const state of ['declined', 'withdrawn', 'completed'] as const) {
      expect(AssignmentMachine.eventsFrom(state)).toEqual([]);
    }
  });

  it('SPK-STAFF-006: fees are approved or adjusted before export; every adjustment keeps the submission adjusted; export and rejection are final', () => {
    expect(FeeSubmissionMachine.next('submitted', 'approve')).toBe('approved');
    expect(FeeSubmissionMachine.next('submitted', 'adjust')).toBe('adjusted');
    expect(FeeSubmissionMachine.next('approved', 'adjust')).toBe('adjusted');
    expect(FeeSubmissionMachine.next('adjusted', 'adjust')).toBe('adjusted');
    expect(FeeSubmissionMachine.can('submitted', 'export')).toBe(false);
    expect(FeeSubmissionMachine.next('approved', 'export')).toBe('exported');
    expect(FeeSubmissionMachine.next('adjusted', 'export')).toBe('exported');
    expect(FeeSubmissionMachine.eventsFrom('exported')).toEqual([]);
    expect(FeeSubmissionMachine.eventsFrom('rejected')).toEqual([]);
    expect(() => FeeSubmissionMachine.next('exported', 'adjust')).toThrow(/cannot adjust/);
  });

  it('SPK-STAFF-001: evidence is verified once, revocation is final; availability is withdrawn, never edited', () => {
    expect(QualificationMachine.next('pending_verification', 'verify')).toBe('verified');
    expect(QualificationMachine.next('verified', 'revoke')).toBe('revoked');
    expect(QualificationMachine.can('revoked', 'verify')).toBe(false);
    expect(QualificationMachine.can('pending_verification', 'revoke')).toBe(false);
    expect(AvailabilityMachine.next('active', 'withdraw')).toBe('withdrawn');
    expect(AvailabilityMachine.can('withdrawn', 'withdraw')).toBe(false);
  });
});
