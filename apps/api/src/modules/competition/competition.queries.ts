import type { RuleSetContent, TeamRoleValue } from '@sportspark/contracts';
import type {
  Db,
  DivisionsTable,
  RosterMembershipsTable,
  RosterPlayingStatus,
  RuleSetsTable,
  TeamEntriesTable,
  TeamRolesTable,
  TeamsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import type { Trx } from '../../kernel';
import {
  ROSTER_LIMIT_STATUSES,
  isEffectiveAt,
  ruleSetContentOf,
  seasonColumns,
  type SeasonRow,
} from './competition.shared';

/** Read-side helpers shared by the services. Every query is organization-scoped. */
export type Reader = Db | Trx;

export async function loadSeasonRow(
  db: Reader,
  organizationId: string,
  seasonId: string,
): Promise<SeasonRow | null> {
  const row = await db
    .selectFrom('seasons')
    .select(seasonColumns)
    .where('seasons.organization_id', '=', organizationId)
    .where('seasons.id', '=', seasonId)
    .executeTakeFirst();
  return (row as SeasonRow | undefined) ?? null;
}

export async function loadRuleSetRow(
  db: Reader,
  organizationId: string,
  ruleSetId: string,
): Promise<Selectable<RuleSetsTable> | null> {
  const row = await db
    .selectFrom('rule_sets')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('id', '=', ruleSetId)
    .executeTakeFirst();
  return row ?? null;
}

export interface EntryContext {
  entry: Selectable<TeamEntriesTable>;
  team: Selectable<TeamsTable>;
  season: SeasonRow;
  ruleSet: Selectable<RuleSetsTable>;
  rules: RuleSetContent;
  division: Selectable<DivisionsTable> | null;
}

/** A team entry with its team, season, rule set and division; null when absent in the organization. */
export async function loadEntryContext(
  db: Reader,
  organizationId: string,
  teamEntryId: string,
  options: { forUpdate?: boolean } = {},
): Promise<EntryContext | null> {
  let query = db
    .selectFrom('team_entries')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('id', '=', teamEntryId);
  if (options.forUpdate) query = query.forUpdate();
  const entry = await query.executeTakeFirst();
  if (!entry) return null;
  const [team, season] = await Promise.all([
    db
      .selectFrom('teams')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', entry.team_id)
      .executeTakeFirstOrThrow(),
    loadSeasonRow(db, organizationId, entry.season_id),
  ]);
  if (!season) return null;
  const ruleSet = await loadRuleSetRow(db, organizationId, season.rule_set_id);
  if (!ruleSet) return null;
  const division = entry.division_id
    ? ((await db
        .selectFrom('divisions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', entry.division_id)
        .executeTakeFirst()) ?? null)
    : null;
  return { entry, team, season, ruleSet, rules: ruleSetContentOf(ruleSet), division };
}

export type RosterRow = Selectable<RosterMembershipsTable>;

/** The status a row conferred while it was effective (a removed row keeps its prior status). */
export function statusAt(row: RosterRow): RosterPlayingStatus | null {
  if (row.status === 'removed') return row.status_before_removal;
  if (row.status === 'active' || row.status === 'guest' || row.status === 'substitute') {
    return row.status;
  }
  return null;
}

/**
 * Roster rows that were effective at the instant (SPK-COMP-005): playing rows, and removed rows
 * whose window still covers the instant. Pending rows never count.
 */
export async function rosterRowsEffectiveAt(
  db: Reader,
  organizationId: string,
  teamEntryId: string,
  at: Date,
): Promise<RosterRow[]> {
  return db
    .selectFrom('roster_memberships')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('team_entry_id', '=', teamEntryId)
    .where('status', 'in', ['active', 'guest', 'substitute', 'removed'])
    .where('effective_from', '<=', at)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]))
    .orderBy('effective_from')
    .orderBy('id')
    .execute();
}

/**
 * Roster rows that are effective at any instant from `from` on (SPK-COMP-005, SPK-COMP-002 roster
 * limits): rows already effective then, and rows that start later (future-dated additions). An
 * addition holds its place from its effective instant onwards, so it is checked against all of them.
 */
export async function rosterRowsOverlapping(
  db: Reader,
  organizationId: string,
  teamEntryId: string,
  from: Date,
): Promise<RosterRow[]> {
  return db
    .selectFrom('roster_memberships')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('team_entry_id', '=', teamEntryId)
    .where('status', 'in', ['active', 'guest', 'substitute', 'removed'])
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', from)]))
    .orderBy('effective_from')
    .orderBy('id')
    .execute();
}

/** The person's open row on the entry (pending or playing), if any. */
export async function openRosterRow(
  db: Reader,
  organizationId: string,
  teamEntryId: string,
  personId: string,
): Promise<RosterRow | null> {
  const row = await db
    .selectFrom('roster_memberships')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('team_entry_id', '=', teamEntryId)
    .where('person_id', '=', personId)
    .where('effective_to', 'is', null)
    .executeTakeFirst();
  return row ?? null;
}

export interface SeasonMembership {
  teamEntryId: string;
  divisionId: string | null;
  statusAt: RosterPlayingStatus;
}

