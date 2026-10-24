import { Inject, Injectable } from '@nestjs/common';
import {
  AssignmentMachine,
  decodeCursor,
  encodeCursor,
  errors,
  newId,
  systemPrincipal,
  z,
  type Assignment,
  type AssignmentOutcome,
  type AssignmentStatus,
  type AssignmentTransitionBody,
  type CreateAssignmentBody,
  type DeclineAssignmentBody,
  type DomainEvent,
  type EventPayload,
  type ListAssignmentsQuery,
  type Page,
  type Principal,
  type WithdrawAssignmentBody,
} from '@sportspark/contracts';
import {
  isExclusionViolation,
  isUniqueViolation,
  json,
  pgConstraintName,
  type AssignmentKind,
  type Database,
  type Db,
} from '@sportspark/db';
import { sql, type UpdateObject } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationsService,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type HandlerContext,
  type Trx,
} from '../../../kernel';
import type { CatalogEvents } from '../../catalog';
import type { CompetitionEvents } from '../../competition';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import type { EventChanged } from '../../scheduling';
import { WorkforceActions } from '../workforce.actions';
import { WorkforceEvents } from '../workforce.events';
import {
  WORKFORCE_POLICY,
  workforcePolicyForFacility,
  type WorkforcePolicy,
} from '../workforce.policy';
import {
  addMinutes,
  COVERING_STATUSES,
  LIVE_STATUSES,
  organizationOf,
  toAssignment,
  type AssignmentRow,
  type RequirementRow,
} from '../workforce.shared';
import { AvailabilityService } from './availability.service';
import { CommitmentChecker } from './commitment-checker';
import { CoverageService, type UncoveredCause, type UncoveredNotice } from './coverage.service';
import { QualificationsService } from './qualifications.service';
import { TargetResolver, type FacilityFacts, type ResolvedTarget } from './target-resolver';
import { TemporaryAccessService } from './temporary-access.service';

const Cursor = z.object({ start: z.string(), id: z.string() });

export interface AssignabilityInput {
  organizationId: string;
  facility: FacilityFacts;
  personId: string;
  requirement: RequirementRow | undefined;
  scheduledStart: Date;
  scheduledEnd: Date;
  turnaroundMinutes: number;
  schedulingEventId: string | null;
  ignoreAssignmentIds: string[];
  /** Declared unavailability blocks proposals and offers (staff acts); the assignee may still accept. */
  checkAvailability: boolean;
}

export interface NewAssignmentInput {
  organizationId: string;
  principal: Principal;
  target: ResolvedTarget;
  personId: string;
  kind: AssignmentKind;
  role: string;
  slot: number;
  engagement: 'regular' | 'temporary' | 'substitute';
  turnaroundMinutes: number;
  offer: boolean;
  replacesAssignmentId: string | null;
  reason: string | null;
  correlationId: string | null;
  operationId?: string | null;
}

