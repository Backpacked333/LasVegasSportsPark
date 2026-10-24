import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type Principal,
  type ResultCard,
  type Standings,
  type StandingsQuery,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  snapshotActor,
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

/**
 * Standings projections (SPK-RESULT-001 official results only, SPK-RESULT-003 versioned rule
 * set with explained tiebreaks). `recompute` runs inside the publishing transaction so the table
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
    const computed = await this.compute(trx, organizationId, seasonId, divisionId);
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
    return toStandings(row, computed.ruleSetVersion);
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
    if (latest) {
      const ruleSet = await loadRuleSetRow(this.db, organizationId, latest.rule_set_id);
      return toStandings(latest, ruleSet?.version ?? 0);
    }
    const computed = await this.compute(this.db, organizationId, seasonId, divisionId);
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

  private async compute(
    db: Reader,
    organizationId: string,
    seasonId: string,
    divisionId: string | null,
  ): Promise<{ computation: StandingsComputation; ruleSetId: string; ruleSetVersion: number }> {
    const season = await loadSeasonRow(db, organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    const ruleSet = await loadRuleSetRow(db, organizationId, season.rule_set_id);
    if (!ruleSet) throw errors.notFound('rule_set', season.rule_set_id);
    const rules = ruleSetContentOf(ruleSet);

    let resultQuery = db
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
      .where('r.status', '=', 'official')
      .where('f.season_id', '=', seasonId)
      .where('f.away_entry_id', 'is not', null)
      .orderBy('r.published_at')
      .orderBy('r.id');
    if (divisionId) resultQuery = resultQuery.where('f.division_id', '=', divisionId);
    const resultRows = await resultQuery.execute();
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
