import { Inject, Injectable } from '@nestjs/common';
import {
  decodeCursor,
  DIVISION_SPECIFICATIONS_LIMIT,
  DomainError,
  errors,
  newId,
  systemPrincipal,
  z,
  type CreateFixtureSpecificationInput,
  type DraftChangeInput,
  type FairnessPreference,
  type FixtureSpecification,
  type GenerateFixturesInput,
  type ListSolverRunsQuery,
  type Page,
  type Principal,
  type SolverOutcome,
  type SolverRun,
  type UpdateFixtureSpecificationInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import { sql } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  FacilityDirectory,
  OperationsService,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  executorFor,
  snapshotActor,
  type Clock,
} from '../../../kernel';
import { ResourcesService, ScheduleDraftsService, resolveLocal } from '../../scheduling';
import { MatchActions } from '../competition-matches.actions';
import { MatchEvents } from '../competition-matches.events';
import { solverDraftName, unscheduledFixtureDeadline } from '../competition-matches.policy';
import {
  proposalEntryIds,
  specificationColumns,
  toFixtureSpecification,
  toSolverRun,
  type SpecificationRow,
} from '../competition-matches.shared';
import { CompetitionEvents } from '../competition.events';
import { loadRuleSetRow, loadSeasonRow, teamNamesOf, type Reader } from '../competition.queries';
import {
  criteriaOf,
  organizationOf,
  ruleSetContentOf,
  type SeasonRow,
} from '../competition.shared';
import { addDays, generateFixtures, type ProposedGame } from '../matches/fixture-generator';
import { nextCursorOf } from './discipline.service';

const RunCursor = z.object({ at: z.string(), id: z.uuid() });

/** Draft states in which a generated proposal still waits in scheduling (CMP-12). */
const OPEN_DRAFT_STATUSES = new Set(['editing', 'validated', 'publishing', 'failed']);

interface GenerationPlan {
  runId: string;
  operationId: string;
  facilityId: string;
  draftName: string;
  draftChanges: DraftChangeInput[];
  seasonId: string;
  divisionId: string;
  outcome: SolverOutcome;
  complete: boolean;
  fixtureIds: string[];
}

/**
 * Fixture generation (SPK-FIX-001..005, SPK-AT-010/011). A specification names the division's
 * teams (its approved entries), games per team, opponent frequency, dates, blackouts, byes,
 * minimum rest, allowed start times, required resources, playoff structure and fairness
 * preferences with hard/soft flags. A run records the input snapshot, rule-set version, search
 * settings and an honest outcome (SPK-FIX-004); the fixtures it creates are the season's
 * obligations, and the scheduled games become a scheduling draft through the scheduling module's
 * draft API (SPK-FIX-005) — publication is the scheduler's normal command, never done here.
 * The draft is created between two transactions like every cross-module command (§4.9).
 */
