import { errors } from './errors';

/**
 * Canonical lifecycles (specification §4.6). Each command must define its allowed source state;
 * independent facts must not overwrite one another's state. These definitions are the single source
 * of truth used by services (guards), the database check constraints (allowed values), and the docs.
 */
export interface StateMachineDefinition<S extends string, E extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly terminal: readonly S[];
  readonly transitions: Readonly<Record<S, Readonly<Partial<Record<E, S>>>>>;
}

export interface StateMachine<S extends string, E extends string> extends StateMachineDefinition<
  S,
  E
> {
  can(from: S, event: E): boolean;
  /** Returns the next state or throws INVALID_TRANSITION. */
  next(from: S, event: E): S;
  isTerminal(state: S): boolean;
  eventsFrom(from: S): E[];
}

export function defineStateMachine<S extends string, E extends string>(
  def: StateMachineDefinition<S, E>,
): StateMachine<S, E> {
  for (const [from, events] of Object.entries(def.transitions) as [S, Partial<Record<E, S>>][]) {
    if (!def.states.includes(from)) throw new Error(`${def.name}: unknown source state ${from}`);
    for (const to of Object.values(events) as S[]) {
      if (!def.states.includes(to)) throw new Error(`${def.name}: unknown target state ${to}`);
    }
  }
  return {
    ...def,
    can(from, event) {
      return def.transitions[from]?.[event] !== undefined;
    },
    next(from, event) {
      const to = def.transitions[from]?.[event];
      if (to === undefined) throw errors.invalidTransition(def.name, from, event);
      return to;
    },
    isTerminal(state) {
      return def.terminal.includes(state);
    },
    eventsFrom(from) {
      return Object.keys(def.transitions[from] ?? {}) as E[];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Application: draft, submitted, awaiting review, accepted, declined, withdrawn
// ---------------------------------------------------------------------------------------------
export type ApplicationState =
  'draft' | 'submitted' | 'awaiting_review' | 'accepted' | 'declined' | 'withdrawn';
export type ApplicationEvent = 'submit' | 'route_for_review' | 'accept' | 'decline' | 'withdraw';
export const ApplicationMachine = defineStateMachine<ApplicationState, ApplicationEvent>({
  name: 'Application',
  initial: 'draft',
  states: ['draft', 'submitted', 'awaiting_review', 'accepted', 'declined', 'withdrawn'],
  terminal: ['accepted', 'declined', 'withdrawn'],
  transitions: {
    draft: { submit: 'submitted', withdraw: 'withdrawn' },
    submitted: {
      route_for_review: 'awaiting_review',
      accept: 'accepted',
      decline: 'declined',
      withdraw: 'withdrawn',
    },
    awaiting_review: { accept: 'accepted', decline: 'declined', withdraw: 'withdrawn' },
    accepted: {},
    declined: {},
    withdrawn: {},
  },
});

// Enrollment: pending, confirmed, canceled, transferred, completed
export type EnrollmentState = 'pending' | 'confirmed' | 'canceled' | 'transferred' | 'completed';
export type EnrollmentEvent = 'confirm' | 'cancel' | 'transfer' | 'complete';
export const EnrollmentMachine = defineStateMachine<EnrollmentState, EnrollmentEvent>({
  name: 'Enrollment',
  initial: 'pending',
  states: ['pending', 'confirmed', 'canceled', 'transferred', 'completed'],
  terminal: ['canceled', 'transferred', 'completed'],
  transitions: {
    pending: { confirm: 'confirmed', cancel: 'canceled' },
    confirmed: { cancel: 'canceled', transfer: 'transferred', complete: 'completed' },
    canceled: {},
    transferred: {},
    completed: {},
  },
});

// Placement: unassigned, proposed, assigned, released
export type PlacementState = 'unassigned' | 'proposed' | 'assigned' | 'released';
export type PlacementEvent = 'propose' | 'reject_proposal' | 'assign' | 'release';
export const PlacementMachine = defineStateMachine<PlacementState, PlacementEvent>({
  name: 'Placement',
  initial: 'unassigned',
  states: ['unassigned', 'proposed', 'assigned', 'released'],
  terminal: ['released'],
  transitions: {
    unassigned: { propose: 'proposed', assign: 'assigned' },
    proposed: { reject_proposal: 'unassigned', assign: 'assigned' },
    assigned: { release: 'released' },
    released: {},
  },
});

// Hold: active, committed, released, expired
export type HoldState = 'active' | 'committed' | 'released' | 'expired';
export type HoldEvent = 'commit' | 'release' | 'expire';
export const HoldMachine = defineStateMachine<HoldState, HoldEvent>({
  name: 'Hold',
  initial: 'active',
  states: ['active', 'committed', 'released', 'expired'],
  terminal: ['committed', 'released', 'expired'],
  transitions: {
    active: { commit: 'committed', release: 'released', expire: 'expired' },
    committed: {},
    released: {},
    expired: {},
  },
});

// Session booking: pending, confirmed, canceled, expired
export type SessionBookingState = 'pending' | 'confirmed' | 'canceled' | 'expired';
export type SessionBookingEvent = 'confirm' | 'cancel' | 'expire';
export const SessionBookingMachine = defineStateMachine<SessionBookingState, SessionBookingEvent>({
  name: 'SessionBooking',
  initial: 'pending',
  states: ['pending', 'confirmed', 'canceled', 'expired'],
  terminal: ['canceled', 'expired'],
  transitions: {
    pending: { confirm: 'confirmed', cancel: 'canceled', expire: 'expired' },
    confirmed: { cancel: 'canceled' },
    canceled: {},
    expired: {},
  },
});

// Payment attempt: created, action required, processing, succeeded, failed, canceled, unknown
export type PaymentAttemptState =
  'created' | 'action_required' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
export type PaymentAttemptEvent =
  'require_action' | 'process' | 'succeed' | 'fail' | 'cancel' | 'lose_track';
export const PaymentAttemptMachine = defineStateMachine<PaymentAttemptState, PaymentAttemptEvent>({
  name: 'PaymentAttempt',
  initial: 'created',
  states: [
    'created',
    'action_required',
    'processing',
    'succeeded',
    'failed',
    'canceled',
    'unknown',
  ],
  terminal: ['succeeded', 'failed', 'canceled'],
  transitions: {
    created: {
      require_action: 'action_required',
      process: 'processing',
      succeed: 'succeeded',
      fail: 'failed',
      cancel: 'canceled',
      lose_track: 'unknown',
    },
    action_required: {
      process: 'processing',
      succeed: 'succeeded',
      fail: 'failed',
      cancel: 'canceled',
      lose_track: 'unknown',
    },
    processing: { succeed: 'succeeded', fail: 'failed', cancel: 'canceled', lose_track: 'unknown' },
    // `unknown` is resolved only by authoritative reconciliation evidence (SPK-PAY-007).
    unknown: { succeed: 'succeeded', fail: 'failed', cancel: 'canceled' },
    succeeded: {},
    failed: {},
    canceled: {},
  },
});

// Refund: requested, processing, succeeded, failed, canceled, unknown
export type RefundState =
  'requested' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'unknown';
export type RefundEvent = 'process' | 'succeed' | 'fail' | 'cancel' | 'lose_track';
export const RefundMachine = defineStateMachine<RefundState, RefundEvent>({
  name: 'Refund',
  initial: 'requested',
  states: ['requested', 'processing', 'succeeded', 'failed', 'canceled', 'unknown'],
  terminal: ['succeeded', 'failed', 'canceled'],
  transitions: {
    requested: { process: 'processing', cancel: 'canceled', fail: 'failed', lose_track: 'unknown' },
    processing: { succeed: 'succeeded', fail: 'failed', lose_track: 'unknown' },
    // An unknown external result retains its reservation until reconciliation (SPK-PAY-008).
    unknown: { succeed: 'succeeded', fail: 'failed' },
    succeeded: {},
    failed: {},
    canceled: {},
  },
});

// Checkout: prepared, awaiting payment, finalizing, completed, recovery required, compensated, aborted
export type CheckoutState =
  | 'prepared'
  | 'awaiting_payment'
  | 'finalizing'
  | 'completed'
  | 'recovery_required'
  | 'compensated'
  | 'aborted';
export type CheckoutEvent =
  | 'initiate_payment'
  | 'payment_succeeded'
  | 'finalized'
  | 'finalization_failed'
  | 'recovered'
  | 'compensate'
  | 'abort';
export const CheckoutMachine = defineStateMachine<CheckoutState, CheckoutEvent>({
  name: 'Checkout',
  initial: 'prepared',
  states: [
    'prepared',
    'awaiting_payment',
    'finalizing',
    'completed',
    'recovery_required',
    'compensated',
    'aborted',
  ],
  terminal: ['completed', 'compensated', 'aborted'],
  transitions: {
    prepared: {
      initiate_payment: 'awaiting_payment',
      payment_succeeded: 'finalizing',
      abort: 'aborted',
    },
    awaiting_payment: { payment_succeeded: 'finalizing', abort: 'aborted' },
    finalizing: { finalized: 'completed', finalization_failed: 'recovery_required' },
    // Provider success followed by local failure stays visible as received money + incomplete fulfillment (§4.11).
    recovery_required: { recovered: 'completed', compensate: 'compensated' },
    completed: {},
    compensated: {},
    aborted: {},
  },
});

// Result: draft, submitted, official, superseded
export type ResultState = 'draft' | 'submitted' | 'official' | 'superseded';
export type ResultEvent = 'submit' | 'return_for_correction' | 'publish' | 'supersede';
export const ResultMachine = defineStateMachine<ResultState, ResultEvent>({
  name: 'Result',
  initial: 'draft',
  states: ['draft', 'submitted', 'official', 'superseded'],
  terminal: ['superseded'],
  transitions: {
    draft: { submit: 'submitted' },
    submitted: { publish: 'official', return_for_correction: 'draft' },
    official: { supersede: 'superseded' },
    superseded: {},
  },
});

// Assignment: proposed, offered, accepted, declined, withdrawn, completed
export type AssignmentState =
  'proposed' | 'offered' | 'accepted' | 'declined' | 'withdrawn' | 'completed';
export type AssignmentEvent = 'offer' | 'accept' | 'decline' | 'withdraw' | 'complete';
export const AssignmentMachine = defineStateMachine<AssignmentState, AssignmentEvent>({
  name: 'Assignment',
  initial: 'proposed',
  states: ['proposed', 'offered', 'accepted', 'declined', 'withdrawn', 'completed'],
  terminal: ['declined', 'withdrawn', 'completed'],
  transitions: {
    proposed: { offer: 'offered', withdraw: 'withdrawn' },
    offered: { accept: 'accepted', decline: 'declined', withdraw: 'withdrawn' },
    accepted: { withdraw: 'withdrawn', complete: 'completed' },
    declined: {},
    withdrawn: {},
    completed: {},
  },
});

export const ALL_STATE_MACHINES = [
  ApplicationMachine,
  EnrollmentMachine,
  PlacementMachine,
  HoldMachine,
  SessionBookingMachine,
  PaymentAttemptMachine,
  RefundMachine,
  CheckoutMachine,
  ResultMachine,
  AssignmentMachine,
] as const;
