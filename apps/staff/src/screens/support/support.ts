/**
 * Support case vocabulary (SPK-SUPPORT-002): machine state names for staff (journeys.md section 3,
 * rule 4), never colour alone.
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusTone } from '../../ui/StatusBadge';

export type CaseStatus = Schema<'CaseStatus'>;
export type CaseCategory = Schema<'CaseCategory'>;
export type CasePriority = Schema<'CasePriority'>;
export type CaseEvent = Schema<'CaseTransitionEvent'>;
export type CaseResolutionKind = Schema<'CaseResolutionKind'>;

export const CASE_STATUS_TONE: Record<CaseStatus, StatusTone> = {
  open: 'warning',
  waiting_customer: 'pending',
  waiting_internal: 'pending',
  resolved: 'success',
  closed: 'neutral',
};

export const CASE_PRIORITY_TONE: Record<CasePriority, StatusTone> = {
  low: 'neutral',
  normal: 'info',
  high: 'warning',
  urgent: 'danger',
};

export const CASE_STATUSES: readonly CaseStatus[] = [
  'open',
  'waiting_customer',
  'waiting_internal',
  'resolved',
  'closed',
];

export const CASE_CATEGORIES: readonly CaseCategory[] = [
  'access',
  'registration',
  'payment',
  'schedule',
  'team',
  'facility',
  'other',
];

export const CASE_PRIORITIES: readonly CasePriority[] = ['low', 'normal', 'high', 'urgent'];

export const CASE_EVENT_LABELS: Record<CaseEvent, string> = {
  wait_customer: 'Wait for the customer',
  wait_internal: 'Wait for an internal team',
  resume: 'Resume',
  resolve: 'Resolve',
  reopen: 'Reopen',
  close: 'Close',
};

export const RESOLUTION_KINDS: readonly { value: CaseResolutionKind; label: string }[] = [
  { value: 'action_taken', label: 'action_taken: a linked command succeeded' },
  { value: 'information_provided', label: 'information_provided' },
  { value: 'no_action_needed', label: 'no_action_needed' },
  { value: 'duplicate', label: 'duplicate' },
  { value: 'customer_unreachable', label: 'customer_unreachable' },
];

export const CASES_KEY = ['api', '/cases'] as const;
export const CASE_KEY = ['api', '/cases/{id}'] as const;

/** Lower-case slug the API accepts for queues (`^[a-z][a-z0-9_]{0,63}$`). */
export const SLUG_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
