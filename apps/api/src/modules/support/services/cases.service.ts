import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  systemPrincipal,
  z,
  type AddCaseNoteInput,
  type AssignCaseInput,
  type Case,
  type CaseDetail,
  type DomainEvent,
  type ListCasesQuery,
  type OpenCaseInput,
  type Page,
  type Principal,
  type StaffRole,
  type TransitionCaseInput,
  type UpdateCaseInput,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  type CaseEventKind,
  type CasePriority,
  type CaseStatus,
  type Database,
  type Db,
} from '@sportspark/db';
import { sql, type SqlBool, type UpdateObject } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type ActionDefinition,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  AccessReviewsService,
  HouseholdsService,
  PERSON_DIRECTORY_PORT,
  STAFF_DIRECTORY_PORT,
  type PersonDirectoryPort,
  type StaffDirectoryPort,
} from '../../identity';
import { SupportActions } from '../support.actions';
import {
  CaseAssigned,
  CaseNoteAdded,
  CaseOpened,
  CaseStatusChanged,
  CaseUpdated,
} from '../support.events';
import { CaseMachine } from '../support.machines';
import { SUPPORT_POLICY, type SupportPolicy } from '../support.policy';
import type { SupportCasesPort, SystemCaseInput } from '../support.ports';
import {
  addMinutesTo,
  iso,
  organizationOf,
  recordRefs,
  toCase,
  toCaseAction,
  toCaseEvent,
  uniqueRefs,
  type CaseRow,
  type Reader,
} from '../support.shared';
import { ExceptionQueuesService } from './exception-queues.service';

const ListCursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

export interface AppendEventInput {
  kind: CaseEventKind;
  body?: string | null;
  fromStatus?: CaseStatus | null;
  toStatus?: CaseStatus | null;
  caseActionId?: string | null;
  details?: Record<string, unknown>;
  actor: Principal;
}

/**
 * Support cases (SPK-SUPPORT-002): owner, category, related records, history and resolution.
 * Staff work cases with their own principal — never a customer's credentials. A case concerns a
 * customer-private subject, so a caller who may not read it receives NOT_FOUND (§4.10). A note is
 * history only; changing money, permissions or participation is the owning module's command,
 * linked to the case by CaseActionsService (SPK-SUPPORT-003).
 */
