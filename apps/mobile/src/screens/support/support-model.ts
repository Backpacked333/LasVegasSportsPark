/**
 * SCR-C-38 vocabulary and the shape of a customer support request (SPK-SUPPORT-002, SUP-01).
 *
 * - Categories and states are the API's (`CaseCategory`, `CaseStatus`); only their words are the
 *   app's, and nothing here decides routing or priority (the API's queues, pending DEC-015).
 * - A request may name records it is about (`relatedRecords`); the API reads each one with the
 *   customer's own principal, so a record of another household answers NOT_FOUND (§4.10). The app
 *   offers only the record types the API accepts from customers (`RelatedRecordsVerifier`).
 * - Route parameters are opaque ids only: `/support?aboutType=enrollment&aboutId=<uuid>` prefills
 *   what a request is about; anything else in them is ignored (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import type { StatusBadgeProps } from '../../ui/StatusBadge';

export type CaseCategory = Schema<'CaseCategory'>;
export type CaseStatus = Schema<'CaseStatus'>;
export type CustomerCase = Schema<'CustomerCase'>;

/** The categories in the order the form offers them, in words a customer recognises. */
export const CATEGORY_LABELS: Readonly<Record<CaseCategory, string>> = {
  registration: 'A registration',
  payment: 'A payment or balance',
  schedule: 'A schedule or activity',
  team: 'A team',
  access: 'My account or access',
  facility: 'The facility',
  other: 'Something else',
};
export const CATEGORIES = Object.keys(CATEGORY_LABELS) as CaseCategory[];

/** Case states as the customer sees them (never notes, owner or queue, §4.14). */
export function caseStatus(status: CaseStatus): StatusBadgeProps {
  switch (status) {
    case 'open':
      return { tone: 'info', label: 'Open' };
    case 'waiting_customer':
      return { tone: 'warning', label: 'Waiting for you' };
    case 'waiting_internal':
      return { tone: 'pending', label: 'With the facility team' };
    case 'resolved':
      return { tone: 'success', label: 'Resolved' };
    case 'closed':
      return { tone: 'neutral', label: 'Closed' };
  }
}

/** What a status means for the customer, in one sentence. */
export function caseStatusMeaning(status: CaseStatus): string {
  switch (status) {
    case 'open':
      return 'The facility team has your request.';
    case 'waiting_customer':
      return 'The facility team needs something from you and will contact you; you can also contact the facility below.';
    case 'waiting_internal':
      return 'The facility team is working on it.';
    case 'resolved':
      return 'The facility team resolved this request.';
    case 'closed':
      return 'This request is closed.';
  }
}

/** Record types a customer may link to a request, with their words (SUP-01). */
export const RELATED_TYPE_LABELS = {
  enrollment: 'this registration',
  application: 'this application',
  session_booking: 'this booked session',
  checkout: 'this checkout',
  order: 'this order',
  obligation: 'this balance',
  payment_attempt: 'this payment',
  refund_attempt: 'this refund',
  credit: 'this credit',
  scheduling_event: 'this scheduled activity',
  fixture: 'this fixture',
} as const;
export type RelatedType = keyof typeof RELATED_TYPE_LABELS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The record a link says the request is about, when both parameters are valid; else null. */
export function relatedFromParams(params: {
  aboutType?: string | string[];
  aboutId?: string | string[];
}): { type: RelatedType; id: string } | null {
  const type = first(params.aboutType);
  const id = first(params.aboutId);
  if (!type || !(type in RELATED_TYPE_LABELS) || !isUuid(id)) return null;
  return { type: type as RelatedType, id };
}

export interface SupportDraft {
  category: CaseCategory | null;
  title: string;
  description: string;
  /** Who it is about; null for the signed-in person (the API's default). */
  subjectPersonId: string | null;
  teamEntryId: string | null;
  related: { type: RelatedType; id: string }[];
}

export const EMPTY_DRAFT: SupportDraft = {
  category: null,
  title: '',
  description: '',
  subjectPersonId: null,
  teamEntryId: null,
  related: [],
};

export type DraftErrors = Partial<Record<'category' | 'title' | 'description', string>>;

/** The checks the API also makes (CustomerSupportRequest), so the person sees them first. */
export function draftErrors(draft: SupportDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.category) errors.category = 'Choose what your request is about.';
  if (draft.title.trim().length === 0) errors.title = 'Give your request a short title.';
  else if (draft.title.trim().length > 200) errors.title = 'Keep the title to 200 characters.';
  if (draft.description.trim().length === 0) errors.description = 'Describe what you need.';
  else if (draft.description.trim().length > 5000)
    errors.description = 'Keep the description to 5000 characters.';
  return errors;
}

/** The request body, exactly the fields the API accepts (the schema is strict). */
export function requestBody(draft: SupportDraft, selfId: string | null) {
  return {
    category: draft.category as CaseCategory,
    title: draft.title.trim(),
    description: draft.description.trim(),
    ...(draft.subjectPersonId && draft.subjectPersonId !== selfId
      ? { subjectPersonId: draft.subjectPersonId }
      : {}),
    ...(draft.teamEntryId ? { teamEntryId: draft.teamEntryId } : {}),
    relatedRecords: draft.related.map((r) => ({ type: r.type, id: r.id })),
  };
}
