/**
 * SCR-S-22 vocabulary (SPK-IAM-005): review states and decision kinds in the API's machine names
 * (journeys.md section 3, rule 4); the glyph agrees with the text, never colour alone.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export type ReviewStatus = Schema<'AccessReview'>['status'];
export type DecisionKind = Schema<'AccessReviewDecision'>['kind'];

export const REVIEW_STATUS_TONE: Record<ReviewStatus, StatusTone> = {
  open: 'warning',
  escalated: 'danger',
  decided: 'info',
  closed: 'neutral',
};

export const DECISION_KINDS: readonly { value: DecisionKind; label: string }[] = [
  { value: 'restrict', label: 'restrict: suspend permissions while the review runs' },
  { value: 'lift', label: 'lift: end a restriction' },
  { value: 'escalate', label: 'escalate: hand to the escalation owner' },
  { value: 'decide', label: 'decide: record the outcome' },
  { value: 'close', label: 'close: end the review' },
  { value: 'note', label: 'note: add to the history only' },
  { value: 'reassign', label: 'reassign: change the review owner' },
];
