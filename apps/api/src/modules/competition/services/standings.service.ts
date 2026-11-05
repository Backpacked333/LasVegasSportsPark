import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type PoolStandings,
  type Principal,
  type ResultCard,
  type Standings,
  type StandingsQuery,
  type StandingsRow,
  type TiebreakExplanation,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
  executorFor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { MatchEvents } from '../competition-matches.events';
import { FAIR_PLAY_POINTS } from '../competition-matches.policy';
import { toStandings } from '../competition-matches.shared';
import { MatchActions } from '../competition-matches.actions';
import { loadRuleSetRow, loadSeasonRow, type Reader } from '../competition.queries';
import { iso, organizationOf, ruleSetContentOf } from '../competition.shared';
import {
  computeStandings,
  type OfficialResultInput,
  type StandingsComputation,
} from '../matches/standings.calculator';
import { readTarget } from './competitions.service';

/** A final-or-not table the bracket seeding reads (CMP-10, CMP-15). */
export interface SeedingTable {
  seasonId: string;
  rows: StandingsRow[];
  tiebreakExplanations: TiebreakExplanation[];
  /** League-phase fixtures of the table without an official result yet (not canceled, no bye). */
  pendingFixtureIds: string[];
}

interface ComputeScope {
  divisionId: string | null;
  /** Restricts the table to these entries and the games between them (a tournament pool). */
  entryIds?: readonly string[];
}

/**
 * Standings projections (SPK-RESULT-001 official results only, SPK-RESULT-003 versioned rule
 * set with explained tiebreaks). League-phase games only: playoff games are bracket progression. `recompute` runs inside the publishing transaction so the table
 * and the result commit together; `get` serves the latest projection and computes live from the
 * official results when none has been stored yet.
 */