@Injectable()
export class FixtureGenerationService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly operations: OperationsService,
    private readonly resources: ResourcesService,
    private readonly drafts: ScheduleDraftsService,
    private readonly facilities: FacilityDirectory,
  ) {}

  /** Solver runs with the proposed games' team names (CMP-01: one join per page). */
  private async runViews(
    db: Reader,
    organizationId: string,
    rows: Parameters<typeof toSolverRun>[0][],
  ): Promise<SolverRun[]> {
    const names = await teamNamesOf(db, organizationId, rows.flatMap(proposalEntryIds));
    return rows.map((row) => toSolverRun(row, names));
  }

  /** `GET /v1/divisions/{id}/fixture-specifications` (CMP-05): bounded, newest first. */
  async listForDivision(
    principal: Principal,
    divisionId: string,
  ): Promise<{ items: FixtureSpecification[] }> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const division = await db
      .selectFrom('divisions')
      .select(['id', 'facility_id'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', divisionId)
      .executeTakeFirst();
    if (!division) throw errors.notFound('division', divisionId);
    // The single read's action, at the division's facility (a facility-scoped manager sees theirs).
    await this.authorization.require(principal, MatchActions.manageFixtureSpecifications, {
      type: 'fixture_specification',
      organizationId,
      facilityId: division.facility_id,
    });
    const rows = (await db
      .selectFrom('fixture_specifications')
      .select([
        ...specificationColumns,
        sql<string>`fixture_specifications.starts_on::text`.as('starts_on'),
        sql<string>`fixture_specifications.ends_on::text`.as('ends_on'),
      ])
      .where('fixture_specifications.organization_id', '=', organizationId)
      .where('fixture_specifications.division_id', '=', divisionId)
      .orderBy('fixture_specifications.created_at', 'desc')
      .orderBy('fixture_specifications.id', 'desc')
      .limit(DIVISION_SPECIFICATIONS_LIMIT)
      .execute()) as SpecificationRow[];
    const teamEntryIds = await this.entryIds(db, organizationId, divisionId);
    return { items: rows.map((row) => toFixtureSpecification(row, teamEntryIds)) };
  }

  /** `GET /v1/fixture-specifications/{id}/solver-runs` (CMP-05): newest first, keyset cursor. */
  async listRuns(
    principal: Principal,
    specificationId: string,
    query: ListSolverRunsQuery,
  ): Promise<Page<SolverRun>> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const spec = await this.loadSpecification(db, organizationId, specificationId);
    if (!spec) throw errors.notFound('fixture_specification', specificationId);
    await this.authorization.require(principal, MatchActions.manageFixtureSpecifications, {
      type: 'solver_run',
      organizationId,
      facilityId: spec.facility_id,
    });
    const cursor = decodeCursor(query.cursor, RunCursor);
    if (query.cursor && !cursor) throw errors.validation('The cursor is not valid.');
    let q = db
      .selectFrom('solver_runs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('specification_id', '=', specificationId);
    if (cursor) {
      const at = new Date(cursor.at);
      q = q.where((eb) =>
        eb.or([
          eb('created_at', '<', at),
          eb.and([eb('created_at', '=', at), eb('id', '<', cursor.id)]),
        ]),
      );
    }
    const rows = await q
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    return {
      items: await this.runViews(db, organizationId, page),
      nextCursor: nextCursorOf(rows, page, query.limit),
    };
  }

  /**
   * `PATCH /v1/fixture-specifications/{id}` (CMP-12, SPK-FIX-001): the creation fields, changed
   * from the revision the caller saw, while no generation run of the specification waits in an
   * open scheduling draft (INVALID_TRANSITION SPECIFICATION_IN_USE): a draft already proposes
   * fixtures from the current content, so the scheduler publishes or discards it first.
   */
  async updateSpecification(
    principal: Principal,
    specificationId: string,
    input: UpdateFixtureSpecificationInput,
    correlationId: string | null,
  ): Promise<FixtureSpecification> {
    const organizationId = organizationOf(principal);
    const current = await this.loadSpecification(this.db, organizationId, specificationId);
    if (!current) throw errors.notFound('fixture_specification', specificationId);
    const facilityId = input.facilityId ?? current.facility_id;
    await this.authorization.require(principal, MatchActions.manageFixtureSpecifications, {
      type: 'fixture_specification',
      id: specificationId,
      organizationId,
      facilityId: current.facility_id,
    });
    if (facilityId !== current.facility_id) {
      await this.authorization.require(principal, MatchActions.manageFixtureSpecifications, {
        type: 'fixture_specification',
        organizationId,
        facilityId,
      });
    }
    const requiredResourceIds = input.requiredResourceIds ?? current.required_resource_ids;
    if (input.requiredResourceIds || input.facilityId) {
      // Resources are validated through the scheduling module (outside the transaction, §4.11).
      const resources = await this.resources.listResources(principal, facilityId);
      const unknown = requiredResourceIds.filter((id) => !resources.some((r) => r.id === id));
      if (unknown.length > 0) {
        throw errors.validation('Required resources must belong to the facility.', {
          unknownResourceIds: unknown,
        });
      }
    }
    const drafts = await this.db
      .selectFrom('solver_runs')
      .select('schedule_draft_id')
      .where('organization_id', '=', organizationId)
      .where('specification_id', '=', specificationId)
      .where('schedule_draft_id', 'is not', null)
      .execute();
    const reader = systemPrincipal(organizationId, 'competition.specification_in_use');
    for (const { schedule_draft_id: draftId } of drafts) {
      if (!draftId) continue;
      const draft = await this.drafts.get(reader, draftId);
      if (OPEN_DRAFT_STATUSES.has(draft.status)) {
        throw new DomainError(
          'INVALID_TRANSITION',
          'A schedule draft generated from this specification is still open; publish or discard it first.',
          {
            details: {
              code: 'SPECIFICATION_IN_USE',
              scheduleDraftId: draftId,
              draftStatus: draft.status,
            },
          },
        );
      }
    }
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadSpecification(trx, organizationId, specificationId, {
        forUpdate: true,
      });
      if (!row) throw errors.notFound('fixture_specification', specificationId);
      assertExpectedRevision(input.expectedRevision, row.revision);
      const season = await loadSeasonRow(trx, organizationId, row.season_id);
      if (!season) throw errors.notFound('season', row.season_id);
      const teamEntryIds = await this.entryIds(trx, organizationId, row.division_id);
      const next = {
        name: input.name ?? row.name,
        gamesPerTeam: input.gamesPerTeam ?? row.games_per_team,
        opponentFrequency: input.opponentFrequency ?? row.opponent_frequency,
        startsOn: input.startsOn ?? row.starts_on,
        endsOn: input.endsOn ?? row.ends_on,
        fairnessPreferences:
          input.fairnessPreferences ?? (row.fairness_preferences as FairnessPreference[]),
      };
      if (next.startsOn > next.endsOn) {
        throw errors.validation('startsOn must not be after endsOn.');
      }
      assertSpecificationConsistent(next, season, teamEntryIds, { requireTeams: false });
      const updated = await trx
        .updateTable('fixture_specifications')
        .set({
          name: next.name,
          facility_id: facilityId,
          games_per_team: next.gamesPerTeam,
          opponent_frequency: next.opponentFrequency,
          starts_on: next.startsOn,
          ends_on: next.endsOn,
          blackouts: input.blackouts ? json(input.blackouts) : undefined,
          byes_allowed: input.byesAllowed,
          minimum_rest_minutes: input.minimumRestMinutes,
          allowed_start_times: input.allowedStartTimes ? json(input.allowedStartTimes) : undefined,
          match_duration_minutes: input.matchDurationMinutes,
          required_resource_ids: input.requiredResourceIds,
          playoff_structure:
            input.playoffStructure === undefined
              ? undefined
              : input.playoffStructure === null
                ? null
                : json(input.playoffStructure),
          fairness_preferences: input.fairnessPreferences
            ? json(input.fairnessPreferences)
            : undefined,
          max_games_per_team_per_day: input.maxGamesPerTeamPerDay,
          officials_per_game: input.officialsPerGame,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', specificationId)
        .where('revision', '=', row.revision)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) {
        throw errors.staleRevision(input.expectedRevision, row.revision);
      }
      const { expectedRevision: _expected, reason, policyReferences: _refs, ...changes } = input;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.manageFixtureSpecifications.id,
        targetType: 'fixture_specification',
        targetId: specificationId,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: reason ?? null,
        correlationId,
        details: { operation: 'update', changedFields: Object.keys(changes).sort() },
      });
      const saved = await this.loadSpecification(trx, organizationId, specificationId);
      if (!saved) throw errors.notFound('fixture_specification', specificationId);
      return toFixtureSpecification(saved, teamEntryIds);
    });
  }

  async createSpecification(
    principal: Principal,
    divisionId: string,
    input: CreateFixtureSpecificationInput,
    correlationId: string | null,
  ): Promise<FixtureSpecification> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, MatchActions.manageFixtureSpecifications, {
      type: 'fixture_specification',
      organizationId,
      facilityId: input.facilityId,
    });
    // Resources are validated through the scheduling module (outside the transaction, §4.11).
    const resources = await this.resources.listResources(principal, input.facilityId);
    const unknown = input.requiredResourceIds.filter((id) => !resources.some((r) => r.id === id));
    if (unknown.length > 0) {
      throw errors.validation('Required resources must belong to the facility.', {
        unknownResourceIds: unknown,
      });
    }
    return this.uow.run(async ({ trx }) => {
      const division = await trx
        .selectFrom('divisions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', divisionId)
        .executeTakeFirst();
      if (!division) throw errors.notFound('division', divisionId);
      const season = await loadSeasonRow(trx, organizationId, division.season_id);
      if (!season) throw errors.notFound('season', division.season_id);
      const ruleSet = await loadRuleSetRow(trx, organizationId, season.rule_set_id);
      if (!ruleSet) throw errors.notFound('rule_set', season.rule_set_id);
      const rules = ruleSetContentOf(ruleSet);
      const teamEntryIds = await this.entryIds(trx, organizationId, divisionId);
      assertSpecificationConsistent(
        {
          gamesPerTeam: input.gamesPerTeam,
          opponentFrequency: input.opponentFrequency,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          fairnessPreferences: input.fairnessPreferences,
        },
        season,
        teamEntryIds,
        { requireTeams: false },
      );
      const id = newId();
      await trx
        .insertInto('fixture_specifications')
        .values({
          id,
          organization_id: organizationId,
          season_id: division.season_id,
          division_id: divisionId,
          facility_id: input.facilityId,
          name: input.name,
          games_per_team: input.gamesPerTeam,
          opponent_frequency: input.opponentFrequency,
          starts_on: input.startsOn,
          ends_on: input.endsOn,
          blackouts: json(input.blackouts),
          byes_allowed: input.byesAllowed,
          minimum_rest_minutes: input.minimumRestMinutes,
          allowed_start_times: json(input.allowedStartTimes),
          match_duration_minutes: input.matchDurationMinutes ?? rules.matchLengthMinutes,
          required_resource_ids: input.requiredResourceIds,
          playoff_structure: input.playoffStructure ? json(input.playoffStructure) : null,
          fairness_preferences: json(input.fairnessPreferences),
          max_games_per_team_per_day: input.maxGamesPerTeamPerDay ?? null,
          officials_per_game: input.officialsPerGame ?? null,
          created_by: json(snapshotActor(principal)),
        })
        .execute();
      const row = await this.loadSpecification(trx, organizationId, id);
      if (!row) throw errors.notFound('fixture_specification', id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.manageFixtureSpecifications.id,
        targetType: 'fixture_specification',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          divisionId,
          gamesPerTeam: input.gamesPerTeam,
          opponentFrequency: input.opponentFrequency,
          hardPreferences: input.fairnessPreferences.filter((p) => p.hard).map((p) => p.kind),
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.fixtureSpecificationCreated, {
        organizationId,
        aggregateType: 'fixture_specification',
        aggregateId: id,
        payload: { specificationId: id, seasonId: division.season_id, divisionId },
        correlationId,
      });
      return toFixtureSpecification(row, teamEntryIds);
    });
  }

  async getSpecification(principal: Principal, id: string): Promise<FixtureSpecification> {
    const organizationId = organizationOf(principal);
    const row = await this.loadSpecification(this.db, organizationId, id);
    if (!row) throw errors.notFound('fixture_specification', id);
    await this.authorization.require(principal, MatchActions.manageFixtureSpecifications, {
      type: 'fixture_specification',
      id,
      organizationId,
      facilityId: row.facility_id,
    });
    return toFixtureSpecification(
      row,
      await this.entryIds(this.db, organizationId, row.division_id),
    );
  }

  /** `POST /v1/fixture-specifications/{id}/generate` */
  async generate(
    principal: Principal,
    specificationId: string,
    input: GenerateFixturesInput,
    correlationId: string | null,
  ): Promise<SolverRun> {
    const organizationId = organizationOf(principal);
    // The resources' setup and cleanup turnover comes from the scheduling module, read before the
    // transaction (§4.11): the generator never places two games on one resource at overlapping
    // occupied times, the same rule publication applies (SPK-FIX-004, SPK-FIX-005).
    const requested = await this.loadSpecification(this.db, organizationId, specificationId);
    if (!requested) throw errors.notFound('fixture_specification', specificationId);
    await this.authorization.require(principal, MatchActions.generateFixtures, {
      type: 'fixture_specification',
      id: specificationId,
      organizationId,
      facilityId: requested.facility_id,
    });
    const resourceBuffers: Record<string, { setupMinutes: number; cleanupMinutes: number }> = {};
    for (const resource of await this.resources.listResources(principal, requested.facility_id)) {
      resourceBuffers[resource.id] = {
        setupMinutes: resource.defaultSetupMinutes,
        cleanupMinutes: resource.defaultCleanupMinutes,
      };
    }
    const plan = await this.uow.run(async ({ trx }): Promise<GenerationPlan> => {
      const spec = await this.loadSpecification(trx, organizationId, specificationId, {
        forUpdate: true,
      });
      if (!spec) throw errors.notFound('fixture_specification', specificationId);
      await this.authorization.require(principal, MatchActions.generateFixtures, {
        type: 'fixture_specification',
        id: specificationId,
        organizationId,
        facilityId: spec.facility_id,
      });
      const season = await loadSeasonRow(trx, organizationId, spec.season_id);
      if (!season) throw errors.notFound('season', spec.season_id);
      const ruleSet = await loadRuleSetRow(trx, organizationId, season.rule_set_id);
      if (!ruleSet) throw errors.notFound('rule_set', season.rule_set_id);
      let divisionQuery = trx
        .selectFrom('divisions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', spec.division_id);
      // SPK-FIX-002 / §4.7: the "division already has fixtures" check below and the fixture inserts
      // must not interleave with a run of another specification of the same division, so a real
      // run holds the division row. FOR NO KEY UPDATE still lets other writers reference it.
      if (!input.dryRun) divisionQuery = divisionQuery.forNoKeyUpdate();
      const division = await divisionQuery.executeTakeFirstOrThrow();
      // CMP-11 (§4.2): the facility's IANA time zone through the kernel's directory (IF-03).
      const facility = (
        await this.facilities.describe(organizationId, [spec.facility_id], trx)
      ).get(spec.facility_id);
      if (!facility) throw errors.notFound('facility', spec.facility_id);
      const entries = await trx
        .selectFrom('team_entries')
        .innerJoin('teams', (join) =>
          join
            .onRef('teams.organization_id', '=', 'team_entries.organization_id')
            .onRef('teams.id', '=', 'team_entries.team_id'),
        )
        .select(['team_entries.id', 'teams.name'])
        .where('team_entries.organization_id', '=', organizationId)
        .where('team_entries.division_id', '=', spec.division_id)
        .where('team_entries.status', '=', 'approved')
        .orderBy('team_entries.id')
        .execute();
      const teamEntryIds = entries.map((e) => e.id);
      const names = new Map(entries.map((e) => [e.id, e.name]));
      // A specification error is a 422 before any run: never reported as "infeasible" (SPK-FIX-004).
      assertSpecificationConsistent(
        {
          gamesPerTeam: spec.games_per_team,
          opponentFrequency: spec.opponent_frequency,
          startsOn: spec.starts_on,
          endsOn: spec.ends_on,
          fairnessPreferences: spec.fairness_preferences as FairnessPreference[],
        },
        season,
        teamEntryIds,
        { requireTeams: true },
      );
      if (!input.dryRun) {
        const existing = await trx
          .selectFrom('fixtures')
          .select('id')
          .where('organization_id', '=', organizationId)
          .where('division_id', '=', spec.division_id)
          .where('status', '<>', 'canceled')
          .limit(1)
          .executeTakeFirst();
        if (existing) {
          throw errors.resourceConflict(
            'The division already has fixtures. Run with dryRun to preview, or cancel them first.',
            { divisionId: spec.division_id },
          );
        }
      }
      const snapshot = toFixtureSpecification(spec, teamEntryIds);
      const startedAt = this.clock.now();
      const result = generateFixtures(
        {
          teamEntryIds,
          gamesPerTeam: spec.games_per_team,
          opponentFrequency: spec.opponent_frequency,
          startsOn: spec.starts_on,
          endsOn: spec.ends_on,
          blackouts: snapshot.blackouts,
          byesAllowed: spec.byes_allowed,
          minimumRestMinutes: spec.minimum_rest_minutes,
          allowedStartTimes: snapshot.allowedStartTimes,
          matchDurationMinutes: spec.match_duration_minutes,
          resourceIds: spec.required_resource_ids,
          resourceBuffers,
          fairnessPreferences: snapshot.fairnessPreferences,
          playoffStructure: snapshot.playoffStructure,
          maxGamesPerTeamPerDay: spec.max_games_per_team_per_day ?? null,
          officialsPerGame: spec.officials_per_game ?? null,
          resolveInstant: (date, time) =>
            resolveLocal(date, time, facility.timezone)?.instant ?? null,
          obligationDeadline: unscheduledFixtureDeadline(
            this.clock.now(),
            resolveLocal(addDays(season.ends_on, 1), '00:00', facility.timezone)?.instant ?? null,
          ).toISOString(),
        },
        input.searchSettings,
        () => this.clock.now().getTime(),
      );
      const finishedAt = this.clock.now();
      const operationId = await this.operations.create(trx, {
        organizationId,
        kind: 'competition.generate_fixtures',
        requestedBy: principal,
        correlationId,
        input: { specificationId, dryRun: input.dryRun, searchSettings: input.searchSettings },
        status: 'running',
      });
      const runId = newId();
      const games: ProposedGame[] = result.proposal?.games ?? [];
      const fixtureIds: string[] = [];
      // A proposal that breaks a hard constraint is an explanation only: it never becomes fixtures
      // or a scheduling draft (SPK-FIX-003 hard constraints are visibly distinct, SPK-FIX-004 "no
      // feasible proposal found"). A partial proposal that respects every hard constraint is
      // materialized, its unscheduled games kept as remaining obligations (SPK-FIX-002).
      const materialize =
        !input.dryRun &&
        result.outcome !== 'proven_infeasible' &&
        result.explanation.hardViolations.length === 0 &&
        games.length > 0;
      if (materialize) {
        for (const game of games) {
          const fixtureId = newId();
          game.fixtureId = fixtureId;
          fixtureIds.push(fixtureId);
          await trx
            .insertInto('fixtures')
            .values({
              id: fixtureId,
              organization_id: organizationId,
              season_id: spec.season_id,
              division_id: spec.division_id,
              round: game.round,
              home_entry_id: game.homeEntryId,
              away_entry_id: game.awayEntryId,
              scheduling_event_id: null,
              scheduled_start: null,
              scheduled_end: null,
              notes: null,
              created_by: json(snapshotActor(principal)),
            })
            .execute();
          await this.outbox.enqueue(trx, CompetitionEvents.fixtureCreated, {
            organizationId,
            aggregateType: 'fixture',
            aggregateId: fixtureId,
            payload: {
              fixtureId,
              seasonId: spec.season_id,
              divisionId: spec.division_id,
              homeEntryId: game.homeEntryId,
              awayEntryId: game.awayEntryId,
              operationId,
            },
            correlationId,
            operationId,
          });
        }
      }
      await trx
        .insertInto('solver_runs')
        .values({
          id: runId,
          organization_id: organizationId,
          specification_id: specificationId,
          specification_snapshot: json(snapshot),
          rule_set_id: ruleSet.id,
          search_settings: json(input.searchSettings),
          outcome: result.outcome,
          proposal: result.proposal ? json({ games }) : null,
          completeness_report: json(result.completeness),
          explanation: json(result.explanation),
          dry_run: input.dryRun,
          schedule_draft_id: null,
          fixture_ids: fixtureIds,
          operation_id: operationId,
          started_at: startedAt,
          finished_at: finishedAt,
          created_by: json(snapshotActor(principal)),
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: MatchActions.generateFixtures.id,
        targetType: 'solver_run',
        targetId: runId,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        operationId,
        details: {
          specificationId,
          outcome: result.outcome,
          dryRun: input.dryRun,
          complete: result.completeness.complete,
          fixtureCount: fixtureIds.length,
          candidatesTried: result.explanation.candidatesTried,
        },
      });
      const format = criteriaOf(division).format;
      const draftChanges: DraftChangeInput[] = materialize
        ? games
            .filter(
              (g) => g.awayEntryId !== null && g.scheduledStart && g.scheduledEnd && g.resourceId,
            )
            .map((g) => ({
              kind: 'create' as const,
              proposed: {
                kind: 'game' as const,
                title: `${names.get(g.homeEntryId) ?? 'Home'} v ${names.get(g.awayEntryId as string) ?? 'Away'}`,
                format,
                scheduledStart: g.scheduledStart as string,
                scheduledEnd: g.scheduledEnd as string,
                sourceType: 'fixture',
                sourceId: g.fixtureId as string,
                commitments: [
                  { partyType: 'team' as const, partyId: g.homeEntryId, role: 'home_team' },
                  {
                    partyType: 'team' as const,
                    partyId: g.awayEntryId as string,
                    role: 'away_team',
                  },
                ],
              },
              resourceIds: [g.resourceId as string],
            }))
        : [];
      const runCount = await trx
        .selectFrom('solver_runs')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('organization_id', '=', organizationId)
        .where('specification_id', '=', specificationId)
        .executeTakeFirstOrThrow();
      return {
        runId,
        operationId,
        facilityId: spec.facility_id,
        draftName: input.draftName ?? solverDraftName(spec.name, Number(runCount.n)),
        draftChanges,
        seasonId: spec.season_id,
        divisionId: spec.division_id,
        outcome: result.outcome,
        complete: result.completeness.complete,
        fixtureIds,
      };
    });

    // Step 2 (own transaction, scheduling module): the proposal becomes a draft, never a publication.
    let scheduleDraftId: string | null = null;
    if (plan.draftChanges.length > 0) {
      try {
        const draft = await this.drafts.create(
          principal,
          {
            facilityId: plan.facilityId,
            name: plan.draftName,
            changes: plan.draftChanges,
            reason: `fixture generation run ${plan.runId}`,
          },
          correlationId ?? undefined,
        );
        scheduleDraftId = draft.id;
      } catch (error) {
        await this.uow.run(async ({ trx }) => {
          await this.operations.transition(trx, plan.operationId, 'failed', {
            error: DomainError.is(error)
              ? { code: error.code, message: error.message, details: error.details }
              : { code: 'INTERNAL_ERROR', message: 'opening the schedule draft failed' },
          });
          await this.audit.record(trx, {
            organizationId,
            actor: principal,
            action: MatchActions.generateFixtures.id,
            targetType: 'solver_run',
            targetId: plan.runId,
            correlationId,
            operationId: plan.operationId,
            details: { step: 'create_draft', outcome: 'failed' },
          });
        });
        throw error;
      }
    }

    return this.uow.run(async ({ trx }) => {
      const run = await trx
        .updateTable('solver_runs')
        .set({ schedule_draft_id: scheduleDraftId, revision: sql`revision + 1` })
        .where('organization_id', '=', organizationId)
        .where('id', '=', plan.runId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.operations.transition(trx, plan.operationId, 'succeeded', {
        result: {
          solverRunId: plan.runId,
          outcome: plan.outcome,
          scheduleDraftId,
          fixtureIds: plan.fixtureIds,
        },
      });
      await this.outbox.enqueue(trx, MatchEvents.fixturesGenerated, {
        organizationId,
        aggregateType: 'solver_run',
        aggregateId: plan.runId,
        payload: {
          solverRunId: plan.runId,
          specificationId,
          seasonId: plan.seasonId,
          divisionId: plan.divisionId,
          outcome: plan.outcome,
          fixtureIds: plan.fixtureIds,
          scheduleDraftId,
          complete: plan.complete,
          operationId: plan.operationId,
        },
        correlationId,
        operationId: plan.operationId,
      });
      const [view] = await this.runViews(trx, organizationId, [run]);
      return view as SolverRun;
    });
  }

  async getRun(principal: Principal, id: string): Promise<SolverRun> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('solver_runs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('solver_run', id);
    const spec = await this.loadSpecification(this.db, organizationId, row.specification_id);
    await this.authorization.require(principal, MatchActions.manageFixtureSpecifications, {
      type: 'solver_run',
      id,
      organizationId,
      facilityId: spec?.facility_id ?? null,
    });
    const [view] = await this.runViews(this.db, organizationId, [row]);
    return view as SolverRun;
  }

  private async loadSpecification(
    db: Reader,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<SpecificationRow | null> {
    let q = db
      .selectFrom('fixture_specifications')
      .select([
        ...specificationColumns,
        sql<string>`fixture_specifications.starts_on::text`.as('starts_on'),
        sql<string>`fixture_specifications.ends_on::text`.as('ends_on'),
      ])
      .where('fixture_specifications.organization_id', '=', organizationId)
      .where('fixture_specifications.id', '=', id);
    if (options.forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    return (row as SpecificationRow | undefined) ?? null;
  }

  private async entryIds(
    db: Reader,
    organizationId: string,
    divisionId: string,
  ): Promise<string[]> {
    const rows = await db
      .selectFrom('team_entries')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('division_id', '=', divisionId)
      .where('status', '=', 'approved')
      .orderBy('id')
      .execute();
    return rows.map((r) => r.id);
  }
}

/**
 * SPK-FIX-001/002 specification consistency, checked before any solver run (a specification error
 * is never reported as an infeasible run, SPK-FIX-004): the competition dates lie inside the
 * season, a team-specific preference names an approved entry of the division, an approved
 * convenience preference cites its approval (SPK-FIX-003, DEC-049), and once the division's teams
 * are known, games per team equal (teams − 1) × opponent frequency for the round robin.
 */
export function assertSpecificationConsistent(
  spec: {
    gamesPerTeam: number;
    opponentFrequency: number;
    startsOn: string;
    endsOn: string;
    fairnessPreferences: FairnessPreference[];
  },
  season: Pick<SeasonRow, 'starts_on' | 'ends_on'>,
  teamEntryIds: string[],
  options: { requireTeams: boolean },
): void {
  if (spec.startsOn < season.starts_on || spec.endsOn > season.ends_on) {
    throw errors.validation('The competition dates must lie within the season.', {
      code: 'dates_outside_season',
      season: { startsOn: season.starts_on, endsOn: season.ends_on },
    });
  }
  for (const preference of spec.fairnessPreferences) {
    const teamSpecific =
      preference.kind === 'preferred_availability' || preference.kind === 'approved_convenience';
    if (teamSpecific && (!preference.teamEntryId || !(preference.startTimes ?? []).length)) {
      throw errors.validation('A team preference names the entry and its preferred times.', {
        code: 'preference_incomplete',
        kind: preference.kind,
      });
    }
    if (
      teamSpecific &&
      preference.teamEntryId &&
      teamEntryIds.length > 0 &&
      !teamEntryIds.includes(preference.teamEntryId)
    ) {
      throw errors.validation('A team preference names an approved entry of the division.', {
        code: 'preference_unknown_entry',
        teamEntryId: preference.teamEntryId,
      });
    }
    if (preference.kind === 'approved_convenience' && !preference.approvalReference) {
      throw errors.validation('Coach or family convenience is used only when approved.', {
        code: 'convenience_not_approved',
        teamEntryId: preference.teamEntryId ?? null,
      });
    }
  }
  const teams = teamEntryIds.length;
  if (teams < 2) {
    if (!options.requireTeams) return;
    throw errors.validation('At least two approved entries are needed to generate fixtures.', {
      code: 'not_enough_teams',
      teams,
    });
  }
  const expected = (teams - 1) * spec.opponentFrequency;
  if (spec.gamesPerTeam !== expected) {
    throw errors.validation(
      `${teams} teams meeting ${spec.opponentFrequency} time(s) play ${expected} games each, not ${spec.gamesPerTeam}.`,
      {
        code: 'games_per_team_inconsistent',
        teams,
        opponentFrequency: spec.opponentFrequency,
        gamesPerTeam: spec.gamesPerTeam,
        expectedGamesPerTeam: expected,
      },
    );
  }
}
