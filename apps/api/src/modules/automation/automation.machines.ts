import { defineStateMachine } from '@sportspark/contracts';
import type { AssistantRequestStatus, RecommendationStatus } from '@sportspark/db';

/**
 * Automation lifecycles (§4.6 "each command must define allowed source state"). The check
 * constraints and guard triggers of migration 1400 list exactly these states and transitions.
 */
export type AssistantRequestEvent = 'answer' | 'fail';

/** A request is processed once: it ends answered (with evidence) or failed (with the reason). */
export const AssistantRequestMachine = defineStateMachine<
  AssistantRequestStatus,
  AssistantRequestEvent
>({
  name: 'AssistantRequest',
  initial: 'processing',
  states: ['processing', 'answered', 'failed'],
  terminal: ['answered', 'failed'],
  transitions: {
    processing: { answer: 'answered', fail: 'failed' },
    answered: {},
    failed: {},
  },
});

export type RecommendationEvent = 'approve' | 'reject' | 'apply' | 'expire';

/**
 * SPK-AUTO-003: a recommendation is a proposal until a person explicitly approves or rejects it;
 * only an approved, consequential recommendation is applied, and only through the owning module's
 * command with the reviewer's principal. An unreviewed or unapplied proposal expires.
 */
export const RecommendationMachine = defineStateMachine<RecommendationStatus, RecommendationEvent>({
  name: 'Recommendation',
  initial: 'proposed',
  states: ['proposed', 'approved', 'rejected', 'applied', 'expired'],
  terminal: ['rejected', 'applied', 'expired'],
  transitions: {
    proposed: { approve: 'approved', reject: 'rejected', expire: 'expired' },
    approved: { apply: 'applied', expire: 'expired' },
    rejected: {},
    applied: {},
    expired: {},
  },
});
