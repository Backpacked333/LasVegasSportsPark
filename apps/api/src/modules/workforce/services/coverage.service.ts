import { Inject, Injectable } from '@nestjs/common';
import {
  systemPrincipal,
  type AssignmentKind,
  type AssignmentTargetType,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  CLOCK,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  FIXTURE_PORT,
  type AssignmentCheckPort,
  type FixturePort,
  type ReadinessCheckContext,
  type ReadinessIssue,
} from '../../competition';
import type { AssignmentCoveragePort, RoleCoverage } from '../ports';
import { WorkforceEvents } from '../workforce.events';
import {
  UNCOVERED_ASSIGNMENT,
  WORKFORCE_POLICY,
  workforcePolicyForFacility,
  type WorkforcePolicy,
} from '../workforce.policy';
import {
  COVERING_STATUSES,
  iso,
  type AssignmentRow,
  type RequirementRow,
} from '../workforce.shared';
import { QualificationsService } from './qualifications.service';

export interface UncoveredNotice {
  exceptionId: string;
  role: string;
  slot: number;
  startsAt: string;
}

export type UncoveredCause = 'declined' | 'withdrawn' | 'schedule_conflict';

/**
 * WRK-02: the assignment (table alias `alias`) does not belong to a retired requirement of its
 * target and role. Assignments without any requirement (declared ad hoc) still count.
 */
export function notOfRetiredRequirement(alias: string) {
  return sql<boolean>`not exists (
    select 1 from assignment_requirements rr
     where rr.organization_id = ${sql.ref(`${alias}.organization_id`)}
       and rr.target_type = ${sql.ref(`${alias}.target_type`)}
       and rr.target_id = ${sql.ref(`${alias}.target_id`)}
       and rr.role = ${sql.ref(`${alias}.role`)}
       and rr.retired_at is not null)`;
}

export const uncoveredDedupeKey = (
  targetType: string,
  targetId: string,
  role: string,
  slot: number,
): string => `${UNCOVERED_ASSIGNMENT}:${targetType}:${targetId}:${role}:${slot}`;

/**
 * Coverage of required roles (SPK-STAFF-002): only accepted (or completed) assignments satisfy a
 * requirement; proposed and offered ones are reported but never counted. Serves:
 *  - competition's readiness check registry (`workforce.required_officials`, SPK-READY-001);
 *  - competition's ASSIGNMENT_CHECK_PORT (an accepted official may submit results, SPK-STAFF-005);
 *  - the escalation of a required slot left uncovered close to the start (SPK-STAFF-003,
 *    SPK-AT-012) and its resolution once the slot is covered again.
 * Reads go through the caller's transaction when one is active.
 */