/**
 * Assignments (§4.6 Assignment machine, SPK-STAFF-001..004, §4.8 `POST /v1/assignments/{id}/accept`).
 *
 *  - Propose/offer: staff assigners; the person must exist, hold the requirement's qualifications
 *    at the start, not have declared themselves unavailable, and be free of overlapping
 *    commitments including turnaround (SPK-STAFF-001/003).
 *  - Accept/decline: only the assignee. Acceptance re-checks qualification and commitments; the
 *    database guarantees one accepted assignment per slot and no overlapping accepted
 *    assignments of a person (turnaround included). A temporary or substitute acceptance grants
 *    time-bounded access through identity (SPK-STAFF-004) as a recorded operation.
 *  - Decline/withdraw of a required slot close to the start raises an uncovered-slot exception
 *    and event (SPK-STAFF-003, SPK-AT-012); acceptance of the slot resolves it.
 *  - Complete: staff, once the activity has started; nothing is ever deleted.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKFORCE_POLICY) private readonly policy: WorkforcePolicy,
    @Inject(PERSON_DIRECTORY_PORT) private readonly people: PersonDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly targets: TargetResolver,
    private readonly checker: CommitmentChecker,
    private readonly coverage: CoverageService,
    private readonly qualifications: QualificationsService,
    private readonly availability: AvailabilityService,
    private readonly access: TemporaryAccessService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  async create(
    principal: Principal,
    body: CreateAssignmentBody,
    correlationId: string | null,
  ): Promise<AssignmentOutcome> {
    const organizationId = organizationOf(principal);
    const target = await this.targets.resolve(organizationId, body);
    await this.authorization.require(principal, WorkforceActions.proposeAssignment, {
      type: 'assignment',
      organizationId,
      facilityId: target.facilityId,
    });
    if (body.engagement !== 'regular') {
      await this.authorization.require(principal, WorkforceActions.grantTemporaryAccess, {
        type: 'assignment',
        organizationId,
        facilityId: target.facilityId,
      });
    }
    if (target.scheduledEnd.getTime() <= this.clock.now().getTime()) {
      throw errors.validation('The activity has already ended.', { code: 'target_ended' });
    }
    const policy = workforcePolicyForFacility(this.policy, target.facilitySettings);
    const row = await this.uow.run(async ({ trx }) => {
      const requirement = await this.coverage.requirementFor(
        trx,
        organizationId,
        target.targetType,
        target.targetId,
        body.role,
      );
      if (requirement && requirement.kind !== body.kind) {
        throw errors.validation(`The ${body.role} requirement is for kind ${requirement.kind}.`, {
          requirementId: requirement.id,
        });
      }
      const slot = body.slot ?? (await this.defaultSlot(trx, organizationId, target, body.role, requirement));
      if (requirement && slot > requirement.required_count) {
        throw errors.validation(
          `Slot ${slot} exceeds the ${requirement.required_count} required ${body.role}.`,
          { requirementId: requirement.id },
        );
      }
      return this.insertAssignment(trx, {
        organizationId,
        principal,
        target,
        personId: body.personId,
        kind: body.kind,
        role: body.role,
        slot,
        engagement: body.engagement,
        turnaroundMinutes: body.turnaroundMinutes ?? policy.turnaroundMinutes[body.kind],
        offer: body.offer,
        replacesAssignmentId: null,
        reason: body.reason ?? null,
        correlationId,
      });
    });
    return { assignment: toAssignment(row, this.clock.now()), operationId: null, uncovered: null };
  }

  async offer(
    principal: Principal,
    id: string,
    body: AssignmentTransitionBody,
    correlationId: string | null,
  ): Promise<AssignmentOutcome> {
    const organizationId = organizationOf(principal);
    const existing = await this.authorizeView(principal, id);
    await this.authorization.require(principal, WorkforceActions.proposeAssignment, {
      type: 'assignment',
      id,
      organizationId,
      facilityId: existing.facility_id,
    });
    const facility = await this.targets.facility(this.db, organizationId, existing.facility_id);
    const row = await this.uow.run(async ({ trx }) => {
      const current = await this.lock(trx, organizationId, id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = AssignmentMachine.next(current.status, 'offer');
      this.assertNotEnded(current);
      await this.assertAssignable(trx, {
        organizationId,
        facility,
        personId: current.person_id,
        requirement: await this.coverage.requirementFor(
          trx,
          organizationId,
          current.target_type,
          current.target_id,
          current.role,
        ),
        scheduledStart: new Date(current.scheduled_start),
        scheduledEnd: new Date(current.scheduled_end),
        turnaroundMinutes: current.turnaround_minutes,
        schedulingEventId: current.scheduling_event_id,
        ignoreAssignmentIds: [current.id],
        checkAvailability: true,
      });
      return this.transition(trx, principal, current, next, {
        set: { offered_at: this.clock.now() },
        action: 'workforce.assignment_offered',
        reason: body.reason ?? null,
        correlationId,
      });
    });
    return { assignment: toAssignment(row, this.clock.now()), operationId: null, uncovered: null };
  }

  async accept(
    principal: Principal,
    id: string,
    body: AssignmentTransitionBody,
    correlationId: string | null,
  ): Promise<AssignmentOutcome> {
    const organizationId = organizationOf(principal);
    const existing = await this.authorizeView(principal, id);
    // §4.8: only the assignee accepts; staff who can see the assignment get an authority error.
    await this.authorization.require(principal, WorkforceActions.acceptAssignment, {
      type: 'assignment',
      id,
      organizationId,
      facilityId: existing.facility_id,
      subjectPersonIds: [existing.person_id],
    });
    const facility = await this.targets.facility(this.db, organizationId, existing.facility_id);
    const { row, operationId } = await this.uow.run(async ({ trx }) => {
      const current = await this.lock(trx, organizationId, id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = AssignmentMachine.next(current.status, 'accept');
      this.assertNotEnded(current);
      await this.assertAssignable(trx, {
        organizationId,
        facility,
        personId: current.person_id,
        requirement: await this.coverage.requirementFor(
          trx,
          organizationId,
          current.target_type,
          current.target_id,
          current.role,
        ),
        scheduledStart: new Date(current.scheduled_start),
        scheduledEnd: new Date(current.scheduled_end),
        turnaroundMinutes: current.turnaround_minutes,
        schedulingEventId: current.scheduling_event_id,
        ignoreAssignmentIds: [current.id],
        checkAvailability: false,
      });
      const needsAccess = this.access.required(current);
      const opId = needsAccess
        ? await this.operations.create(trx, {
            organizationId,
            kind: 'workforce.accept_assignment',
            requestedBy: principal,
            correlationId,
            input: { assignmentId: id, engagement: current.engagement },
            status: 'running',
          })
        : null;
      const now = this.clock.now();
      const updated = await this.transition(trx, principal, current, next, {
        set: {
          accepted_at: now,
          responded_at: now,
          access_status: needsAccess ? 'pending' : current.access_status,
        },
        action: WorkforceActions.acceptAssignment.id,
        reason: body.reason ?? null,
        correlationId,
        operationId: opId,
      });
      await this.coverage.resolveIfCovered(trx, updated, correlationId);
      return { row: updated, operationId: opId };
    });
    if (operationId) {
      await this.access.grant(principal, id, organizationId, operationId, correlationId);
    }
    const final = await this.load(this.db, organizationId, id);
    return {
      assignment: toAssignment(final ?? row, this.clock.now()),
      operationId,
      uncovered: null,
    };
  }

  async decline(
    principal: Principal,
    id: string,
    body: DeclineAssignmentBody,
    correlationId: string | null,
  ): Promise<AssignmentOutcome> {
    const organizationId = organizationOf(principal);
    const existing = await this.authorizeView(principal, id);
    await this.authorization.require(principal, WorkforceActions.declineAssignment, {
      type: 'assignment',
      id,
      organizationId,
      facilityId: existing.facility_id,
      subjectPersonIds: [existing.person_id],
    });
    const facility = await this.targets.facility(this.db, organizationId, existing.facility_id);
    const { row, uncovered } = await this.uow.run(async ({ trx }) => {
      const current = await this.lock(trx, organizationId, id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = AssignmentMachine.next(current.status, 'decline');
      const now = this.clock.now();
      const updated = await this.transition(trx, principal, current, next, {
        set: { declined_at: now, responded_at: now, decline_reason: body.reason ?? null },
        action: WorkforceActions.declineAssignment.id,
        reason: body.reason ?? null,
        correlationId,
      });
      const notice = await this.coverage.escalateIfUncovered(
        trx,
        updated,
        'declined',
        correlationId,
        facility.settings,
      );
      return { row: updated, uncovered: notice };
    });
    return { assignment: toAssignment(row, this.clock.now()), operationId: null, uncovered };
  }

  async withdraw(
    principal: Principal,
    id: string,
    body: WithdrawAssignmentBody,
    correlationId: string | null,
  ): Promise<AssignmentOutcome> {
    const organizationId = organizationOf(principal);
    const existing = await this.authorizeView(principal, id);
    await this.authorization.require(principal, WorkforceActions.withdrawAssignment, {
      type: 'assignment',
      id,
      organizationId,
      facilityId: existing.facility_id,
      subjectPersonIds: [existing.person_id],
    });
    const facility = await this.targets.facility(this.db, organizationId, existing.facility_id);
    const result = await this.uow.run(async ({ trx }) => {
      const current = await this.lock(trx, organizationId, id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      return this.withdrawInTransaction(trx, principal, current, {
        reason: body.reason,
        cause: 'withdrawn',
        correlationId,
        facilitySettings: facility.settings,
      });
    });
    if (result.operationId) {
      await this.access.end(
        principal,
        id,
        organizationId,
        result.operationId,
        body.reason,
        correlationId,
      );
    }
    const final = await this.load(this.db, organizationId, id);
    return {
      assignment: toAssignment(final ?? result.row, this.clock.now()),
      operationId: result.operationId,
      uncovered: result.uncovered,
    };
  }

  async complete(
    principal: Principal,
    id: string,
    body: AssignmentTransitionBody,
    correlationId: string | null,
  ): Promise<AssignmentOutcome> {
    const organizationId = organizationOf(principal);
    const existing = await this.authorizeView(principal, id);
    await this.authorization.require(principal, WorkforceActions.completeAssignment, {
      type: 'assignment',
      id,
      organizationId,
      facilityId: existing.facility_id,
    });
    const row = await this.uow.run(async ({ trx }) => {
      const current = await this.lock(trx, organizationId, id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      const next = AssignmentMachine.next(current.status, 'complete');
      const now = this.clock.now();
      if (now.getTime() < new Date(current.scheduled_start).getTime()) {
        throw errors.validation('Work can be completed only once the activity has started.', {
          code: 'not_started',
          scheduledStart: new Date(current.scheduled_start).toISOString(),
        });
      }
      return this.transition(trx, principal, current, next, {
        set: { completed_at: now, completed_by: json(snapshotActor(principal)) },
        action: WorkforceActions.completeAssignment.id,
        reason: body.reason ?? null,
        correlationId,
      });
    });
    return { assignment: toAssignment(row, this.clock.now()), operationId: null, uncovered: null };
  }

  // -------------------------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<Assignment> {
    const row = await this.authorizeView(principal, id);
    return toAssignment(row, this.clock.now());
  }

  async list(principal: Principal, query: ListAssignmentsQuery): Promise<Page<Assignment>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, WorkforceActions.viewAssignments, {
      type: 'assignment',
      organizationId,
      subjectPersonIds: query.personId ? [query.personId] : [],
      protected: query.personId !== undefined,
    });
    const cursor = decodeCursor(query.cursor, Cursor);
    let q = this.db
      .selectFrom('assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('scheduled_start')
      .orderBy('id')
      .limit(query.limit + 1);
    if (query.targetType) q = q.where('target_type', '=', query.targetType);
    if (query.targetId) q = q.where('target_id', '=', query.targetId);
    if (query.personId) q = q.where('person_id', '=', query.personId);
    if (query.status) q = q.where('status', '=', query.status);
    if (query.from) q = q.where('scheduled_end', '>', new Date(query.from));
    if (query.to) q = q.where('scheduled_start', '<', new Date(query.to));
    // Staff limited to some facilities see those facilities' assignments only (§4.3).
    const selfOnly = query.personId !== undefined && query.personId === principal.personId;
    if (!selfOnly && principal.kind === 'staff' && principal.facilityIds.length > 0) {
      q = q.where('facility_id', 'in', principal.facilityIds);
    }
    if (cursor) {
      q = q.where(
        sql<boolean>`(scheduled_start, id) > (${new Date(cursor.start)}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await q.execute();
    const now = this.clock.now();
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toAssignment(r, now)),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor({ start: new Date(last.scheduled_start).toISOString(), id: last.id })
          : null,
    };
  }

  /** Loads the assignment and requires view authority; otherwise NOT_FOUND (§4.10). */
  async authorizeView(principal: Principal, id: string): Promise<AssignmentRow> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('assignment');
    await this.authorization.require(principal, WorkforceActions.viewAssignments, {
      type: 'assignment',
      id,
      organizationId,
      facilityId: row.facility_id,
      subjectPersonIds: [row.person_id],
      protected: true,
    });
    return row;
  }

  // -------------------------------------------------------------------------------------------
  // Building blocks shared with the replacement workflow
  // -------------------------------------------------------------------------------------------

  async load(db: Db | Trx, organizationId: string, id: string): Promise<AssignmentRow | undefined> {
    return db
      .selectFrom('assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async lock(trx: Trx, organizationId: string, id: string): Promise<AssignmentRow> {
    const row = await trx
      .selectFrom('assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('assignment');
    return row;
  }

  /**
   * Qualification (SPK-STAFF-001), declared unavailability, and overlapping commitments with
   * turnaround (SPK-STAFF-003). Throws ELIGIBILITY_FAILED or RESOURCE_CONFLICT with reasons.
   */
  async assertAssignable(trx: Trx, input: AssignabilityInput): Promise<void> {
    const person = await this.people.findPerson(input.organizationId, input.personId, trx);
    if (!person || person.status !== 'active') {
      throw errors.notFound('person', input.personId);
    }
    const required = input.requirement?.required_qualifications ?? [];
    if (required.length > 0) {
      const checks = await this.qualifications.check(
        trx,
        input.organizationId,
        input.personId,
        required,
        input.scheduledStart,
      );
      const missing = checks.filter((c) => c.status !== 'held');
      if (missing.length > 0) {
        throw errors.eligibility('The person does not hold the required qualifications.', {
          reasons: missing.map((c) => ({
            code: `qualification_${c.status}`,
            kind: c.kind,
            qualificationIds: c.qualificationIds,
          })),
        });
      }
    }
    const conflicts: Array<Record<string, unknown>> = [];
    if (input.checkAvailability) {
      const windows = await this.availability.overlapping(
        trx,
        input.organizationId,
        input.personId,
        input.scheduledStart,
        input.scheduledEnd,
      );
      const unavailable = windows.filter((w) => w.kind === 'unavailable');
      if (unavailable.length > 0) {
        conflicts.push({
          code: 'person_unavailable',
          message: 'The person declared themselves unavailable for this time.',
          availabilityIds: unavailable.map((w) => w.id),
        });
      }
    }
    const commitments = await this.checker.conflicts(trx, {
      organizationId: input.organizationId,
      facility: { id: input.facility.id, timezone: input.facility.timezone },
      personId: input.personId,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      turnaroundMinutes: input.turnaroundMinutes,
      schedulingEventId: input.schedulingEventId,
      ignoreAssignmentIds: input.ignoreAssignmentIds,
    });
    conflicts.push(...commitments.map((c) => ({ ...c })));
    if (conflicts.length > 0) {
      throw errors.resourceConflict('The person has conflicting commitments for this time.', {
        conflicts,
        conflictingAssignmentIds: [
          ...new Set(commitments.flatMap((c) => c.assignmentIds)),
        ].sort(),
        conflictingEventIds: [...new Set(commitments.flatMap((c) => c.conflictingEventIds))].sort(),
      });
    }
  }

  /** Inserts a proposed (or offered) assignment after the assignability checks. */
  async insertAssignment(trx: Trx, input: NewAssignmentInput): Promise<AssignmentRow> {
    const facility = await this.targets.facility(trx, input.organizationId, input.target.facilityId);
    const requirement = await this.coverage.requirementFor(
      trx,
      input.organizationId,
      input.target.targetType,
      input.target.targetId,
      input.role,
    );
    await this.assertAssignable(trx, {
      organizationId: input.organizationId,
      facility,
      personId: input.personId,
      requirement,
      scheduledStart: input.target.scheduledStart,
      scheduledEnd: input.target.scheduledEnd,
      turnaroundMinutes: input.turnaroundMinutes,
      schedulingEventId: input.target.schedulingEventId,
      ignoreAssignmentIds: input.replacesAssignmentId ? [input.replacesAssignmentId] : [],
      checkAvailability: true,
    });
    const id = newId();
    const now = this.clock.now();
    const status = input.offer
      ? AssignmentMachine.next(AssignmentMachine.initial, 'offer')
      : AssignmentMachine.initial;
    try {
      await trx
        .insertInto('assignments')
        .values({
          id,
          organization_id: input.organizationId,
          facility_id: input.target.facilityId,
          person_id: input.personId,
          kind: input.kind,
          target_type: input.target.targetType,
          target_id: input.target.targetId,
          fixture_id: input.target.fixtureId,
          scheduling_event_id: input.target.schedulingEventId,
          offering_session_id: input.target.offeringSessionId,
          offering_id: input.target.offeringId,
          target_title: input.target.title,
          role: input.role,
          slot: input.slot,
          engagement: input.engagement,
          status,
          scheduled_start: input.target.scheduledStart,
          scheduled_end: input.target.scheduledEnd,
          turnaround_minutes: input.turnaroundMinutes,
          committed_end: addMinutes(input.target.scheduledEnd, input.turnaroundMinutes),
          replaces_assignment_id: input.replacesAssignmentId,
          offered_at: input.offer ? now : null,
          responded_at: null,
          accepted_at: null,
          declined_at: null,
          decline_reason: null,
          withdrawn_at: null,
          withdrawn_reason: null,
          withdrawn_by: null,
          completed_at: null,
          completed_by: null,
          access_membership_id: null,
          access_from: null,
          access_until: null,
          created_by: json(snapshotActor(input.principal)),
          created_by_person_id: input.principal.personId,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.resourceConflict('The person already holds a live assignment for this slot.', {
          conflicts: [{ code: 'already_assigned_to_slot', constraint: pgConstraintName(error) }],
        });
      }
      throw error;
    }
    await this.audit.record(trx, {
      organizationId: input.organizationId,
      actor: input.principal,
      action: input.replacesAssignmentId
        ? WorkforceActions.triggerReplacement.id
        : WorkforceActions.proposeAssignment.id,
      targetType: 'assignment',
      targetId: id,
      afterRevision: 1,
      reason: input.reason,
      correlationId: input.correlationId,
      operationId: input.operationId ?? null,
      details: {
        personId: input.personId,
        targetType: input.target.targetType,
        targetId: input.target.targetId,
        role: input.role,
        slot: input.slot,
        status,
        engagement: input.engagement,
        replacesAssignmentId: input.replacesAssignmentId,
      },
    });
    const row = (await this.load(trx, input.organizationId, id)) as AssignmentRow;
    await this.notify(trx, row, null, input.reason, input.correlationId, input.operationId ?? null);
    return row;
  }

  /**
   * Withdraws inside the caller's transaction. Returns the operation that must end granted access
   * after commit (identity runs its own transaction) and the uncovered-slot notice, if any.
   */
  async withdrawInTransaction(
    trx: Trx,
    principal: Principal,
    current: AssignmentRow,
    options: {
      reason: string;
      cause: UncoveredCause;
      correlationId: string | null;
      facilitySettings: Record<string, unknown>;
      operationId?: string | null;
    },
  ): Promise<{ row: AssignmentRow; operationId: string | null; uncovered: UncoveredNotice | null }> {
    const next = AssignmentMachine.next(current.status, 'withdraw');
    const endsAccess = current.access_status === 'granted';
    const operationId =
      options.operationId ??
      (endsAccess
        ? await this.operations.create(trx, {
            organizationId: current.organization_id,
            kind: 'workforce.withdraw_assignment',
            requestedBy: principal,
            correlationId: options.correlationId,
            input: { assignmentId: current.id },
            status: 'running',
          })
        : null);
    const updated = await this.transition(trx, principal, current, next, {
      set: {
        withdrawn_at: this.clock.now(),
        withdrawn_reason: options.reason,
        withdrawn_by: json(snapshotActor(principal)),
      },
      action: WorkforceActions.withdrawAssignment.id,
      reason: options.reason,
      correlationId: options.correlationId,
      operationId,
    });
    const uncovered =
      current.status === 'accepted'
        ? await this.coverage.escalateIfUncovered(
            trx,
            updated,
            options.cause,
            options.correlationId,
            options.facilitySettings,
          )
        : null;
    return { row: updated, operationId: endsAccess ? operationId : null, uncovered };
  }

  // -------------------------------------------------------------------------------------------
  // Following the targets (outbox handlers; idempotent under replay, writes through ctx.trx)
  // -------------------------------------------------------------------------------------------

  /** competition.fixture_changed: retime live assignments, withdraw them when the game is off. */
  async onFixtureChanged(
    event: DomainEvent<EventPayload<typeof CompetitionEvents.fixtureChanged>>,
    ctx: HandlerContext,
  ): Promise<void> {
    const p = event.payload;
    const rows = await this.liveFor(ctx.trx, event.organizationId, 'fixture', p.fixtureId);
    if (rows.length === 0) return;
    if (['canceled', 'postponed', 'unscheduled'].includes(p.status)) {
      for (const row of rows) {
        await this.systemWithdraw(ctx.trx, row, `The fixture was ${p.status}.`, event, false);
      }
      return;
    }
    if (p.status === 'scheduled' && p.scheduledStart && p.scheduledEnd) {
      await this.retime(
        ctx.trx,
        rows,
        new Date(p.scheduledStart),
        new Date(p.scheduledEnd),
        p.schedulingEventId,
        event,
      );
    }
  }

  /** scheduling.event_changed: the same for assignments whose target is the event itself. */
  async onSchedulingEventChanged(
    event: DomainEvent<EventPayload<typeof EventChanged>>,
    ctx: HandlerContext,
  ): Promise<void> {
    const p = event.payload;
    const rows = await this.liveFor(ctx.trx, event.organizationId, 'event', p.eventId);
    if (rows.length === 0) return;
    if (p.change === 'canceled') {
      for (const row of rows) {
        await this.systemWithdraw(ctx.trx, row, 'The event was canceled.', event, false);
      }
      return;
    }
    if (p.after && (p.change === 'moved' || p.change === 'resized' || p.change === 'updated')) {
      await this.retime(
        ctx.trx,
        rows,
        new Date(p.after.scheduledStart),
        new Date(p.after.scheduledEnd),
        p.eventId,
        event,
      );
    }
  }

  /** catalog.session_canceled: live assignments of the session are withdrawn. */
  async onSessionCanceled(
    event: DomainEvent<EventPayload<typeof CatalogEvents.sessionCanceled>>,
    ctx: HandlerContext,
  ): Promise<void> {
    const rows = await this.liveFor(ctx.trx, event.organizationId, 'session', event.payload.sessionId);
    for (const row of rows) {
      await this.systemWithdraw(ctx.trx, row, 'The session was canceled.', event, false);
    }
  }

  private async liveFor(
    trx: Trx,
    organizationId: string,
    targetType: 'fixture' | 'event' | 'session',
    targetId: string,
  ): Promise<AssignmentRow[]> {
    return trx
      .selectFrom('assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId)
      .where('status', 'in', [...LIVE_STATUSES])
      .orderBy('id')
      .forUpdate()
      .execute();
  }

  private async retime(
    trx: Trx,
    rows: AssignmentRow[],
    start: Date,
    end: Date,
    schedulingEventId: string | null,
    event: DomainEvent<unknown>,
  ): Promise<void> {
    for (const row of rows) {
      const unchanged =
        new Date(row.scheduled_start).getTime() === start.getTime() &&
        new Date(row.scheduled_end).getTime() === end.getTime() &&
        row.scheduling_event_id === schedulingEventId;
      if (unchanged) continue;
      const savepoint = sql.id(`workforce_retime_${row.id.replaceAll('-', '')}`);
      await sql`savepoint ${savepoint}`.execute(trx);
      let changed: boolean;
      try {
        const result = await trx
          .updateTable('assignments')
          .set({
            scheduled_start: start,
            scheduled_end: end,
            committed_end: addMinutes(end, row.turnaround_minutes),
            scheduling_event_id: schedulingEventId,
            revision: row.revision + 1,
          })
          .where('organization_id', '=', row.organization_id)
          .where('id', '=', row.id)
          .where('revision', '=', row.revision)
          .executeTakeFirst();
        changed = Number(result.numUpdatedRows) > 0;
        await sql`release savepoint ${savepoint}`.execute(trx);
      } catch (error) {
        if (!isExclusionViolation(error)) throw error;
        // The new time collides with another accepted assignment of the person (SPK-STAFF-003):
        // the moved assignment is withdrawn and its slot reported uncovered, never double-booked.
        await sql`rollback to savepoint ${savepoint}`.execute(trx);
        await this.systemWithdraw(
          trx,
          row,
          'The rescheduled time overlaps another accepted assignment of the person.',
          event,
          true,
        );
        continue;
      }
      if (!changed) continue;
      const updated = (await this.load(trx, row.organization_id, row.id)) as AssignmentRow;
      await this.audit.record(trx, {
        organizationId: row.organization_id,
        actor: systemPrincipal(row.organization_id, 'workforce.target_sync'),
        action: 'workforce.assignment_retimed',
        targetType: 'assignment',
        targetId: row.id,
        beforeRevision: row.revision,
        afterRevision: updated.revision,
        correlationId: event.correlationId,
        details: {
          sourceEventId: event.id,
          before: {
            start: new Date(row.scheduled_start).toISOString(),
            end: new Date(row.scheduled_end).toISOString(),
          },
          after: { start: start.toISOString(), end: end.toISOString() },
        },
      });
      await this.notify(trx, updated, row.status, 'The activity was rescheduled.', event.correlationId, null);
    }
  }

  /**
   * Withdrawal decided by a follow-up (target canceled, rescheduled into a conflict). Granted
   * access is not ended here — identity runs its own transaction — and expires at its scheduled
   * end (README "Known gaps").
   */
  private async systemWithdraw(
    trx: Trx,
    row: AssignmentRow,
    reason: string,
    event: DomainEvent<unknown>,
    escalate: boolean,
  ): Promise<void> {
    const system = systemPrincipal(row.organization_id, 'workforce.target_sync');
    const facility = await this.targets.facility(trx, row.organization_id, row.facility_id);
    const next = AssignmentMachine.next(row.status, 'withdraw');
    const updated = await this.transition(trx, system, row, next, {
      set: {
        withdrawn_at: this.clock.now(),
        withdrawn_reason: reason,
        withdrawn_by: json(snapshotActor(system)),
      },
      action: 'workforce.assignment_withdrawn_by_target_change',
      reason,
      correlationId: event.correlationId,
      operationId: null,
      details: { sourceEventId: event.id, sourceEventType: event.type },
    });
    if (escalate && row.status === 'accepted') {
      await this.coverage.escalateIfUncovered(
        trx,
        updated,
        'schedule_conflict',
        event.correlationId,
        facility.settings,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  private assertNotEnded(row: AssignmentRow): void {
    if (this.clock.now().getTime() >= new Date(row.scheduled_end).getTime()) {
      throw errors.validation('The activity has already ended.', { code: 'target_ended' });
    }
  }

  /** The lowest required slot without an accepted assignment (slot 1 when nothing is declared). */
  private async defaultSlot(
    trx: Trx,
    organizationId: string,
    target: ResolvedTarget,
    role: string,
    requirement: RequirementRow | undefined,
  ): Promise<number> {
    if (!requirement) return 1;
    const covered = await trx
      .selectFrom('assignments')
      .select('slot')
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', target.targetType)
      .where('target_id', '=', target.targetId)
      .where('role', '=', role)
      .where('status', 'in', [...COVERING_STATUSES])
      .execute();
    const taken = new Set(covered.map((r) => r.slot));
    for (let slot = 1; slot <= requirement.required_count; slot += 1) {
      if (!taken.has(slot)) return slot;
    }
    throw errors.resourceConflict(`Every required ${role} slot is already covered.`, {
      conflicts: [{ code: 'slots_covered', requirementId: requirement.id }],
    });
  }

  private async transition(
    trx: Trx,
    principal: Principal,
    current: AssignmentRow,
    next: AssignmentStatus,
    options: {
      set: UpdateObject<Database, 'assignments'>;
      action: string;
      reason: string | null;
      correlationId: string | null;
      operationId?: string | null;
      details?: Record<string, unknown>;
    },
  ): Promise<AssignmentRow> {
    try {
      await trx
        .updateTable('assignments')
        .set({ ...options.set, status: next, revision: current.revision + 1 })
        .where('organization_id', '=', current.organization_id)
        .where('id', '=', current.id)
        .where('revision', '=', current.revision)
        .execute();
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw errors.resourceConflict(
          'The person already holds an accepted assignment overlapping this one (turnaround included).',
          { conflicts: [{ code: 'assignment_overlap' }], constraint: pgConstraintName(error) },
        );
      }
      if (isUniqueViolation(error)) {
        throw errors.resourceConflict('The slot already has an accepted assignment.', {
          conflicts: [{ code: 'slot_covered' }],
          constraint: pgConstraintName(error),
        });
      }
      throw error;
    }
    await this.audit.record(trx, {
      organizationId: current.organization_id,
      actor: principal,
      action: options.action,
      targetType: 'assignment',
      targetId: current.id,
      beforeRevision: current.revision,
      afterRevision: current.revision + 1,
      reason: options.reason,
      correlationId: options.correlationId,
      operationId: options.operationId ?? null,
      details: { from: current.status, to: next, ...(options.details ?? {}) },
    });
    const updated = (await this.load(trx, current.organization_id, current.id)) as AssignmentRow;
    await this.notify(
      trx,
      updated,
      current.status,
      options.reason,
      options.correlationId,
      options.operationId ?? null,
    );
    return updated;
  }

  private async notify(
    trx: Trx,
    row: AssignmentRow,
    previousStatus: AssignmentStatus | null,
    reason: string | null,
    correlationId: string | null,
    operationId: string | null,
  ): Promise<void> {
    await this.outbox.enqueue(trx, WorkforceEvents.assignmentChanged, {
      organizationId: row.organization_id,
      aggregateType: 'assignment',
      aggregateId: row.id,
      correlationId,
      operationId,
      payload: {
        assignmentId: row.id,
        personId: row.person_id,
        kind: row.kind,
        targetType: row.target_type,
        targetId: row.target_id,
        facilityId: row.facility_id,
        role: row.role,
        slot: row.slot,
        engagement: row.engagement,
        status: row.status,
        previousStatus,
        scheduledStart: new Date(row.scheduled_start).toISOString(),
        scheduledEnd: new Date(row.scheduled_end).toISOString(),
        replacesAssignmentId: row.replaces_assignment_id,
        reason,
      },
    });
  }
}
