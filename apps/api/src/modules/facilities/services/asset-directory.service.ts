import { Inject, Injectable } from '@nestjs/common';
import { isUuid } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import { executorFor, type Clock, type Trx } from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import type { AssetDirectoryEntry, AssetDirectoryPort } from '../ports';

/**
 * Asset directory for booking equipment (FAC-02, IF-33; SPK-COND-003 "equipment reserved with the
 * booking", §4.2). Other modules read assets through this port, never the facilities tables. It
 * reads through the passed transaction, else the active one (so a booking command sees its own
 * uncommitted writes and never opens a second connection), else the root database.
 *
 * An asset is `usable` when its status is `in_service` and no active restriction names it at the
 * instant (the injected clock). Ids of another organization, unknown ids and malformed ids are
 * omitted: the caller refuses a booking that names an omitted or unusable asset. Equipment
 * commitments in scheduling keep using the asset id as the party id.
 */
@Injectable()
export class AssetDirectoryService implements AssetDirectoryPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async describe(
    organizationId: string,
    assetIds: readonly string[],
    trx?: Trx,
  ): Promise<Map<string, AssetDirectoryEntry>> {
    const entries = new Map<string, AssetDirectoryEntry>();
    const ids = [...new Set(assetIds)].filter((id) => isUuid(id));
    if (ids.length === 0 || !isUuid(organizationId)) return entries;
    const db = trx ?? executorFor(this.db);
    const now = this.clock.now();
    const rows = await db
      .selectFrom('assets')
      .select(['id', 'facility_id', 'kind', 'name', 'status'])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('restrictions')
              .select(sql`1`.as('one'))
              .where('restrictions.organization_id', '=', organizationId)
              .whereRef('restrictions.asset_id', '=', 'assets.id')
              .where('restrictions.status', '=', 'active')
              .where(sql<boolean>`restrictions.during @> ${now}::timestamptz`),
          )
          .as('restricted_now'),
      )
      .where('organization_id', '=', organizationId)
      .where('id', 'in', ids)
      .execute();
    for (const row of rows) {
      entries.set(row.id, {
        id: row.id,
        facilityId: row.facility_id,
        kind: row.kind,
        name: row.name,
        status: row.status,
        usable: row.status === 'in_service' && !row.restricted_now,
      });
    }
    return entries;
  }
}
