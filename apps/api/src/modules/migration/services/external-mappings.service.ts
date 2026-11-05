import { Inject, Injectable } from '@nestjs/common';
import {
  type ExternalMapping,
  type ListExternalMappingsQuery,
  type Page,
  type Principal,
} from '@sportspark/contracts';
import type { Db, MappedEntityType } from '@sportspark/db';
import { AuthorizationService, currentTransaction, DATABASE, type Trx } from '../../../kernel';
import { MigrationActions } from '../migration.actions';
import type { ExternalMappingPort } from '../migration.ports';
import {
  afterKeyset,
  createdAtText,
  keysetPage,
  organizationOf,
  readKeysetCursor,
  toExternalMapping,
  type Reader,
} from '../migration.shared';
import { isMappedEntityType } from '../staging/categories';

/**
 * Stable identity of migrated records (§5.3 "preserve external identifiers and extraction
 * provenance"; SPK-AT-024 "stable identities"). The key is (source system, entity type, external
 * id); a name or an email never identifies a record (§5.3).
 */
@Injectable()
export class ExternalMappingsService implements ExternalMappingPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(
    principal: Principal,
    query: ListExternalMappingsQuery,
  ): Promise<Page<ExternalMapping>> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MigrationActions.readMappings, {
      type: 'external_mapping',
      organizationId,
      protected: true,
    });
    // MIG-01: keyset paging, newest first (created_at desc, id desc).
    const cursor = readKeysetCursor(query.cursor);
    let q = this.db
      .selectFrom('external_mappings')
      .selectAll()
      .select(createdAtText('created_at').as('created_at_text'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (query.sourceSystem) q = q.where('source_system', '=', query.sourceSystem);
    if (query.entityType) {
      if (!isMappedEntityType(query.entityType)) return { items: [], nextCursor: null };
      q = q.where('entity_type', '=', query.entityType);
    }
    if (query.externalId) q = q.where('external_id', '=', query.externalId);
    if (query.internalId) q = q.where('internal_id', '=', query.internalId);
    if (cursor) q = q.where(afterKeyset('created_at', 'id', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return { items: page.rows.map(toExternalMapping), nextCursor: page.nextCursor };
  }

  async findInternalId(
    organizationId: string,
    sourceSystem: string,
    entityType: MappedEntityType,
    externalId: string,
    trx?: Trx,
  ): Promise<string | null> {
    const db: Reader = trx ?? currentTransaction() ?? this.db;
    const row = await db
      .selectFrom('external_mappings')
      .select(['internal_id', 'status'])
      .where('organization_id', '=', organizationId)
      .where('source_system', '=', sourceSystem)
      .where('entity_type', '=', entityType)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
    return row?.status === 'linked' ? row.internal_id : null;
  }

  async mappingsFor(
    organizationId: string,
    entityType: MappedEntityType,
    internalId: string,
    trx?: Trx,
  ): Promise<ExternalMapping[]> {
    const db: Reader = trx ?? currentTransaction() ?? this.db;
    const rows = await db
      .selectFrom('external_mappings')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('entity_type', '=', entityType)
      .where('internal_id', '=', internalId)
      .orderBy('created_at')
      .execute();
    return rows.map(toExternalMapping);
  }
}
