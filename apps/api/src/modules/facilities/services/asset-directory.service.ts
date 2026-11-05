import { Inject, Injectable } from '@nestjs/common';
import { errors, isUuid } from '@sportspark/contracts';
import { tstzrange, type Database, type Db } from '@sportspark/db';
import { sql, type ExpressionBuilder } from 'kysely';
import { executorFor, type Clock, type Trx } from '../../../kernel';
import { CLOCK, DATABASE } from '../../../kernel/tokens';
import type { AssetDirectoryEntry, AssetDirectoryOptions, AssetDirectoryPort } from '../ports';

/**
 * Asset directory for booking equipment (FAC-02, IF-33; SPK-COND-003 "equipment reserved with the
 * booking", §4.2). Other modules read assets through this port, never the facilities tables. It
 * reads through the passed transaction, else the active one (so a booking command sees its own
 * uncommitted writes and never opens a second connection), else the root database.
 *
 * Without `intervals`, an asset is `usable` when its status is `in_service` and no active
 * restriction names it at the instant (the injected clock): conservative, because an approved
 * restriction marks its asset `restricted` from activation, however far ahead its interval is.
 * With `intervals` (R4-OPS-MODULES-05, SPK-FAC-003: a restriction affects availability for its
 * approved interval), `usable` answers for those times: the asset is in service, or `restricted`
 * only because approved or active restrictions name it, and none of them overlaps any interval. A
 * booking outside a future restriction's window is therefore accepted, and a booking inside it is
 * refused even while the asset still reads `in_service`. Retired and out-of-service assets, and an
 * asset set `restricted` with no restriction behind it, are never usable. Ids of another
 * organization, unknown ids and malformed ids are omitted: the caller refuses a booking that names
 * an omitted or unusable asset. Equipment commitments in scheduling keep using the asset id as the
 * party id.
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
    options: AssetDirectoryOptions = {},
  ): Promise<Map<string, AssetDirectoryEntry>> {
    const entries = new Map<string, AssetDirectoryEntry>();
    const intervals = (options.intervals ?? []).map((i) => ({
      start: new Date(i.start),
      end: new Date(i.end),
    }));
    for (const interval of intervals) {
      if (!(interval.start.getTime() < interval.end.getTime())) {
        throw errors.validation('An equipment interval ends after it starts.', {
          path: 'intervals',
          start: interval.start.toISOString(),
          end: interval.end.toISOString(),
        });
      }
    }
    const ids = [...new Set(assetIds)].filter((id) => isUuid(id));
    if (ids.length === 0 || !isUuid(organizationId)) return entries;
    const db = trx ?? executorFor(this.db);
    const now = this.clock.now();
    const restrictionsOfAsset = (eb: ExpressionBuilder<Database, 'assets'>) =>
      eb
        .selectFrom('restrictions')
        .select(sql`1`.as('one'))
        .where('restrictions.organization_id', '=', organizationId)
        .whereRef('restrictions.asset_id', '=', 'assets.id');
    const rows = await db
      .selectFrom('assets')
      .select(['id', 'facility_id', 'kind', 'name', 'status'])
      .select((eb) =>
        eb
          .exists(
            restrictionsOfAsset(eb)
              .where('restrictions.status', '=', 'active')
              .where(sql<boolean>`restrictions.during @> ${now.toISOString()}::timestamptz`),
          )
          .as('restricted_now'),
      )
      .select((eb) =>
        eb
          .exists(
            restrictionsOfAsset(eb).where('restrictions.status', 'in', ['approved', 'active']),
          )
          .as('restricted_by_restrictions'),
      )
      .select((eb) =>
        intervals.length === 0
          ? sql<boolean>`false`.as('restricted_during')
          : eb
              .exists(
                restrictionsOfAsset(eb)
                  .where('restrictions.status', 'in', ['approved', 'active'])
                  .where(
                    sql<boolean>`(${sql.join(
                      intervals.map(
                        (i) => sql`restrictions.during && ${tstzrange(i.start, i.end)}`,
                      ),
                      sql` or `,
                    )})`,
                  ),
              )
              .as('restricted_during'),
      )
      .where('organization_id', '=', organizationId)
      .where('id', 'in', ids)
      .execute();
    for (const row of rows) {
      const usable =
        intervals.length === 0
          ? row.status === 'in_service' && !row.restricted_now
          : (row.status === 'in_service' ||
              (row.status === 'restricted' && Boolean(row.restricted_by_restrictions))) &&
            !row.restricted_during;
      entries.set(row.id, {
        id: row.id,
        facilityId: row.facility_id,
        kind: row.kind,
        name: row.name,
        status: row.status,
        usable,
      });
    }
    return entries;
  }
}
