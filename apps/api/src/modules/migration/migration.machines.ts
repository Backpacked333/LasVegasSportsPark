import {
  defineStateMachine,
  type ImportBatchStatusValue,
  type StateMachine,
} from '@sportspark/contracts';

/**
 * Module lifecycles (§4.6 "each command must define allowed source state"). The database check
 * constraints and guard triggers in migration 1200 list the same states and transitions.
 */

export type ImportBatchEvent = 'validate' | 'review' | 'apply' | 'abort';

/**
 * Import batch: received → validated → reviewed → applied; validation may be repeated (a
 * reviewed batch re-validated needs a new review); abort from any non-terminal state while no
 * apply has started (records created by an apply cannot be undone by aborting, §5.8).
 */
export const ImportBatchMachine: StateMachine<ImportBatchStatusValue, ImportBatchEvent> =
  defineStateMachine<ImportBatchStatusValue, ImportBatchEvent>({
    name: 'ImportBatch',
    initial: 'received',
    states: ['received', 'validated', 'reviewed', 'applied', 'aborted'],
    terminal: ['applied', 'aborted'],
    transitions: {
      received: { validate: 'validated', abort: 'aborted' },
      validated: { validate: 'validated', review: 'reviewed', abort: 'aborted' },
      reviewed: { validate: 'validated', apply: 'applied', abort: 'aborted' },
      applied: {},
      aborted: {},
    },
  });

export type ImportExceptionState = 'open' | 'decided' | 'withdrawn';
export type ImportExceptionEvent = 'decide' | 'withdraw';

/** Import exception: one decision, final; withdrawn when re-validation no longer raises it. */
export const ImportExceptionMachine = defineStateMachine<
  ImportExceptionState,
  ImportExceptionEvent
>({
  name: 'ImportException',
  initial: 'open',
  states: ['open', 'decided', 'withdrawn'],
  terminal: ['decided', 'withdrawn'],
  transitions: {
    open: { decide: 'decided', withdraw: 'withdrawn' },
    decided: {},
    withdrawn: {},
  },
});

export type ReconciliationApprovalState = 'pending' | 'approved' | 'rejected' | 'superseded';
export type ReconciliationApprovalEvent = 'approve' | 'reject' | 'supersede';

/** Reconciliation report approval: complete when every required area approved; final. */
export const ReconciliationApprovalMachine = defineStateMachine<
  ReconciliationApprovalState,
  ReconciliationApprovalEvent
>({
  name: 'ReconciliationApproval',
  initial: 'pending',
  states: ['pending', 'approved', 'rejected', 'superseded'],
  terminal: ['approved', 'rejected', 'superseded'],
  transitions: {
    pending: { approve: 'approved', reject: 'rejected', supersede: 'superseded' },
    approved: {},
    rejected: {},
    superseded: {},
  },
});
