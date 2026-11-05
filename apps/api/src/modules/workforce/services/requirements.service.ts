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
import { QualificationsService } from './qualifications.service';
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
    private readonly qualifications: QualificationsService,
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
      // R2-RACES-02: the requirement key exclusively, before the insert. No assignment command or
      // qualification revocation for this target and role is in flight meanwhile (they take the
      // key shared), so the flagging below sees every acceptance, and every revocation it does not
      // see waits and then finds the new requirement.
      await this.coverage.lockRequirementKey(
        trx,
        organizationId,
        target.targetType,
        target.targetId,
        body.role,
      );
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
      // SPK-STAFF-001, SPK-READY-004: assignments accepted before the target had this requirement
      // are flagged when their assignee lacks its qualifications, as for an edit.
      await this.flagUnqualified(trx, row);
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
      // WRK-02: a retired requirement is final (the database refuses the update as well).
      if (current.retired_at) {
        throw errors.invalidTransition('AssignmentRequirement', 'retired', 'update');
      }
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
      // R4-OPS-MODULES-08 (SPK-UX-006, SPK-STAFF-003, SPK-AT-012): a slot the edit no longer
      // requires (above a lowered count, or every slot once acceptance is not demanded) needs no
      // covering, so its open uncovered-slot exception is resolved here, naming this revision, as a
      // retirement resolves its role's (WRK-02). Under the row's FOR UPDATE lock, which an
      // escalation or an acceptance of the role waits for, so neither commits beside this edit.
      const role = row.role.replaceAll('_', ' ');
      const settled = row.must_be_accepted
        ? `the ${role} requirement now needs ${row.required_count} accepted`
        : `the ${role} requirement no longer demands acceptance`;
      await this.coverage.resolveUncoveredNoLongerRequired(
        trx,
        row,
        `${settled} (revision ${row.revision}).${body.reason ? ` ${body.reason}` : ''}`,
        {
          requirementId: row.id,
          requirementRevision: row.revision,
          requiredCount: row.required_count,
          mustBeAccepted: row.must_be_accepted,
        },
        correlationId,
      );
      // A change of the qualifications, or of the count (a slot brought back under the
      // requirement), can leave an accepted assignee unqualified. R2-RACES-02: this runs under the
      // requirement row's FOR UPDATE lock, which a concurrent revocation's flagging waits for (it
      // takes the share lock of the requirements its assignments name), so whichever commits
      // second sees the other.
      if (body.requiredQualifications !== undefined || body.requiredCount !== undefined) {
        await this.flagUnqualified(trx, row);
      }
      // R4-OPS-MODULES-08 rework (SPK-UX-006, SPK-STAFF-001): and the reverse. An accepted
      // assignment the edit no longer makes unqualified (its slot above a lowered count, or its
      // assignee holding every qualification the requirement now names) has its open
      // `workforce.unqualified_assignment` card resolved, naming this revision, under the same lock.
      await this.qualifications.resolveUnqualifiedNoLongerLacking(
        trx,
        row,
        body.reason ?? null,
        correlationId,
      );
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

  /**
   * R3-PERFORMANCE-01 (SPK-UX-006, SPK-STAFF-002): {@link list} for many targets at once, for
   * callers that read a whole day (support's Today feed). The requirements and their coverage are
   * read in two queries for all targets, and the read is authorized once per facility (the same
   * `workforce.view_assignments` decision `list` makes for each target, on its first requirement's
   * facility, or the organization when it has none). Keyed by `coverageTargetKey(type, id)`; a
   * target the caller may not read is `'not_permitted'` instead of an error, so one unreadable
   * target never hides the others.
   */
  async listForTargets(
    principal: Principal,
    targets: readonly AssignmentTargetQuery[],
  ): Promise<Map<string, AssignmentRequirement[] | 'not_permitted'>> {
    const organizationId = organizationOf(principal);
    const found = await this.coverage.coverageForTargets(this.db, organizationId, targets);
    const decisions = new Map<string | null, boolean>();
    const out = new Map<string, AssignmentRequirement[] | 'not_permitted'>();
    for (const [key, { requirements, coverage }] of found) {
      const facilityId = requirements[0]?.facility_id ?? null;
      let allowed = decisions.get(facilityId);
      if (allowed === undefined) {
        allowed = (
          await this.authorization.decide(principal, WorkforceActions.viewAssignments, {
            type: 'assignment_requirement',
            organizationId,
            facilityId,
          })
        ).allowed;
        decisions.set(facilityId, allowed);
      }
      out.set(
        key,
        allowed ? requirements.map((row) => this.toView(row, coverage)) : 'not_permitted',
      );
    }
    return out;
  }

  /**
   * SPK-STAFF-001: accepted assignees who do not hold the requirement's qualifications are flagged
   * for an operator decision (never withdrawn automatically, POL-033 pending).
   */
  private async flagUnqualified(trx: Trx, row: RequirementRow): Promise<void> {
    if (row.required_qualifications.length === 0) return;
    await this.qualifications.flagUnqualifiedAssignments(trx, row.organization_id, {
      targetType: row.target_type,
      targetId: row.target_id,
      role: row.role,
    });
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
        retiredAt: null,
      },
    });
  }
}
