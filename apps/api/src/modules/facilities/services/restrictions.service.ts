import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type CreateRestrictionBody,
  type FacilityOperatingStatus,
  type ListRestrictionsQuery,
  type Principal,
  type Resource,
  type ResourceOperatingStatus,
  type Restriction,
} from '@sportspark/contracts';
import { isUniqueViolation, json, tstzrange, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  OperationalExceptions,
  OperationsService,
  Outbox,
  snapshotActor,
  UnitOfWork,
  executorFor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import {
  CLOSURE_PORT,
  ClosuresService,
  ResourcesService,
  type ClosurePort,
} from '../../scheduling';
import { FacilitiesActions } from '../facilities.actions';
import { RestrictionActivated, RestrictionReleased } from '../facilities.events';
import { FACILITIES_POLICY, type FacilitiesPolicy } from '../facilities.policy';
import { AssetMachine, RestrictionMachine } from '../facilities.state-machines';
import type { OperatingStatusPort } from '../ports';
import { FacilitiesReader, iso, organizationOf, type RestrictionRow } from './facilities-reader';

export interface ApproveRestrictionInput {
  resolutionMode?: 'cancel_affected' | 'leave_for_resolution';
  expectedRevision?: number;
  reason?: string;
  correlationId?: string | null;
}

export interface ReleaseRestrictionInput {
  reason: string;
  expectedRevision?: number;
  correlationId?: string | null;
}

export interface ProposeRestrictionInput {
  facilityId: string;
  resourceId?: string | null;
  assetId?: string | null;
  taskId?: string | null;
  preventiveScheduleId?: string | null;
  occurrenceIndex?: number | null;
  kind: 'closed' | 'limited';
  interval: { start: string; end: string };
  reason: string;
  correlationId?: string | null;
}

/**
 * Operating restrictions (SPK-FAC-003/004, SPK-AT-021). A restriction names the affected physical
 * area (a scheduling resource). Approving it is a multi-step command recorded as an operation:
 * the authority is recorded in one transaction, the scheduling closure is created and applied
 * through the scheduling module's closure port (its own transactions: this module never writes
 * scheduling tables, and under PGlite a nested transaction would deadlock), and the restriction
 * becomes active with the conflict units derived from the resource. Because a whole pitch maps
 * to every subdivision's unit and a subdivision only to its own, the closure blocks exactly the
 * affected area. Release is the symmetric, separately authorized act that lifts the closure; a
 * task that requires inspection cannot be released without a passed inspection.
 */
@Injectable()
export class RestrictionsService implements OperatingStatusPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FACILITIES_POLICY) private readonly policy: FacilitiesPolicy,
    @Inject(CLOSURE_PORT) private readonly closurePort: ClosurePort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly exceptions: OperationalExceptions,
    private readonly reader: FacilitiesReader,
    private readonly closures: ClosuresService,
    private readonly resources: ResourcesService,
  ) {}

  /** `POST /v1/maintenance-restrictions`: propose and (by default) approve in the same request. */
  async create(
    principal: Principal,
    body: CreateRestrictionBody,
    correlationId?: string,
  ): Promise<Restriction> {
    const proposed = await this.propose(principal, {
      facilityId: body.facilityId,
      resourceId: body.resourceId ?? null,
      assetId: body.assetId ?? null,
      taskId: body.taskId ?? null,
      kind: body.kind,
      interval: body.interval,
      reason: body.reason,
      correlationId: correlationId ?? null,
    });
    if (!body.approve) return proposed;
    return this.approve(principal, proposed.id, {
      resolutionMode: body.resolutionMode,
      reason: body.reason,
      correlationId: correlationId ?? null,
    });
  }

  /** Records a proposed restriction on the affected area (no scheduling effect yet). */
  async propose(principal: Principal, input: ProposeRestrictionInput): Promise<Restriction> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(executorFor(this.db), organizationId, input.facilityId);
    const resource = await this.resolveResource(principal, organizationId, input);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.reader.loadFacility(trx, organizationId, input.facilityId);
      await this.authorization.require(principal, FacilitiesActions.applyRestriction, {
        type: 'restriction',
        organizationId,
        facilityId: facility.id,
      });
      if (resource.facilityId !== facility.id) {
        throw errors.validation('The resource belongs to another facility.', {
          resourceId: resource.id,
        });
      }
      if (input.assetId) {
        const asset = await this.reader.loadAsset(trx, organizationId, input.assetId);
        if (!asset || asset.facility_id !== facility.id)
          throw errors.notFound('asset', input.assetId);
      }
      if (input.taskId) {
        const task = await this.reader.loadTask(trx, organizationId, input.taskId);
        if (!task || task.facility_id !== facility.id) {
          throw errors.notFound('maintenance_task', input.taskId);
        }
        if (task.status === 'closed') {
          throw errors.invalidTransition('MaintenanceTask', 'closed', 'restrict');
        }
      }
      const id = newId();
      let row: RestrictionRow | undefined;
      try {
        await trx
          .insertInto('restrictions')
          .values({
            id,
            organization_id: organizationId,
            facility_id: facility.id,
            resource_id: resource.id,
            asset_id: input.assetId ?? null,
            task_id: input.taskId ?? null,
            preventive_schedule_id: input.preventiveScheduleId ?? null,
            occurrence_index: input.occurrenceIndex ?? null,
            kind: input.kind,
            during: tstzrange(input.interval.start, input.interval.end),
            reason: input.reason,
            approved_by: null,
            approved_at: null,
            scheduling_closure_id: null,
            released_by: null,
            released_at: null,
            release_reason: null,
            operation_id: null,
          })
          .execute();
        row = await this.reader.loadRestriction(trx, organizationId, id);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict(
            'The maintenance task already carries an unreleased operating restriction.',
            { taskId: input.taskId, preventiveScheduleId: input.preventiveScheduleId },
          );
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.restriction_proposed',
        targetType: 'restriction',
        targetId: id,
        afterRevision: 1,
        reason: input.reason,
        correlationId: input.correlationId ?? null,
        details: { resourceId: resource.id, kind: input.kind, taskId: input.taskId ?? null },
      });
      return this.reader.restrictionView(row as RestrictionRow);
    });
  }

  /**
   * Approve (from proposed) and make effective: creates and applies the scheduling closure through
   * the closure port, then activates the restriction with the area's conflict units. Resumes an
   * `approved` restriction whose activation did not complete (idempotent per step).
   *
   * §4.7 invariant 12, SPK-AT-021: approval, the closure and the activation commit in ONE
   * transaction (scheduling's closure commands join it; UnitOfWork.run is reentrant). A stop or a
   * refused step leaves the restriction as it was, never `approved` with the field still bookable
   * and an operation left `running`.
   */
  async approve(
    principal: Principal,
    restrictionId: string,
    input: ApproveRestrictionInput = {},
  ): Promise<Restriction> {
    return this.uow.run(() => this.approveSteps(principal, restrictionId, input));
  }

  private async approveSteps(
    principal: Principal,
    restrictionId: string,
    input: ApproveRestrictionInput,
  ): Promise<Restriction> {
    const organizationId = organizationOf(principal);
    const operationId = await this.uow.run(async ({ trx }) => {
      const current = await this.reader.loadRestriction(trx, organizationId, restrictionId, true);
      if (!current) throw errors.notFound('restriction', restrictionId);
      await this.authorization.require(principal, FacilitiesActions.applyRestriction, {
        type: 'restriction',
        id: restrictionId,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      const resumed = current.status === 'approved';
      const next = resumed ? current.status : RestrictionMachine.next(current.status, 'approve');
      const opId = await this.operations.create(trx, {
        organizationId,
        kind: 'facilities.approve_restriction',
        requestedBy: principal,
        correlationId: input.correlationId ?? null,
        input: { restrictionId, resumed },
        status: 'running',
      });
      const now = this.clock.now();
      await trx
        .updateTable('restrictions')
        .set({
          status: next,
          approved_by: resumed ? undefined : json(snapshotActor(principal)),
          approved_at: resumed ? undefined : now,
          operation_id: opId,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', restrictionId)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: resumed
          ? 'facilities.restriction_activation_resumed'
          : 'facilities.restriction_approved',
        targetType: 'restriction',
        targetId: restrictionId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        operationId: opId,
      });
      return opId;
    });
    return this.activate(principal, organizationId, restrictionId, operationId, input);
  }

  private async activate(
    principal: Principal,
    organizationId: string,
    restrictionId: string,
    operationId: string,
    input: ApproveRestrictionInput,
  ): Promise<Restriction> {
    const approved = await this.reader.loadRestriction(
      executorFor(this.db),
      organizationId,
      restrictionId,
    );
    if (!approved) throw errors.notFound('restriction', restrictionId);
    const interval = { start: iso(approved.start), end: iso(approved.end) };
    let closureId = approved.scheduling_closure_id;
    if (!closureId) {
      // Scheduling authority (SPK-FAC-003): the closure, not this module, affects availability.
      const closure = await this.closurePort.createClosure(principal, {
        facilityId: approved.facility_id,
        resourceId: approved.resource_id,
        interval,
        reason: approved.reason,
        source: 'maintenance',
        correlationId: input.correlationId ?? null,
      });
      // SPK-FAC-004 / SPK-AT-021: exactly one closure backs a restriction. The link is made under
      // the restriction's row lock; when a concurrent approval linked its closure first, that one
      // is used and the closure created here stays pending (inert: only active closures block).
      closureId = await this.uow.run(async ({ trx }) => {
        const current = await this.reader.loadRestriction(trx, organizationId, restrictionId, true);
        if (!current) throw errors.notFound('restriction', restrictionId);
        if (current.scheduling_closure_id) {
          await this.audit.record(trx, {
            organizationId,
            actor: principal,
            action: 'facilities.restriction_closure_superseded',
            targetType: 'restriction',
            targetId: restrictionId,
            correlationId: input.correlationId ?? null,
            operationId,
            details: {
              schedulingClosureId: current.scheduling_closure_id,
              supersededClosureId: closure.id,
            },
          });
          return current.scheduling_closure_id;
        }
        if (current.status !== 'approved') {
          throw errors.invalidTransition('Restriction', current.status, 'activate');
        }
        await trx
          .updateTable('restrictions')
          .set({ scheduling_closure_id: closure.id })
          .where('organization_id', '=', organizationId)
          .where('id', '=', restrictionId)
          .where('scheduling_closure_id', 'is', null)
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'facilities.restriction_closure_created',
          targetType: 'restriction',
          targetId: restrictionId,
          correlationId: input.correlationId ?? null,
          operationId,
          details: { schedulingClosureId: closure.id },
        });
        return closure.id;
      });
    }
    const linkedClosureId: string = closureId;
    const closure = await this.closures.getClosure(principal, linkedClosureId);
    if (closure.status === 'pending') {
      try {
        await this.closurePort.applyClosure(principal, linkedClosureId, {
          mode: input.resolutionMode ?? this.policy.defaultResolutionMode,
          expectedRevision: closure.revision,
          reason: input.reason,
          correlationId: input.correlationId ?? null,
        });
      } catch (error) {
        // a concurrent approval applied the same closure first: that is the outcome we need
        const raced =
          DomainError.is(error) &&
          (error.code === 'STALE_REVISION' || error.code === 'INVALID_TRANSITION');
        if (!raced) throw error;
        const latest = await this.closures.getClosure(principal, linkedClosureId);
        if (latest.status !== 'active') throw error;
      }
    } else if (closure.status !== 'active') {
      throw errors.invalidTransition('SchedulingClosure', closure.status, 'apply');
    }
    // The affected physical area decides what is blocked: a whole pitch carries every
    // subdivision's unit, a subdivision only its own (SPK-FAC-003, SPK-SCHED-002).
    const resource = await this.resources.getResource(principal, approved.resource_id);
    return this.uow.run(async ({ trx }) => {
      const current = await this.reader.loadRestriction(trx, organizationId, restrictionId, true);
      if (!current) throw errors.notFound('restriction', restrictionId);
      if (current.status === 'active' && current.scheduling_closure_id === linkedClosureId) {
        // a concurrent approval completed the activation with the same closure
        await this.operations.transition(trx, operationId, 'succeeded', {
          result: {
            restrictionId,
            status: current.status,
            schedulingClosureId: linkedClosureId,
            alreadyActive: true,
          },
        });
        return this.reader.restrictionView(current);
      }
      const next = RestrictionMachine.next(current.status, 'activate');
      await trx
        .updateTable('restrictions')
        .set({
          status: next,
          affected_conflict_unit_ids: resource.conflictUnitIds,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', restrictionId)
        .where('revision', '=', current.revision)
        .execute();
      if (current.asset_id) {
        await this.transitionAsset(trx, principal, organizationId, current.asset_id, 'restrict', {
          correlationId: input.correlationId ?? null,
          operationId,
          restrictionId,
        });
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.restriction_activated',
        targetType: 'restriction',
        targetId: restrictionId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        operationId,
        details: {
          schedulingClosureId: closureId,
          affectedConflictUnitIds: resource.conflictUnitIds,
        },
      });
      await this.outbox.enqueue(trx, RestrictionActivated, {
        organizationId,
        aggregateType: 'restriction',
        aggregateId: restrictionId,
        correlationId: input.correlationId ?? null,
        operationId,
        payload: {
          restrictionId,
          facilityId: current.facility_id,
          resourceId: current.resource_id,
          assetId: current.asset_id,
          taskId: current.task_id,
          kind: current.kind,
          interval,
          reason: current.reason,
          affectedConflictUnitIds: resource.conflictUnitIds,
          schedulingClosureId: closureId as string,
        },
      });
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: {
          restrictionId,
          status: next,
          schedulingClosureId: closureId,
          affectedConflictUnitIds: resource.conflictUnitIds,
        },
      });
      const row = await this.reader.loadRestriction(trx, organizationId, restrictionId);
      return this.reader.restrictionView(row as RestrictionRow);
    });
  }

  /**
   * Authorized release (SPK-FAC-004): facilities operator or general manager. When the task
   * requires an inspection, the latest inspection must have passed; closing the task alone never
   * reopens the space. Lifts the closure through the scheduling authority, then records the release.
   */
  async release(
    principal: Principal,
    restrictionId: string,
    input: ReleaseRestrictionInput,
  ): Promise<Restriction> {
    // §4.7 invariant 12: the release request, the closure lift and the release commit together.
    return this.uow.run(() => this.releaseSteps(principal, restrictionId, input));
  }

  private async releaseSteps(
    principal: Principal,
    restrictionId: string,
    input: ReleaseRestrictionInput,
  ): Promise<Restriction> {
    const organizationId = organizationOf(principal);
    const { operationId, closureId } = await this.uow.run(async ({ trx }) => {
      const current = await this.reader.loadRestriction(trx, organizationId, restrictionId, true);
      if (!current) throw errors.notFound('restriction', restrictionId);
      await this.authorization.require(principal, FacilitiesActions.releaseToService, {
        type: 'restriction',
        id: restrictionId,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      RestrictionMachine.next(current.status, 'release');
      await this.assertInspectionPassed(trx, organizationId, current);
      const opId = await this.operations.create(trx, {
        organizationId,
        kind: 'facilities.release_restriction',
        requestedBy: principal,
        correlationId: input.correlationId ?? null,
        input: { restrictionId, reason: input.reason },
        status: 'running',
      });
      await trx
        .updateTable('restrictions')
        .set({ operation_id: opId, revision: current.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', restrictionId)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.release_requested',
        targetType: 'restriction',
        targetId: restrictionId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        correlationId: input.correlationId ?? null,
        operationId: opId,
      });
      return { operationId: opId, closureId: current.scheduling_closure_id as string };
    });
    {
      const closure = await this.closures.getClosure(principal, closureId);
      if (closure.status === 'active') {
        await this.closurePort.liftClosure(principal, closureId, {
          expectedRevision: closure.revision,
          reason: input.reason,
          correlationId: input.correlationId ?? null,
        });
      } else if (closure.status !== 'lifted') {
        throw errors.invalidTransition('SchedulingClosure', closure.status, 'lift');
      }
      return await this.uow.run(async ({ trx }) => {
        const current = await this.reader.loadRestriction(trx, organizationId, restrictionId, true);
        if (!current) throw errors.notFound('restriction', restrictionId);
        const next = RestrictionMachine.next(current.status, 'release');
        const now = this.clock.now();
        await trx
          .updateTable('restrictions')
          .set({
            status: next,
            released_by: json(snapshotActor(principal)),
            released_at: now,
            release_reason: input.reason,
            revision: current.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', restrictionId)
          .where('revision', '=', current.revision)
          .execute();
        if (
          current.asset_id &&
          !(await this.reader.hasOtherOpenRestrictions(
            trx,
            organizationId,
            current.asset_id,
            restrictionId,
          ))
        ) {
          await this.transitionAsset(
            trx,
            principal,
            organizationId,
            current.asset_id,
            'return_to_service',
            { correlationId: input.correlationId ?? null, operationId, restrictionId },
          );
        }
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'facilities.restriction_released',
          targetType: 'restriction',
          targetId: restrictionId,
          beforeRevision: current.revision,
          afterRevision: current.revision + 1,
          reason: input.reason,
          correlationId: input.correlationId ?? null,
          operationId,
          details: { schedulingClosureId: closureId },
        });
        await this.outbox.enqueue(trx, RestrictionReleased, {
          organizationId,
          aggregateType: 'restriction',
          aggregateId: restrictionId,
          correlationId: input.correlationId ?? null,
          operationId,
          payload: {
            restrictionId,
            facilityId: current.facility_id,
            resourceId: current.resource_id,
            assetId: current.asset_id,
            taskId: current.task_id,
            interval: { start: iso(current.start), end: iso(current.end) },
            reason: input.reason,
            affectedConflictUnitIds: current.affected_conflict_unit_ids,
            schedulingClosureId: closureId,
          },
        });
        await this.operations.transition(trx, operationId, 'succeeded', {
          result: { restrictionId, status: next, schedulingClosureId: closureId },
        });
        const row = await this.reader.loadRestriction(trx, organizationId, restrictionId);
        return this.reader.restrictionView(row as RestrictionRow);
      });
    }
  }

  async get(principal: Principal, restrictionId: string): Promise<Restriction> {
    const organizationId = organizationOf(principal);
    const row = await this.reader.loadRestriction(
      executorFor(this.db),
      organizationId,
      restrictionId,
    );
    if (!row) throw errors.notFound('restriction', restrictionId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'restriction',
      id: restrictionId,
      organizationId,
      facilityId: row.facility_id,
    });
    return this.reader.restrictionView(row);
  }

  async list(principal: Principal, query: ListRestrictionsQuery): Promise<Restriction[]> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(executorFor(this.db), organizationId, query.facilityId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'restriction',
      organizationId,
      facilityId: query.facilityId,
    });
    let q = this.reader
      .restrictionQuery(executorFor(this.db))
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', query.facilityId)
      .orderBy(sql`lower(during)`)
      .orderBy('id');
    if (query.status) q = q.where('status', '=', query.status);
    if (query.resourceId) q = q.where('resource_id', '=', query.resourceId);
    if (query.taskId) q = q.where('task_id', '=', query.taskId);
    return (await q.execute()).map((r) => this.reader.restrictionView(r));
  }

  async activeRestrictions(
    principal: Principal,
    facilityId: string,
    interval: { start: string; end: string },
    resourceId?: string | null,
  ): Promise<Restriction[]> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(executorFor(this.db), organizationId, facilityId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'restriction',
      organizationId,
      facilityId,
    });
    let q = this.reader
      .restrictionQuery(executorFor(this.db))
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('status', '=', 'active')
      .where(sql<boolean>`during && ${tstzrange(interval.start, interval.end)}`)
      .orderBy(sql`lower(during)`)
      .orderBy('id');
    if (resourceId) q = q.where('resource_id', '=', resourceId);
    return (await q.execute()).map((r) => this.reader.restrictionView(r));
  }

  /**
   * `GET /v1/facilities/{id}/operating-status`: every resource of the facility with its status at
   * the instant. A resource is restricted when an active restriction's conflict units intersect
   * its own: restricting one half restricts the whole pitch but not the other half (SPK-AT-021).
   */
  async operatingStatus(
    principal: Principal,
    facilityId: string,
    at?: Date | string,
  ): Promise<FacilityOperatingStatus> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(executorFor(this.db), organizationId, facilityId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'facility',
      id: facilityId,
      organizationId,
      facilityId,
    });
    const instant = at ? new Date(at) : this.clock.now();
    const inventory: Resource[] = await this.resources.listResources(principal, facilityId);
    const active = await this.reader
      .restrictionQuery(executorFor(this.db))
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', facilityId)
      .where('status', '=', 'active')
      .where(sql<boolean>`during @> ${instant}::timestamptz`)
      .orderBy(sql`lower(during)`)
      .orderBy('id')
      .execute();
    const resources: ResourceOperatingStatus[] = inventory.map((resource) => {
      const units = new Set(resource.conflictUnitIds);
      const hits = active.filter(
        (r) =>
          r.resource_id === resource.id || r.affected_conflict_unit_ids.some((u) => units.has(u)),
      );
      return {
        resourceId: resource.id,
        name: resource.name,
        kind: resource.kind,
        parentResourceId: resource.parentResourceId,
        inventoryStatus: resource.status,
        conflictUnitIds: resource.conflictUnitIds,
        status: hits.length > 0 ? 'restricted' : 'in_service',
        restrictions: hits.map((r) => ({
          restrictionId: r.id,
          kind: r.kind,
          reason: r.reason,
          interval: { start: iso(r.start), end: iso(r.end) },
          taskId: r.task_id,
          resourceId: r.resource_id,
          affectedConflictUnitIds: r.affected_conflict_unit_ids,
        })),
      };
    });
    return { facilityId, at: instant.toISOString(), resources };
  }

  /**
   * Scheduling closure lift guard (SPK-FAC-004, SPK-AT-021): a closure that backs an approved or
   * active restriction may be lifted only by that restriction's facilities release, which checks
   * `facilities.release_to_service` and a passed inspection before it marks its
   * `facilities.release_restriction` operation running. Any other lift (a scheduler, a system
   * administrator, or a facilities operator skipping the inspection through `POST
   * /v1/closures/{id}/lift`) is refused. Which roles may reopen a maintained space is pending with
   * Operations (DEC-001, acceptance fixtures §9 item 15); refusing is the conservative default.
   * Closures that no restriction backs stay liftable in scheduling.
   */
  async assertClosureLiftAllowed(
    trx: Trx,
    organizationId: string,
    closureId: string,
  ): Promise<void> {
    const restriction = await this.reader
      .restrictionQuery(trx)
      .where('organization_id', '=', organizationId)
      .where('scheduling_closure_id', '=', closureId)
      .where('status', 'in', ['approved', 'active'])
      .executeTakeFirst();
    if (!restriction) return;
    if (await this.releaseInProgress(trx, organizationId, restriction.operation_id)) return;
    throw errors.eligibility(
      'This closure backs a maintenance restriction; the space returns to service only through the facilities release (inspection and release authority).',
      { code: 'restriction_release_required', restrictionId: restriction.id, closureId },
    );
  }

  /** Whether the restriction's operation is its own facilities release, still in progress. */
  private async releaseInProgress(
    trx: Trx,
    organizationId: string,
    operationId: string | null,
  ): Promise<boolean> {
    if (!operationId) return false;
    const operation = await trx
      .selectFrom('operations')
      .select(['kind', 'status'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', operationId)
      .executeTakeFirst();
    return (
      operation?.kind === 'facilities.release_restriction' &&
      (operation.status === 'pending' || operation.status === 'running')
    );
  }

  /**
   * Outbox handler target for `scheduling.closure_lifted`: a closure backing an active restriction
   * that was lifted outside a facilities release is surfaced to the facilities operator (the
   * restriction keeps its authority state; nothing reopens silently, SPK-FAC-004). The lift guard
   * above refuses such lifts; this stays as defense in depth (for example a lift written before
   * the guard was registered).
   */
  async reconcileLiftedClosure(trx: Trx, organizationId: string, closureId: string): Promise<void> {
    const restriction = await this.reader
      .restrictionQuery(trx)
      .where('organization_id', '=', organizationId)
      .where('scheduling_closure_id', '=', closureId)
      .where('status', 'in', ['approved', 'active'])
      .executeTakeFirst();
    if (!restriction) return;
    // our own release is in progress
    if (await this.releaseInProgress(trx, organizationId, restriction.operation_id)) return;
    await this.exceptions.raise(trx, {
      organizationId,
      facilityId: restriction.facility_id,
      category: 'facilities.closure_lifted_outside_release',
      severity: 'high',
      title: 'A restriction closure was lifted in scheduling without a facilities release',
      affectedType: 'restriction',
      affectedId: restriction.id,
      ownerQueue: 'facilities_operator',
      dedupeKey: `restriction:${restriction.id}:closure_lifted`,
      details: {
        schedulingClosureId: closureId,
        taskId: restriction.task_id,
        resourceId: restriction.resource_id,
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  /** The affected area: an explicit resource, or the space the asset is attached to. */
  private async resolveResource(
    principal: Principal,
    organizationId: string,
    input: { resourceId?: string | null; assetId?: string | null },
  ): Promise<Resource> {
    let resourceId = input.resourceId ?? null;
    if (!resourceId && input.assetId) {
      const asset = await this.reader.loadAsset(
        executorFor(this.db),
        organizationId,
        input.assetId,
      );
      if (!asset) throw errors.notFound('asset', input.assetId);
      resourceId = asset.resource_id;
      if (!resourceId) {
        throw errors.validation(
          'The asset is not attached to a space; name the affected resource explicitly.',
          { assetId: input.assetId },
        );
      }
    }
    if (!resourceId) throw errors.validation('resourceId or assetId is required.');
    return this.resources.getResource(principal, resourceId);
  }

  /** SPK-FAC-004: when the task requires an inspection, the latest inspection must have passed. */
  private async assertInspectionPassed(
    trx: Trx,
    organizationId: string,
    restriction: RestrictionRow,
  ): Promise<void> {
    if (!restriction.task_id) return;
    const task = await this.reader.loadTask(trx, organizationId, restriction.task_id);
    if (!task?.requires_inspection) return;
    const latest = await this.reader.latestInspection(trx, organizationId, task.id);
    if (latest?.outcome === 'passed') return;
    throw errors.eligibility(
      'A passed inspection is required before this area returns to service.',
      {
        code: 'inspection_required',
        taskId: task.id,
        taskStatus: task.status,
        latestInspection: latest
          ? { id: latest.id, outcome: latest.outcome, inspectedAt: iso(latest.inspected_at) }
          : null,
      },
    );
  }

  /** The asset's own status follows its restrictions (in_service ⇄ restricted); other states are left alone. */
  private async transitionAsset(
    trx: Trx,
    principal: Principal,
    organizationId: string,
    assetId: string,
    event: 'restrict' | 'return_to_service',
    context: { correlationId: string | null; operationId: string; restrictionId: string },
  ): Promise<void> {
    const asset = await this.reader.loadAsset(trx, organizationId, assetId, true);
    if (!asset) return;
    const expected = event === 'restrict' ? 'in_service' : 'restricted';
    if (asset.status !== expected || !AssetMachine.can(asset.status, event)) return;
    const next = AssetMachine.next(asset.status, event);
    await trx
      .updateTable('assets')
      .set({ status: next, revision: asset.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', assetId)
      .where('revision', '=', asset.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: principal,
      action: 'facilities.asset_updated',
      targetType: 'asset',
      targetId: assetId,
      beforeRevision: asset.revision,
      afterRevision: asset.revision + 1,
      correlationId: context.correlationId,
      operationId: context.operationId,
      details: { status: next, restrictionId: context.restrictionId },
    });
  }
}
