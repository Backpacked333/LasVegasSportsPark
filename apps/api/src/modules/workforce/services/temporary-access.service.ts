import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError, systemPrincipal, type Principal } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  AuditWriter,
  CLOCK,
  DATABASE,
  OperationalExceptions,
  OperationsService,
  Outbox,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import { StaffMembershipsService } from '../../identity';
import { WorkforceEvents } from '../workforce.events';
import {
  TEMPORARY_ACCESS_FAILED,
  WORKFORCE_POLICY,
  type WorkforcePolicy,
} from '../workforce.policy';
import { addHours, type AssignmentRow } from '../workforce.shared';

/** The identity service records the membership as created by this system actor. */
const accessActor = (organizationId: string): Principal =>
  systemPrincipal(organizationId, 'workforce.temporary_access');

/**
 * Time-bounded access for temporary and substitute work (SPK-STAFF-004). The access is a staff
 * membership created and ended through identity's exported StaffMembershipsService — this module
 * never writes identity tables. The membership runs from acceptance until the activity's end plus
 * the policy's trailing hours; the principal resolver stops granting its roles at that instant,
 * so access expires on schedule while the assignment, its audit trail and its fee records remain.
 *
 * Identity commands run their own transactions, so each call happens between this module's
 * transactions and its outcome is recorded as a fact: granted, ended, or failed (the operation
 * is then `recovery_required` and a `workforce.temporary_access_failed` exception names it).
 */
