import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  PreventiveTaskTemplateSchema,
  RecurrenceRuleSchema,
  systemPrincipal,
  type CreatePreventiveScheduleBody,
  type ListPreventiveSchedulesQuery,
  type PreventiveGenerationResult,
  type PreventiveSchedule,
  type Principal,
  type Resource,
  type UpdatePreventiveScheduleBody,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  OperationsService,
  Outbox,
  UnitOfWork,
  type Clock,
} from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import { materializeOccurrences, ResourcesService } from '../../scheduling';
import { FacilitiesActions } from '../facilities.actions';
import { PreventiveOccurrencesGenerated } from '../facilities.events';
import { FACILITIES_POLICY, type FacilitiesPolicy } from '../facilities.policy';
import { PreventiveScheduleMachine, scheduleEventFor } from '../facilities.state-machines';
import { FacilitiesReader, organizationOf, type ScheduleRow } from './facilities-reader';
import { MaintenanceTasksService } from './maintenance-tasks.service';
import { RestrictionsService } from './restrictions.service';

export interface GenerateInput {
  through?: string;
  resolutionMode?: 'cancel_affected' | 'leave_for_resolution';
  expectedRevision?: number;
  reason?: string;
  correlationId?: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Preventive maintenance (SPK-FAC-005): a recurrence in facility-local time on an asset or space.
 * Generation materializes every occurrence due within the lead time as a maintenance task (from
 * the template) plus an operating restriction that is approved through the same scheduling
 * authority as ad-hoc restrictions, so the future closures appear in availability. Each
 * occurrence is materialized at most once (database unique indexes); a run interrupted midway is
 * resumed by the next run.
 */
@Injectable()
export class PreventiveSchedulesService {
  private readonly logger = new Logger(PreventiveSchedulesService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FACILITIES_POLICY) private readonly policy: FacilitiesPolicy,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly reader: FacilitiesReader,
    private readonly resources: ResourcesService,
    private readonly tasks: MaintenanceTasksService,
    private readonly restrictions: RestrictionsService,
  ) {}

