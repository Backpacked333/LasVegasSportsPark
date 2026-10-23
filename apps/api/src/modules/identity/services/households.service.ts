import { Inject, Injectable } from '@nestjs/common';
import { errors, newId, type Household, type Principal } from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  DATABASE,
  UnitOfWork,
  snapshotActor,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { toHousehold } from '../identity.shared';

/**
 * Households (SPK-IAM-001, §4.5). A household is a convenience grouping: membership is never
 * consulted by any authority check and `Person.householdId` does not exist in this model.
 */
@Injectable()
export class HouseholdsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  async createHousehold(
    principal: Principal,
    input: { name: string },
    correlationId: string | null,
  ): Promise<Household> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const selfService = principal.kind === 'customer';
    if (selfService && !principal.personId) {
      throw errors.accessDenied('Link your account to a person before creating a household.');
    }
    await this.authorization.require(principal, IdentityActions.createHousehold, {
      type: 'household',
      organizationId,
      subjectPersonIds: selfService && principal.personId ? [principal.personId] : undefined,
    });
    return runInTransaction(this.uow, async ({ trx }) => {
      const id = newId();
      await trx
        .insertInto('households')
        .values({
          id,
          organization_id: organizationId,
          name: input.name,
          created_by: json(snapshotActor(principal)),
        })
        .execute();
      if (selfService && principal.personId) {
        await trx
          .insertInto('household_memberships')
          .values({
            id: newId(),
            organization_id: organizationId,
            household_id: id,
            person_id: principal.personId,
            label: null,
            added_by: json(snapshotActor(principal)),
          })
          .execute();
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.createHousehold.id,
        targetType: 'household',
        targetId: id,
        afterRevision: 1,
        correlationId,
      });
      return this.detail(trx, organizationId, id);
    });
  }

  async addMember(
    principal: Principal,
    householdId: string,
    input: { personId: string; label?: string },
    correlationId: string | null,
  ): Promise<Household> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const household = await trx
        .selectFrom('households')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', householdId)
        .executeTakeFirst();
      if (!household) throw errors.protectedNotFound('household');
      if (principal.kind === 'customer') {
        const member = principal.personId
          ? await trx
              .selectFrom('household_memberships')
              .select('id')
              .where('organization_id', '=', organizationId)
              .where('household_id', '=', householdId)
              .where('person_id', '=', principal.personId)
              .executeTakeFirst()
          : undefined;
        if (!member) throw errors.protectedNotFound('household');
      }
      await this.authorization.require(principal, IdentityActions.addHouseholdMember, {
        type: 'household',
        id: householdId,
        organizationId,
        subjectPersonIds: [input.personId],
        protected: true,
      });
      const person = await trx
        .selectFrom('persons')
        .select('status')
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.personId)
        .executeTakeFirst();
      if (!person || person.status !== 'active') throw errors.protectedNotFound('person');
      const inserted = await trx
        .insertInto('household_memberships')
        .values({
          id: newId(),
          organization_id: organizationId,
          household_id: householdId,
          person_id: input.personId,
          label: input.label ?? null,
          added_by: json(snapshotActor(principal)),
        })
        .onConflict((oc) =>
          oc.columns(['organization_id', 'household_id', 'person_id']).doNothing(),
        )
        .returning('id')
        .executeTakeFirst();
      if (inserted) {
        await this.audit.record(trx, {
          organizationId,
          actor: principal,
          action: IdentityActions.addHouseholdMember.id,
          targetType: 'household',
          targetId: householdId,
          correlationId,
          details: { personId: input.personId },
        });
      }
      return this.detail(trx, organizationId, householdId);
    });
  }

  async detail(db: Db | Trx, organizationId: string, id: string): Promise<Household> {
    const row = await db
      .selectFrom('households')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('household');
    const members = await db
      .selectFrom('household_memberships')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('household_id', '=', id)
      .orderBy('created_at')
      .execute();
    return toHousehold(row, members);
  }
}
