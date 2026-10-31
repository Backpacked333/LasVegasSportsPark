import {
  DomainError,
  errors,
  type ActorSnapshot,
  type Case,
  type CaseAction,
  type CaseEvent,
  type ExceptionQueue,
  type Principal,
  type StaffRole,
} from '@sportspark/contracts';
import type {
  CaseActionsTable,
  CaseEventsTable,
  CasesTable,
  Db,
  ExceptionQueuesTable,
  RecordReference,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { Trx } from '../../kernel';
import { CaseMachine } from './support.machines';

export type Reader = Db | Trx;
export type CaseRow = Selectable<CasesTable>;
export type CaseEventRow = Selectable<CaseEventsTable>;
export type CaseActionRow = Selectable<CaseActionsTable>;
export type ExceptionQueueRow = Selectable<ExceptionQueuesTable>;

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

export function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value === null || value === undefined ? null : iso(value);
}

export function isStaffLike(principal: Principal): boolean {
  return principal.kind === 'staff' || principal.kind === 'system';
}

/** Domain errors that mean "the viewer may not read this source" rather than a failure. */
export function isPermissionError(error: unknown): boolean {
  return (
    DomainError.is(error) &&
    (error.code === 'ACCESS_DENIED' ||
      error.code === 'NOT_FOUND' ||
      error.code === 'PARTICIPANT_AUTHORITY_REQUIRED')
  );
}

export function actorOf(value: unknown): ActorSnapshot {
  const v = (value ?? {}) as Partial<ActorSnapshot>;
  return {
    kind: typeof v.kind === 'string' ? v.kind : 'unknown',
    accountId: v.accountId ?? null,
    personId: v.personId ?? null,
    staffRoles: Array.isArray(v.staffRoles) ? v.staffRoles : [],
    sessionId: v.sessionId ?? null,
    actorLabel: typeof v.actorLabel === 'string' ? v.actorLabel : 'unknown',
  };
}

export function recordRefs(value: unknown): RecordReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (r): r is RecordReference =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as RecordReference).type === 'string' &&
      typeof (r as RecordReference).id === 'string',
  );
}

/** Duplicate references collapse; order is kept. */
export function uniqueRefs(refs: readonly RecordReference[]): RecordReference[] {
  const seen = new Set<string>();
  const out: RecordReference[] = [];
  for (const r of refs) {
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: r.type, id: r.id });
  }
  return out;
}

/**
 * The staff view of a case. `canonicalPersonId` is the subject's surviving person (SUP-05,
 * SPK-IAM-007), resolved by the caller through identity's person directory; the subject itself
 * is never rewritten.
 */
export function toCase(row: CaseRow, now: Date, canonicalPersonId: string | null = null): Case {
  const dueAt = row.due_at ? new Date(row.due_at) : null;
  const live = row.status !== 'resolved' && row.status !== 'closed';
  return {
    id: row.id,
    facilityId: row.facility_id,
    category: row.category,
    priority: row.priority,
    status: row.status,
    title: row.title,
    description: row.description,
    subject: {
      personId: row.subject_person_id,
      householdId: row.subject_household_id,
      canonicalPersonId: row.subject_person_id
        ? (canonicalPersonId ?? row.subject_person_id)
        : null,
    },
    owner: { personId: row.owner_person_id, queue: row.owner_queue },
    relatedRecords: recordRefs(row.related_records),
    origin: row.origin_access_review_id
      ? { type: 'access_review', id: row.origin_access_review_id }
      : row.origin_exception_id
        ? { type: 'operational_exception', id: row.origin_exception_id }
        : null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    overdue: live && dueAt !== null && dueAt.getTime() < now.getTime(),
    resolution:
      row.resolution_kind && row.resolution_summary
        ? { kind: row.resolution_kind, summary: row.resolution_summary }
        : null,
    resolvedAt: isoOrNull(row.resolved_at),
    closedAt: isoOrNull(row.closed_at),
    openedBy: actorOf(row.opened_by),
    openedVia: row.opened_via,
    allowedEvents: CaseMachine.eventsFrom(row.status),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toCaseEvent(row: CaseEventRow): CaseEvent {
  return {
    id: row.id,
    sequence: row.sequence,
    kind: row.kind,
    body: row.body,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    caseActionId: row.case_action_id,
    details: (row.details ?? {}) as Record<string, unknown>,
    actor: actorOf(row.actor),
    occurredAt: iso(row.occurred_at),
  };
}

export function toCaseAction(row: CaseActionRow): CaseAction {
  const error = row.error as { code: string; message: string; details?: unknown } | null;
  return {
    id: row.id,
    caseId: row.case_id,
    actionId: row.action_id,
    via: row.via,
    status: row.status,
    commandOperationId: row.command_operation_id,
    auditRecordId: row.audit_record_id,
    supportOperationId: row.support_operation_id,
    record: row.record_type && row.record_id ? { type: row.record_type, id: row.record_id } : null,
    input: (row.input ?? {}) as Record<string, unknown>,
    error: error ? { code: error.code, message: error.message, details: error.details } : null,
    note: row.note,
    actor: actorOf(row.actor),
    requestedAt: iso(row.requested_at),
    completedAt: isoOrNull(row.completed_at),
    revision: row.revision,
  };
}

export function toExceptionQueue(row: ExceptionQueueRow): ExceptionQueue {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owningRoles: row.owning_roles as StaffRole[],
    acknowledgeWithinMinutes: row.acknowledge_within_minutes,
    resolveWithinMinutes: row.resolve_within_minutes,
    status: row.status,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function minutesBetween(from: Date | string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 60_000));
}

export function addMinutesTo(instant: Date | string, minutes: number): Date {
  return new Date(new Date(instant).getTime() + minutes * 60_000);
}
