import { Inject, Injectable } from '@nestjs/common';
import type { Db, FacilityStatus } from '@sportspark/db';
import { executorFor } from '../database/transaction-context';
import type { Trx } from '../database/unit-of-work';
import { DATABASE } from '../tokens';

/**
 * One facility as every module may read it (K-04, IF-03, SPK-SCHED-008): its IANA time zone is
 * the zone every facility-local time is interpreted in.
 */
export interface FacilitySummary {
  id: string;
  slug: string;
  name: string;
  /** IANA time zone (SPK-SCHED-008). */
  timezone: string;
  status: FacilityStatus;
  address: Record<string, unknown> | null;
}

/** The statuses a directory list returns unless told otherwise: archived facilities are hidden. */
export const DEFAULT_FACILITY_STATUSES: readonly FacilityStatus[] = ['active', 'closed'];

/**
 * The facility directory (K-04, IF-03; §4.2: `facilities` is a kernel table, so modules read it
 * here instead of selecting it). Reads join the active transaction (`executorFor`) unless a
 * handle is passed; an unknown id, or one of another organization, is simply omitted (§4.10).
 */
@Injectable()
export class FacilityDirectory {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async describe(
    organizationId: string,
    ids: readonly string[],
    db?: Db | Trx,
  ): Promise<Map<string, FacilitySummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await (db ?? executorFor(this.db))
      .selectFrom('facilities')
      .select(['id', 'slug', 'name', 'timezone', 'status', 'address'])
      .where('organization_id', '=', organizationId)
      .where('id', 'in', unique)
      .execute();
    return new Map(rows.map((row) => [row.id, toSummary(row)]));
  }

  async list(
    organizationId: string,
    options: { statuses?: readonly FacilityStatus[] } = {},
    db?: Db | Trx,
  ): Promise<FacilitySummary[]> {
    const statuses = options.statuses ?? DEFAULT_FACILITY_STATUSES;
    if (statuses.length === 0) return [];
    const rows = await (db ?? executorFor(this.db))
      .selectFrom('facilities')
      .select(['id', 'slug', 'name', 'timezone', 'status', 'address'])
      .where('organization_id', '=', organizationId)
      .where('status', 'in', [...statuses])
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map(toSummary);
  }
}

function toSummary(row: {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  status: FacilityStatus;
  address: Record<string, unknown> | null;
}): FacilitySummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    status: row.status,
    address: row.address ?? null,
  };
}
