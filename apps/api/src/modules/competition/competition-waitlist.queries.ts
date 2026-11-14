import type { TeamEntryPlaceOffer, TeamEntryWaiting } from '@sportspark/contracts';
import type { TeamEntriesTable, TeamEntryPlaceOffersTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { Reader } from './competition.queries';

/**
 * Reads of the team waiting list (SPK-COMP-006, proposed amendment PA-10, migration 0467). The
 * capacity of a division is consumed by its applied and approved entries and by open place
 * offers; a waiting entry never consumes it.
 */

export type PlaceOfferRow = Selectable<TeamEntryPlaceOffersTable>;

const iso = (value: Date | string): string => new Date(value).toISOString();

export function toPlaceOffer(row: PlaceOfferRow, divisionName: string): TeamEntryPlaceOffer {
  return {
    id: row.id,
    teamEntryId: row.team_entry_id,
    seasonId: row.season_id,
    divisionId: row.division_id,
    divisionName,
    status: row.status,
    positionAtOffer: row.position_at_offer,
    offeredAt: iso(row.offered_at),
    expiresAt: iso(row.expires_at),
    note: row.note,
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
    resolutionReason: row.resolution_reason,
    revision: row.revision,
  };
}

export interface DivisionPlaces {
  divisionId: string;
  name: string;
  facilityId: string | null;
  /** Null: the division has no limit. */
  capacity: number | null;
  /** Applied and approved entries placed in the division. */
  placed: number;
  /** Places held by open offers. */
  openOffers: number;
}

/** No place can be given or offered: the placed entries and the open offers fill the capacity. */
export function isFull(places: DivisionPlaces): boolean {
  return places.capacity !== null && places.placed + places.openOffers >= places.capacity;
}

export function freePlaces(places: DivisionPlaces): number | null {
  return places.capacity === null
    ? null
    : Math.max(0, places.capacity - places.placed - places.openOffers);
}

/** Places held in a division by open offers, optionally leaving out the offer made to one entry. */
export async function openOfferCount(
  db: Reader,
  organizationId: string,
  divisionId: string,
  exceptEntryId?: string,
): Promise<number> {
  let query = db
    .selectFrom('team_entry_place_offers')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('organization_id', '=', organizationId)
    .where('division_id', '=', divisionId)
    .where('status', '=', 'offered');
  if (exceptEntryId) query = query.where('team_entry_id', '<>', exceptEntryId);
  return Number((await query.executeTakeFirstOrThrow()).n);
}

/**
 * How a division's capacity is used. With `forUpdate` the division row is locked first (the lock
 * every placement and offer takes), so the counts hold until the transaction ends.
 */
export async function divisionPlaces(
  db: Reader,
  organizationId: string,
  seasonId: string,
  divisionId: string,
  options: { forUpdate?: boolean } = {},
): Promise<DivisionPlaces | null> {
  let query = db
    .selectFrom('divisions')
    .select(['id', 'name', 'facility_id', 'capacity_team_entries'])
    .where('organization_id', '=', organizationId)
    .where('season_id', '=', seasonId)
    .where('id', '=', divisionId);
  if (options.forUpdate) query = query.forUpdate();
  const division = await query.executeTakeFirst();
  if (!division) return null;
  const placed = await db
    .selectFrom('team_entries')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('organization_id', '=', organizationId)
    .where('division_id', '=', divisionId)
    .where('status', 'in', ['applied', 'approved'])
    .executeTakeFirstOrThrow();
  return {
    divisionId: division.id,
    name: division.name,
    facilityId: division.facility_id,
    capacity: division.capacity_team_entries,
    placed: Number(placed.n),
    openOffers: await openOfferCount(db, organizationId, divisionId),
  };
}

/** Every division of a season with its places, by name. */
export async function seasonDivisionPlaces(
  db: Reader,
  organizationId: string,
  seasonId: string,
  options: { forUpdate?: boolean } = {},
): Promise<DivisionPlaces[]> {
  const ids = await db
    .selectFrom('divisions')
    .select('id')
    .where('organization_id', '=', organizationId)
    .where('season_id', '=', seasonId)
    .orderBy('name')
    .orderBy('id')
    .execute();
  const out: DivisionPlaces[] = [];
  for (const { id } of ids) {
    const places = await divisionPlaces(db, organizationId, seasonId, id, options);
    if (places) out.push(places);
  }
  return out;
}

export interface WaitingRow {
  id: string;
  team_id: string;
  team_name: string;
  waiting_since: Date;
  waiting_division_id: string | null;
  revision: number;
}

/**
 * The waiting entries of a season in list order: by the instant the wait began, then by id. The
 * order of one list is the order of the rows that share its `waiting_division_id`.
 */
export async function waitingRows(
  db: Reader,
  organizationId: string,
  seasonId: string,
): Promise<WaitingRow[]> {
  const rows = await db
    .selectFrom('team_entries')
    .innerJoin('teams', (join) =>
      join
        .onRef('teams.organization_id', '=', 'team_entries.organization_id')
        .onRef('teams.id', '=', 'team_entries.team_id'),
    )
    .select([
      'team_entries.id',
      'team_entries.team_id',
      'teams.name as team_name',
      'team_entries.waiting_since',
      'team_entries.waiting_division_id',
      'team_entries.revision',
    ])
    .where('team_entries.organization_id', '=', organizationId)
    .where('team_entries.season_id', '=', seasonId)
    .where('team_entries.status', '=', 'waiting')
    .orderBy('team_entries.waiting_since')
    .orderBy('team_entries.id')
    .execute();
  return rows.map((row) => ({ ...row, waiting_since: new Date(row.waiting_since as Date) }));
}

/** The entry's place on its own list (1 waited longest) and the length of that list. */
export async function waitingPosition(
  db: Reader,
  entry: Pick<
    Selectable<TeamEntriesTable>,
    'id' | 'organization_id' | 'season_id' | 'waiting_division_id'
  >,
): Promise<{ position: number; listLength: number }> {
  const list = (await waitingRows(db, entry.organization_id, entry.season_id)).filter(
    (row) => row.waiting_division_id === entry.waiting_division_id,
  );
  const index = list.findIndex((row) => row.id === entry.id);
  return { position: index < 0 ? list.length + 1 : index + 1, listLength: list.length };
}

/** The open offer made to an entry, if any (at most one, by the partial unique index). */
export async function openOfferOf(
  db: Reader,
  organizationId: string,
  teamEntryId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PlaceOfferRow | null> {
  let query = db
    .selectFrom('team_entry_place_offers')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('team_entry_id', '=', teamEntryId)
    .where('status', '=', 'offered');
  if (options.forUpdate) query = query.forUpdate();
  return (await query.executeTakeFirst()) ?? null;
}

export async function divisionNames(
  db: Reader,
  organizationId: string,
  divisionIds: readonly string[],
): Promise<Map<string, string>> {
  if (divisionIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('divisions')
    .select(['id', 'name'])
    .where('organization_id', '=', organizationId)
    .where('id', 'in', [...new Set(divisionIds)])
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** What a waiting entry's workspace shows (SPK-COMP-006); null unless the entry is waiting. */
export async function waitingViewOf(
  db: Reader,
  entry: Selectable<TeamEntriesTable>,
): Promise<TeamEntryWaiting | null> {
  if (entry.status !== 'waiting' || !entry.waiting_since) return null;
  const offer = await openOfferOf(db, entry.organization_id, entry.id);
  const names = await divisionNames(
    db,
    entry.organization_id,
    [entry.waiting_division_id, offer?.division_id].filter((id): id is string => !!id),
  );
  const { position, listLength } = await waitingPosition(db, entry);
  return {
    since: iso(entry.waiting_since),
    division: entry.waiting_division_id
      ? {
          id: entry.waiting_division_id,
          name: names.get(entry.waiting_division_id) ?? 'Unknown division',
        }
      : null,
    position,
    listLength,
    openOffer: offer
      ? toPlaceOffer(offer, names.get(offer.division_id) ?? 'Unknown division')
      : null,
  };
}
