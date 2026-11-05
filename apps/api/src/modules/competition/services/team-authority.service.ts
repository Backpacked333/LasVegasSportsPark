import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@sportspark/db';
import {
  CLOCK,
  DATABASE,
  currentTransaction,
  type Clock,
  type TeamAuthorityPort,
  type TeamRole,
} from '../../../kernel';
import { ruleSetContentOf } from '../competition.shared';

/**
 * TEAM_AUTHORITY_IMPL (kernel authorization step "team role"). A person holds a role on a season
 * entry exactly when a team_roles row is effective at the clock. Roles are hierarchical downward:
 * a captain satisfies co_captain and member checks; a co-captain satisfies member checks and
 * satisfies captain checks only when the season's rule set says so
 * (`roster.coCaptainMayActAsCaptain`, proposed default false; DEC-002). Reads go through the
 * caller's transaction so a role assigned earlier in the same command counts.
 */
@Injectable()
export class TeamAuthority implements TeamAuthorityPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async hasTeamRole(
    organizationId: string,
    personId: string,
    teamEntryId: string,
    role: TeamRole,
  ): Promise<boolean> {
    const db = currentTransaction() ?? this.db;
    const now = this.clock.now();
    const rows = await db
      .selectFrom('team_roles')
      .select('role')
      .where('organization_id', '=', organizationId)
      .where('team_entry_id', '=', teamEntryId)
      .where('person_id', '=', personId)
      .where('effective_from', '<=', now)
      .where((eb) => eb.or([eb('effective_to', 'is', null), eb('effective_to', '>', now)]))
      .execute();
    const held = new Set(rows.map((r) => r.role));
    if (held.size === 0) return false;
    if (role === 'member') return true;
    if (held.has('captain')) return true;
    if (role === 'co_captain') return held.has('co_captain');
    if (!held.has('co_captain')) return false;
    const rule = await db
      .selectFrom('team_entries')
      .innerJoin('seasons', (join) =>
        join
          .onRef('seasons.organization_id', '=', 'team_entries.organization_id')
          .onRef('seasons.id', '=', 'team_entries.season_id'),
      )
      .innerJoin('rule_sets', (join) =>
        join
          .onRef('rule_sets.organization_id', '=', 'seasons.organization_id')
          .onRef('rule_sets.id', '=', 'seasons.rule_set_id'),
      )
      .select('rule_sets.content')
      .where('team_entries.organization_id', '=', organizationId)
      .where('team_entries.id', '=', teamEntryId)
      .executeTakeFirst();
    if (!rule) return false;
    return ruleSetContentOf(rule).roster.coCaptainMayActAsCaptain === true;
  }
}