/**
 * Other live entries of the same season the person is effectively on at the instant (multi-team
 * rules). With `overlapping`, every membership effective at any instant from `at` on counts, so an
 * addition is checked against memberships that start later as well (SPK-COMP-005).
 */
export async function personSeasonMemberships(
  db: Reader,
  organizationId: string,
  personId: string | readonly string[],
  seasonId: string,
  at: Date,
  excludeEntryId: string,
  options: { overlapping?: boolean } = {},
): Promise<SeasonMembership[]> {
  let query = db
    .selectFrom('roster_memberships as rm')
    .innerJoin('team_entries as te', (join) =>
      join
        .onRef('te.organization_id', '=', 'rm.organization_id')
        .onRef('te.id', '=', 'rm.team_entry_id'),
    )
    .select(['rm.team_entry_id', 'rm.status', 'rm.status_before_removal', 'te.division_id'])
    .where('rm.organization_id', '=', organizationId)
    .where('rm.person_id', 'in', typeof personId === 'string' ? [personId] : [...personId])
    .where('te.season_id', '=', seasonId)
    .where('te.status', 'in', ['applied', 'approved'])
    .where('rm.team_entry_id', '<>', excludeEntryId)
    .where('rm.status', 'in', ['active', 'guest', 'substitute', 'removed'])
    .where((eb) => eb.or([eb('rm.effective_to', 'is', null), eb('rm.effective_to', '>', at)]));
  if (!options.overlapping) query = query.where('rm.effective_from', '<=', at);
  const rows = await query.execute();
  const out: SeasonMembership[] = [];
  for (const row of rows) {
    const status = row.status === 'removed' ? row.status_before_removal : row.status;
    // One entry counts once, however many of its rows the window covers.
    if (out.some((o) => o.teamEntryId === row.team_entry_id)) continue;
    if (status === 'active' || status === 'guest' || status === 'substitute') {
      out.push({ teamEntryId: row.team_entry_id, divisionId: row.division_id, statusAt: status });
    }
  }
  return out;
}

export async function effectiveRoles(
  db: Reader,
  organizationId: string,
  teamEntryId: string,
  at: Date,
  personId?: string,
): Promise<Selectable<TeamRolesTable>[]> {
  let query = db
    .selectFrom('team_roles')
    .selectAll()
    .where('organization_id', '=', organizationId)
    .where('team_entry_id', '=', teamEntryId)
    .where('effective_from', '<=', at)
    .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', at)]));
  if (personId) query = query.where('person_id', '=', personId);
  return query.orderBy('effective_from').execute();
}

export function rolesByPerson(rows: Selectable<TeamRolesTable>[]): Map<string, TeamRoleValue[]> {
  const map = new Map<string, TeamRoleValue[]>();
  for (const row of rows) {
    const list = map.get(row.person_id) ?? [];
    list.push(row.role);
    map.set(row.person_id, list);
  }
  return map;
}

export interface RosterCounts {
  /** Rows counting toward the rule set's roster maximum (active + substitute). */
  limited: number;
  guests: number;
  total: number;
}

export function countRoster(rows: RosterRow[]): RosterCounts {
  let limited = 0;
  let guests = 0;
  let total = 0;
  for (const row of rows) {
    const status = statusAt(row);
    if (!status) continue;
    total += 1;
    if (ROSTER_LIMIT_STATUSES.includes(status)) limited += 1;
    if (status === 'guest') guests += 1;
  }
  return { limited, guests, total };
}

/**
 * The largest roster counts at any instant from `from` on. Counts only rise when a row starts, so
 * the instants to check are `from` and every later start.
 */
export function peakRosterCounts(rows: RosterRow[], from: Date): RosterCounts {
  const instants = [
    from,
    ...rows.map((r) => new Date(r.effective_from)).filter((t) => t.getTime() > from.getTime()),
  ];
  const peak: RosterCounts = { limited: 0, guests: 0, total: 0 };
  for (const instant of instants) {
    const counts = countRoster(rows.filter((r) => isEffectiveAt(r, instant)));
    peak.limited = Math.max(peak.limited, counts.limited);
    peak.guests = Math.max(peak.guests, counts.guests);
    peak.total = Math.max(peak.total, counts.total);
  }
  return peak;
}

/** Live entries (applied or approved) consuming a division's capacity. */
export async function divisionEntryCount(
  db: Reader,
  organizationId: string,
  divisionId: string,
): Promise<number> {
  const row = await db
    .selectFrom('team_entries')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('organization_id', '=', organizationId)
    .where('division_id', '=', divisionId)
    .where('status', 'in', ['applied', 'approved'])
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/**
 * Team names of entries (CMP-01): one join for a whole page of rows; unknown or other-organization
 * entry ids are omitted.
 */
export async function teamNamesOf(
  db: Reader,
  organizationId: string,
  entryIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = [...new Set(entryIds.filter((id): id is string => typeof id === 'string'))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('team_entries')
    .innerJoin('teams', (join) =>
      join
        .onRef('teams.organization_id', '=', 'team_entries.organization_id')
        .onRef('teams.id', '=', 'team_entries.team_id'),
    )
    .select(['team_entries.id', 'teams.name'])
    .where('team_entries.organization_id', '=', organizationId)
    .where('team_entries.id', 'in', ids)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}
