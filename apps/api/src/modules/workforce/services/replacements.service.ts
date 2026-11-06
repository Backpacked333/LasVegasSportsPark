import { Inject, Injectable } from '@nestjs/common';
import {
  assertExpectedRevision,
  AuthorizationService,
  CLOCK,
  DATABASE,
  OperationsService,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  errors,
  type AssignmentKind,
  type AssignmentStatus,
  type CandidateReason,
  type CreateReplacementBody,
  type OpenSlotCandidates,
  type Principal,
  type ReplacementCandidate,
  type ReplacementList,
  type ReplacementOutcome,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { PeopleService, STAFF_DIRECTORY_PORT, type StaffDirectoryPort } from '../../identity';
import { WorkforceActions } from '../workforce.actions';
import {
  CANDIDATE_ROLES,
  turnaroundFor,
  WORKFORCE_POLICY,
  workforcePolicyForFacility,
  type WorkforcePolicy,
} from '../workforce.policy';
import {
  COVERING_STATUSES,
  iso,
  LIVE_STATUSES,
  organizationOf,
  type RequirementRow,
  toAssignment,
  type AssignmentRow,
} from '../workforce.shared';
import { AssignmentsService } from './assignments.service';
import { AvailabilityService } from './availability.service';
import { CommitmentChecker } from './commitment-checker';
import { CoverageService } from './coverage.service';
import { QualificationsService } from './qualifications.service';
import { TargetResolver, type ResolvedTarget } from './target-resolver';
import { TemporaryAccessService } from './temporary-access.service';

/**
 * Replacement workflow (SPK-STAFF-003 "an absent official can trigger a replacement workflow and
 * operational escalation", SPK-AT-012). Candidates are people holding the kind's staff role at the
 * facility or every required qualification; each one is explained: qualifications held at the
 * start, declared availability, overlapping commitments and turnaround (workforce and scheduling),
 * and earlier declines of the slot. Offering the slot creates a new assignment that names the one
 * it replaces, optionally withdrawing the original in the same transaction, as an operation.
 */
@Injectable()
export class ReplacementsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKFORCE_POLICY) private readonly policy: WorkforcePolicy,
    @Inject(STAFF_DIRECTORY_PORT) private readonly staff: StaffDirectoryPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly operations: OperationsService,
    private readonly people: PeopleService,
    private readonly assignments: AssignmentsService,
    private readonly coverage: CoverageService,
    private readonly qualifications: QualificationsService,
    private readonly availability: AvailabilityService,
    private readonly checker: CommitmentChecker,
    private readonly targets: TargetResolver,
    private readonly access: TemporaryAccessService,
  ) {}

  async candidates(principal: Principal, assignmentId: string): Promise<ReplacementList> {
    const organizationId = organizationOf(principal);
    const row = await this.assignments.authorizeView(principal, assignmentId);
    await this.authorization.require(principal, WorkforceActions.triggerReplacement, {
      type: 'assignment',
      id: assignmentId,
      organizationId,
      facilityId: row.facility_id,
    });
    // SPK-STAFF-003, SPK-AT-012: candidates are evaluated for the activity's CURRENT time and
    // facility, read from its owning module; the original row may predate a reschedule (a declined
    // or withdrawn row is never retimed). A canceled or unscheduled activity has no candidates.
    const target = await this.resolveTarget(principal, row);
    const evaluatedAt = this.clock.now();
    const start = target.scheduledStart;
    const end = target.scheduledEnd;
    // One read transaction: every check sees the same snapshot.
    return this.uow.run(async ({ trx }) => {
      const requirement = await this.coverage.requirementFor(
        trx,
        organizationId,
        row.target_type,
        row.target_id,
        row.role,
      );
      const required = requirement?.required_qualifications ?? [];
      const pool = new Set<string>();
      for (const role of CANDIDATE_ROLES[row.kind]) {
        for (const personId of await this.staff.staffWithRole(
          organizationId,
          role,
          target.facilityId,
          trx,
        )) {
          pool.add(personId);
        }
      }
      for (const personId of await this.qualifications.holdersOfAll(
        trx,
        organizationId,
        required,
        start,
      )) {
        pool.add(personId);
      }
      pool.delete(row.person_id);
      const slotRows = await trx
        .selectFrom('assignments')
        .select(['id', 'person_id', 'status'])
        .where('organization_id', '=', organizationId)
        .where('target_type', '=', row.target_type)
        .where('target_id', '=', row.target_id)
        .where('role', '=', row.role)
        .where('slot', '=', row.slot)
        .execute();

      const candidates = await this.evaluate(trx, {
        organizationId,
        kind: row.kind,
        target,
        requirement,
        pool,
        slotRows,
        scope: 'slot',
        turnaroundMinutes: row.turnaround_minutes,
      });
      return {
        assignmentId: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        role: row.role,
        slot: row.slot,
        scheduledStart: iso(start),
        scheduledEnd: iso(end),
        requiredQualifications: required,
        evaluatedAt: evaluatedAt.toISOString(),
        candidates,
      };
    });
  }

  /**
   * `GET /v1/assignment-requirements/{id}/candidates` (SPK-STAFF-003, SPK-AT-012): candidates for
   * an open slot that has no assignment to replace, evaluated exactly like replacement candidates
   * for the requirement's activity as its owning module holds it now. A person already proposed,
   * offered or accepted for the role is named and blocked; an earlier decline is a warning.
   */
  async openSlotCandidates(
    principal: Principal,
    requirementId: string,
  ): Promise<OpenSlotCandidates> {
    const organizationId = organizationOf(principal);
    const requirement = await this.db
      .selectFrom('assignment_requirements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', requirementId)
      .executeTakeFirst();
    if (!requirement || requirement.retired_at !== null) {
      throw errors.notFound('assignment requirement', requirementId);
    }
    await this.authorization.require(principal, WorkforceActions.triggerReplacement, {
      type: 'assignment_requirement',
      id: requirementId,
      organizationId,
      facilityId: requirement.facility_id,
    });
    const target = await this.targets.resolve(organizationId, {
      targetType: requirement.target_type,
      targetId: requirement.target_id,
      offeringId: requirement.offering_id,
    });
    if (target.facilityId !== requirement.facility_id) {
      await this.authorization.require(principal, WorkforceActions.triggerReplacement, {
        type: 'assignment_requirement',
        id: requirementId,
        organizationId,
        facilityId: target.facilityId,
      });
    }
    const policy = workforcePolicyForFacility(this.policy, target.facilitySettings);
    const evaluatedAt = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const pool = new Set<string>();
      for (const role of CANDIDATE_ROLES[requirement.kind]) {
        for (const personId of await this.staff.staffWithRole(
          organizationId,
          role,
          target.facilityId,
          trx,
        )) {
          pool.add(personId);
        }
      }
      for (const personId of await this.qualifications.holdersOfAll(
        trx,
        organizationId,
        requirement.required_qualifications,
        target.scheduledStart,
      )) {
        pool.add(personId);
      }
      const slotRows = await trx
        .selectFrom('assignments')
        .select(['id', 'person_id', 'status'])
        .where('organization_id', '=', organizationId)
        .where('target_type', '=', requirement.target_type)
        .where('target_id', '=', requirement.target_id)
        .where('role', '=', requirement.role)
        .execute();
      const candidates = await this.evaluate(trx, {
        organizationId,
        kind: requirement.kind,
        target,
        requirement,
        pool,
        slotRows,
        scope: 'role',
        turnaroundMinutes: turnaroundFor(policy, requirement.kind),
      });
      return {
        requirementId: requirement.id,
        kind: requirement.kind,
        targetType: requirement.target_type,
        targetId: requirement.target_id,
        offeringId: requirement.offering_id,
        role: requirement.role,
        requiredCount: requirement.required_count,
        covered: slotRows.filter((r) => (COVERING_STATUSES as readonly string[]).includes(r.status))
          .length,
        scheduledStart: iso(target.scheduledStart),
        scheduledEnd: iso(target.scheduledEnd),
        requiredQualifications: requirement.required_qualifications,
        evaluatedAt: evaluatedAt.toISOString(),
        candidates,
      };
    });
  }

  /**
   * Explains and ranks each person of the pool for the activity (SPK-STAFF-003, SPK-AT-012):
   * the slot's (or role's) earlier rows, qualifications held at the start, declared availability,
   * overlapping commitments and turnaround; plus the grade and safeguarding certification the
   * workforce settings name (SPK-STAFF-001). Eligible first, then by positive reasons, then name.
   */
  private async evaluate(
    trx: Trx,
    input: {
      organizationId: string;
      kind: AssignmentKind;
      target: ResolvedTarget;
      requirement: RequirementRow | undefined;
      pool: ReadonlySet<string>;
      slotRows: ReadonlyArray<{ id: string; person_id: string; status: AssignmentStatus }>;
      /** `slot`: replacing one slot's assignment; `role`: an open slot of the requirement. */
      scope: 'slot' | 'role';
      turnaroundMinutes: number;
    },
  ): Promise<ReplacementCandidate[]> {
    const { organizationId, target, requirement, slotRows } = input;
    const start = target.scheduledStart;
    const end = target.scheduledEnd;
    const required = requirement?.required_qualifications ?? [];
    const profile = this.policy.candidateProfile ?? { gradeKind: null, safeguardingKind: null };
    const candidates: Array<ReplacementCandidate & { positives: number }> = [];
    const unit = input.scope === 'slot' ? 'slot' : 'role';
    for (const personId of [...input.pool].sort()) {
      const person = await this.people.loadPerson(trx, organizationId, personId);
      if (!person || person.status !== 'active') continue;
      const reasons: CandidateReason[] = [];
      const live = slotRows.find(
        (r) => r.person_id === personId && LIVE_STATUSES.includes(r.status),
      );
      if (live) {
        reasons.push({
          code: input.scope === 'slot' ? 'already_on_slot' : 'already_on_role',
          severity: 'blocking',
          message: `Already ${live.status} for this ${unit}.`,
          sourceType: 'assignment',
          sourceIds: [live.id],
        });
      }
      const earlier = slotRows.filter(
        (r) => r.person_id === personId && (r.status === 'declined' || r.status === 'withdrawn'),
      );
      if (earlier.length > 0) {
        reasons.push({
          code: 'previously_declined',
          severity: 'warning',
          message: `Declined or withdrew from this ${unit} before.`,
          sourceType: 'assignment',
          sourceIds: earlier.map((r) => r.id),
        });
      }
      const checks = await this.qualifications.check(
        trx,
        organizationId,
        personId,
        required,
        start,
      );
      if (required.length === 0) {
        reasons.push({
          code: 'no_qualification_required',
          severity: 'info',
          message: 'The requirement names no qualification.',
          sourceType: requirement ? 'assignment_requirement' : null,
          sourceIds: requirement ? [requirement.id] : [],
        });
      }
      for (const check of checks) {
        reasons.push(
          check.status === 'held'
            ? {
                code: 'qualified',
                severity: 'positive',
                message: `Holds a verified ${check.kind} valid at the start.`,
                sourceType: 'qualification',
                sourceIds: check.qualificationIds,
              }
            : {
                code: `qualification_${check.status}`,
                severity: 'blocking',
                message:
                  check.status === 'missing'
                    ? `No ${check.kind} qualification on record.`
                    : check.status === 'expired'
                      ? `The ${check.kind} qualification is not valid at the start.`
                      : `The ${check.kind} evidence awaits verification.`,
                sourceType: 'qualification',
                sourceIds: check.qualificationIds,
              },
        );
      }
      const windows = await this.availability.overlapping(
        trx,
        organizationId,
        personId,
        start,
        end,
      );
      const unavailable = windows.filter((w) => w.kind === 'unavailable');
      const covering = windows.filter(
        (w) =>
          w.kind === 'available' &&
          new Date(w.starts_at).getTime() <= start.getTime() &&
          new Date(w.ends_at).getTime() >= end.getTime(),
      );
      if (unavailable.length > 0) {
        reasons.push({
          code: 'declared_unavailable',
          severity: 'blocking',
          message: 'Declared unavailable for this time.',
          sourceType: 'availability',
          sourceIds: unavailable.map((w) => w.id),
        });
      } else if (covering.length > 0) {
        reasons.push({
          code: 'declared_available',
          severity: 'positive',
          message: 'Declared available for the whole activity.',
          sourceType: 'availability',
          sourceIds: covering.map((w) => w.id),
        });
      } else {
        reasons.push({
          code: 'availability_not_declared',
          severity: 'info',
          message: 'No availability declared for this time.',
          sourceType: null,
          sourceIds: [],
        });
      }
      const conflicts = await this.checker.conflicts(trx, {
        organizationId,
        facility: { id: target.facilityId, timezone: target.timezone },
        personId,
        scheduledStart: start,
        scheduledEnd: end,
        turnaroundMinutes: input.turnaroundMinutes,
        schedulingEventId: target.schedulingEventId,
        ignoreAssignmentIds: [],
        lock: false,
      });
      for (const conflict of conflicts) {
        reasons.push({
          code: conflict.code,
          severity: 'blocking',
          message: conflict.message,
          sourceType: conflict.assignmentIds.length > 0 ? 'assignment' : 'event',
          sourceIds:
            conflict.assignmentIds.length > 0
              ? conflict.assignmentIds
              : conflict.conflictingEventIds,
        });
      }
      if (conflicts.length === 0) {
        reasons.push({
          code: 'no_conflicts',
          severity: 'positive',
          message: 'No overlapping commitment; turnaround respected.',
          sourceType: null,
          sourceIds: [],
        });
      }
      // SPK-STAFF-001: the grade and safeguarding certification the settings name (DEC-011
      // pending: which kinds an operator records is configuration). A requirement that names
      // either kind already decided above; these reasons only describe.
      let grade: string | null = null;
      if (profile.gradeKind && input.kind === 'official') {
        const held = await this.qualifications.describe(
          trx,
          organizationId,
          personId,
          profile.gradeKind,
          start,
        );
        if (held.status === 'held') {
          grade = held.level;
          reasons.push({
            code: 'official_grade',
            severity: 'info',
            message: held.level
              ? `Grade ${held.level}.`
              : `Holds a ${profile.gradeKind} with no level.`,
            sourceType: 'qualification',
            sourceIds: held.qualificationIds,
          });
        } else {
          reasons.push({
            code: 'official_grade_unknown',
            severity: 'info',
            message: 'No verified grade valid at the start.',
            sourceType: held.qualificationIds.length > 0 ? 'qualification' : null,
            sourceIds: held.qualificationIds,
          });
        }
      }
      let safeguarding: ReplacementCandidate['safeguarding'] = null;
      if (profile.safeguardingKind) {
        const held = await this.qualifications.describe(
          trx,
          organizationId,
          personId,
          profile.safeguardingKind,
          start,
        );
        safeguarding = {
          kind: profile.safeguardingKind,
          status: held.status,
          validTo: held.validTo ? iso(held.validTo) : null,
        };
        if (!required.includes(profile.safeguardingKind)) {
          reasons.push(
            held.status === 'held'
              ? {
                  code: 'safeguarding_current',
                  severity: 'positive',
                  message: held.validTo
                    ? `Safeguarding certification valid until ${held.validTo.toISOString().slice(0, 10)}.`
                    : 'Safeguarding certification current, no expiry recorded.',
                  sourceType: 'qualification',
                  sourceIds: held.qualificationIds,
                }
              : {
                  code: `safeguarding_${held.status}`,
                  severity: 'warning',
                  message:
                    held.status === 'missing'
                      ? 'No safeguarding certification on record.'
                      : held.status === 'expired'
                        ? 'The safeguarding certification is not valid at the start.'
                        : 'The safeguarding certification awaits verification.',
                  sourceType: held.qualificationIds.length > 0 ? 'qualification' : null,
                  sourceIds: held.qualificationIds,
                },
          );
        }
      }
      candidates.push({
        personId,
        displayName: `${person.given_name} ${person.family_name}`,
        eligible: !reasons.some((r) => r.severity === 'blocking'),
        reasons,
        grade,
        safeguarding,
        positives: reasons.filter((r) => r.severity === 'positive').length,
      });
    }
    candidates.sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        b.positives - a.positives ||
        a.displayName.localeCompare(b.displayName) ||
        a.personId.localeCompare(b.personId),
    );
    return candidates.map(({ positives: _positives, ...candidate }) => candidate);
  }

  async replace(
    principal: Principal,
    assignmentId: string,
    body: CreateReplacementBody,
    correlationId: string | null,
  ): Promise<ReplacementOutcome> {
    const organizationId = organizationOf(principal);
    const existing = await this.assignments.authorizeView(principal, assignmentId);
    await this.authorization.require(principal, WorkforceActions.triggerReplacement, {
      type: 'assignment',
      id: assignmentId,
      organizationId,
      facilityId: existing.facility_id,
    });
    if (body.engagement !== 'regular') {
      await this.authorization.require(principal, WorkforceActions.grantTemporaryAccess, {
        type: 'assignment',
        id: assignmentId,
        organizationId,
        facilityId: existing.facility_id,
      });
    }
    // SPK-STAFF-003/004, SPK-AT-012, §4.6: the replacement is for the activity as its owning
    // module holds it now. A canceled, postponed or unscheduled activity is refused
    // (`target_not_scheduled`, the guard `create` applies), and the replacement takes the current
    // time, event and facility rather than the original row's copy.
    const target = await this.resolveTarget(principal, existing, body.engagement !== 'regular');
    const policy = workforcePolicyForFacility(this.policy, target.facilitySettings);
    const result = await this.uow.run(async ({ trx }) => {
      // WRK-02: the requirement's share lock before the assignment's (a retirement's order).
      await this.coverage.lockRequirementShared(
        trx,
        organizationId,
        existing.target_type,
        existing.target_id,
        existing.role,
      );
      const original = await this.assignments.lock(trx, organizationId, assignmentId);
      assertExpectedRevision(body.expectedRevision, original.revision);
      if (this.clock.now().getTime() >= target.scheduledEnd.getTime()) {
        throw errors.validation('The activity has already ended.', { code: 'target_ended' });
      }
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'workforce.replace_assignment',
        requestedBy: principal,
        correlationId,
        input: {
          assignmentId,
          personId: body.personId,
          withdrawOriginal: body.withdrawOriginal,
          offer: body.offer,
        },
        status: 'running',
      });
      let originalRow: AssignmentRow = original;
      let endsAccess = false;
      let uncovered = null;
      if (body.withdrawOriginal) {
        if (!LIVE_STATUSES.includes(original.status)) {
          throw errors.invalidTransition('Assignment', original.status, 'withdraw');
        }
        const withdrawn = await this.assignments.withdrawInTransaction(trx, principal, original, {
          reason: body.reason,
          cause: 'withdrawn',
          correlationId,
          facilitySettings: target.facilitySettings,
          operationId,
        });
        originalRow = withdrawn.row;
        endsAccess = withdrawn.operationId !== null;
        uncovered = withdrawn.uncovered;
      } else if (original.status !== 'declined' && original.status !== 'withdrawn') {
        throw errors.invalidTransition('Assignment', original.status, 'replace');
      }
      const replacement = await this.assignments.insertAssignment(trx, {
        organizationId,
        principal,
        target,
        personId: body.personId,
        kind: original.kind,
        role: original.role,
        slot: original.slot,
        engagement: body.engagement,
        turnaroundMinutes: turnaroundFor(policy, original.kind),
        offer: body.offer,
        replacesAssignmentId: original.id,
        reason: body.reason,
        correlationId,
        operationId,
      });
      const summary = { originalId: original.id, replacementId: replacement.id };
      if (!endsAccess) {
        await this.operations.transition(trx, operationId, 'succeeded', { result: summary });
      } else {
        // SPK-STAFF-004: the original's access ends in this transaction (identity joins it).
        await this.access.end(
          principal,
          assignmentId,
          organizationId,
          operationId,
          body.reason,
          correlationId,
          summary,
        );
      }
      return { originalRow, replacement, operationId, endsAccess, uncovered, summary };
    });
    const now = this.clock.now();
    const original = await this.assignments.load(this.db, organizationId, assignmentId);
    return {
      original: toAssignment(original ?? result.originalRow, now),
      replacement: toAssignment(result.replacement, now),
      operationId: result.operationId,
      uncovered: result.uncovered,
    };
  }

  /**
   * The original's activity as its owning module holds it now (outside any transaction, like every
   * target resolution). When it moved to another facility, the replacement authority must hold
   * there too.
   */
  private async resolveTarget(
    principal: Principal,
    row: AssignmentRow,
    temporary = false,
  ): Promise<ResolvedTarget> {
    const target = await this.targets.resolve(row.organization_id, {
      targetType: row.target_type,
      targetId: row.target_id,
      offeringId: row.offering_id,
    });
    if (target.facilityId !== row.facility_id) {
      await this.authorization.require(principal, WorkforceActions.triggerReplacement, {
        type: 'assignment',
        id: row.id,
        organizationId: row.organization_id,
        facilityId: target.facilityId,
      });
      if (temporary) {
        await this.authorization.require(principal, WorkforceActions.grantTemporaryAccess, {
          type: 'assignment',
          id: row.id,
          organizationId: row.organization_id,
          facilityId: target.facilityId,
        });
      }
    }
    return target;
  }
}
