import { Inject, Injectable } from '@nestjs/common';
import {
  systemPrincipal,
  type AssignmentKind,
  type AssignmentTargetType,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
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

export interface UncoveredNotice {
  exceptionId: string;
  role: string;
  slot: number;
  startsAt: string;
}

export type UncoveredCause = 'declined' | 'withdrawn' | 'schedule_conflict';

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
  ) {}

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
      .orderBy('role')
      .execute();
  }

  async requirementFor(
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

  async acceptedAssignees(
    organizationId: string,
    targetType: AssignmentTargetType,
    targetId: string,
    kind?: AssignmentKind,
    trx?: Trx,
  ): Promise<string[]> {
    let q = (trx ?? this.uow.reader())
      .selectFrom('assignments')
      .select('person_id')
      .distinct()
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', targetType)
      .where('target_id', '=', targetId)
      .where('status', 'in', [...COVERING_STATUSES]);
    if (kind) q = q.where('kind', '=', kind);
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
      .selectFrom('assignments')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('target_type', '=', 'fixture')
      .where('target_id', '=', fixtureId)
      .where('person_id', '=', personId)
      .where('kind', '=', 'official')
      .where('status', 'in', [...COVERING_STATUSES])
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Readiness check `workforce.required_officials` (SPK-READY-001/003, SPK-STAFF-002). Each
   * requirement short of accepted people is a blocking issue (a warning when the requirement does
   * not demand acceptance); proposed and offered assignments are named but never counted.
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
        code: role.kind === 'official' ? 'required_officials_not_accepted' : 'required_staff_not_accepted',
        severity: role.mustBeAccepted ? 'blocking' : 'warning',
        message: `${accepted} of ${role.requiredCount} required ${role.role} accepted.${pending}`,
        source: { type: 'assignment_requirement', id: role.requirementId },
        responsibleRole: 'league_manager',
        requiredAction:
          'Offer the role to a qualified, available person and obtain acceptance (see the replacement candidates of the open assignment).',
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
    const requirement = await this.requirementFor(
      trx,
      row.organization_id,
      row.target_type,
      row.target_id,
      row.role,
    );
    if (!requirement || !requirement.must_be_accepted) return null;
    if (row.slot > requirement.required_count) return null;
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
    const windowMs = policy.uncoveredEscalationHours * 3_600_000;
    if (now.getTime() >= end.getTime()) return null;
    if (start.getTime() - now.getTime() > windowMs) return null;
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
    const open = await trx
      .selectFrom('operational_exceptions')
      .select('id')
      .where('organization_id', '=', row.organization_id)
      .where('dedupe_key', '=', uncoveredDedupeKey(row.target_type, row.target_id, row.role, row.slot))
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
}
