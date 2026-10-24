import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AssignmentRequirement,
  type AssignmentTargetQuery,
  type CreateAssignmentRequirementBody,
  type Principal,
  type UpdateAssignmentRequirementBody,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  DATABASE,
  Outbox,
  snapshotActor,
  UnitOfWork,
  type Trx,
} from '../../../kernel';
import type { RoleCoverage } from '../ports';
import { WorkforceActions } from '../workforce.actions';
import { WorkforceEvents } from '../workforce.events';
import { iso, organizationOf, type RequirementRow } from '../workforce.shared';
import { CoverageService } from './coverage.service';
import { TargetResolver } from './target-resolver';

/**
 * Assignment requirements (SPK-STAFF-001 assignment scope, SPK-STAFF-002): the roles a target
 * needs, how many, whether only accepted assignments satisfy them, and the qualifications
 * required. Coverage is derived from assignments on every read, never stored (SPK-READY-004).
 */
@Injectable()
export class RequirementsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly targets: TargetResolver,
    private readonly coverage: CoverageService,
  ) {}

  async create(
    principal: Principal,
    body: CreateAssignmentRequirementBody,
    correlationId: string | null,
  ): Promise<AssignmentRequirement> {
    const organizationId = organizationOf(principal);
    const target = await this.targets.resolve(organizationId, body);
    await this.authorization.require(principal, WorkforceActions.manageRequirements, {
      type: 'assignment_requirement',
      organizationId,
      facilityId: target.facilityId,
    });
    return this.uow.run(async ({ trx }) => {
      const id = newId();
      try {
        await trx
          .insertInto('assignment_requirements')
          .values({
            id,
            organization_id: organizationId,
            facility_id: target.facilityId,
            target_type: target.targetType,
            target_id: target.targetId,
            fixture_id: target.fixtureId,
            scheduling_event_id: target.targetType === 'event' ? target.targetId : null,
            offering_session_id: target.offeringSessionId,
            offering_id: target.offeringId,
            kind: body.kind,
            role: body.role,
            required_count: body.requiredCount,
            must_be_accepted: body.mustBeAccepted,
            required_qualifications: body.requiredQualifications,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict(
            `A ${body.role} requirement already exists for this target; change it instead.`,
            { conflicts: [{ code: 'requirement_exists', role: body.role }] },
          );
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: WorkforceActions.manageRequirements.id,
        targetType: 'assignment_requirement',
        targetId: id,
        afterRevision: 1,
        reason: body.reason ?? null,
        correlationId,
        details: {
          operation: 'create',
          targetType: target.targetType,
          targetId: target.targetId,
          role: body.role,
          requiredCount: body.requiredCount,
          mustBeAccepted: body.mustBeAccepted,
          requiredQualifications: body.requiredQualifications,
        },
      });
      const row = (await this.load(trx, organizationId, id)) as RequirementRow;
      await this.notify(trx, row, correlationId);
      return this.view(trx, row);
    });
  }

  async update(
    principal: Principal,
    id: string,
    body: UpdateAssignmentRequirementBody,
    correlationId: string | null,
  ): Promise<AssignmentRequirement> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, id, true);
      if (!current) throw errors.notFound('assignment_requirement', id);
      await this.authorization.require(principal, WorkforceActions.manageRequirements, {
        type: 'assignment_requirement',
        id,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      await trx
        .updateTable('assignment_requirements')
        .set({
          required_count: body.requiredCount ?? current.required_count,
          must_be_accepted: body.mustBeAccepted ?? current.must_be_accepted,
          required_qualifications: body.requiredQualifications ?? current.required_qualifications,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: WorkforceActions.manageRequirements.id,
        targetType: 'assignment_requirement',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: body.reason ?? null,
        correlationId,
        details: {
          operation: 'update',
          requiredCount: body.requiredCount ?? current.required_count,
          mustBeAccepted: body.mustBeAccepted ?? current.must_be_accepted,
          requiredQualifications: body.requiredQualifications ?? current.required_qualifications,
        },
      });
      const row = (await this.load(trx, organizationId, id)) as RequirementRow;
      await this.notify(trx, row, correlationId);
      return this.view(trx, row);
    });
  }

  async list(principal: Principal, query: AssignmentTargetQuery): Promise<AssignmentRequirement[]> {
    const organizationId = organizationOf(principal);
    const rows = await this.coverage.requirements(
      this.db,
      organizationId,
      query.targetType,
      query.targetId,
    );
    await this.authorization.require(principal, WorkforceActions.viewAssignments, {
      type: 'assignment_requirement',
      organizationId,
      facilityId: rows[0]?.facility_id ?? null,
    });
    const coverage = await this.coverage.coverage(organizationId, query.targetType, query.targetId);
    return rows.map((row) => this.toView(row, coverage));
  }

  private async view(trx: Trx, row: RequirementRow): Promise<AssignmentRequirement> {
    const coverage = await this.coverage.coverage(
      row.organization_id,
      row.target_type,
      row.target_id,
      trx,
    );
    return this.toView(row, coverage);
  }

  private toView(row: RequirementRow, coverage: RoleCoverage[]): AssignmentRequirement {
    const own = coverage.find((c) => c.requirementId === row.id);
    return {
      id: row.id,
      facilityId: row.facility_id,
      targetType: row.target_type,
      targetId: row.target_id,
      offeringId: row.offering_id,
      kind: row.kind,
      role: row.role,
      requiredCount: row.required_count,
      mustBeAccepted: row.must_be_accepted,
      requiredQualifications: row.required_qualifications,
      coverage: {
        accepted: own?.acceptedPersonIds.length ?? 0,
        offered: own?.offered ?? 0,
        proposed: own?.proposed ?? 0,
        uncoveredSlots: own?.uncoveredSlots ?? [],
      },
      revision: row.revision,
      createdAt: iso(row.created_at),
    };
  }

  private async load(
    db: Db | Trx,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<RequirementRow | undefined> {
    let q = db
      .selectFrom('assignment_requirements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async notify(trx: Trx, row: RequirementRow, correlationId: string | null) {
    await this.outbox.enqueue(trx, WorkforceEvents.requirementChanged, {
      organizationId: row.organization_id,
      aggregateType: 'assignment_requirement',
      aggregateId: row.id,
      correlationId,
      payload: {
        requirementId: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        role: row.role,
        requiredCount: row.required_count,
        mustBeAccepted: row.must_be_accepted,
      },
    });
  }
}
