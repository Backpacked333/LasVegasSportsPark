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
  type CustomerCase,
  type CustomerSupportRequestInput,
  type DomainEvent,
  type ListCasesQuery,
  type ListMyCasesQuery,
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
  type CaseOpenedVia,
  type CasePriority,
  type CaseStatus,
  type Database,
  type Db,
  type RecordReference,
} from '@sportspark/db';
import { sql, type SqlBool, type UpdateObject } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  FacilityDirectory,
  OperationalExceptions,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type ActionDefinition,
  type Clock,
  type Trx,
  listFacilityScope,
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
  isoOrNull,
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
import { RelatedRecordsVerifier } from './related-records';

const ListCursor = z.object({ createdAt: z.iso.datetime(), id: z.uuid() });

/** An operation linked to a case that waits for recovery (SUP-04, §4.11). */
export interface RecoveryOperation {
  operationId: string;
  kind: string;
  status: 'recovery_required';
}

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
    private readonly facilities: FacilityDirectory,
    private readonly kernelExceptions: OperationalExceptions,
    private readonly operations: OperationsService,
    private readonly relatedRecords: RelatedRecordsVerifier,
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
          // §4.2 (SUP-02): the kernel's exception read, never its table.
          const exception = await this.kernelExceptions.get(
            organizationId,
            input.originExceptionId,
            trx,
          );
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
            // A case that coordinates an exception was opened for that origin record (1102).
            opened_via: input.originExceptionId ? 'hook' : 'staff',
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
          action: SupportActions.openCase,
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
        // An origin record makes it a hook case; without one it is an internal case (1102).
        opened_via: input.origin ? 'hook' : 'staff',
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
      action: SupportActions.openCase,
    });
    return { caseId: id, deduplicated: false };
  }

  // -------------------------------------------------------------------------------------------
  // Customer support requests (SUP-01: SPK-SUPPORT-002, SPK-CAP-001, SCR-C-22, SCR-C-38)
  // -------------------------------------------------------------------------------------------

  /**
   * POST /me/support-requests: a customer contacts the operating team about themselves, someone
   * they hold `view` over, or a team entry they captain (`support.request_support`). The subject,
   * the team and every linked record are authorized with the customer's own principal; anything
   * they may not see is not found (§4.10). The case is routed to the queue the support policy
   * names for its category (pending DEC-015) and the customer later reads only its status.
   */
  async requestSupport(
    principal: Principal,
    input: CustomerSupportRequestInput,
    correlationId: string | null,
  ): Promise<CustomerCase> {
    const organizationId = organizationOf(principal);
    if (!principal.personId) throw errors.authenticationRequired();
    const subjectPersonId = input.subjectPersonId ?? principal.personId;
    await this.authorization.require(principal, SupportActions.requestSupport, {
      type: 'support_request',
      organizationId,
      subjectPersonIds: [subjectPersonId],
      protected: true,
    });
    if (input.teamEntryId) {
      // SPK-CAP-001: only the entry's captain contacts the operating team for the team.
      await this.authorization.require(principal, SupportActions.requestSupport, {
        type: 'team_entry',
        id: input.teamEntryId,
        organizationId,
        teamEntryId: input.teamEntryId,
        subjectPersonIds: [],
        protected: true,
      });
    }
    // The owning modules read through the root database: verify before support's transaction.
    const linked = await this.relatedRecords.verify(
      principal,
      input.relatedRecords.filter((r) => !(r.type === 'team_entry' && r.id === input.teamEntryId)),
    );
    const relatedRecords: RecordReference[] = uniqueRefs([
      ...(input.teamEntryId ? [{ type: 'team_entry', id: input.teamEntryId }] : []),
      ...linked,
    ]);
    const ownerQueue = this.policy.customerRequestQueues[input.category];
    const priority = this.policy.customerRequestPriority;
    return this.uow.run(async ({ trx }) => {
      const subject = await this.persons.findPerson(organizationId, subjectPersonId, trx);
      if (!subject) throw errors.protectedNotFound('person');
      if (subject.status === 'merged') {
        throw errors.validation(
          'The person was merged; open the request for the surviving record.',
          {
            code: 'PERSON_MERGED',
          },
        );
      }
      const opener = await this.knownPerson(trx, organizationId, principal.personId);
      if (!opener) throw errors.protectedNotFound('person');
      await this.queues.assertKnown(trx, organizationId, ownerQueue);
      const id = newId();
      const now = this.clock.now();
      await trx
        .insertInto('cases')
        .values({
          id,
          organization_id: organizationId,
          facility_id: null,
          category: input.category,
          priority,
          title: input.title,
          description: input.description,
          subject_person_id: subjectPersonId,
          subject_household_id: null,
          owner_person_id: null,
          owner_queue: ownerQueue,
          related_records: json(relatedRecords),
          origin_access_review_id: null,
          origin_exception_id: null,
          due_at: this.dueAt(now, priority),
          resolution_kind: null,
          resolution_summary: null,
          resolved_at: null,
          resolved_by: null,
          closed_at: null,
          opened_by: json(snapshotActor(principal)),
          opened_by_person_id: opener,
          opened_via: 'customer',
          created_at: now,
          updated_at: now,
        })
        .execute();
      await this.afterOpen(trx, principal, id, correlationId, {
        priority,
        origin: null,
        reason: input.reason ?? null,
        action: SupportActions.requestSupport,
      });
      const row = await this.load(trx, organizationId, id);
      if (!row) throw errors.internal('opened case vanished');
      return toCustomerCase(row);
    });
  }

  /** GET /me/cases: the caller's own requests (opened under any of their merged records). */
  async myCases(principal: Principal, query: ListMyCasesQuery): Promise<Page<CustomerCase>> {
    const organizationId = organizationOf(principal);
    const openers = await this.requireOwnRequests(principal, organizationId);
    const cursor = decodeCursor(query.cursor, ListCursor);
    let q = this.db
      .selectFrom('cases')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('opened_via', '=', 'customer')
      .where('opened_by_person_id', 'in', openers)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) {
      q = q.where(
        sql<SqlBool>`(created_at, id) < (${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items: rows.slice(0, query.limit).map(toCustomerCase),
      nextCursor: last ? encodeCursor({ createdAt: iso(last.created_at), id: last.id }) : null,
    };
  }

  /** GET /me/cases/{id}: one of the caller's own requests; anyone else's is not found. */
  async myCase(principal: Principal, id: string): Promise<CustomerCase> {
    const organizationId = organizationOf(principal);
    const openers = await this.requireOwnRequests(principal, organizationId);
    const row = await this.load(this.db, organizationId, id);
    if (
      !row ||
      row.opened_via !== 'customer' ||
      !row.opened_by_person_id ||
      !openers.includes(row.opened_by_person_id)
    ) {
      throw errors.protectedNotFound('case');
    }
    return toCustomerCase(row);
  }

  /** The people whose requests are the caller's (SUP-05: their merged records resolve to them). */
  private async requireOwnRequests(principal: Principal, organizationId: string) {
    const personId = principal.personId;
    if (!personId) throw errors.protectedNotFound('case');
    await this.authorization.require(principal, SupportActions.requestSupport, {
      type: 'support_request',
      organizationId,
      subjectPersonIds: [personId],
      protected: true,
    });
    return this.resolvingIds(organizationId, personId);
  }

  /** `[canonical, ...merged into it]` (IF-09, SPK-IAM-007); the id itself when unknown. */
  async resolvingIds(organizationId: string, personId: string, trx?: Trx): Promise<string[]> {
    const ids = await this.persons.personIdsResolvingTo(organizationId, personId, trx);
    return ids.length > 0 ? ids : [personId];
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
      action: ActionDefinition;
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
      action: extra.action.id,
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
        openedVia: row.opened_via,
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
        openedVia: row.opened_via,
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

  /** Case views with each subject's surviving person (SUP-05; the subject id is never rewritten). */
  async views(db: Reader, rows: readonly CaseRow[]): Promise<Case[]> {
    const now = this.clock.now();
    const canonical = new Map<string, string>();
    for (const row of rows) {
      const subject = row.subject_person_id;
      if (!subject || canonical.has(subject)) continue;
      canonical.set(
        subject,
        await this.persons.resolveCanonicalPersonId(
          row.organization_id,
          subject,
          transactionOf(db),
        ),
      );
    }
    return rows.map((row) =>
      toCase(
        row,
        now,
        row.subject_person_id ? (canonical.get(row.subject_person_id) ?? null) : null,
      ),
    );
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
    if (query.subjectPersonId) {
      // SUP-05 (SPK-IAM-007): a survivor's search includes the cases of people merged into it.
      const ids = await this.resolvingIds(organizationId, query.subjectPersonId);
      q = q.where('subject_person_id', 'in', ids);
    }
    if (query.facilityId) q = q.where('facility_id', '=', query.facilityId);
    switch (query.origin) {
      case 'staff':
      case 'customer':
        q = q.where('opened_via', '=', query.origin);
        break;
      case 'access_review':
        q = q.where('origin_access_review_id', 'is not', null);
        break;
      case 'exception':
        q = q.where('origin_exception_id', 'is not', null);
        break;
      default:
        break;
    }
    // Facility-scoped staff see cases of their facilities and organization-wide cases (§4.3),
    // through the roles that hold the read action (§4.14, identity-05).
    const scope = listFacilityScope(principal, SupportActions.readCase);
    if (scope) {
      const facilityIds = [...scope];
      q = q.where((eb) =>
        facilityIds.length > 0
          ? eb.or([eb('facility_id', 'is', null), eb('facility_id', 'in', facilityIds)])
          : eb('facility_id', 'is', null),
      );
    }
    if (cursor) {
      q = q.where(
        sql<SqlBool>`(created_at, id) < (${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const items = await this.views(this.db, rows.slice(0, query.limit));
    const last = rows.length > query.limit ? rows[query.limit - 1] : undefined;
    return {
      items,
      nextCursor: last ? encodeCursor({ createdAt: iso(last.created_at), id: last.id }) : null,
    };
  }

  /**
   * Timeline source (SPK-SUPPORT-001, SUP-03): the opening, reopening, resolution and closure of
   * the cases about any of `personIds`, newest first after `after` (case history keyset).
   * Authorization is the caller's.
   */
  async statusHistoryAbout(
    organizationId: string,
    personIds: readonly string[],
    after: { at: string; id: string } | null,
    limit: number,
  ) {
    if (personIds.length === 0) return [];
    let q = this.db
      .selectFrom('case_events as e')
      .innerJoin('cases as c', (join) =>
        join.onRef('c.organization_id', '=', 'e.organization_id').onRef('c.id', '=', 'e.case_id'),
      )
      .selectAll('c')
      .select([
        'e.id as event_id',
        'e.occurred_at as event_at',
        'e.from_status as event_from',
        'e.to_status as event_to',
        'e.details as event_details',
      ])
      .where('e.organization_id', '=', organizationId)
      .where('e.kind', '=', 'status')
      .where('e.to_status', 'in', ['open', 'resolved', 'closed'])
      .where('c.subject_person_id', 'in', [...personIds])
      .orderBy('e.occurred_at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(limit);
    if (after) {
      q = q.where(
        sql<SqlBool>`(e.occurred_at, e.id) < (${new Date(after.at)}::timestamptz, ${after.id}::uuid)`,
      );
    }
    return q.execute();
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
    // SUP-04: the operations linked to the case are read before support's transaction (the
    // kernel's operation read uses the root database); the refusal itself comes after the case's
    // own authorization, so a caller who may not see the case learns nothing from it.
    const recovery =
      input.event === 'resolve' || input.event === 'close'
        ? await this.relatedRecovery(organizationId, id)
        : [];
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadForUpdate(trx, organizationId, id);
      if (!row) throw errors.protectedNotFound('case');
      await this.requireOn(principal, SupportActions.workCase, row);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const to = CaseMachine.next(row.status, input.event);
      const now = this.clock.now();
      if (to === 'closed') {
        // support-migration-09: an action whose outcome is unknown must be settled first, or the
        // outcome could never be recorded on the case (§4.7 invariant 12). The database refuses
        // the same close (cases_close_requires_settled_actions).
        const unsettled = await trx
          .selectFrom('case_actions')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('case_id', '=', id)
          .where('status', 'in', ['requested', 'unknown'])
          .execute();
        if (unsettled.length) {
          throw new DomainError(
            'RESOURCE_CONFLICT',
            'This case has an action whose outcome is not recorded yet; record it before closing the case.',
            {
              details: {
                code: 'ACTION_OUTCOME_UNKNOWN',
                caseActionIds: unsettled.map((a) => a.id),
              },
              nextAction: 'settle_case_action',
            },
          );
        }
      }
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
      // SUP-04, after the rules no acknowledgment overrides (unsettled actions, action taken).
      if (recovery.length > 0 && !input.acknowledgeOpenRecovery) {
        // §4.11 "unknown kept explicit until reconciled": a case is not resolved or closed as if
        // its related work were done while that work still waits for recovery.
        throw new DomainError(
          'RESOURCE_CONFLICT',
          'A record related to this case is still in recovery; acknowledge it with a reason to resolve or close the case anyway.',
          { details: { code: 'RELATED_RECORD_IN_RECOVERY', operations: recovery } },
        );
      }
      const acknowledgedRecovery =
        recovery.length > 0 && input.acknowledgeOpenRecovery
          ? recovery.map((r) => r.operationId)
          : null;
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
        details: {
          event: input.event,
          resolutionKind: input.resolution?.kind ?? null,
          ...(acknowledgedRecovery ? { acknowledgedOpenRecovery: acknowledgedRecovery } : {}),
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
        details: {
          change: 'transition',
          event: input.event,
          from: row.status,
          to,
          resolutionKind: input.resolution?.kind ?? null,
          // SUP-04: who resolved or closed past an open recovery, of which operations, and why.
          ...(acknowledgedRecovery ? { acknowledgedOpenRecovery: acknowledgedRecovery } : {}),
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
   * SUP-04 (§4.11, SPK-UX-006): the operations linked to a case — its case actions' command and
   * coordinating operations and related records of type `operation` — that are
   * `recovery_required`, read through the kernel's OperationsService (a lookup by id, after which
   * the case's own authorization applies). Other record types keep their recovery state in their
   * owning module, which exposes no such read yet.
   */
  async relatedRecovery(organizationId: string, caseId: string): Promise<RecoveryOperation[]> {
    const row = await this.load(this.db, organizationId, caseId);
    if (!row) return [];
    const actions = await this.db
      .selectFrom('case_actions')
      .select(['command_operation_id', 'support_operation_id'])
      .where('organization_id', '=', organizationId)
      .where('case_id', '=', caseId)
      .execute();
    const ids = new Set<string>();
    for (const a of actions) {
      if (a.command_operation_id) ids.add(a.command_operation_id);
      if (a.support_operation_id) ids.add(a.support_operation_id);
    }
    for (const ref of recordRefs(row.related_records)) {
      if (ref.type === 'operation' && OperationId.safeParse(ref.id).success) ids.add(ref.id);
    }
    const lookup = systemPrincipal(organizationId, 'support.case_recovery_check');
    const out: RecoveryOperation[] = [];
    for (const operationId of [...ids].sort()) {
      try {
        const operation = await this.operations.find(lookup, operationId);
        if (operation.status === 'recovery_required') {
          out.push({ operationId, kind: operation.kind, status: 'recovery_required' });
        }
      } catch (error) {
        if (!DomainError.is(error) || error.code !== 'NOT_FOUND') throw error;
      }
    }
    return out;
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
    options: { allowClosed?: boolean } = {},
  ): Promise<CaseRow> {
    const row = await this.loadForUpdate(trx, organizationId, id);
    if (!row) throw errors.protectedNotFound('case');
    await this.requireOn(principal, action, row);
    // A closed case accepts no new action; recording the outcome of an action it already has is
    // not a new action (support-migration-09, §4.7 invariant 12).
    if (row.status === 'closed' && !options.allowClosed) {
      throw errors.invalidTransition('Case', 'closed', operation);
    }
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
    const [view] = await this.views(db, [row]);
    if (!view) throw errors.internal('case view vanished');
    return {
      ...view,
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
    // §4.2 (SUP-02): the kernel's facility directory, never its table.
    const found = await this.facilities.describe(organizationId, [facilityId], db);
    if (!found.has(facilityId)) throw errors.notFound('facility', facilityId);
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

const OperationId = z.uuid();

/** The handle to pass a port: the transaction itself, or none (the port reads the root database). */
function transactionOf(db: Reader): Trx | undefined {
  return 'isTransaction' in db && db.isTransaction ? (db as Trx) : undefined;
}

/** SUP-01: what a customer sees of their own request — never notes, owner or internals (§4.14). */
export function toCustomerCase(row: CaseRow): CustomerCase {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    resolvedAt: isoOrNull(row.resolved_at),
  };
}

export type { CaseOpenedVia };