@Injectable()
export class StandingsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
    private readonly outbox: Outbox,
  ) {}

  async recompute(
    trx: Trx,
    principal: Principal,
    input: {
      organizationId: string;
      seasonId: string;
      divisionId: string | null;
      triggerResultId: string | null;
      correlationId: string | null;
      operationId: string | null;
    },
  ): Promise<Standings> {
    const { organizationId, seasonId, divisionId } = input;
    const computed = await this.compute(trx, organizationId, seasonId, { divisionId });
    const id = newId();
    const now = this.clock.now();
    const row = await trx
      .insertInto('standings_projections')
      .values({
        id,
        organization_id: organizationId,
        season_id: seasonId,
        division_id: divisionId,
        rule_set_id: computed.ruleSetId,
        rule_set_version: computed.ruleSetVersion,
        computed_at: now,
        source_result_ids: computed.computation.countedResultIds,
        rows: json(computed.computation.rows),
        tiebreak_explanations: json(computed.computation.tiebreakExplanations),
        trigger_result_id: input.triggerResultId,
        created_by: json(snapshotActor(principal)),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.outbox.enqueue(trx, MatchEvents.standingsRecomputed, {
      organizationId,
      aggregateType: 'standings_projection',
      aggregateId: id,
      payload: {
        standingsProjectionId: id,
        seasonId,
        divisionId,
        ruleSetId: computed.ruleSetId,
        sourceResultCount: computed.computation.countedResultIds.length,
      },
      correlationId: input.correlationId,
      operationId: input.operationId,
    });
    return toStandings(row);
  }

  /** `GET /v1/seasons/{id}/standings`: the latest projection, or a live computation when none exists. */
  async get(principal: Principal, seasonId: string, query: StandingsQuery): Promise<Standings> {
    const organizationId = organizationOf(principal);
    const season = await loadSeasonRow(this.db, organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    await this.authorization.require(
      principal,
      MatchActions.readStandings,
      readTarget(principal, 'season', seasonId, organizationId),
    );
    const divisionId = query.divisionId ?? null;
    if (!divisionId) {
      // CMP-12 (SPK-RESULT-001): a divided season has one table per division, never a mixed one.
      const divisions = await this.db
        .selectFrom('divisions')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('season_id', '=', seasonId)
        .orderBy('name')
        .orderBy('id')
        .execute();
      if (divisions.length > 0) {
        throw errors.validation('This season has divisions; name one with divisionId.', {
          code: 'DIVISION_REQUIRED',
          divisionIds: divisions.map((d) => d.id),
        });
      }
    }
    let q = this.db
      .selectFrom('standings_projections')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .orderBy('computed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1);
    q = divisionId ? q.where('division_id', '=', divisionId) : q.where('division_id', 'is', null);
    const latest = await q.executeTakeFirst();
    if (latest) return toStandings(latest);
    const computed = await this.compute(this.db, organizationId, seasonId, { divisionId });
    return {
      id: null,
      seasonId,
      divisionId,
      ruleSetId: computed.ruleSetId,
      ruleSetVersion: computed.ruleSetVersion,
      computedAt: iso(this.clock.now()),
      sourceResultIds: computed.computation.countedResultIds,
      rows: computed.computation.rows,
      tiebreakExplanations: computed.computation.tiebreakExplanations,
    };
  }

  /**
   * Entry ids in table order for the official results of the scope, optionally with one fixture's
   * official result replaced by a candidate revision: how a correction would reorder the seeds a
   * published bracket draws from (SPK-RESULT-004), computed without writing anything.
   */
  async seedOrder(
    db: Reader,
    organizationId: string,
    seasonId: string,
    divisionId: string | null,
    replace?: { fixtureId: string; resultRevisionId: string },
  ): Promise<string[]> {
    const computed = await this.compute(db, organizationId, seasonId, { divisionId }, replace);
    return computed.computation.rows.map((r) => r.teamEntryId);
  }

  /** CMP-10: a division's table with the fixtures still waiting for an official result. */
  async divisionTable(
    db: Reader,
    organizationId: string,
    seasonId: string,
    divisionId: string,
  ): Promise<SeedingTable | null> {
    const division = await db
      .selectFrom('divisions')
      .select(['id', 'season_id'])
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .where('id', '=', divisionId)
      .executeTakeFirst();
    if (!division) return null;
    const computed = await this.compute(db, organizationId, seasonId, { divisionId });
    return {
      seasonId,
      rows: computed.computation.rows,
      tiebreakExplanations: computed.computation.tiebreakExplanations,
      pendingFixtureIds: await this.pendingFixtures(db, organizationId, seasonId, { divisionId }),
    };
  }

  /** CMP-15: a tournament pool's table (its entries and the games between them). */
  async poolTable(
    db: Reader,
    organizationId: string,
    poolId: string,
  ): Promise<SeedingTable | null> {
    const pool = await this.poolScope(db, organizationId, poolId);
    if (!pool) return null;
    const scope = { divisionId: pool.divisionId, entryIds: pool.entryIds };
    const computed = await this.compute(db, organizationId, pool.seasonId, scope);
    return {
      seasonId: pool.seasonId,
      rows: computed.computation.rows,
      tiebreakExplanations: computed.computation.tiebreakExplanations,
      pendingFixtureIds: await this.pendingFixtures(db, organizationId, pool.seasonId, scope),
    };
  }

  /** `GET /v1/pools/{id}/standings` (CMP-15): read with the season's standings read action. */
  async poolStandings(principal: Principal, poolId: string): Promise<PoolStandings> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const pool = await this.poolScope(db, organizationId, poolId);
    if (!pool) throw errors.notFound('pool', poolId);
    await this.authorization.require(
      principal,
      MatchActions.readStandings,
      readTarget(principal, 'season', pool.seasonId, organizationId),
    );
    const scope = { divisionId: pool.divisionId, entryIds: pool.entryIds };
    const computed = await this.compute(db, organizationId, pool.seasonId, scope);
    return {
      poolId,
      seasonId: pool.seasonId,
      divisionId: pool.divisionId,
      ruleSetId: computed.ruleSetId,
      ruleSetVersion: computed.ruleSetVersion,
      computedAt: iso(this.clock.now()),
      sourceResultIds: computed.computation.countedResultIds,
      pendingFixtureIds: await this.pendingFixtures(db, organizationId, pool.seasonId, scope),
      rows: computed.computation.rows,
      tiebreakExplanations: computed.computation.tiebreakExplanations,
    };
  }

  private async poolScope(
    db: Reader,
    organizationId: string,
    poolId: string,
  ): Promise<{ seasonId: string; divisionId: string; entryIds: string[] } | null> {
    const pool = await db
      .selectFrom('pools')
      .select(['id', 'season_id', 'division_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', poolId)
      .executeTakeFirst();
    if (!pool) return null;
    const entries = await db
      .selectFrom('pool_entries')
      .select('team_entry_id')
      .where('organization_id', '=', organizationId)
      .where('pool_id', '=', poolId)
      .execute();
    return {
      seasonId: pool.season_id,
      divisionId: pool.division_id,
      entryIds: entries.map((e) => e.team_entry_id),
    };
  }

  /** League-phase fixtures of the scope (not canceled, not byes) without an official result. */
  private async pendingFixtures(
    db: Reader,
    organizationId: string,
    seasonId: string,
    scope: ComputeScope,
  ): Promise<string[]> {
    if (scope.entryIds && scope.entryIds.length < 2) return [];
    let q = db
      .selectFrom('fixtures as f')
      .select('f.id')
      .where('f.organization_id', '=', organizationId)
      .where('f.season_id', '=', seasonId)
      .where('f.away_entry_id', 'is not', null)
      .where('f.status', '<>', 'canceled')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('bracket_nodes as bn')
              .select('bn.id')
              .whereRef('bn.organization_id', '=', 'f.organization_id')
              .whereRef('bn.fixture_id', '=', 'f.id'),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('result_revisions as r')
              .select('r.id')
              .whereRef('r.organization_id', '=', 'f.organization_id')
              .whereRef('r.fixture_id', '=', 'f.id')
              .where('r.status', '=', 'official'),
          ),
        ),
      );
    q = scope.divisionId
      ? q.where('f.division_id', '=', scope.divisionId)
      : q.where('f.division_id', 'is', null);
    if (scope.entryIds) {
      const ids = [...scope.entryIds];
      q = q.where('f.home_entry_id', 'in', ids).where('f.away_entry_id', 'in', ids);
    }
    const rows = await q.orderBy('f.id').execute();
    return rows.map((r) => r.id);
  }

  private async compute(
    db: Reader,
    organizationId: string,
    seasonId: string,
    scope: ComputeScope,
    replace?: { fixtureId: string; resultRevisionId: string },
  ): Promise<{ computation: StandingsComputation; ruleSetId: string; ruleSetVersion: number }> {
    const { divisionId } = scope;
    const season = await loadSeasonRow(db, organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    const ruleSet = await loadRuleSetRow(db, organizationId, season.rule_set_id);
    if (!ruleSet) throw errors.notFound('rule_set', season.rule_set_id);
    const rules = ruleSetContentOf(ruleSet);

    const base = db
      .selectFrom('result_revisions as r')
      .innerJoin('fixtures as f', (join) =>
        join
          .onRef('f.organization_id', '=', 'r.organization_id')
          .onRef('f.id', '=', 'r.fixture_id'),
      )
      .select([
        'r.id',
        'r.fixture_id',
        'r.home_score',
        'r.away_score',
        'r.classification',
        'r.forfeiting_entry_id',
        'r.details',
        'f.home_entry_id',
        'f.away_entry_id',
      ])
      .where('r.organization_id', '=', organizationId)
      .where('f.season_id', '=', seasonId)
      .where('f.away_entry_id', 'is not', null)
      // Playoff games (played in a bracket node) never count in the league table.
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('bracket_nodes as bn')
              .select('bn.id')
              .whereRef('bn.organization_id', '=', 'f.organization_id')
              .whereRef('bn.fixture_id', '=', 'f.id'),
          ),
        ),
      );
    let resultQuery = base
      .where('r.status', '=', 'official')
      .orderBy('r.published_at')
      .orderBy('r.id');
    if (divisionId) resultQuery = resultQuery.where('f.division_id', '=', divisionId);
    if (scope.entryIds) {
      const ids = [...scope.entryIds];
      if (ids.length === 0) {
        resultQuery = resultQuery.where(sql<boolean>`false`);
      } else {
        resultQuery = resultQuery
          .where('f.home_entry_id', 'in', ids)
          .where('f.away_entry_id', 'in', ids);
      }
    }
    let resultRows = await resultQuery.execute();
    if (replace) {
      const candidate = await base
        .where('r.id', '=', replace.resultRevisionId)
        .where('r.fixture_id', '=', replace.fixtureId)
        .executeTakeFirst();
      resultRows = resultRows.filter((r) => r.fixture_id !== replace.fixtureId);
      if (candidate) resultRows.push(candidate);
    }
    const results: OfficialResultInput[] = resultRows.map((r) => {
      const details = r.details as {
        cards?: ResultCard[];
        abandonment?: { minutePlayed: number } | null;
      };
      return {
        id: r.id,
        fixtureId: r.fixture_id,
        homeEntryId: r.home_entry_id,
        awayEntryId: r.away_entry_id as string,
        homeScore: r.home_score,
        awayScore: r.away_score,
        classification: r.classification,
        forfeitingEntryId: r.forfeiting_entry_id,
        cards: details.cards ?? [],
        abandonmentMinutePlayed: details.abandonment?.minutePlayed ?? null,
      };
    });

    let entryQuery = db
      .selectFrom('team_entries')
      .innerJoin('teams', (join) =>
        join
          .onRef('teams.organization_id', '=', 'team_entries.organization_id')
          .onRef('teams.id', '=', 'team_entries.team_id'),
      )
      .select(['team_entries.id', 'team_entries.status', 'teams.name'])
      .where('team_entries.organization_id', '=', organizationId)
      .where('team_entries.season_id', '=', seasonId)
      .where('team_entries.status', 'in', ['approved', 'withdrawn'])
      .orderBy('teams.name')
      .orderBy('team_entries.id');
    if (divisionId) entryQuery = entryQuery.where('team_entries.division_id', '=', divisionId);
    if (scope.entryIds) {
      const ids = [...scope.entryIds];
      entryQuery =
        ids.length === 0
          ? entryQuery.where(sql<boolean>`false`)
          : entryQuery.where('team_entries.id', 'in', ids);
    }
    const entryRows = await entryQuery.execute();
    const referenced = new Set(results.flatMap((r) => [r.homeEntryId, r.awayEntryId]));
    const entries = entryRows
      .filter((e) => e.status === 'approved' || referenced.has(e.id))
      .map((e) => ({ teamEntryId: e.id, teamName: e.name }));

    return {
      computation: computeStandings(rules, entries, results, FAIR_PLAY_POINTS),
      ruleSetId: ruleSet.id,
      ruleSetVersion: ruleSet.version,
    };
  }
}
