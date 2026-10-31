import { defineStateMachine, ResultMachine } from '@sportspark/contracts';
import type {
  AppealStatus,
  DisciplinaryDecisionStatus,
  DisputeStatus,
  IncidentStatus,
  SuspensionStatus,
} from '@sportspark/db';

/**
 * Lifecycles for part 2 (§4.6). Results use the canonical `ResultMachine` from the contracts
 * (draft → submitted → official → superseded); the check constraints in migration 0450 list
 * exactly the states below.
 */
export { ResultMachine };

export type SuspensionEvent = 'approve' | 'complete' | 'overturn';
export const SuspensionMachine = defineStateMachine<SuspensionStatus, SuspensionEvent>({
  name: 'Suspension',
  initial: 'proposed',
  states: ['proposed', 'active', 'served', 'overturned'],
  terminal: ['served', 'overturned'],
  transitions: {
    proposed: { approve: 'active', overturn: 'overturned' },
    active: { complete: 'served', overturn: 'overturned' },
    served: {},
    overturned: {},
  },
});

export type DisputeEvent = 'review' | 'decide' | 'withdraw';
export const DisputeMachine = defineStateMachine<DisputeStatus, DisputeEvent>({
  name: 'Dispute',
  initial: 'submitted',
  states: ['submitted', 'under_review', 'decided', 'withdrawn'],
  terminal: ['decided', 'withdrawn'],
  transitions: {
    submitted: { review: 'under_review', decide: 'decided', withdraw: 'withdrawn' },
    under_review: { decide: 'decided', withdraw: 'withdrawn' },
    decided: {},
    withdrawn: {},
  },
});

export type AppealEvent = 'review' | 'grant' | 'deny' | 'withdraw';
export const AppealMachine = defineStateMachine<AppealStatus, AppealEvent>({
  name: 'Appeal',
  initial: 'submitted',
  states: ['submitted', 'under_review', 'granted', 'denied', 'withdrawn'],
  terminal: ['granted', 'denied', 'withdrawn'],
  transitions: {
    submitted: { review: 'under_review', grant: 'granted', deny: 'denied', withdraw: 'withdrawn' },
    under_review: { grant: 'granted', deny: 'denied', withdraw: 'withdrawn' },
    granted: {},
    denied: {},
    withdrawn: {},
  },
});

export type IncidentEvent = 'review' | 'close';
export const IncidentMachine = defineStateMachine<IncidentStatus, IncidentEvent>({
  name: 'Incident',
  initial: 'open',
  states: ['open', 'under_review', 'closed'],
  terminal: ['closed'],
  transitions: {
    open: { review: 'under_review', close: 'closed' },
    under_review: { close: 'closed' },
    closed: {},
  },
});

export type DecisionEvent = 'overturn';
export const DecisionMachine = defineStateMachine<DisciplinaryDecisionStatus, DecisionEvent>({
  name: 'DisciplinaryDecision',
  initial: 'issued',
  states: ['issued', 'overturned'],
  terminal: ['overturned'],
  transitions: {
    issued: { overturn: 'overturned' },
    overturned: {},
  },
});
