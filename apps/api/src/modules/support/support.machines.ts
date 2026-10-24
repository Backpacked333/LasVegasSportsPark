import { defineStateMachine } from '@sportspark/contracts';
import type { CaseActionStatus, CaseStatus } from '@sportspark/db';

/**
 * Support lifecycles (§4.6 "each command must define allowed source state"). The database check
 * constraints and guard triggers in migration 1100 list exactly these states and transitions.
 */
export type CaseEvent =
  'wait_customer' | 'wait_internal' | 'resume' | 'resolve' | 'reopen' | 'close';

/** SPK-SUPPORT-002: a case is worked, waits on the customer or on staff, is resolved, then closed. */
export const CaseMachine = defineStateMachine<CaseStatus, CaseEvent>({
  name: 'Case',
  initial: 'open',
  states: ['open', 'waiting_customer', 'waiting_internal', 'resolved', 'closed'],
  terminal: ['closed'],
  transitions: {
    open: {
      wait_customer: 'waiting_customer',
      wait_internal: 'waiting_internal',
      resolve: 'resolved',
    },
    waiting_customer: { resume: 'open', wait_internal: 'waiting_internal', resolve: 'resolved' },
    waiting_internal: { resume: 'open', wait_customer: 'waiting_customer', resolve: 'resolved' },
    resolved: { reopen: 'open', close: 'closed' },
    closed: {},
  },
});

export type CaseActionEvent = 'succeed' | 'fail' | 'lose_outcome';

/**
 * SPK-SUPPORT-003: a helper action records the intent before the owning module's command runs
 * and the outcome after; when support cannot learn the outcome it stays `unknown` (never assumed)
 * until a reviewer records what the owning module reports.
 */
export const CaseActionMachine = defineStateMachine<CaseActionStatus, CaseActionEvent>({
  name: 'CaseAction',
  initial: 'requested',
  states: ['requested', 'succeeded', 'failed', 'unknown'],
  terminal: ['succeeded', 'failed'],
  transitions: {
    requested: { succeed: 'succeeded', fail: 'failed', lose_outcome: 'unknown' },
    unknown: { succeed: 'succeeded', fail: 'failed' },
    succeeded: {},
    failed: {},
  },
});
