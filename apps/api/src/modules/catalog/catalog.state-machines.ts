import { defineStateMachine } from '@sportspark/contracts';
import type {
  DiscountStatus,
  OfferingSessionStatus,
  PolicyApprovalStatus,
  ProgramStatus,
  PublicationState,
} from '@sportspark/db';

/**
 * Catalog lifecycles (§4.6 "each command must define allowed source state"). The database check
 * constraints in migration 0200 list exactly these states.
 */

/**
 * SPK-CAT-004: publication and registration opening are distinct actions. Pausing registration
 * keeps the offering published and preserves existing participation; closing ends registration
 * for good; archiving is terminal.
 */
export type OfferingPublicationEvent =
  | 'publish'
  | 'open_registration'
  | 'pause_registration'
  | 'resume_registration'
  | 'close'
  | 'archive';
export const OfferingPublicationMachine = defineStateMachine<
  PublicationState,
  OfferingPublicationEvent
>({
  name: 'OfferingPublication',
  initial: 'draft',
  states: ['draft', 'published', 'registration_open', 'registration_paused', 'closed', 'archived'],
  terminal: ['archived'],
  transitions: {
    draft: { publish: 'published', archive: 'archived' },
    published: { open_registration: 'registration_open', close: 'closed' },
    registration_open: { pause_registration: 'registration_paused', close: 'closed' },
    registration_paused: { resume_registration: 'registration_open', close: 'closed' },
    closed: { archive: 'archived' },
    archived: {},
  },
});

/** States in which an offering's configuration may still be edited. */
export const EDITABLE_PUBLICATION_STATES: readonly PublicationState[] = [
  'draft',
  'published',
  'registration_open',
  'registration_paused',
];

export type PolicyVersionEvent = 'approve' | 'retire';
export const PolicyVersionMachine = defineStateMachine<PolicyApprovalStatus, PolicyVersionEvent>({
  name: 'PolicyVersion',
  initial: 'draft',
  states: ['draft', 'approved', 'retired'],
  terminal: ['retired'],
  transitions: {
    draft: { approve: 'approved' },
    // Approving a newer version retires nothing automatically: retirement is its own command.
    approved: { retire: 'retired' },
    retired: {},
  },
});

export type ProgramEvent = 'activate' | 'archive';
export const ProgramMachine = defineStateMachine<ProgramStatus, ProgramEvent>({
  name: 'Program',
  initial: 'draft',
  states: ['draft', 'active', 'archived'],
  terminal: ['archived'],
  transitions: {
    draft: { activate: 'active', archive: 'archived' },
    active: { archive: 'archived' },
    archived: {},
  },
});

export type OfferingSessionEvent = 'cancel' | 'complete';
export const OfferingSessionMachine = defineStateMachine<
  OfferingSessionStatus,
  OfferingSessionEvent
>({
  name: 'OfferingSession',
  initial: 'scheduled',
  states: ['scheduled', 'canceled', 'completed'],
  terminal: ['canceled', 'completed'],
  transitions: {
    scheduled: { cancel: 'canceled', complete: 'completed' },
    canceled: {},
    completed: {},
  },
});

export type DiscountEvent = 'activate' | 'retire';
export const DiscountMachine = defineStateMachine<DiscountStatus, DiscountEvent>({
  name: 'Discount',
  initial: 'draft',
  states: ['draft', 'active', 'retired'],
  terminal: ['retired'],
  transitions: {
    draft: { activate: 'active', retire: 'retired' },
    active: { retire: 'retired' },
    retired: {},
  },
});
