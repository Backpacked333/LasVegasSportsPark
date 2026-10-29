import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  systemPrincipal,
  z,
  type Principal,
} from '@sportspark/contracts';
import { json } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { EventsService } from '../../scheduling';
import type { EventStaffingRequirement, WorkforceStaffingPort } from '../ports';
import { WorkforceActions } from '../workforce.actions';
import { WorkforceEvents } from '../workforce.events';
import {
  LIVE_STATUSES,
  organizationOf,
  type AssignmentRow,
  type RequirementRow,
} from '../workforce.shared';
import { AssignmentsService } from './assignments.service';
import { CoverageService } from './coverage.service';
import { TargetResolver, type FacilityFacts } from './target-resolver';
import { TemporaryAccessService } from './temporary-access.service';

/** The system caller allowed to declare and withdraw booking staffing (IF-32). */
export const STAFFING_SYSTEM_CALLER = 'enrollment.booking';

const Slug = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const DeclareInput = z.object({
  targetType: z.literal('event'),
  targetId: z.uuid(),
  facilityId: z.uuid(),
  targetTitle: z.string().trim().min(1).max(300),
  requirements: z
    .array(
      z.object({
        kind: z.enum(['supervisor', 'organizer']),
        role: Slug,
        requiredCount: z.number().int().min(1).max(50),
        requiredQualifications: z.array(Slug).max(20),
      }),
    )
    .min(1)
    .max(20)
    .refine((list) => new Set(list.map((r) => r.role)).size === list.length, {
      message: 'Each role is declared once.',
    }),
});
const WithdrawInput = z.object({
  targetType: z.literal('event'),
  targetId: z.uuid(),
  reason: z.string().trim().min(1).max(2000),
});

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw errors.validation('The staffing request is not valid.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

/**
 * Staffing of booking events (WRK-02, IF-32; SPK-COND-003, SPK-STAFF-001/002). Enrollment
 * declares the supervisors and organizers a rental or party event needs when it books the event,
 * and withdraws them when the booking ends, inside its own unit of work (both methods join the
 * caller's transaction; `UnitOfWork.run` is reentrant).
 *
 *  - declareRequirements: one must-be-accepted requirement per (event, role); a repeat is a no-op
 *    (the unique key decides) and answers the existing requirement's id. The event is read from
 *    scheduling in the same transaction: it must exist, be at the stated facility and not be
 *    canceled.
 *  - withdrawRequirements: locks the event's requirements in force, retires them (when, why, by
 *    whom; the database keeps a retired requirement final), then withdraws every proposed, offered
 *    or accepted assignment of their roles through the Assignment machine (one
 *    `workforce.assignment_changed` each; granted temporary access ends as for any withdrawal) and
 *    resolves the open uncovered-slot exceptions of those roles. A retired requirement never counts
 *    again in coverage, readiness, exceptions or Today. A repeat retires nothing.
 *
 * Callers: the system principal `enrollment.booking`, or staff holding
 * `workforce.manage_requirements` at the event's facility. Staffing rules themselves (which roles,
 * how many) are configuration on the package definition, pending DEC-011.
 */
@Injectable()
export class StaffingService implements WorkforceStaffingPort {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly events: EventsService,
    private readonly coverage: CoverageService,
    private readonly assignments: AssignmentsService,
    private readonly access: TemporaryAccessService,
    private readonly targets: TargetResolver,
  ) {}

  async declareRequirements(
    principal: Principal,
    input: {
      targetType: 'event';
      targetId: string;
      facilityId: string;
      targetTitle: string;
      requirements: EventStaffingRequirement[];
    },
  ): Promise<{ requirementIds: string[] }> {
    const organizationId = organizationOf(principal);
    const body = parse(DeclareInput, input);
    await this.authorize(principal, organizationId, body.facilityId);
    return this.uow.run(async ({ trx }) => {
      await this.assertEventAt(organizationId, body.targetId, body.facilityId);
      const requirementIds: string[] = [];
      for (const requirement of body.requirements) {
        const id = newId();
        const inserted = await trx
          .insertInto('assignment_requirements')
          .values({
            id,
            organization_id: organizationId,
            facility_id: body.facilityId,
            target_type: 'event',
            target_id: body.targetId,
            fixture_id: null,
            scheduling_event_id: body.targetId,
            offering_session_id: null,
            offering_id: null,
            kind: requirement.kind,
            role: requirement.role,
            required_count: requirement.requiredCount,
            // SPK-STAFF-002, IF-32: booking staffing counts only accepted assignments.
            must_be_accepted: true,
            required_qualifications: requirement.requiredQualifications,
            created_by: json(snapshotActor(principal)),
          })
          .onConflict((oc) =>
            oc.columns(['organization_id', 'target_type', 'target_id', 'role']).doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        if (!inserted) {
          // A repeat for the same (event, role) changes nothing (IF-32).
          const existing = await this.coverage.anyRequirementFor(
            trx,
            organizationId,
            'event',
            body.targetId,
            requirement.role,
          );
          if (existing) requirementIds.push(existing.id);
          continue;
        }
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: WorkforceActions.manageRequirements.id,
          targetType: 'assignment_requirement',
          targetId: id,
          afterRevision: 1,
          correlationId: null,
          details: {
            operation: 'declare_event_staffing',
            targetType: 'event',
            targetId: body.targetId,
            targetTitle: body.targetTitle,
            kind: requirement.kind,
            role: requirement.role,
            requiredCount: requirement.requiredCount,
            mustBeAccepted: true,
            requiredQualifications: requirement.requiredQualifications,
          },
        });
        const row = await this.load(trx, organizationId, id);
        await this.notify(trx, row);
        requirementIds.push(id);
      }
      return { requirementIds };
    });
  }

  async withdrawRequirements(
    principal: Principal,
    input: { targetType: 'event'; targetId: string; reason: string },
  ): Promise<{ withdrawnAssignmentIds: string[]; retiredRequirementIds: string[] }> {
    const organizationId = organizationOf(principal);
    const body = parse(WithdrawInput, input);
    return this.uow.run(async ({ trx }) => {
      // Requirements first, then assignments: the lock order of every assignment command.
      const requirements = await trx
        .selectFrom('assignment_requirements')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('target_type', '=', 'event')
        .where('target_id', '=', body.targetId)
        .where('retired_at', 'is', null)
        .orderBy('role')
        .orderBy('id')
        .forUpdate()
        .execute();
      if (requirements.length === 0) {
        // Nothing in force (never declared, or already retired): a repeat retires nothing.
        await this.authorize(principal, organizationId, null);
        return { withdrawnAssignmentIds: [], retiredRequirementIds: [] };
      }
      for (const facilityId of new Set(requirements.map((r) => r.facility_id))) {
        await this.authorize(principal, organizationId, facilityId);
      }
      const now = this.clock.now();
      const retiredRequirementIds: string[] = [];
      for (const requirement of requirements) {
        await trx
          .updateTable('assignment_requirements')
          .set({
            retired_at: now,
            retired_reason: body.reason,
            retired_by: json(snapshotActor(principal)),
            revision: requirement.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', requirement.id)
          .where('revision', '=', requirement.revision)
          .execute();
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: 'workforce.requirement_retired',
          targetType: 'assignment_requirement',
          targetId: requirement.id,
          beforeRevision: requirement.revision,
          afterRevision: requirement.revision + 1,
          reason: body.reason,
          correlationId: null,
          details: { targetType: 'event', targetId: body.targetId, role: requirement.role },
        });
        await this.notify(trx, await this.load(trx, organizationId, requirement.id));
        retiredRequirementIds.push(requirement.id);
      }
      const roles = requirements.map((r) => r.role);
      const live = await trx
        .selectFrom('assignments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('target_type', '=', 'event')
        .where('target_id', '=', body.targetId)
        .where('role', 'in', roles)
        .where('status', 'in', [...LIVE_STATUSES])
        .orderBy('id')
        .forUpdate()
        .execute();
      const facilities = new Map<string, FacilityFacts>();
      const withdrawnAssignmentIds: string[] = [];
      for (const row of live) {
        const facility = await this.facilityOf(trx, row, facilities);
        // The requirement is retired, so the withdrawal escalates nothing (no slot to cover).
        const withdrawn = await this.assignments.withdrawInTransaction(trx, principal, row, {
          reason: body.reason,
          cause: 'withdrawn',
          correlationId: null,
          facilitySettings: facility.settings,
        });
        // SPK-STAFF-004: granted time-bounded access ends with the withdrawal, as today.
        if (withdrawn.operationId) {
          await this.access.end(
            principal,
            row.id,
            organizationId,
            withdrawn.operationId,
            body.reason,
            null,
          );
        }
        withdrawnAssignmentIds.push(row.id);
      }
      await this.coverage.resolveUncoveredOfRetired(
        trx,
        organizationId,
        'event',
        body.targetId,
        roles,
        `The requirement was retired: ${body.reason}`,
        { retiredRequirementIds },
        null,
      );
      return { withdrawnAssignmentIds, retiredRequirementIds };
    });
  }

  /**
   * IF-32 callers: the system principal of enrollment bookings, or staff holding
   * `workforce.manage_requirements` at the facility.
   */
  private async authorize(
    principal: Principal,
    organizationId: string,
    facilityId: string | null,
  ): Promise<void> {
    if (principal.kind === 'system') {
      if (principal.actorLabel === STAFFING_SYSTEM_CALLER) return;
      throw errors.accessDenied(
        `Booking staffing is declared by ${STAFFING_SYSTEM_CALLER} or by staff managing requirements.`,
        { action: WorkforceActions.manageRequirements.id },
      );
    }
    await this.authorization.require(principal, WorkforceActions.manageRequirements, {
      type: 'assignment_requirement',
      organizationId,
      facilityId,
    });
  }

  /** The event as scheduling holds it, read in this transaction (§4.2: through its service). */
  private async assertEventAt(
    organizationId: string,
    eventId: string,
    facilityId: string,
  ): Promise<void> {
    const event = await this.events
      .getEvent(systemPrincipal(organizationId, 'workforce.targets'), eventId)
      .catch((error: unknown) => {
        if (DomainError.is(error) && error.code === 'NOT_FOUND') {
          throw errors.notFound('event', eventId);
        }
        throw error;
      });
    if (event.facilityId !== facilityId) {
      throw errors.validation('The event is at another facility.', {
        code: 'facility_mismatch',
        eventFacilityId: event.facilityId,
      });
    }
    if (event.status === 'canceled') {
      throw errors.validation('The event has no usable time: it is canceled.', {
        code: 'target_not_scheduled',
      });
    }
  }

  private async facilityOf(
    trx: Trx,
    row: AssignmentRow,
    cache: Map<string, FacilityFacts>,
  ): Promise<FacilityFacts> {
    const cached = cache.get(row.facility_id);
    if (cached) return cached;
    const facility = await this.targets.facility(trx, row.organization_id, row.facility_id);
    cache.set(row.facility_id, facility);
    return facility;
  }

  private async load(trx: Trx, organizationId: string, id: string): Promise<RequirementRow> {
    return trx
      .selectFrom('assignment_requirements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  private async notify(trx: Trx, row: RequirementRow): Promise<void> {
    await this.outbox.enqueue(trx, WorkforceEvents.requirementChanged, {
      organizationId: row.organization_id,
      aggregateType: 'assignment_requirement',
      aggregateId: row.id,
      correlationId: null,
      payload: {
        requirementId: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        role: row.role,
        requiredCount: row.required_count,
        mustBeAccepted: row.must_be_accepted,
        retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
      },
    });
  }
}