@Injectable()
export class CoverageService implements AssignmentCheckPort, AssignmentCoveragePort {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKFORCE_POLICY) private readonly policy: WorkforcePolicy,
    @Inject(FIXTURE_PORT) private readonly fixtures: FixturePort,
    private readonly uow: UnitOfWork,
    private readonly exceptions: OperationalExceptions,
    private readonly outbox: Outbox,
    private readonly qualifications: QualificationsService,
  ) {}

  /** The target's requirements in force (WRK-02: retired requirements are skipped). */
  async requirements(
    db: Db | Trx,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
  ): Promise<RequirementRow[]> {
    return db
      .selectFrom('assignment_requirements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId)
      .where('retired_at', 'is', null)
      .orderBy('role')
      .execute();
  }

  /** The requirement in force for the target and role (WRK-02: never a retired one). */
  async requirementFor(
    db: Db | Trx,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    role: string,
  ): Promise<RequirementRow | undefined> {
    const row = await this.anyRequirementFor(db, organizationId, targetType, targetId, role);
    return row && row.retired_at === null ? row : undefined;
  }

  /** The requirement for the target and role, retired or not (unique per target and role). */
  async anyRequirementFor(
    db: Db | Trx,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    role: string,
  ): Promise<RequirementRow | undefined> {
    return db
      .selectFrom('assignment_requirements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId)
      .where('role', '=', role)
      .executeTakeFirst();
  }

  /**
   * Takes the requirement row's share lock before an assignment of its role is locked or inserted
   * (WRK-02): the trigger `assignments_requirement_not_retired` takes the same lock, and a
   * retirement locks the requirement before the assignments, so both take the locks in one order.
   * Returns the requirement (retired or not), if any.
   */
  async lockRequirementShared(
    trx: Trx,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    role: string,
  ): Promise<RequirementRow | undefined> {
    return trx
      .selectFrom('assignment_requirements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId)
      .where('role', '=', role)
      .forShare()
      .executeTakeFirst();
  }

  /** Coverage per requirement, computed from the assignment rows (never stored, SPK-READY-004). */
  async coverage(
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    trx?: Trx,
  ): Promise<RoleCoverage[]> {
    const db = trx ?? this.uow.reader();
    const requirements = await this.requirements(db, organizationId, targetType, targetId);
    if (requirements.length === 0) return [];
    const rows = await db
      .selectFrom('assignments')
      .select(['person_id', 'role', 'slot', 'status'])
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId)
      .where('status', 'in', ['proposed', 'offered', 'accepted', 'completed'])
      .execute();
    return requirements.map((req) => {
      const own = rows.filter((r) => r.role === req.role && r.slot <= req.required_count);
      const covering = own.filter((r) => COVERING_STATUSES.includes(r.status));
      const covered = new Set(covering.map((r) => r.slot));
      const uncoveredSlots: number[] = [];
      for (let slot = 1; slot <= req.required_count; slot += 1) {
        if (!covered.has(slot)) uncoveredSlots.push(slot);
      }
      return {
        requirementId: req.id,
        role: req.role,
        kind: req.kind,
        requiredCount: req.required_count,
        mustBeAccepted: req.must_be_accepted,
        acceptedPersonIds: covering.map((r) => r.person_id),
        offered: own.filter((r) => r.status === 'offered').length,
        proposed: own.filter((r) => r.status === 'proposed').length,
        uncoveredSlots,
      };
    });
  }

  /**
   * IF-34, WRK-03 (SPK-UX-007 assigned activities only, SPK-YOUTH-005): whether the person holds an
   * accepted or completed assignment of the kind on any session of the offering. Proposed and
   * offered assignments never count; assignments of a retired requirement are skipped (WRK-02).
   * Reads through the passed transaction, else the active one.
   */
  async isAcceptedOnOffering(
    organizationId: string,
    offeringId: string,
    personId: string,
    kind: AssignmentKind,
    trx?: Trx,
  ): Promise<boolean> {
    const row = await (trx ?? this.uow.reader())
      .selectFrom('assignments as a')
      .select('a.id')
      .where('a.organization_id', '=', organizationId)
      .where('a.target_type', '=', 'session')
      .where('a.offering_id', '=', offeringId)
      .where('a.person_id', '=', personId)
      .where('a.kind', '=', kind)
      .where('a.status', 'in', [...COVERING_STATUSES])
      .where(notOfRetiredRequirement('a'))
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** People holding an accepted (or completed) assignment of the kind (retired requirements skipped). */
  async acceptedAssignees(
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    kind?: AssignmentKind,
    trx?: Trx,
  ): Promise<string[]> {
    let q = (trx ?? this.uow.reader())
      .selectFrom('assignments as a')
      .select('a.person_id')
      .distinct()
      .where('a.organization_id', '=', organizationId)
      .where('a.target_type', '=', targetType)
      .where('a.target_id', '=', targetId)
      .where('a.status', 'in', [...COVERING_STATUSES])
      .where(notOfRetiredRequirement('a'));
    if (kind) q = q.where('a.kind', '=', kind);
    return (await q.execute()).map((r) => r.person_id).sort();
  }

  /** ASSIGNMENT_CHECK_PORT (competition): an accepted (or completed) official assignment for the fixture. */
  async isAcceptedOfficial(
    organizationId: string,
    fixtureId: string,
    personId: string,
    trx?: Trx,
  ): Promise<boolean> {
    const row = await (trx ?? this.uow.reader())
      .selectFrom('assignments as a')
      .select('a.id')
      .where('a.organization_id', '=', organizationId)
      .where('a.target_type', '=', 'fixture')
      .where('a.target_id', '=', fixtureId)
      .where('a.person_id', '=', personId)
      .where('a.kind', '=', 'official')
      .where('a.status', 'in', [...COVERING_STATUSES])
      .where(notOfRetiredRequirement('a'))
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Readiness check `workforce.required_officials` (SPK-READY-001/003, SPK-STAFF-002). Each
   * requirement short of accepted people is a blocking issue (a warning when the requirement does
   * not demand acceptance); proposed and offered assignments are named but never counted.
   *
   * SPK-READY-002/004, SPK-STAFF-001: an accepted assignee must still hold the requirement's
   * qualifications, verified and valid at the activity's (current) start, evaluated now from the
   * qualification records: a revocation after acceptance, a requirement edited to add a
   * qualification, or a reschedule past the qualification's validity each make the check blocked
   * (`required_official_unqualified`). The coverage counts stay the assignment fact. The message
   * names no person and no qualification status, because readiness reaches team members.
   */
  async readinessIssues(context: ReadinessCheckContext): Promise<ReadinessIssue[]> {
    const coverage = await this.coverage(
      context.organizationId,
      'fixture',
      context.fixtureId,
      context.trx,
    );
    if (coverage.length === 0) {
      return [
        {
          code: 'officials_not_required',
          severity: 'info',
          message: 'No official or staff requirement is declared for this fixture.',
          source: { type: 'fixture', id: context.fixtureId },
          responsibleRole: 'league_manager',
          requiredAction: 'Declare an assignment requirement if the fixture needs officials.',
          deadline: null,
        },
      ];
    }
    const fixture = await this.fixtures.findFixture(
      context.organizationId,
      context.fixtureId,
      context.trx,
    );
    const deadline = fixture?.scheduledStart ? iso(fixture.scheduledStart) : null;
    const issues: ReadinessIssue[] = [];
    for (const role of coverage) {
      if (role.uncoveredSlots.length === 0) continue;
      const accepted = role.requiredCount - role.uncoveredSlots.length;
      const pending =
        role.offered + role.proposed > 0
          ? ` ${role.offered} offered and ${role.proposed} proposed assignment(s) do not count until accepted.`
          : '';
      issues.push({
        code:
          role.kind === 'official'
            ? 'required_officials_not_accepted'
            : 'required_staff_not_accepted',
        severity: role.mustBeAccepted ? 'blocking' : 'warning',
        message: `${accepted} of ${role.requiredCount} required ${role.role} accepted.${pending}`,
        source: { type: 'assignment_requirement', id: role.requirementId },
        responsibleRole: 'league_manager',
        requiredAction:
          'Offer the role to a qualified, available person and obtain acceptance (see the replacement candidates of the open assignment).',
        deadline,
      });
    }
    issues.push(...(await this.unqualifiedIssues(context, deadline)));
    return issues;
  }

  /** Accepted assignees of required slots who no longer hold the required qualifications. */
  private async unqualifiedIssues(
    context: ReadinessCheckContext,
    deadline: string | null,
  ): Promise<ReadinessIssue[]> {
    const db = context.trx ?? this.uow.reader();
    const requirements = (
      await this.requirements(db, context.organizationId, 'fixture', context.fixtureId)
    ).filter((req) => req.required_qualifications.length > 0);
    const issues: ReadinessIssue[] = [];
    for (const req of requirements) {
      const accepted = await db
        .selectFrom('assignments')
        .select(['person_id', 'scheduled_start'])
        .where('organization_id', '=', context.organizationId)
        .where('target_type', '=', 'fixture')
        .where('target_id', '=', context.fixtureId)
        .where('role', '=', req.role)
        .where('slot', '<=', req.required_count)
        .where('status', '=', 'accepted')
        .execute();
      let unqualified = 0;
      for (const row of accepted) {
        const checks = await this.qualifications.check(
          db,
          context.organizationId,
          row.person_id,
          req.required_qualifications,
          new Date(row.scheduled_start),
        );
        if (checks.some((c) => c.status !== 'held')) unqualified += 1;
      }
      if (unqualified === 0) continue;
      issues.push({
        code:
          req.kind === 'official' ? 'required_official_unqualified' : 'required_staff_unqualified',
        severity: req.must_be_accepted ? 'blocking' : 'warning',
        message: `${unqualified} accepted ${req.role} assignment(s) lack a required qualification (${req.required_qualifications.join(', ')}) valid at the start.`,
        source: { type: 'assignment_requirement', id: req.id },
        responsibleRole: 'league_manager',
        requiredAction:
          'Verify current qualification evidence or replace the assignee (see the replacement candidates of the assignment).',
        deadline,
      });
    }
    return issues;
  }

  /**
   * After a decline or withdrawal: when the slot is required, demands acceptance, has no accepted
   * assignment any more and the activity starts within the escalation window, raise
   * `workforce.uncovered_assignment` (league manager queue for fixtures, scheduler otherwise) and
   * enqueue `workforce.assignment_uncovered` (SPK-STAFF-003, SPK-AT-012).
   */
  async escalateIfUncovered(
    trx: Trx,
    row: AssignmentRow,
    cause: UncoveredCause,
    correlationId: string | null,
    facilitySettings: Record<string, unknown>,
  ): Promise<UncoveredNotice | null> {
    // WRK-02: read under the requirement's share lock, so an escalation racing a retirement either
    // sees the requirement retired (nothing to cover) or is seen by the retirement and resolved.
    const locked = await this.lockRequirementShared(
      trx,
      row.organization_id,
      row.target_type,
      row.target_id,
      row.role,
    );
    const requirement = locked && locked.retired_at === null ? locked : undefined;
    if (!requirement || !requirement.must_be_accepted) return null;
    if (row.slot > requirement.required_count) return null;
    // SPK-UX-006: serialized with an acceptance of the same slot (resolveIfCovered takes the same
    // lock), so a decline and a concurrent acceptance never leave an open exception on a covered slot.
    await this.lockSlot(trx, row);
    const covering = await trx
      .selectFrom('assignments')
      .select('id')
      .where('organization_id', '=', row.organization_id)
      .where('target_type', '=', row.target_type)
      .where('target_id', '=', row.target_id)
      .where('role', '=', row.role)
      .where('slot', '=', row.slot)
      .where('status', 'in', [...COVERING_STATUSES])
      .executeTakeFirst();
    if (covering) return null;
    const now = this.clock.now();
    const start = new Date(row.scheduled_start);
    const end = new Date(row.scheduled_end);
    const policy = workforcePolicyForFacility(this.policy, facilitySettings);
    if (now.getTime() >= end.getTime()) return null;
    // WRK-06 (DEC-011 pending): without a configured escalation window the slot escalates at once.
    if (
      policy.uncoveredEscalationHours !== null &&
      start.getTime() - now.getTime() > policy.uncoveredEscalationHours * 3_600_000
    ) {
      return null;
    }
    const raised = await this.exceptions.raise(trx, {
      organizationId: row.organization_id,
      facilityId: row.facility_id,
      category: UNCOVERED_ASSIGNMENT,
      severity: 'high',
      title: `Uncovered ${row.role.replaceAll('_', ' ')} (slot ${row.slot}) for ${row.target_title}`,
      affectedType: row.target_type,
      affectedId: row.target_id,
      ownerQueue: row.target_type === 'fixture' ? 'league_manager' : 'scheduler',
      deadlineAt: start,
      dedupeKey: uncoveredDedupeKey(row.target_type, row.target_id, row.role, row.slot),
      details: {
        assignmentId: row.id,
        role: row.role,
        slot: row.slot,
        cause,
        startsAt: start.toISOString(),
        replacementsHref: `/v1/assignments/${row.id}/replacements`,
      },
    });
    if (!raised.deduplicated) {
      await this.outbox.enqueue(trx, WorkforceEvents.assignmentUncovered, {
        organizationId: row.organization_id,
        aggregateType: 'assignment',
        aggregateId: row.id,
        correlationId,
        payload: {
          assignmentId: row.id,
          targetType: row.target_type,
          targetId: row.target_id,
          facilityId: row.facility_id,
          role: row.role,
          slot: row.slot,
          startsAt: start.toISOString(),
          cause,
          exceptionId: raised.id,
        },
      });
    }
    return {
      exceptionId: raised.id,
      role: row.role,
      slot: row.slot,
      startsAt: start.toISOString(),
    };
  }

  /** Resolves an open uncovered-slot exception once an accepted assignment covers the slot again. */
  async resolveIfCovered(
    trx: Trx,
    row: AssignmentRow,
    correlationId: string | null,
  ): Promise<string | null> {
    await this.lockSlot(trx, row);
    const open = await trx
      .selectFrom('operational_exceptions')
      .select('id')
      .where('organization_id', '=', row.organization_id)
      .where(
        'dedupe_key',
        '=',
        uncoveredDedupeKey(row.target_type, row.target_id, row.role, row.slot),
      )
      .where('status', 'in', ['open', 'acknowledged'])
      .executeTakeFirst();
    if (!open) return null;
    await this.exceptions.transition(
      trx,
      systemPrincipal(row.organization_id, 'workforce.coverage'),
      open.id,
      'resolved',
      {
        reason: `Slot covered by accepted assignment ${row.id}.`,
        resolution: { coveredByAssignmentId: row.id, personId: row.person_id },
        correlationId: correlationId ?? undefined,
      },
    );
    return open.id;
  }

  /** Whether the target has an open (or acknowledged) uncovered-slot exception. */
  async hasOpenUncovered(
    trx: Trx,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
  ): Promise<boolean> {
    const row = await this.openUncovered(
      trx,
      organizationId,
      targetType,
      targetId,
    ).executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Closes the target's open uncovered-slot exceptions when the activity itself is canceled,
   * postponed or unscheduled (SPK-UX-006: the queue reflects reality; SPK-AT-012). They stay as
   * history. Idempotent under replay: only open or acknowledged exceptions match.
   */
  async closeUncovered(
    trx: Trx,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    reason: string,
    correlationId: string | null,
  ): Promise<string[]> {
    const open = await this.openUncovered(trx, organizationId, targetType, targetId).execute();
    for (const exception of open) {
      await this.exceptions.transition(
        trx,
        systemPrincipal(organizationId, 'workforce.coverage'),
        exception.id,
        'closed',
        { reason, correlationId: correlationId ?? undefined },
      );
    }
    return open.map((e) => e.id);
  }

  /**
   * WRK-02: a retired requirement needs no covering, so the open (or acknowledged) uncovered-slot
   * exceptions of its role on the target are resolved, naming the retirement. They stay as
   * history; idempotent (only open or acknowledged exceptions match).
   */
  async resolveUncoveredOfRetired(
    trx: Trx,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    roles: readonly string[],
    reason: string,
    resolution: Record<string, unknown>,
    correlationId: string | null,
  ): Promise<string[]> {
    if (roles.length === 0) return [];
    const open = await trx
      .selectFrom('operational_exceptions')
      .select(['id', 'dedupe_key'])
      .where('organization_id', '=', organizationId)
      .where('category', '=', UNCOVERED_ASSIGNMENT)
      .where('affected_type', '=', targetType)
      .where('affected_id', '=', targetId)
      .where('status', 'in', ['open', 'acknowledged'])
      .orderBy('id')
      .execute();
    const prefixes = roles.map(
      (role) => `${UNCOVERED_ASSIGNMENT}:${targetType}:${targetId}:${role}:`,
    );
    const resolved: string[] = [];
    for (const exception of open) {
      const key = exception.dedupe_key;
      if (!key || !prefixes.some((prefix) => key.startsWith(prefix))) continue;
      await this.exceptions.transition(
        trx,
        systemPrincipal(organizationId, 'workforce.coverage'),
        exception.id,
        'resolved',
        { reason, resolution, correlationId: correlationId ?? undefined },
      );
      resolved.push(exception.id);
    }
    return resolved;
  }

  private openUncovered(
    trx: Trx,
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
  ) {
    return trx
      .selectFrom('operational_exceptions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('category', '=', UNCOVERED_ASSIGNMENT)
      .where('affected_type', '=', targetType)
      .where('affected_id', '=', targetId)
      .where('status', 'in', ['open', 'acknowledged'])
      .orderBy('id');
  }

  /** Transaction-scoped lock of one required slot (escalation and resolution are serialized). */
  private async lockSlot(trx: Trx, row: AssignmentRow): Promise<void> {
    const key = `workforce.slot:${uncoveredDedupeKey(row.target_type, row.target_id, row.role, row.slot)}:${row.organization_id}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
  }
}
