import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CreateStaffMembershipInput,
  type Principal,
  type StaffMembership,
  type StaffRole,
  type UpdateStaffMembershipInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  ensureUpdated,
  executorFor,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import { StaffMembershipMachine } from '../identity.machines';
import type { StaffDirectoryPort } from '../identity.ports';
import { toStaffMembership } from '../identity.shared';

/**
 * Staff memberships (§2.1, §4.14). Time-bounded role assignments managed only by system
 * administrators; the principal resolver reads them at request time, so ending a membership
 * removes staff authority on the next request without touching any guardian grant.
 */
@Injectable()
export class StaffMembershipsService implements StaffDirectoryPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async create(
    principal: Principal,
    input: CreateStaffMembershipInput,
    correlationId: string | null,
  ): Promise<StaffMembership> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.manageStaffMembership, {
      type: 'staff_membership',
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      const person = await trx
        .selectFrom('persons')
        .select(['kind', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.personId)
        .executeTakeFirst();
      if (!person) throw errors.notFound('person', input.personId);
      if (person.status !== 'active' || person.kind !== 'adult') {
        throw errors.validation('Staff memberships require an active adult person.');
      }
      await this.assertFacilities(trx, organizationId, input.facilityIds);
      const now = this.clock.now();
      const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
      const effectiveTo = input.effectiveTo ? new Date(input.effectiveTo) : null;
      if (effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
        throw errors.validation('effectiveTo must be after effectiveFrom.');
      }
      const id = newId();
      await trx
        .insertInto('staff_memberships')
        .values({
          id,
          organization_id: organizationId,
          person_id: input.personId,
          roles: input.roles,
          facility_ids: input.facilityIds,
          effective_from: effectiveFrom,
          effective_to: effectiveTo,
          ended_at: null,
          ended_reason: null,
          created_by: json(snapshotActor(principal)),
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageStaffMembership.id,
        targetType: 'staff_membership',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'create', personId: input.personId, roles: input.roles },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffMembershipChanged, {
        organizationId,
        aggregateType: 'staff_membership',
        aggregateId: id,
        payload: {
          membershipId: id,
          personId: input.personId,
          status: 'active',
          roles: input.roles,
        },
        correlationId,
      });
      return this.load(trx, organizationId, id);
    });
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateStaffMembershipInput,
    correlationId: string | null,
  ): Promise<StaffMembership> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.manageStaffMembership, {
      type: 'staff_membership',
      id,
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      // §4.9: locked so concurrent changes to one membership are serialized.
      const current = await trx
        .selectFrom('staff_memberships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('staff_membership', id);
      assertExpectedRevision(input.expectedRevision, current.revision);
      if (current.status !== 'active') {
        throw errors.invalidTransition('StaffMembership', current.status, 'update');
      }
      if (input.facilityIds) await this.assertFacilities(trx, organizationId, input.facilityIds);
      const effectiveTo =
        input.effectiveTo === undefined
          ? current.effective_to
          : input.effectiveTo === null
            ? null
            : new Date(input.effectiveTo);
      if (
        effectiveTo &&
        new Date(effectiveTo).getTime() <= new Date(current.effective_from).getTime()
      ) {
        throw errors.validation('effectiveTo must be after effectiveFrom.');
      }
      const updated = await trx
        .updateTable('staff_memberships')
        .set({
          roles: input.roles ?? current.roles,
          facility_ids: input.facilityIds ?? current.facility_ids,
          effective_to: effectiveTo,
          revision: current.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      ensureUpdated(updated.numUpdatedRows, () =>
        errors.staleRevision(current.revision, current.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageStaffMembership.id,
        targetType: 'staff_membership',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'update', roles: input.roles ?? current.roles },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffMembershipChanged, {
        organizationId,
        aggregateType: 'staff_membership',
        aggregateId: id,
        payload: {
          membershipId: id,
          personId: current.person_id,
          status: 'active',
          roles: input.roles ?? current.roles,
        },
        correlationId,
      });
      return this.load(trx, organizationId, id);
    });
  }

  async end(
    principal: Principal,
    id: string,
    input: { reason: string; expectedRevision?: number },
    correlationId: string | null,
  ): Promise<StaffMembership> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    await this.authorization.require(principal, IdentityActions.manageStaffMembership, {
      type: 'staff_membership',
      id,
      organizationId,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      // §4.9: locked so concurrent changes to one membership are serialized.
      const current = await trx
        .selectFrom('staff_memberships')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('staff_membership', id);
      assertExpectedRevision(input.expectedRevision, current.revision);
      const next = StaffMembershipMachine.next(current.status, 'end');
      const now = this.clock.now();
      const cap =
        current.effective_to && new Date(current.effective_to).getTime() < now.getTime()
          ? new Date(current.effective_to)
          : now;
      // SPK-STAFF-004, SPK-IAM-006: a membership ended before it started gets the empty window
      // [effective_from, effective_from), which never grants anything (the 0100 check allows it).
      const neverEffective = cap.getTime() < new Date(current.effective_from).getTime();
      const effectiveTo = neverEffective ? new Date(current.effective_from) : cap;
      const ended = await trx
        .updateTable('staff_memberships')
        .set({
          status: next,
          ended_at: now,
          ended_reason: input.reason,
          effective_to: effectiveTo,
          revision: current.revision + 1,
        })
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      ensureUpdated(ended.numUpdatedRows, () =>
        errors.staleRevision(current.revision, current.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.manageStaffMembership.id,
        targetType: 'staff_membership',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason,
        correlationId,
        details: { operation: 'end', ...(neverEffective ? { neverEffective: true } : {}) },
      });
      await this.outbox.enqueue(trx, IdentityEvents.staffMembershipChanged, {
        organizationId,
        aggregateType: 'staff_membership',
        aggregateId: id,
        payload: {
          membershipId: id,
          personId: current.person_id,
          status: 'ended',
          roles: current.roles,
        },
        correlationId,
      });
      return this.load(trx, organizationId, id);
    });
  }

  /**
   * One membership, or null. Reads through the active transaction when called from another
   * module's command or handler (executorFor), so it sees that transaction's own writes.
   */
  async find(organizationId: string, id: string): Promise<StaffMembership | null> {
    const row = await executorFor(this.db)
      .selectFrom('staff_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toStaffMembership(row) : null;
  }

  async listForPerson(organizationId: string, personId: string): Promise<StaffMembership[]> {
    const rows = await executorFor(this.db)
      .selectFrom('staff_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('person_id', '=', personId)
      .orderBy('effective_from', 'desc')
      .execute();
    return rows.map(toStaffMembership);
  }

  // StaffDirectoryPort
  async staffWithRole(
    organizationId: string,
    role: StaffRole,
    facilityId?: string | null,
    trx?: Trx,
  ): Promise<string[]> {
    const now = this.clock.now();
    let query = (trx ?? executorFor(this.db))
      .selectFrom('staff_memberships')
      .select('person_id')
      .distinct()
      .where('organization_id', '=', organizationId)
      .where('status', '=', 'active')
      .where('effective_from', '<=', now)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
      .where(sql<boolean>`${role} = any(roles)`);
    if (facilityId) {
      query = query.where(
        sql<boolean>`(cardinality(facility_ids) = 0 or ${facilityId}::uuid = any(facility_ids))`,
      );
    }
    const rows = await query.execute();
    return rows.map((r) => r.person_id);
  }

  private async assertFacilities(trx: Trx, organizationId: string, facilityIds: string[]) {
    if (facilityIds.length === 0) return;
    const rows = await trx
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', 'in', facilityIds)
      .execute();
    if (rows.length !== new Set(facilityIds).size) {
      throw errors.validation('Every facilityId must belong to this organization.', {
        facilityIds,
      });
    }
  }

  private async load(trx: Trx, organizationId: string, id: string): Promise<StaffMembership> {
    const row = await trx
      .selectFrom('staff_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toStaffMembership(row);
  }
}
