import { defineStateMachine } from '@sportspark/contracts';

/**
 * Module-level lifecycles that §4.6 does not list. The Assignment lifecycle itself is the
 * canonical `AssignmentMachine` in packages/contracts/src/state-machines.ts. Database check
 * constraints in migration 0700 list exactly these states.
 */

// Fee submission (SPK-STAFF-006): approval with adjustment history, then export.
export type FeeSubmissionState = 'submitted' | 'approved' | 'adjusted' | 'rejected' | 'exported';
export type FeeSubmissionEvent = 'approve' | 'adjust' | 'reject' | 'export';
export const FeeSubmissionMachine = defineStateMachine<FeeSubmissionState, FeeSubmissionEvent>({
  name: 'FeeSubmission',
  initial: 'submitted',
  states: ['submitted', 'approved', 'adjusted', 'rejected', 'exported'],
  terminal: ['rejected', 'exported'],
  transitions: {
    submitted: { approve: 'approved', adjust: 'adjusted', reject: 'rejected' },
    approved: { adjust: 'adjusted', export: 'exported' },
    // Every further adjustment appends a fee_adjustments row; the submission stays adjusted.
    adjusted: { adjust: 'adjusted', export: 'exported' },
    rejected: {},
    exported: {},
  },
});

// Qualification evidence (SPK-STAFF-001).
export type QualificationState = 'pending_verification' | 'verified' | 'rejected' | 'revoked';
export type QualificationEvent = 'verify' | 'reject' | 'revoke';
export const QualificationMachine = defineStateMachine<QualificationState, QualificationEvent>({
  name: 'Qualification',
  initial: 'pending_verification',
  states: ['pending_verification', 'verified', 'rejected', 'revoked'],
  terminal: ['rejected', 'revoked'],
  transitions: {
    pending_verification: { verify: 'verified', reject: 'rejected' },
    verified: { revoke: 'revoked' },
    rejected: {},
    revoked: {},
  },
});

// Availability window (SPK-STAFF-001): withdrawn windows stay for history.
export type AvailabilityState = 'active' | 'withdrawn';
export type AvailabilityEvent = 'withdraw';
export const AvailabilityMachine = defineStateMachine<AvailabilityState, AvailabilityEvent>({
  name: 'Availability',
  initial: 'active',
  states: ['active', 'withdrawn'],
  terminal: ['withdrawn'],
  transitions: {
    active: { withdraw: 'withdrawn' },
    withdrawn: {},
  },
});