  async create(
    principal: Principal,
    body: CreatePreventiveScheduleBody,
    correlationId?: string,
  ): Promise<PreventiveSchedule> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(this.db, organizationId, body.facilityId);
    const resource = await this.resolveResource(principal, organizationId, body);
    return this.uow.run(async ({ trx }) => {
      const facility = await this.reader.loadFacility(trx, organizationId, body.facilityId);
      await this.authorization.require(principal, FacilitiesActions.schedulePreventiveMaintenance, {
        type: 'preventive_schedule',
        organizationId,
        facilityId: facility.id,
      });
      if (resource.facilityId !== facility.id) {
        throw errors.validation('The resource belongs to another facility.', {
          resourceId: resource.id,
        });
      }
      if (body.assetId) {
        const asset = await this.reader.loadAsset(trx, organizationId, body.assetId);
        if (!asset || asset.facility_id !== facility.id)
          throw errors.notFound('asset', body.assetId);
      }
      const id = newId();
      const row = await trx
        .insertInto('preventive_schedules')
        .values({
          id,
          organization_id: organizationId,
          facility_id: facility.id,
          resource_id: resource.id,
          asset_id: body.assetId ?? null,
          name: body.name,
          recurrence: json(body.recurrence),
          local_start_time: body.localStartTime,
          duration_minutes: body.durationMinutes,
          timezone: facility.timezone,
          task_template: json(body.taskTemplate),
          restriction_kind: body.restrictionKind,
          lead_time_days: body.leadTimeDays ?? this.policy.defaultPreventiveLeadTimeDays,
          last_generated_at: null,
          last_generated_through: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.preventive_schedule_created',
        targetType: 'preventive_schedule',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: { resourceId: resource.id, recurrence: body.recurrence },
      });
      return this.reader.scheduleView(row);
    });
  }

  async update(
    principal: Principal,
    scheduleId: string,
    body: UpdatePreventiveScheduleBody,
    correlationId?: string,
  ): Promise<PreventiveSchedule> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.reader.loadSchedule(trx, organizationId, scheduleId, true);
      if (!current) throw errors.notFound('preventive_schedule', scheduleId);
      await this.authorization.require(principal, FacilitiesActions.schedulePreventiveMaintenance, {
        type: 'preventive_schedule',
        id: scheduleId,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      let status = current.status;
      if (body.status !== undefined && body.status !== current.status) {
        status = PreventiveScheduleMachine.next(current.status, scheduleEventFor(body.status));
      } else if (current.status === 'ended') {
        throw errors.invalidTransition('PreventiveSchedule', 'ended', 'update');
      }
      const updated = await trx
        .updateTable('preventive_schedules')
        .set({
          name: body.name,
          task_template: body.taskTemplate === undefined ? undefined : json(body.taskTemplate),
          restriction_kind: body.restrictionKind,
          lead_time_days: body.leadTimeDays,
          status,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', scheduleId)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.preventive_schedule_updated',
        targetType: 'preventive_schedule',
        targetId: scheduleId,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: status !== current.status ? { status } : {},
      });
      return this.reader.scheduleView(updated);
    });
  }

  async get(principal: Principal, scheduleId: string): Promise<PreventiveSchedule> {
    const organizationId = organizationOf(principal);
    const row = await this.reader.loadSchedule(this.db, organizationId, scheduleId);
    if (!row) throw errors.notFound('preventive_schedule', scheduleId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'preventive_schedule',
      id: scheduleId,
      organizationId,
      facilityId: row.facility_id,
    });
    return this.reader.scheduleView(row);
  }

  async list(
    principal: Principal,
    query: ListPreventiveSchedulesQuery,
  ): Promise<PreventiveSchedule[]> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(this.db, organizationId, query.facilityId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'preventive_schedule',
      organizationId,
      facilityId: query.facilityId,
    });
    let q = this.db
      .selectFrom('preventive_schedules')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', query.facilityId)
      .orderBy('name')
      .orderBy('id');
    if (query.status) q = q.where('status', '=', query.status);
    return (await q.execute()).map((r) => this.reader.scheduleView(r));
  }

  /**
   * Materializes the occurrences that start before the horizon (now + lead time, or `through`)
   * and have not ended: one task and one restriction each, the restriction approved through the
   * scheduling authority. Multi-step: recorded as an operation; resumable.
   */
  async generate(
    principal: Principal,
    scheduleId: string,
    input: GenerateInput = {},
  ): Promise<PreventiveGenerationResult> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const plan = await this.uow.run(async ({ trx }) => {
      const schedule = await this.reader.loadSchedule(trx, organizationId, scheduleId, true);
      if (!schedule) throw errors.notFound('preventive_schedule', scheduleId);
      await this.authorization.require(principal, FacilitiesActions.schedulePreventiveMaintenance, {
        type: 'preventive_schedule',
        id: scheduleId,
        organizationId,
        facilityId: schedule.facility_id,
      });
      assertExpectedRevision(input.expectedRevision, schedule.revision);
      if (schedule.status !== 'active') {
        throw errors.invalidTransition('PreventiveSchedule', schedule.status, 'generate');
      }
      const horizon = input.through
        ? new Date(input.through)
        : new Date(now.getTime() + schedule.lead_time_days * DAY_MS);
      if (horizon.getTime() < now.getTime()) {
        throw errors.validation('through must not be in the past.', { path: 'through' });
      }
      const occurrences = materializeOccurrences(RecurrenceRuleSchema.parse(schedule.recurrence), {
        localStartTime: schedule.local_start_time.slice(0, 5),
        durationMinutes: schedule.duration_minutes,
        timezone: schedule.timezone,
        maxOccurrences: this.policy.maxScheduleOccurrences,
      }).filter((o) => o.start.getTime() <= horizon.getTime() && o.end.getTime() > now.getTime());
      const existing = await trx
        .selectFrom('restrictions')
        .select(['id', 'occurrence_index', 'status'])
        .where('organization_id', '=', organizationId)
        .where('preventive_schedule_id', '=', scheduleId)
        .execute();
      const done = new Set(
        existing
          .filter((e) => e.status === 'active' || e.status === 'released')
          .map((e) => e.occurrence_index as number),
      );
      const resumable = new Map(
        existing
          .filter((e) => e.status === 'proposed' || e.status === 'approved')
          .map((e) => [e.occurrence_index as number, e.id]),
      );
      const pending = occurrences
        .filter((o) => !done.has(o.occurrenceIndex))
        .slice(0, this.policy.maxPreventiveOccurrencesPerRun);
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'facilities.generate_preventive_maintenance',
        requestedBy: principal,
        correlationId: input.correlationId ?? null,
        input: {
          scheduleId,
          horizon: horizon.toISOString(),
          occurrenceIndexes: pending.map((o) => o.occurrenceIndex),
        },
        status: 'running',
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.preventive_generation_started',
        targetType: 'preventive_schedule',
        targetId: scheduleId,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        operationId,
        details: { horizon: horizon.toISOString(), pending: pending.length },
      });
      return {
        schedule,
        horizon,
        pending,
        resumable,
        alreadyGenerated: occurrences
          .filter((o) => done.has(o.occurrenceIndex))
          .map((o) => o.occurrenceIndex),
        operationId,
      };
    });

    // Creating the schedule was the authorized approval (schedule_preventive_maintenance);
    // materializing its occurrences is mechanical and runs under the schedule's own authority,
    // so a scheduler or an automation run may generate without holding apply_restriction.
    // The requester stays on the operation and as the reporter of every task.
    const authority = systemPrincipal(organizationId, `preventive_schedule:${scheduleId}`);
    const generated: PreventiveGenerationResult['generated'] = [];
    try {
      const template = PreventiveTaskTemplateSchema.parse(plan.schedule.task_template);
      for (const occurrence of plan.pending) {
        const interval = {
          start: occurrence.start.toISOString(),
          end: occurrence.end.toISOString(),
        };
        let restrictionId = plan.resumable.get(occurrence.occurrenceIndex);
        if (!restrictionId) {
          restrictionId = await this.materialize(
            principal,
            authority,
            organizationId,
            plan.schedule,
            occurrence.occurrenceIndex,
            interval,
            template,
            input.correlationId ?? null,
          );
        }
        const restriction = await this.restrictions.approve(authority, restrictionId, {
          resolutionMode: input.resolutionMode,
          reason: `Preventive maintenance: ${plan.schedule.name}`,
          correlationId: input.correlationId ?? null,
        });
        generated.push({
          occurrenceIndex: occurrence.occurrenceIndex,
          interval,
          taskId: restriction.taskId as string,
          restrictionId,
        });
      }
    } catch (error) {
      await this.failOperation(plan.operationId, error, generated);
      throw error;
    }

    return this.uow.run(async ({ trx }) => {
      const current = await this.reader.loadSchedule(trx, organizationId, scheduleId, true);
      if (!current) throw errors.notFound('preventive_schedule', scheduleId);
      await trx
        .updateTable('preventive_schedules')
        .set({
          last_generated_at: now,
          last_generated_through: plan.horizon,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', scheduleId)
        .where('revision', '=', current.revision)
        .execute();
      const result: PreventiveGenerationResult = {
        scheduleId,
        operationId: plan.operationId,
        horizon: plan.horizon.toISOString(),
        generated,
        alreadyGeneratedOccurrenceIndexes: plan.alreadyGenerated,
      };
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.preventive_occurrences_generated',
        targetType: 'preventive_schedule',
        targetId: scheduleId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId: input.correlationId ?? null,
        operationId: plan.operationId,
        details: { generated: generated.length, horizon: result.horizon },
      });
      await this.outbox.enqueue(trx, PreventiveOccurrencesGenerated, {
        organizationId,
        aggregateType: 'preventive_schedule',
        aggregateId: scheduleId,
        correlationId: input.correlationId ?? null,
        operationId: plan.operationId,
        payload: {
          scheduleId,
          facilityId: current.facility_id,
          resourceId: current.resource_id,
          horizon: result.horizon,
          generated,
        },
      });
      await this.operations.transition(trx, plan.operationId, 'succeeded', { result });
      return result;
    });
  }

  /** One transaction per occurrence: the task from the template and its proposed restriction. */
  private async materialize(
    principal: Principal,
    authority: Principal,
    organizationId: string,
    schedule: ScheduleRow,
    occurrenceIndex: number,
    interval: { start: string; end: string },
    template: ReturnType<typeof PreventiveTaskTemplateSchema.parse>,
    correlationId: string | null,
  ): Promise<string> {
    const taskId = await this.uow.run(async ({ trx }) => {
      const task = await this.tasks.insertTask(trx, {
        organizationId,
        facilityId: schedule.facility_id,
        assetId: schedule.asset_id,
        resourceId: schedule.resource_id,
        issue: template.issue,
        severity: template.severity,
        reporter: principal,
        reporterNote: `preventive schedule ${schedule.name}`,
        evidence: [],
        dueAt: new Date(interval.end),
        requiresInspection: template.requiresInspection,
        assignedOwnerPersonId: template.assignedOwnerPersonId,
        preventiveScheduleId: schedule.id,
        occurrenceIndex,
        reason: `Preventive maintenance: ${schedule.name}`,
        correlationId,
      });
      return task.id;
    });
    const restriction = await this.restrictions.propose(authority, {
      facilityId: schedule.facility_id,
      resourceId: schedule.resource_id,
      assetId: schedule.asset_id,
      taskId,
      preventiveScheduleId: schedule.id,
      occurrenceIndex,
      kind: schedule.restriction_kind,
      interval,
      reason: `Preventive maintenance: ${schedule.name}`,
      correlationId,
    });
    return restriction.id;
  }

  private async resolveResource(
    principal: Principal,
    organizationId: string,
    input: { resourceId?: string; assetId?: string },
  ): Promise<Resource> {
    let resourceId = input.resourceId ?? null;
    if (!resourceId && input.assetId) {
      const asset = await this.reader.loadAsset(this.db, organizationId, input.assetId);
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

  private async failOperation(
    operationId: string,
    error: unknown,
    generated: PreventiveGenerationResult['generated'],
  ): Promise<void> {
    try {
      await this.uow.run((ctx) =>
        this.operations.transition(ctx.trx, operationId, 'failed', {
          result: { generated },
          error: DomainError.is(error)
            ? { code: error.code, message: error.message, details: error.details }
            : { code: 'INTERNAL_ERROR', message: String(error) },
        }),
      );
    } catch (failure) {
      this.logger.error(`could not record failure of operation ${operationId}: ${String(failure)}`);
    }
  }
}