@Injectable()
export class TemporaryAccessService {
  private readonly logger = new Logger(TemporaryAccessService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKFORCE_POLICY) private readonly policy: WorkforcePolicy,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly exceptions: OperationalExceptions,
    private readonly memberships: StaffMembershipsService,
  ) {}

  /** Whether accepting this assignment grants access (temporary or substitute work with roles to grant). */
  required(row: Pick<AssignmentRow, 'engagement' | 'kind'>): boolean {
    return row.engagement !== 'regular' && this.policy.temporaryAccess.roles[row.kind].length > 0;
  }

  /** Grants access after the acceptance committed. Identity failures are recorded, never thrown. */
  async grant(
    principal: Principal,
    assignmentId: string,
    organizationId: string,
    operationId: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.load(this.db, organizationId, assignmentId);
    if (!row || row.access_status !== 'pending' || row.status !== 'accepted') {
      await this.uow.run(({ trx }) =>
        this.operations.transition(trx, operationId, 'succeeded', {
          result: { assignmentId, access: row?.access_status ?? 'missing' },
        }),
      );
      return;
    }
    const now = this.clock.now();
    const from = now;
    const until = addHours(new Date(row.scheduled_end), this.policy.temporaryAccess.trailHours);
    let membershipId: string;
    try {
      const membership = await this.memberships.create(
        accessActor(organizationId),
        {
          personId: row.person_id,
          roles: this.policy.temporaryAccess.roles[row.kind],
          facilityIds: [row.facility_id],
          effectiveFrom: from.toISOString(),
          effectiveTo: until.toISOString(),
          reason: `Time-bounded access for ${row.engagement} assignment ${row.id} (SPK-STAFF-004)`,
        },
        correlationId,
      );
      membershipId = membership.id;
    } catch (error) {
      await this.recordFailure(principal, row, operationId, 'grant', error, correlationId);
      return;
    }
    await this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, assignmentId, true);
      if (!current) return;
      await trx
        .updateTable('assignments')
        .set({
          access_status: 'granted',
          access_membership_id: membershipId,
          access_from: from,
          access_until: until,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', assignmentId)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'workforce.temporary_access_granted',
        targetType: 'assignment',
        targetId: assignmentId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        correlationId,
        operationId,
        details: {
          staffMembershipId: membershipId,
          from: from.toISOString(),
          until: until.toISOString(),
          roles: this.policy.temporaryAccess.roles[row.kind],
        },
      });
      await this.outbox.enqueue(trx, WorkforceEvents.temporaryAccessChanged, {
        organizationId,
        aggregateType: 'assignment',
        aggregateId: assignmentId,
        correlationId,
        operationId,
        payload: {
          assignmentId,
          personId: row.person_id,
          status: 'granted',
          staffMembershipId: membershipId,
          from: from.toISOString(),
          until: until.toISOString(),
        },
      });
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: { assignmentId, access: 'granted', staffMembershipId: membershipId },
      });
    });
  }

  /**
   * Ends granted access early (withdrawal). The membership row stays in identity as history; the
   * assignment keeps its window with the end moved to the withdrawal instant.
   */
  async end(
    principal: Principal,
    assignmentId: string,
    organizationId: string,
    operationId: string,
    reason: string,
    correlationId: string | null,
    extraResult: Record<string, unknown> = {},
  ): Promise<void> {
    const row = await this.load(this.db, organizationId, assignmentId);
    if (!row || row.access_status !== 'granted' || !row.access_membership_id) {
      await this.uow.run(({ trx }) =>
        this.operations.transition(trx, operationId, 'succeeded', {
          result: { ...extraResult, assignmentId, access: row?.access_status ?? 'missing' },
        }),
      );
      return;
    }
    const membershipId = row.access_membership_id;
    try {
      await this.memberships.end(accessActor(organizationId), membershipId, { reason }, correlationId);
    } catch (error) {
      // A membership that already ended (or expired and was ended) is the outcome we want.
      const alreadyEnded = DomainError.is(error) && error.code === 'INVALID_TRANSITION';
      if (!alreadyEnded) {
        await this.recordFailure(principal, row, operationId, 'end', error, correlationId);
        return;
      }
    }
    const now = this.clock.now();
    await this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, organizationId, assignmentId, true);
      if (!current) return;
      const from = current.access_from ? new Date(current.access_from) : now;
      const until = current.access_until ? new Date(current.access_until) : now;
      // The window keeps a positive length; an access ended at its first instant is recorded as such.
      const endedAt = now.getTime() < until.getTime() ? now : until;
      const newUntil = endedAt.getTime() > from.getTime() ? endedAt : new Date(from.getTime() + 1);
      await trx
        .updateTable('assignments')
        .set({
          access_status: 'ended',
          access_until: newUntil,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', assignmentId)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'workforce.temporary_access_ended',
        targetType: 'assignment',
        targetId: assignmentId,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason,
        correlationId,
        operationId,
        details: { staffMembershipId: membershipId, endedAt: now.toISOString() },
      });
      await this.outbox.enqueue(trx, WorkforceEvents.temporaryAccessChanged, {
        organizationId,
        aggregateType: 'assignment',
        aggregateId: assignmentId,
        correlationId,
        operationId,
        payload: {
          assignmentId,
          personId: row.person_id,
          status: 'ended',
          staffMembershipId: membershipId,
          from: from.toISOString(),
          until: newUntil.toISOString(),
        },
      });
      await this.operations.transition(trx, operationId, 'succeeded', {
        result: { ...extraResult, assignmentId, access: 'ended', staffMembershipId: membershipId },
      });
    });
  }

  private async recordFailure(
    principal: Principal,
    row: AssignmentRow,
    operationId: string,
    step: 'grant' | 'end',
    error: unknown,
    correlationId: string | null,
  ): Promise<void> {
    const code = DomainError.is(error) ? error.code : 'INTERNAL_ERROR';
    const message = DomainError.is(error) ? error.message : 'Identity did not complete the change.';
    this.logger.warn(`temporary access ${step} failed for assignment ${row.id}: ${String(error)}`);
    await this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, row.organization_id, row.id, true);
      if (!current) return;
      if (step === 'grant') {
        await trx
          .updateTable('assignments')
          .set({ access_status: 'failed', revision: current.revision + 1 })
          .where('organization_id', '=', row.organization_id)
          .where('id', '=', row.id)
          .where('revision', '=', current.revision)
          .execute();
        await this.outbox.enqueue(trx, WorkforceEvents.temporaryAccessChanged, {
          organizationId: row.organization_id,
          aggregateType: 'assignment',
          aggregateId: row.id,
          correlationId,
          operationId,
          payload: {
            assignmentId: row.id,
            personId: row.person_id,
            status: 'failed',
            staffMembershipId: null,
            from: null,
            until: null,
          },
        });
      }
      await this.audit.record(trx, {
        organizationId: row.organization_id,
        actor: principal,
        action: `workforce.temporary_access_${step}_failed`,
        targetType: 'assignment',
        targetId: row.id,
        correlationId,
        operationId,
        details: { code, message },
      });
      await this.exceptions.raise(trx, {
        organizationId: row.organization_id,
        facilityId: row.facility_id,
        category: TEMPORARY_ACCESS_FAILED,
        severity: 'high',
        title:
          step === 'grant'
            ? `Time-bounded access could not be granted for assignment ${row.id}`
            : `Time-bounded access could not be ended for assignment ${row.id}`,
        affectedType: 'assignment',
        affectedId: row.id,
        ownerQueue: 'system_administrator',
        dedupeKey: `${TEMPORARY_ACCESS_FAILED}:${step}:${row.id}`,
        details: { step, code, message, staffMembershipId: row.access_membership_id },
      });
      await this.operations.transition(trx, operationId, 'recovery_required', {
        error: { code, message, details: { step, assignmentId: row.id } },
      });
    });
  }

  private async load(
    db: Db | Trx,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<AssignmentRow | undefined> {
    let q = db
      .selectFrom('assignments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }
}
