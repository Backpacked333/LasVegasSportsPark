import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Asset,
  type CreateAssetBody,
  type ListAssetsQuery,
  type Principal,
  type Resource,
  type UpdateAssetBody,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  UnitOfWork,
} from '../../../kernel';
import { DATABASE } from '../../../kernel/tokens';
import { ResourcesService } from '../../scheduling';
import { FacilitiesActions } from '../facilities.actions';
import { AssetMachine, assetEventFor } from '../facilities.state-machines';
import { FacilitiesReader, organizationOf } from './facilities-reader';

/**
 * Maintainable assets (SPK-FAC-001): turf areas, goals, nets, boards, dividers, lighting,
 * scoreboards and equipment, optionally attached to the scheduling resource (space) they belong
 * to. Retiring keeps the record for maintenance history.
 */
@Injectable()
export class AssetsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly reader: FacilitiesReader,
    private readonly resources: ResourcesService,
  ) {}

  async create(
    principal: Principal,
    body: CreateAssetBody,
    correlationId?: string,
  ): Promise<Asset> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(this.db, organizationId, body.facilityId);
    // Cross-module reads go through the scheduling public API and happen before the transaction.
    const resource = body.resourceId
      ? await this.resourceInFacility(principal, body.resourceId, body.facilityId)
      : null;
    return this.uow.run(async ({ trx }) => {
      const facility = await this.reader.loadFacility(trx, organizationId, body.facilityId);
      await this.authorization.require(principal, FacilitiesActions.manageAsset, {
        type: 'asset',
        organizationId,
        facilityId: facility.id,
      });
      const id = newId();
      let row;
      try {
        row = await trx
          .insertInto('assets')
          .values({
            id,
            organization_id: organizationId,
            facility_id: facility.id,
            resource_id: resource?.id ?? null,
            kind: body.kind,
            name: body.name,
            identifier: body.identifier ?? null,
            attributes: json(body.attributes ?? {}),
            status: body.status ?? 'in_service',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.validation('An asset with this identifier already exists in the facility.', {
            path: 'identifier',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.asset_created',
        targetType: 'asset',
        targetId: id,
        afterRevision: row.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: { kind: body.kind, resourceId: resource?.id ?? null },
      });
      return this.reader.assetView(row);
    });
  }

  async update(
    principal: Principal,
    assetId: string,
    body: UpdateAssetBody,
    correlationId?: string,
  ): Promise<Asset> {
    const organizationId = organizationOf(principal);
    const existing = await this.reader.loadAsset(this.db, organizationId, assetId);
    if (!existing) throw errors.notFound('asset', assetId);
    const resource = body.resourceId
      ? await this.resourceInFacility(principal, body.resourceId, existing.facility_id)
      : null;
    return this.uow.run(async ({ trx }) => {
      const current = await this.reader.loadAsset(trx, organizationId, assetId, true);
      if (!current) throw errors.notFound('asset', assetId);
      await this.authorization.require(principal, FacilitiesActions.manageAsset, {
        type: 'asset',
        id: assetId,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(body.expectedRevision, current.revision);
      let status = current.status;
      if (body.status !== undefined && body.status !== current.status) {
        status = AssetMachine.next(current.status, assetEventFor(body.status));
      } else if (current.status === 'retired' && body.status === undefined) {
        throw errors.invalidTransition('Asset', 'retired', 'update');
      }
      let updated;
      try {
        updated = await trx
          .updateTable('assets')
          .set({
            resource_id: body.resourceId === undefined ? undefined : (resource?.id ?? null),
            kind: body.kind,
            name: body.name,
            identifier: body.identifier,
            attributes: body.attributes === undefined ? undefined : json(body.attributes),
            status,
            revision: current.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', assetId)
          .where('revision', '=', current.revision)
          .returningAll()
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.validation('An asset with this identifier already exists in the facility.', {
            path: 'identifier',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.asset_updated',
        targetType: 'asset',
        targetId: assetId,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: body.reason ?? null,
        correlationId: correlationId ?? null,
        details: status !== current.status ? { status } : {},
      });
      return this.reader.assetView(updated);
    });
  }

  /** Retiring is idempotent and keeps the record; an asset with open maintenance tasks cannot retire. */
  async retire(
    principal: Principal,
    assetId: string,
    options: { expectedRevision?: number; reason?: string; correlationId?: string } = {},
  ): Promise<Asset> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await this.reader.loadAsset(trx, organizationId, assetId, true);
      if (!current) throw errors.notFound('asset', assetId);
      await this.authorization.require(principal, FacilitiesActions.manageAsset, {
        type: 'asset',
        id: assetId,
        organizationId,
        facilityId: current.facility_id,
      });
      assertExpectedRevision(options.expectedRevision, current.revision);
      if (current.status === 'retired') return this.reader.assetView(current);
      const next = AssetMachine.next(current.status, 'retire');
      if (await this.reader.hasOpenTasks(trx, organizationId, assetId)) {
        throw errors.invalidTransition('Asset', current.status, 'retire');
      }
      const updated = await trx
        .updateTable('assets')
        .set({ status: next, revision: current.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', assetId)
        .where('revision', '=', current.revision)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'facilities.asset_retired',
        targetType: 'asset',
        targetId: assetId,
        beforeRevision: current.revision,
        afterRevision: updated.revision,
        reason: options.reason ?? null,
        correlationId: options.correlationId ?? null,
      });
      return this.reader.assetView(updated);
    });
  }

  async get(principal: Principal, assetId: string): Promise<Asset> {
    const organizationId = organizationOf(principal);
    const row = await this.reader.loadAsset(this.db, organizationId, assetId);
    if (!row) throw errors.notFound('asset', assetId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'asset',
      id: assetId,
      organizationId,
      facilityId: row.facility_id,
    });
    return this.reader.assetView(row);
  }

  async list(principal: Principal, query: ListAssetsQuery): Promise<Asset[]> {
    const organizationId = organizationOf(principal);
    await this.reader.loadFacility(this.db, organizationId, query.facilityId);
    await this.authorization.require(principal, FacilitiesActions.viewMaintenance, {
      type: 'asset',
      organizationId,
      facilityId: query.facilityId,
    });
    let q = this.db
      .selectFrom('assets')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('facility_id', '=', query.facilityId)
      .orderBy('name')
      .orderBy('id');
    if (query.resourceId) q = q.where('resource_id', '=', query.resourceId);
    if (query.kind) q = q.where('kind', '=', query.kind);
    if (query.status) q = q.where('status', '=', query.status);
    else if (!query.includeRetired) q = q.where('status', '<>', 'retired');
    return (await q.execute()).map((r) => this.reader.assetView(r));
  }

  private async resourceInFacility(
    principal: Principal,
    resourceId: string,
    facilityId: string,
  ): Promise<Resource> {
    const resource = await this.resources.getResource(principal, resourceId);
    if (resource.facilityId !== facilityId) {
      throw errors.validation('The resource belongs to another facility.', { resourceId });
    }
    return resource;
  }
}