@Injectable()
export class CasesService implements SupportCasesPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SUPPORT_POLICY) private readonly policy: SupportPolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly persons: PersonDirectoryPort,
    @Inject(STAFF_DIRECTORY_PORT) private readonly staff: StaffDirectoryPort,
    private readonly households: HouseholdsService,
    private readonly accessReviews: AccessReviewsService,
    private readonly queues: ExceptionQueuesService,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Open
  // -------------------------------------------------------------------------------------------

  async open(
    principal: Principal,
    input: OpenCaseInput,
    correlationId: string | null,
  ): Promise<CaseDetail> {
    const organizationId = organizationOf(principal);
    // Staff-only: decided before any lookup so a customer learns nothing about the subject.
    await this.authorization.require(principal, SupportActions.openCase, {
      type: 'support_case',
      organizationId,
      facilityId: input.facilityId ?? null,
    });
    try {
      return await this.uow.run(async ({ trx }) => {
        if (input.facilityId) await this.assertFacility(trx, organizationId, input.facilityId);
        if (input.subjectPersonId) {
          await this.assertPerson(trx, organizationId, input.subjectPersonId);
        }
        if (input.subjectHouseholdId) {
          await this.households.detail(trx, organizationId, input.subjectHouseholdId);
        }
        if (input.ownerPersonId) {
          await this.assertCaseHandler(
            trx,
            organizationId,
            input.ownerPersonId,
            input.facilityId ?? null,
          );
        }
        if (input.ownerQueue) await this.queues.assertKnown(trx, organizationId, input.ownerQueue);
        const relatedRecords = uniqueRefs(input.relatedRecords);
        if (input.originExceptionId) {
          const exception = await trx
            .selectFrom('operational_exceptions')
            .select(['id', 'affected_type', 'affected_id'])
            .where('organization_id', '=', organizationId)
            .where('id', '=', input.originExceptionId)
            .executeTakeFirst();
          if (!exception) throw errors.notFound('exception', input.originExceptionId);
          relatedRecords.push({ type: 'operational_exception', id: exception.id });
          if (exception.affected_type && exception.affected_id) {
            relatedRecords.push({ type: exception.affected_type, id: exception.affected_id });
          }
        }
        const id = newId();
        const now = this.clock.now();
        await trx
          .insertInto('cases')
          .values({
            id,
            organization_id: organizationId,
            facility_id: input.facilityId ?? null,
            category: input.category,
            priority: input.priority,
            title: input.title,
            description: input.description ?? null,
            subject_person_id: input.subjectPersonId ?? null,
            subject_household_id: input.subjectHouseholdId ?? null,
            owner_person_id: input.ownerPersonId ?? null,
            owner_queue: input.ownerQueue ?? null,
            related_records: json(uniqueRefs(relatedRecords)),
            origin_access_review_id: null,
            origin_exception_id: input.originExceptionId ?? null,
            due_at: this.dueAt(now, input.priority),
            resolution_kind: null,
            resolution_summary: null,
            resolved_at: null,
            resolved_by: null,
            closed_at: null,
            opened_by: json(snapshotActor(principal)),
            opened_by_person_id: await this.knownPerson(trx, organizationId, principal.personId),
            created_at: now,
            updated_at: now,
          })
          .execute();
        await this.afterOpen(trx, principal, id, correlationId, {
          priority: input.priority,
          origin: input.originExceptionId
            ? { type: 'operational_exception', id: input.originExceptionId }
            : null,
          reason: input.reason ?? null,
        });
        return this.detail(trx, organizationId, id);
      });
    } catch (error) {
      if (isUniqueViolation(error) && input.originExceptionId) {
        const live = await this.db
          .selectFrom('cases')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('origin_exception_id', '=', input.originExceptionId)
          .where('status', '<>', 'closed')
          .executeTakeFirst();
        throw errors.resourceConflict('A live case already coordinates this exception.', {
          code: 'CASE_EXISTS_FOR_ORIGIN',
          caseId: live?.id ?? null,
        });
      }
      throw error;
    }
  }

  /** SUPPORT_CASES_PORT: a case opened by a module's workflow, attributed to the system. */
  async openSystemCase(
    trx: Trx,
    input: SystemCaseInput,
  ): Promise<{ caseId: string; deduplicated: boolean }> {
    const organizationId = input.organizationId;
    const actor = systemPrincipal(organizationId, input.actorLabel);
    const existing = await this.liveCaseForOrigin(trx, organizationId, input.origin ?? null);
    if (existing) return { caseId: existing.id, deduplicated: true };
    if (input.ownerQueue) await this.queues.assertKnown(trx, organizationId, input.ownerQueue);
    const id = newId();
    const now = this.clock.now();
    const relatedRecords = uniqueRefs([
      ...(input.relatedRecords ?? []),
      ...(input.origin ? [{ type: input.origin.type, id: input.origin.id }] : []),
    ]);
    const inserted = await trx
      .insertInto('cases')
      .values({
        id,
        organization_id: organizationId,
        facility_id: input.facilityId ?? null,
        category: input.category,
        priority: input.priority,
        title: input.title,
        description: null,
        subject_person_id: input.subjectPersonId ?? null,
        subject_household_id: null,
        owner_person_id: null,
        owner_queue: input.ownerQueue ?? null,
        related_records: json(relatedRecords),
        origin_access_review_id: input.origin?.type === 'access_review' ? input.origin.id : null,
        origin_exception_id:
          input.origin?.type === 'operational_exception' ? input.origin.id : null,
        due_at: this.dueAt(now, input.priority),
        resolution_kind: null,
        resolution_summary: null,
        resolved_at: null,
        resolved_by: null,
        closed_at: null,
        opened_by: json(snapshotActor(actor)),
        opened_by_person_id: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        input.origin?.type === 'access_review'
          ? oc
              .columns(['organization_id', 'origin_access_review_id'])
              .where(sql<SqlBool>`origin_access_review_id is not null and status <> 'closed'`)
              .doNothing()
          : oc
              .columns(['organization_id', 'origin_exception_id'])
              .where(sql<SqlBool>`origin_exception_id is not null and status <> 'closed'`)
              .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      const live = await this.liveCaseForOrigin(trx, organizationId, input.origin ?? null);
      if (!live) throw errors.internal('the live case for the origin vanished');
      return { caseId: live.id, deduplicated: true };
    }
    await this.afterOpen(trx, actor, id, input.correlationId ?? null, {
      priority: input.priority,
      origin: input.origin ?? null,
      reason: null,
    });
    return { caseId: id, deduplicated: false };
  }

  private async afterOpen(
    trx: Trx,
    actor: Principal,
    id: string,
    correlationId: string | null,
    extra: {
      priority: CasePriority;
      origin: { type: string; id: string } | null;
      reason: string | null;
    },
  ): Promise<void> {
    const row = await this.loadForUpdate(trx, actor.organizationId as string, id);
    if (!row) throw errors.internal('opened case vanished');
    await this.appendEvent(trx, row, {
      kind: 'status',
      fromStatus: null,
      toStatus: 'open',
      details: { event: 'open', priority: extra.priority, origin: extra.origin },
      actor,
    });
    await this.audit.record(trx, {
      organizationId: row.organization_id,
      actor,
      action: SupportActions.openCase.id,
      targetType: 'support_case',
      targetId: id,
      afterRevision: 1,
      reason: extra.reason,
      correlationId,
      // Identifiers and enumerations only: descriptions may hold customer information (§4.14).
      details: {
        category: row.category,
        priority: row.priority,
        subjectPersonId: row.subject_person_id,
        origin: extra.origin,
      },
    });
    await this.outbox.enqueue(trx, CaseOpened, {
      organizationId: row.organization_id,
      aggregateType: 'support_case',
      aggregateId: id,
      payload: {
        caseId: id,
        category: row.category,
        priority: row.priority,
        facilityId: row.facility_id,
        subjectPersonId: row.subject_person_id,
        ownerPersonId: row.owner_person_id,
        ownerQueue: row.owner_queue,
        origin: extra.origin,
      },
      correlationId,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<CaseDetail> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('case');
    await this.requireOn(principal, SupportActions.readCase, row);
    return this.detail(this.db, organizationId, id);
  }

  async list(principal: Principal, query: ListCasesQuery): Promise<Page<Case>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, SupportActions.readCase, {
      type: 'support_case',
      organizationId,
      facilityId: query.facilityId ?? null,
    });
    const cursor = decodeCursor(query.cursor, ListCursor);
    let q = this.db
      .selectFrom('cases')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.category) q = q.where('category', '=', query.category);
    if (query.ownerPersonId) q = q.where('owner_person_id', '=', query.ownerPersonId);
    if (query.ownerQueue) q = q.where('owner_queue', '=', query.ownerQueue);
    if (query.subjectPersonId) q = q.where('subject_person_id', '=', query.subjectPersonId);
    if (query.facilityId) q = q.where('facility_id', '=', query.facilityId);
    // Facility-scoped staff see cases of their facilities and organization-wide cases (§4.3).
    if (principal.kind === 'staff' && principal.facilityIds.length > 0) {
      const facilityIds = principal.facilityIds;
      q = q.where((eb) =>
        eb.or([eb('facility_id', 'is', null), eb('facility_id', 'in', facilityIds)]),
      );
    }
    if (cursor) {
      q = q.where(
        sql<SqlBool>`(created_at, id) < (${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const now = this.clock.now();
    const items = rows.slice(0, query.limit).map((r) => toCase(r, now));
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeCursor({ createdAt: iso(last.created_at), id: last.id }) : null,
    };
  }

  /** Cases about any of the people (timeline source); authorization is the caller's. */
  async casesAbout(organizationId: string, personIds: readonly string[], limit: number) {
    if (personIds.length === 0) return [];
    return this.db
      .selectFrom('cases')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_person_id', 'in', [...personIds])
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
  }

  async casesByIds(organizationId: string, ids: readonly string[]) {
    if (ids.length === 0) return [];
    return this.db
      .selectFrom('cases')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', 'in', [...ids])
      .execute();
  }

  // -------------------------------------------------------------------------------------------
  // Work: update, assign, transition, note
  // -------------------------------------------------------------------------------------------

  async update(
    principal: Principal,
    id: string,
    input: UpdateCaseInput,
    correlationId: string | null,
  ): Promise<CaseDetail> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadWorkable(trx, principal, organizationId, id, 'update');
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (input.facilityId) await this.assertFacility(trx, organizationId, input.facilityId);
      if (input.facilityId !== undefined && input.facilityId !== row.facility_id) {
        // Moving a case to a facility is itself scoped: the operator must work in that facility.
        await this.authorization.require(principal, SupportActions.workCase, {
          type: 'support_case',
          id,
          organizationId,
          facilityId: input.facilityId,
        });
      }
      const priority = input.priority ?? row.priority;
      const fields = Object.keys(input).filter(
        (k) => !['expectedRevision', 'reason', 'policyReferences'].includes(k),
      );
      await this.updateRow(trx, row, {
        category: input.category ?? row.category,
        priority,
        title: input.title ?? row.title,
        description: input.description === undefined ? row.description : input.description,
        facility_id: input.facilityId === undefined ? row.facility_id : input.facilityId,
        related_records: input.relatedRecords
          ? json(uniqueRefs(input.relatedRecords))
          : json(recordRefs(row.related_records)),
        due_at:
          priority !== row.priority ? this.dueAt(new Date(row.created_at), priority) : row.due_at,
      });
      const updated = await this.reload(trx, row);
      await this.appendEvent(trx, updated, {
        kind: 'update',
        details: {
          fields,
          ...(input.priority && input.priority !== row.priority
            ? { priority: { from: row.priority, to: input.priority } }
            : {}),
          ...(input.category && input.category !== row.category
            ? { category: { from: row.category, to: input.category } }
            : {}),
        },
        actor: principal,
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: SupportActions.workCase.id,
        targetType: 'support_case',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { change: 'update', fields },
      });
      await this.outbox.enqueue(trx, CaseUpdated, {
        organizationId,
        aggregateType: 'support_case',
        aggregateId: id,
        payload: { caseId: id, fields, revision: row.revision + 1 },
        correlationId,
      });
      return this.detail(trx, organizationId, id);
    });
  }

  async assign(
    principal: Principal,
    id: string,
    input: AssignCaseInput,
    correlationId: string | null,
  ): Promise<CaseDetail> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadWorkable(trx, principal, organizationId, id, 'assign');
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (input.ownerPersonId) {
        await this.assertCaseHandler(trx, organizationId, input.ownerPersonId, row.facility_id);
      }
      const ownerQueue = input.ownerQueue === undefined ? row.owner_queue : input.ownerQueue;
      if (ownerQueue) await this.queues.assertKnown(trx, organizationId, ownerQueue);
      if (input.ownerPersonId === null && ownerQueue === null) {
        throw errors.validation('A case needs an owner or a queue.', { code: 'CASE_UNOWNED' });
      }
      await this.updateRow(trx, row, {
        owner_person_id: input.ownerPersonId,
        owner_queue: ownerQueue,
      });
      const updated = await this.reload(trx, row);
      await this.appendEvent(trx, updated, {
        kind: 'assignment',
        details: {
          from: { personId: row.owner_person_id, queue: row.owner_queue },
          to: { personId: input.ownerPersonId, queue: ownerQueue },
        },
        actor: principal,
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: SupportActions.workCase.id,
        targetType: 'support_case',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { change: 'assign', ownerPersonId: input.ownerPersonId, ownerQueue },
      });
      await this.outbox.enqueue(trx, CaseAssigned, {
        organizationId,
        aggregateType: 'support_case',
        aggregateId: id,
        payload: { caseId: id, ownerPersonId: input.ownerPersonId, ownerQueue },
        correlationId,
      });
      return this.detail(trx, organizationId, id);
    });
  }

  async transition(
    principal: Principal,
    id: string,
    input: TransitionCaseInput,
    correlationId: string | null,
  ): Promise<CaseDetail> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadForUpdate(trx, organizationId, id);
      if (!row) throw errors.protectedNotFound('case');
      await this.requireOn(principal, SupportActions.workCase, row);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const to = CaseMachine.next(row.status, input.event);
      const now = this.clock.now();
      if (input.event === 'resolve' && input.resolution?.kind === 'action_taken') {
        // SPK-SUPPORT-003: "action taken" means an authorized command ran; a note never counts.
        const evidence = await trx
          .selectFrom('case_actions')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('case_id', '=', id)
          .where('status', '=', 'succeeded')
          .executeTakeFirst();
        if (!evidence) {
          throw new DomainError(
            'RESOURCE_CONFLICT',
            'A case is resolved as action taken only after an authorized command is linked to it.',
            { details: { code: 'ACTION_REQUIRED' }, nextAction: 'link_authorized_action' },
          );
        }
      }
      await this.updateRow(trx, row, {
        status: to,
        ...(to === 'resolved'
          ? {
              resolution_kind: input.resolution?.kind ?? null,
              resolution_summary: input.resolution?.summary ?? null,
              resolved_at: now,
              resolved_by: json(snapshotActor(principal)),
            }
          : {}),
        ...(input.event === 'reopen'
          ? {
              resolution_kind: null,
              resolution_summary: null,
              resolved_at: null,
              resolved_by: null,
            }
          : {}),
        ...(to === 'closed' ? { closed_at: now } : {}),
      });
      const updated = await this.reload(trx, row);
      await this.appendEvent(trx, updated, {
        kind: 'status',
        fromStatus: row.status,
        toStatus: to,
        body: input.resolution?.summary ?? null,
        details: { event: input.event, resolutionKind: input.resolution?.kind ?? null },
        actor: principal,
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: SupportActions.workCase.id,
        targetType: 'support_case',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          change: 'transition',
          event: input.event,
          from: row.status,
          to,
          resolutionKind: input.resolution?.kind ?? null,
        },
      });
      await this.outbox.enqueue(trx, CaseStatusChanged, {
        organizationId,
        aggregateType: 'support_case',
        aggregateId: id,
        payload: {
          caseId: id,
          from: row.status,
          to,
          resolutionKind: input.resolution?.kind ?? null,
        },
        correlationId,
      });
      return this.detail(trx, organizationId, id);
    });
  }

  async addNote(
    principal: Principal,
    id: string,
    input: AddCaseNoteInput,
    correlationId: string | null,
  ): Promise<CaseDetail> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadWorkable(trx, principal, organizationId, id, 'add_note');
      // A note is history only: no other module's state is read or changed (SPK-SUPPORT-003).
      const eventId = await this.appendEvent(trx, row, {
        kind: 'note',
        body: input.body,
        actor: principal,
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: SupportActions.workCase.id,
        targetType: 'support_case',
        targetId: id,
        reason: input.reason ?? null,
        correlationId,
        details: { change: 'note', caseEventId: eventId },
      });
      await this.outbox.enqueue(trx, CaseNoteAdded, {
        organizationId,
        aggregateType: 'support_case',
        aggregateId: id,
        payload: { caseId: id, caseEventId: eventId },
        correlationId,
      });
      return this.detail(trx, organizationId, id);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Hooks (outbox handlers): SPK-IAM-005 escalation, SPK-IAM-007 merges
  // -------------------------------------------------------------------------------------------

  /**
   * `identity.access_review_decided`: an escalated disputed-access review becomes a support case
   * owned by the review's owner role (SPK-IAM-005 "escalation"). Later decisions and closure of
   * the review are recorded on the case for its owner; the case is never resolved from them
   * (resolution is a staff decision, never inferred from family membership).
   */
  async onAccessReviewDecided(
    trx: Trx,
    event: DomainEvent<{ reviewId: string; subjectPersonId: string; kind: string; status: string }>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const { reviewId, subjectPersonId, kind, status } = event.payload;
    const origin = { type: 'access_review' as const, id: reviewId };
    if (kind === 'escalate') {
      const review = await this.accessReviews.detail(trx, organizationId, reviewId);
      const opened = await this.openSystemCase(trx, {
        organizationId,
        category: 'access',
        priority: this.policy.accessEscalationPriority,
        title: 'Escalated disputed-access review',
        subjectPersonId,
        ownerQueue: review.ownerRole,
        relatedRecords: [{ type: 'person', id: subjectPersonId }],
        origin,
        correlationId: event.correlationId,
        actorLabel: 'support.access_escalation',
      });
      if (!opened.deduplicated) return;
      const live = await this.loadForUpdate(trx, organizationId, opened.caseId);
      if (!live) return;
      await this.appendEvent(trx, live, {
        kind: 'update',
        details: { accessReview: { reviewId, kind, status }, sourceEventId: event.id },
        actor: systemPrincipal(organizationId, 'support.access_escalation'),
      });
      return;
    }
    const live = await this.liveCaseForOrigin(trx, organizationId, origin);
    if (!live) return;
    const row = await this.loadForUpdate(trx, organizationId, live.id);
    if (!row) return;
    await this.appendEvent(trx, row, {
      kind: 'update',
      details: { accessReview: { reviewId, kind, status }, sourceEventId: event.id },
      actor: systemPrincipal(organizationId, 'support.access_escalation'),
    });
  }

  /**
   * `identity.persons_merged`: live cases about the merged person move to the survivor with a
   * history entry; closed cases keep their history and are indexed for the survivor's timeline
   * (SPK-IAM-007 "preserve history").
   */
  async onPersonsMerged(
    trx: Trx,
    event: DomainEvent<{ survivorPersonId: string; mergedPersonId: string }>,
  ): Promise<void> {
    const organizationId = event.organizationId;
    const { survivorPersonId, mergedPersonId } = event.payload;
    const actor = systemPrincipal(organizationId, 'support.person_merge');
    const rows = await trx
      .selectFrom('cases')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('subject_person_id', '=', mergedPersonId)
      .forUpdate()
      .execute();
    for (const row of rows) {
      await trx
        .insertInto('timeline_references')
        .values({
          id: newId(),
          organization_id: organizationId,
          person_id: survivorPersonId,
          record_type: 'support_case',
          record_id: row.id,
          relation: 'subject',
          facility_id: row.facility_id,
          occurred_at: row.created_at,
          source_event_id: event.id,
          source_event_type: event.type,
          summary: json({ mergedPersonId }),
        })
        .onConflict((oc) =>
          oc
            .columns([
              'organization_id',
              'source_event_id',
              'person_id',
              'record_type',
              'record_id',
            ])
            .doNothing(),
        )
        .execute();
      if (row.status === 'closed') continue;
      await this.updateRow(trx, row, { subject_person_id: survivorPersonId });
      const updated = await this.reload(trx, row);
      await this.appendEvent(trx, updated, {
        kind: 'update',
        details: {
          fields: ['subjectPersonId'],
          merge: { from: mergedPersonId, to: survivorPersonId },
          sourceEventId: event.id,
        },
        actor,
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Shared internals (also used by CaseActionsService)
  // -------------------------------------------------------------------------------------------

  async load(db: Reader, organizationId: string, id: string): Promise<CaseRow | undefined> {
    return db
      .selectFrom('cases')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async loadForUpdate(trx: Trx, organizationId: string, id: string): Promise<CaseRow | undefined> {
    return trx
      .selectFrom('cases')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
  }

  /** Loads with a lock, authorizes `action` on the case, and refuses a closed case. */
  async loadWorkable(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    id: string,
    operation: string,
    action: ActionDefinition = SupportActions.workCase,
  ): Promise<CaseRow> {
    const row = await this.loadForUpdate(trx, organizationId, id);
    if (!row) throw errors.protectedNotFound('case');
    await this.requireOn(principal, action, row);
    if (row.status === 'closed') throw errors.invalidTransition('Case', 'closed', operation);
    return row;
  }

  /** Object-level authorization against the real case: facility scope and protected subject. */
  async requireOn(principal: Principal, action: ActionDefinition, row: CaseRow): Promise<void> {
    await this.authorization.require(principal, action, {
      type: 'support_case',
      id: row.id,
      organizationId: row.organization_id,
      facilityId: row.facility_id,
      subjectPersonIds: row.subject_person_id ? [row.subject_person_id] : [],
      protected: true,
    });
  }

  async appendEvent(trx: Trx, row: CaseRow, input: AppendEventInput): Promise<string> {
    const last = await trx
      .selectFrom('case_events')
      .select((eb) => eb.fn.max<number>('sequence').as('n'))
      .where('organization_id', '=', row.organization_id)
      .where('case_id', '=', row.id)
      .executeTakeFirst();
    const id = newId();
    await trx
      .insertInto('case_events')
      .values({
        id,
        organization_id: row.organization_id,
        case_id: row.id,
        sequence: Number(last?.n ?? 0) + 1,
        kind: input.kind,
        body: input.body ?? null,
        from_status: input.fromStatus ?? null,
        to_status: input.toStatus ?? null,
        case_action_id: input.caseActionId ?? null,
        details: json(input.details ?? {}),
        actor: json(snapshotActor(input.actor)),
        actor_person_id: await this.knownPerson(trx, row.organization_id, input.actor.personId),
        occurred_at: this.clock.now(),
      })
      .execute();
    return id;
  }

  async detail(db: Reader, organizationId: string, id: string): Promise<CaseDetail> {
    const row = await this.load(db, organizationId, id);
    if (!row) throw errors.protectedNotFound('case');
    const events = await db
      .selectFrom('case_events')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('case_id', '=', id)
      .orderBy('sequence')
      .execute();
    const actions = await db
      .selectFrom('case_actions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('case_id', '=', id)
      .orderBy('requested_at')
      .orderBy('id')
      .execute();
    return {
      ...toCase(row, this.clock.now()),
      events: events.map(toCaseEvent),
      actions: actions.map(toCaseAction),
    };
  }

  private async updateRow(
    trx: Trx,
    row: CaseRow,
    patch: UpdateObject<Database, 'cases'>,
  ): Promise<void> {
    const result = await trx
      .updateTable('cases')
      .set({ ...patch, revision: row.revision + 1 })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      throw errors.staleRevision(row.revision, row.revision + 1);
    }
  }

  private async reload(trx: Trx, row: CaseRow): Promise<CaseRow> {
    const fresh = await this.load(trx, row.organization_id, row.id);
    if (!fresh) throw errors.internal('case vanished');
    return fresh;
  }

  private async liveCaseForOrigin(
    db: Reader,
    organizationId: string,
    origin: { type: 'access_review' | 'operational_exception'; id: string } | null,
  ): Promise<{ id: string } | undefined> {
    if (!origin) return undefined;
    return db
      .selectFrom('cases')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where(
        origin.type === 'access_review' ? 'origin_access_review_id' : 'origin_exception_id',
        '=',
        origin.id,
      )
      .where('status', '<>', 'closed')
      .executeTakeFirst();
  }

  private dueAt(openedAt: Date, priority: CasePriority): Date {
    return addMinutesTo(openedAt, this.policy.caseDueMinutes[priority]);
  }

  private async assertFacility(db: Reader, organizationId: string, facilityId: string) {
    const facility = await db
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!facility) throw errors.notFound('facility', facilityId);
  }

  private async assertPerson(trx: Trx, organizationId: string, personId: string): Promise<void> {
    const person = await this.persons.findPerson(organizationId, personId, trx);
    if (!person) throw errors.protectedNotFound('person');
    if (person.status === 'merged') {
      throw errors.validation('The person was merged; open the case for the surviving record.', {
        code: 'PERSON_MERGED',
        canonicalPersonId: person.canonicalPersonId,
      });
    }
  }

  /** The owner must currently hold a role that works cases (in the case's facility, if any). */
  private async assertCaseHandler(
    trx: Trx,
    organizationId: string,
    personId: string,
    facilityId: string | null,
  ): Promise<void> {
    for (const role of SupportActions.workCase.staffRoles as readonly StaffRole[]) {
      const holders = await this.staff.staffWithRole(organizationId, role, facilityId, trx);
      if (holders.includes(personId)) return;
    }
    throw errors.validation('The owner must be a current staff member who works support cases.', {
      code: 'OWNER_NOT_CASE_STAFF',
    });
  }

  /** The actor's person id when it exists in the organization (fixtures may use free ids). */
  private async knownPerson(
    trx: Trx,
    organizationId: string,
    personId: string | null,
  ): Promise<string | null> {
    if (!personId) return null;
    const person = await this.persons.findPerson(organizationId, personId, trx);
    return person ? person.id : null;
  }
}
