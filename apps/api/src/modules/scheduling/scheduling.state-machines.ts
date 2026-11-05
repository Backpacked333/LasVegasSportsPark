import { defineStateMachine } from '@sportspark/contracts';
import type { ClosureStatus, EventStatus, ScheduleDraftStatus } from '@sportspark/db';

/**
 * Scheduling lifecycles (§4.6 "each command must define allowed source state"). The database check
 * constraints in migration 0300 list exactly these states.
 */

export type EventEvent = 'publish' | 'cancel';
export const EventMachine = defineStateMachine<EventStatus, EventEvent>({
  name: 'Event',
  initial: 'draft',
  states: ['draft', 'published', 'canceled'],
  terminal: ['canceled'],
  transitions: {
    draft: { publish: 'published', cancel: 'canceled' },
    published: { cancel: 'canceled' },
    canceled: {},
  },
});

export type ClosureEvent = 'apply' | 'withdraw' | 'lift';
export const ClosureMachine = defineStateMachine<ClosureStatus, ClosureEvent>({
  name: 'Closure',
  initial: 'pending',
  states: ['pending', 'active', 'lifted', 'withdrawn'],
  terminal: ['lifted', 'withdrawn'],
  transitions: {
    pending: { apply: 'active', withdraw: 'withdrawn' },
    active: { lift: 'lifted' },
    lifted: {},
    withdrawn: {},
  },
});

export type ScheduleDraftEvent = 'edit' | 'validate' | 'publish' | 'commit' | 'fail' | 'discard';
export const ScheduleDraftMachine = defineStateMachine<ScheduleDraftStatus, ScheduleDraftEvent>({
  name: 'ScheduleDraft',
  initial: 'editing',
  states: ['editing', 'validated', 'publishing', 'published', 'failed', 'discarded'],
  terminal: ['published', 'discarded'],
  transitions: {
    editing: {
      edit: 'editing',
      validate: 'validated',
      publish: 'publishing',
      fail: 'failed',
      discard: 'discarded',
    },
    validated: {
      edit: 'editing',
      validate: 'validated',
      publish: 'publishing',
      fail: 'failed',
      discard: 'discarded',
    },
    publishing: { commit: 'published', fail: 'failed' },
    failed: {
      edit: 'editing',
      validate: 'validated',
      publish: 'publishing',
      fail: 'failed',
      discard: 'discarded',
    },
    published: {},
    discarded: {},
  },
});
