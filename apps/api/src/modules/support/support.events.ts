import { defineEvent, z } from '@sportspark/contracts';

/**
 * Support domain events (§4.12). Payloads carry identifiers and enumerations only — never case
 * descriptions, notes, names or child information (§4.14).
 */
const CaseStatus = z.enum(['open', 'waiting_customer', 'waiting_internal', 'resolved', 'closed']);

export const CaseOpened = defineEvent(
  'support.case_opened',
  z.object({
    caseId: z.uuid(),
    category: z.string(),
    priority: z.string(),
    facilityId: z.uuid().nullable(),
    subjectPersonId: z.uuid().nullable(),
    ownerPersonId: z.uuid().nullable(),
    ownerQueue: z.string().nullable(),
    origin: z.object({ type: z.string(), id: z.uuid() }).nullable(),
  }),
);

export const CaseUpdated = defineEvent(
  'support.case_updated',
  z.object({ caseId: z.uuid(), fields: z.array(z.string()), revision: z.number().int() }),
);

export const CaseAssigned = defineEvent(
  'support.case_assigned',
  z.object({
    caseId: z.uuid(),
    ownerPersonId: z.uuid().nullable(),
    ownerQueue: z.string().nullable(),
  }),
);

export const CaseStatusChanged = defineEvent(
  'support.case_status_changed',
  z.object({
    caseId: z.uuid(),
    from: CaseStatus,
    to: CaseStatus,
    resolutionKind: z.string().nullable(),
  }),
);

export const CaseNoteAdded = defineEvent(
  'support.case_note_added',
  z.object({ caseId: z.uuid(), caseEventId: z.uuid() }),
);

/** SPK-SUPPORT-003: a case now points at the outcome of an authorized command. */
export const CaseActionRecorded = defineEvent(
  'support.case_action_recorded',
  z.object({
    caseId: z.uuid(),
    caseActionId: z.uuid(),
    actionId: z.string(),
    status: z.enum(['requested', 'succeeded', 'failed', 'unknown']),
    commandOperationId: z.uuid().nullable(),
  }),
);

/** SPK-UX-006: an exception changed state through the workflow; the underlying record did not. */
export const ExceptionTransitioned = defineEvent(
  'support.exception_transitioned',
  z.object({
    exceptionId: z.uuid(),
    from: z.string(),
    to: z.enum(['acknowledged', 'resolved', 'closed']),
    ownerQueue: z.string(),
  }),
);

export const ExceptionQueueChanged = defineEvent(
  'support.exception_queue_changed',
  z.object({ queueId: z.uuid(), name: z.string(), revision: z.number().int() }),
);

export const SupportEvents = {
  caseOpened: CaseOpened,
  caseUpdated: CaseUpdated,
  caseAssigned: CaseAssigned,
  caseStatusChanged: CaseStatusChanged,
  caseNoteAdded: CaseNoteAdded,
  caseActionRecorded: CaseActionRecorded,
  exceptionTransitioned: ExceptionTransitioned,
  exceptionQueueChanged: ExceptionQueueChanged,
} as const;
