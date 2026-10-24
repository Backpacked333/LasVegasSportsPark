import { Inject, Injectable, Logger } from '@nestjs/common';
import { DomainError, systemPrincipal, type Principal } from '@sportspark/contracts';
import { isSerializationFailure, type Db } from '@sportspark/db';
import {
  AuditWriter,
  CLOCK,
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
 * membership created, moved and ended through identity's exported StaffMembershipsService — this
 * module never writes identity tables. The membership runs from acceptance until the activity's
 * end plus the policy's trailing hours; the principal resolver stops granting its roles at that
 * instant, so access expires on schedule while the assignment, its audit trail and its fee records
 * remain.
 *
 * Every method runs inside the caller's transaction (the acceptance, the withdrawal, or an outbox
 * handler's): identity's command joins it (UnitOfWork.run is reentrant), so the assignment and the
 * membership change commit together and a stop between them cannot leave access `pending` or a
 * membership the assignment does not reference (§4.7 invariants 3 and 12). Identity refusing the
 * change is recorded as a fact in the same transaction: the access is `failed`, the operation is
 * `recovery_required` and a `workforce.temporary_access_failed` exception names it.
 */
@Injectable()
export class TemporaryAccessService {
  private readonly logger = new Logger(TemporaryAccessService.name);

  constructor(
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

  /** Grants access within the acceptance's transaction. Identity failures are recorded, never thrown. */
  async grant(
    principal: Principal,
    assignmentId: string,
    organizationId: string,
    operationId: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.load(this.uow.reader(), organizationId, assignmentId);
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
      // A serialization failure or deadlock is retried by the outermost unit of work.
      if (isSerializationFailure(error)) throw error;
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
   * Ends granted access early (withdrawal, by a person or by a follow-up such as a canceled
   * fixture). The membership row stays in identity as history; the assignment keeps its window
   * with the end moved to the withdrawal instant.
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
    const row = await this.load(this.uow.reader(), organizationId, assignmentId);
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
      await this.memberships.end(
        accessActor(organizationId),
        membershipId,
        { reason },
        correlationId,
      );
    } catch (error) {
      // A membership that already ended (or expired and was ended) is the outcome we want.
      if (isSerializationFailure(error)) throw error;
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

  /**
   * Moves the end of granted access with a rescheduled activity (new end plus the trailing hours),
   * so access neither outlives a game brought forward nor expires before a game moved later
   * (SPK-STAFF-004). Called from the retime follow-up inside its transaction; no operation.
   */
  async move(
    principal: Principal,
    row: AssignmentRow,
    activityEnd: Date,
    correlationId: string | null,
  ): Promise<void> {
    if (row.access_status !== 'granted' || !row.access_membership_id) return;
    const membershipId = row.access_membership_id;
    const until = addHours(activityEnd, this.policy.temporaryAccess.trailHours);
    if (row.access_until && new Date(row.access_until).getTime() === until.getTime()) return;
    const from = row.access_from ? new Date(row.access_from) : this.clock.now();
    if (until.getTime() <= from.getTime()) {
      // Moved to before the access began: nothing of the window is left.
      return this.endWithoutOperation(
        principal,
        row,
        'The activity moved before the access began.',
        correlationId,
      );
    }
    try {
      const membership = await this.memberships.find(row.organization_id, membershipId);
      if (!membership || membership.status !== 'active') return;
      await this.memberships.update(
        accessActor(row.organization_id),
        membershipId,
        {
          effectiveTo: until.toISOString(),
          expectedRevision: membership.revision,
          reason: `Activity rescheduled (assignment ${row.id})`,
        },
        correlationId,
      );
    } catch (error) {
      // An ended membership needs no move; anything else is an owned failure (never thrown, so
      // the retime itself still commits).
      if (isSerializationFailure(error)) throw error;
      if (DomainError.is(error) && error.code === 'INVALID_TRANSITION') return;
      await this.recordFailure(principal, row, null, 'move', error, correlationId);
      return;
    }
    await this.uow.run(async ({ trx }) => {
      const current = await this.load(trx, row.organization_id, row.id, true);
      if (!current) return;
      await trx
        .updateTable('assignments')
        .set({ access_until: until, revision: current.revision + 1 })
        .where('organization_id', '=', row.organization_id)
        .where('id', '=', row.id)
        .where('revision', '=', current.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId: row.organization_id,
        actor: principal,
        action: 'workforce.temporary_access_moved',
        targetType: 'assignment',
        targetId: row.id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        correlationId,
        details: {
          staffMembershipId: membershipId,
          before: current.access_until ? new Date(current.access_until).toISOString() : null,
          until: until.toISOString(),
        },
      });
      await this.outbox.enqueue(trx, WorkforceEvents.temporaryAccessChanged, {
        organizationId: row.organization_id,
        aggregateType: 'assignment',
        aggregateId: row.id,
        correlationId,
        payload: {
          assignmentId: row.id,
          personId: row.person_id,
          status: 'granted',
          staffMembershipId: membershipId,
          from: from.toISOString(),
          until: until.toISOString(),
        },
      });
    });
  }

  /** `end` for a follow-up that has no operation of its own (a retime that left no window). */
  private async endWithoutOperation(
    principal: Principal,
    row: AssignmentRow,
    reason: string,
    correlationId: string | null,
  ): Promise<void> {
    const operationId = await this.uow.run(({ trx }) =>
      this.operations.create(trx, {
        organizationId: row.organization_id,
        kind: 'workforce.end_temporary_access',
        requestedBy: principal,
        correlationId,
        input: { assignmentId: row.id },
        status: 'running',
      }),
    );
    await this.end(principal, row.id, row.organization_id, operationId, reason, correlationId);
  }

  private async recordFailure(
    principal: Principal,
    row: AssignmentRow,
    operationId: string | null,
    step: 'grant' | 'end' | 'move',
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
            : step === 'end'
              ? `Time-bounded access could not be ended for assignment ${row.id}`
              : `Time-bounded access could not follow the rescheduled assignment ${row.id}`,
        affectedType: 'assignment',
        affectedId: row.id,
        ownerQueue: 'system_administrator',
        dedupeKey: `${TEMPORARY_ACCESS_FAILED}:${step}:${row.id}`,
        details: { step, code, message, staffMembershipId: row.access_membership_id },
      });
      if (operationId) {
        await this.operations.transition(trx, operationId, 'recovery_required', {
          error: { code, message, details: { step, assignmentId: row.id } },
        });
      }
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
