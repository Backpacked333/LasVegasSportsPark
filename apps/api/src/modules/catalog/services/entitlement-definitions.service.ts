import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type CreateEntitlementDefinitionInput,
  type EntitlementDefinition,
  type Principal,
  type UpdateEntitlementDefinitionInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  DATABASE,
  snapshotActor,
  UnitOfWork,
} from '../../../kernel';
import { CatalogActions } from '../catalog.actions';
import { organizationOf, toEntitlementDefinition } from '../catalog.shared';

/**
 * What participation a purchase grants (§4.4 EntitlementDefinition). The equivalence scope is
 * the rule enrollment uses to compute the key that forbids duplicate equivalent entitlements
 * (§4.7 invariant 2, `entitlements/equivalence-key.ts`).
 */
@Injectable()
export class EntitlementDefinitionsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  async create(
    principal: Principal,
    body: CreateEntitlementDefinitionInput,
    correlationId: string | null,
  ): Promise<EntitlementDefinition> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.manageEntitlementDefinitions, {
      type: 'entitlement_definition',
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('entitlement_definitions')
          .values({
            id,
            organization_id: organizationId,
            name: body.name,
            description: body.description ?? null,
            kind: body.kind,
            scope: json(body.scope),
            equivalence_scope: body.equivalenceScope,
            equivalence_rule: json(body.equivalenceRule),
            created_by: json(snapshotActor(principal)),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.validation('An entitlement definition with this name already exists.', {
            path: 'name',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.entitlement_definition_created',
        targetType: 'entitlement_definition',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId,
      });
      return toEntitlementDefinition(row);
    });
  }

  async update(
    principal: Principal,
    id: string,
    body: UpdateEntitlementDefinitionInput,
    correlationId: string | null,
  ): Promise<EntitlementDefinition> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.manageEntitlementDefinitions, {
      type: 'entitlement_definition',
      id,
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('entitlement_definitions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('entitlement definition', id);
      assertExpectedRevision(body.expectedRevision, current.revision);
      if (current.status === 'archived' && body.status !== 'active') {
        throw errors.invalidTransition('EntitlementDefinition', 'archived', 'update');
      }
      let updated;
      try {
        updated = await trx
          .updateTable('entitlement_definitions')
          .set({
            name: body.name,
            description: body.description,
            scope: body.scope === undefined ? undefined : json(body.scope),
            equivalence_scope: body.equivalenceScope,
            equivalence_rule:
              body.equivalenceRule === undefined ? undefined : json(body.equivalenceRule),
            status: body.status,
            revision: current.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .where('revision', '=', current.revision)
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.validation('An entitlement definition with this name already exists.', {
            path: 'name',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'catalog.entitlement_definition_updated',
        targetType: 'entitlement_definition',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId,
      });
      return toEntitlementDefinition(updated);
    });
  }

  async get(principal: Principal, id: string): Promise<EntitlementDefinition> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'entitlement_definition',
      id,
      organizationId,
    });
    const row = await this.db
      .selectFrom('entitlement_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('entitlement definition', id);
    return toEntitlementDefinition(row);
  }

  async list(principal: Principal): Promise<EntitlementDefinition[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CatalogActions.readCatalog, {
      type: 'entitlement_definition',
      organizationId,
    });
    const rows = await this.db
      .selectFrom('entitlement_definitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toEntitlementDefinition);
  }
}
