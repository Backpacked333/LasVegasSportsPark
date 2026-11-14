import { Inject, Injectable } from '@nestjs/common';
import {
  DivisionCriteriaSchema,
  DomainError,
  errors,
  type ChangeCompetitionPublicationInput,
  type CompetitionPublication,
  type DivisionCriteria,
  type Principal,
  type PublicBracketMatch,
  type PublicCompetitionView,
  type PublicDirectory,
  type PublicFixture,
  type PublicScore,
  type PublicSeasonView,
} from '@sportspark/contracts';
import { json, type CompetitionsTable, type Db, type FixturesTable } from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  executorFor,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  PUBLIC_CACHE_SECONDS,
  PublicScheduleService,
  newPublicCode,
  publicViewNotAvailable,
  resolvePublicOrganization,
  type PublicEventRef,
  type PublicEventTitle,
} from '../../scheduling';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import { organizationOf } from '../competition.shared';
import { StandingsService } from '../services/standings.service';

type Reader = Db | Trx;
type CompetitionRow = Selectable<CompetitionsTable>;

/** The age from which a player is an adult for publication (proposed, DEC-100 N2, N3). */
export const PUBLIC_ADULT_AGE = 18;
const MINOR_WORDS =
  /\b(youth|junior|juniors|kid|kids|boy|boys|girl|girls|child|children|minor|minors)\b/i;
const UNDER_AGE = /\bu[-\s]?(\d{1,2})\b/i;

/**
 * Whether a division's documented criteria describe players under 18 (SPK-SCHED-010 "no child's
 * name ... appears"; proposed rule pending DEC-100): an age band that starts under 18 or is open
 * at the bottom, or a name, level or category that says so ("U12", "Youth", "Girls"). A division
 * with no age criteria at all describes nobody under 18. The rule errs towards private: a band
 * with only a maximum counts as describing minors.
 */
export function describesMinors(division: { name: string; criteria: unknown }): boolean {
  const parsed = DivisionCriteriaSchema.safeParse(division.criteria);
  // Criteria that cannot be read are not evidence of an adult division.
  if (!parsed.success) return true;
  const criteria: DivisionCriteria = parsed.data;
  const band = criteria.ageBand;
  if (band && (band.minAge !== null || band.maxAge !== null)) {
    if (band.minAge === null || band.minAge < PUBLIC_ADULT_AGE) return true;
  }
  const words = [division.name, criteria.level, criteria.category].filter(Boolean).join(' ');
  if (MINOR_WORDS.test(words)) return true;
  const under = UNDER_AGE.exec(words);
  return under !== null && Number(under[1]) <= PUBLIC_ADULT_AGE;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null => (value ? iso(value) : null);

/**
 * Public competition views and the staff switch behind them (SPK-SCHED-010, proposed amendment
 * PA-06; capability `public_schedule`, pending DEC-100; ADR-005). A competition is private until a
 * permitted staff member publishes it; publishing is refused, and a public competition answers
 * "not available", while any of its divisions describes players under 18. The public reads are
 * queries of their own into shapes with team names, scores, times and field names only.
 */
@Injectable()
export class PublicCompetitionService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly standings: StandingsService,
    private readonly schedules: PublicScheduleService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Public reads (no sign-in)
  // -------------------------------------------------------------------------------------------
  /**
   * What the organization has made public: enabled facility schedules and shown competitions,
   * each with its public code. Nothing private is listed.
   */
  async directory(organizationSlug: string): Promise<PublicDirectory> {
    const db = executorFor(this.db);
    const organization = await resolvePublicOrganization(db, this.capabilities, organizationSlug);
    const competitions = await db
      .selectFrom('competitions')
      .selectAll()
      .where('organization_id', '=', organization.id)
      .where('public_visibility', '=', 'public')
      .where('status', '<>', 'archived')
      .orderBy('name')
      .execute();
    const shown = [];
    for (const competition of competitions) {
      if (competition.public_code && (await this.isShown(db, competition))) {
        shown.push({
          name: competition.name,
          kind: competition.kind,
          code: competition.public_code,
        });
      }
    }
    return {
      organizationName: organization.name,
      schedules: await this.schedules.enabledViews(organization.id),
      competitions: shown,
      computedAt: this.clock.now().toISOString(),
      cacheSeconds: PUBLIC_CACHE_SECONDS,
    };
  }

  async competitionView(organizationSlug: string, code: string): Promise<PublicCompetitionView> {
    const db = executorFor(this.db);
    const organization = await resolvePublicOrganization(db, this.capabilities, organizationSlug);
    const competition = await db
      .selectFrom('competitions')
      .selectAll()
      .where('organization_id', '=', organization.id)
      .where('public_code', '=', code)
      .executeTakeFirst();
    if (!competition || !(await this.isShown(db, competition))) throw publicViewNotAvailable();
    const seasons = await db
      .selectFrom('seasons')
      .select(['name', 'starts_on', 'ends_on', 'public_code'])
      .where('organization_id', '=', organization.id)
      .where('competition_id', '=', competition.id)
      .where('status', 'in', ['open', 'active', 'completed'])
      .where('public_code', 'is not', null)
      .orderBy('starts_on', 'desc')
      .orderBy('name')
      .execute();
    return {
      organizationName: organization.name,
      name: competition.name,
      kind: competition.kind,
      sportFormat: competition.sport_format,
      seasons: seasons.map((season) => ({
        code: season.public_code as string,
        name: season.name,
        startsOn: season.starts_on,
        endsOn: season.ends_on,
      })),
      computedAt: this.clock.now().toISOString(),
      cacheSeconds: PUBLIC_CACHE_SECONDS,
    };
  }

  async seasonView(organizationSlug: string, code: string): Promise<PublicSeasonView> {
    const db = executorFor(this.db);
    const organization = await resolvePublicOrganization(db, this.capabilities, organizationSlug);
    const season = await db
      .selectFrom('seasons')
      .select(['id', 'competition_id', 'name', 'starts_on', 'ends_on', 'status'])
      .where('organization_id', '=', organization.id)
      .where('public_code', '=', code)
      .executeTakeFirst();
    if (!season || season.status === 'draft' || season.status === 'archived') {
      throw publicViewNotAvailable();
    }
    const competition = await db
      .selectFrom('competitions')
      .selectAll()
      .where('organization_id', '=', organization.id)
      .where('id', '=', season.competition_id)
      .executeTakeFirst();
    if (!competition || !(await this.isShown(db, competition))) throw publicViewNotAvailable();

    const divisions = await db
      .selectFrom('divisions')
      .select(['id', 'name'])
      .where('organization_id', '=', organization.id)
      .where('season_id', '=', season.id)
      .orderBy('name')
      .orderBy('id')
      .execute();
    const fixtures = await db
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organization.id)
      .where('season_id', '=', season.id)
      .orderBy('scheduled_start')
      .orderBy('round')
      .orderBy('id')
      .execute();
    const teamNames = await this.teamNames(
      db,
      organization.id,
      fixtures.flatMap((f) => [f.home_entry_id, f.away_entry_id]),
    );
    const scores = await this.officialScores(
      db,
      organization.id,
      fixtures.map((f) => f.id),
    );
    const publicFixture = (fixture: Selectable<FixturesTable>): PublicFixture => ({
      round: fixture.round,
      startsAt: isoOrNull(fixture.scheduled_start),
      endsAt: isoOrNull(fixture.scheduled_end),
      timezone: fixture.venue?.timezone ?? null,
      fields: (fixture.venue?.resources ?? []).map((resource) => resource.name).sort(),
      status: fixture.status,
      home: teamNames.get(fixture.home_entry_id) ?? 'Team',
      away: fixture.away_entry_id ? (teamNames.get(fixture.away_entry_id) ?? 'Team') : null,
      score: scores.get(fixture.id) ?? null,
    });
    const publicDivisions = [];
    for (const division of divisions) {
      const table = await this.standings.divisionTable(db, organization.id, season.id, division.id);
      publicDivisions.push({
        name: division.name,
        fixtures: fixtures.filter((f) => f.division_id === division.id).map(publicFixture),
        // Field by field: nothing of the staff row (entry ids, fair-play points) is carried over.
        standings: (table?.rows ?? []).map((row) => ({
          position: row.position,
          team: row.teamName,
          played: row.played,
          won: row.won,
          drawn: row.drawn,
          lost: row.lost,
          goalsFor: row.goalsFor,
          goalsAgainst: row.goalsAgainst,
          goalDifference: row.goalDifference,
          points: row.points,
        })),
      });
    }
    return {
      organizationName: organization.name,
      competitionName: competition.name,
      competitionKind: competition.kind,
      sportFormat: competition.sport_format,
      seasonName: season.name,
      startsOn: season.starts_on,
      endsOn: season.ends_on,
      divisions: publicDivisions,
      otherFixtures: fixtures.filter((f) => f.division_id === null).map(publicFixture),
      bracket:
        competition.kind === 'tournament'
          ? await this.bracket(db, organization.id, season.id, divisions, scores)
          : null,
      computedAt: this.clock.now().toISOString(),
      cacheSeconds: PUBLIC_CACHE_SECONDS,
    };
  }

  /**
   * Titles for the public facility schedule (scheduling's `PublicScheduleTitles`): a published
   * event that is a fixture reads "Home vs Away" with its official score when the fixture's
   * competition is public and shown; any other fixture is left to the schedule's own words
   * ("League game").
   */
  async fixtureTitles(
    db: Reader,
    organizationId: string,
    events: readonly PublicEventRef[],
  ): Promise<Map<string, PublicEventTitle>> {
    const out = new Map<string, PublicEventTitle>();
    const eventIds = events.map((event) => event.eventId);
    if (eventIds.length === 0) return out;
    const fixtures = await db
      .selectFrom('fixtures')
      .innerJoin('seasons', (join) =>
        join
          .onRef('seasons.organization_id', '=', 'fixtures.organization_id')
          .onRef('seasons.id', '=', 'fixtures.season_id'),
      )
      .select([
        'fixtures.id',
        'fixtures.scheduling_event_id',
        'fixtures.home_entry_id',
        'fixtures.away_entry_id',
        'seasons.competition_id',
      ])
      .where('fixtures.organization_id', '=', organizationId)
      .where('fixtures.scheduling_event_id', 'in', eventIds)
      .execute();
    if (fixtures.length === 0) return out;
    const shown = new Map<string, boolean>();
    for (const competitionId of new Set(fixtures.map((f) => f.competition_id))) {
      const competition = await db
        .selectFrom('competitions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', competitionId)
        .executeTakeFirst();
      shown.set(competitionId, competition ? await this.isShown(db, competition) : false);
    }
    const visible = fixtures.filter((f) => shown.get(f.competition_id) === true);
    const teamNames = await this.teamNames(
      db,
      organizationId,
      visible.flatMap((f) => [f.home_entry_id, f.away_entry_id]),
    );
    const scores = await this.officialScores(
      db,
      organizationId,
      visible.map((f) => f.id),
    );
    for (const fixture of visible) {
      if (!fixture.scheduling_event_id) continue;
      const home = teamNames.get(fixture.home_entry_id);
      const away = fixture.away_entry_id ? teamNames.get(fixture.away_entry_id) : null;
      if (!home || !away) continue;
      out.set(fixture.scheduling_event_id, {
        title: `${home} vs ${away}`,
        score: scores.get(fixture.id) ?? null,
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Staff: publication
  // -------------------------------------------------------------------------------------------
  async publication(principal: Principal, competitionId: string): Promise<CompetitionPublication> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.readCompetitions, {
      type: 'competition',
      id: competitionId,
      organizationId,
    });
    const db = executorFor(this.db);
    const competition = await this.load(db, organizationId, competitionId);
    return this.toPublication(db, competition);
  }

  async publish(
    principal: Principal,
    competitionId: string,
    input: ChangeCompetitionPublicationInput,
    correlationId: string | null,
  ): Promise<CompetitionPublication> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const competition = await this.load(trx, organizationId, competitionId, true);
      await this.authorization.require(principal, CompetitionActions.publishCompetition, {
        type: 'competition',
        id: competitionId,
        organizationId,
      });
      await this.capabilities.require(organizationId, 'public_schedule', trx);
      assertExpectedRevision(input.expectedRevision, competition.revision);
      if (competition.status === 'archived') {
        throw errors.invalidTransition('Competition', competition.status, 'publish');
      }
      const minors = await this.minorDivisions(trx, organizationId, competitionId);
      if (minors.length > 0) {
        throw new DomainError(
          'VALIDATION_FAILED',
          'A competition with a division for players under 18 cannot be made public.',
          { details: { code: 'COMPETITION_HAS_MINOR_DIVISION', divisions: minors } },
        );
      }
      await trx
        .updateTable('competitions')
        .set({
          public_visibility: 'public',
          public_code: competition.public_code ?? newPublicCode(),
          public_changed_at: now,
          public_changed_by: json(snapshotActor(principal)),
          revision: competition.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', competitionId)
        .where('revision', '=', competition.revision)
        .execute();
      // Every season of the competition gets its own code (seasons created later get one at
      // creation, see SeasonsService.create).
      const uncoded = await trx
        .selectFrom('seasons')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('competition_id', '=', competitionId)
        .where('public_code', 'is', null)
        .execute();
      for (const season of uncoded) {
        await trx
          .updateTable('seasons')
          .set({ public_code: newPublicCode() })
          .where('organization_id', '=', organizationId)
          .where('id', '=', season.id)
          .execute();
      }
      await this.record(trx, principal, competition, 'public', input.reason ?? null, correlationId);
      return this.toPublication(trx, await this.load(trx, organizationId, competitionId));
    });
  }

  /** Never gated by the capability: an organization can always take a competition private. */
  async unpublish(
    principal: Principal,
    competitionId: string,
    input: ChangeCompetitionPublicationInput,
    correlationId: string | null,
  ): Promise<CompetitionPublication> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const competition = await this.load(trx, organizationId, competitionId, true);
      await this.authorization.require(principal, CompetitionActions.unpublishCompetition, {
        type: 'competition',
        id: competitionId,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, competition.revision);
      if (competition.public_visibility === 'public') {
        await trx
          .updateTable('competitions')
          .set({
            public_visibility: 'private',
            public_changed_at: now,
            public_changed_by: json(snapshotActor(principal)),
            revision: competition.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', competitionId)
          .where('revision', '=', competition.revision)
          .execute();
        await this.record(
          trx,
          principal,
          competition,
          'private',
          input.reason ?? null,
          correlationId,
        );
      }
      return this.toPublication(trx, await this.load(trx, organizationId, competitionId));
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  /** Public, not archived, and no division describes players under 18 (checked on every read). */
  private async isShown(db: Reader, competition: CompetitionRow): Promise<boolean> {
    if (competition.public_visibility !== 'public' || competition.status === 'archived') {
      return false;
    }
    const minors = await this.minorDivisions(db, competition.organization_id, competition.id);
    return minors.length === 0;
  }

  private async minorDivisions(
    db: Reader,
    organizationId: string,
    competitionId: string,
  ): Promise<Array<{ seasonName: string; divisionName: string }>> {
    const divisions = await db
      .selectFrom('divisions')
      .innerJoin('seasons', (join) =>
        join
          .onRef('seasons.organization_id', '=', 'divisions.organization_id')
          .onRef('seasons.id', '=', 'divisions.season_id'),
      )
      .select(['divisions.name', 'divisions.criteria', 'seasons.name as season_name'])
      .where('divisions.organization_id', '=', organizationId)
      .where('seasons.competition_id', '=', competitionId)
      .orderBy('seasons.name')
      .orderBy('divisions.name')
      .execute();
    return divisions
      .filter((division) => describesMinors(division))
      .map((division) => ({ seasonName: division.season_name, divisionName: division.name }));
  }

  private async load(
    db: Reader,
    organizationId: string,
    competitionId: string,
    forUpdate = false,
  ): Promise<CompetitionRow> {
    let query = db
      .selectFrom('competitions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', competitionId);
    if (forUpdate) query = query.forUpdate();
    const competition = await query.executeTakeFirst();
    if (!competition) throw errors.notFound('competition', competitionId);
    return competition;
  }

  private async toPublication(
    db: Reader,
    competition: CompetitionRow,
  ): Promise<CompetitionPublication> {
    const organization = await db
      .selectFrom('organizations')
      .select('slug')
      .where('id', '=', competition.organization_id)
      .executeTakeFirstOrThrow();
    const seasons = await db
      .selectFrom('seasons')
      .select(['id', 'name', 'public_code'])
      .where('organization_id', '=', competition.organization_id)
      .where('competition_id', '=', competition.id)
      .orderBy('starts_on', 'desc')
      .orderBy('name')
      .execute();
    return {
      competitionId: competition.id,
      visibility: competition.public_visibility,
      organizationSlug: organization.slug,
      publicCode: competition.public_code,
      changedAt: isoOrNull(competition.public_changed_at),
      seasons: seasons.map((season) => ({
        seasonId: season.id,
        name: season.name,
        publicCode: season.public_code,
      })),
      minorDivisions: await this.minorDivisions(db, competition.organization_id, competition.id),
      revision: competition.revision,
    };
  }

  private async record(
    trx: Trx,
    principal: Principal,
    competition: CompetitionRow,
    visibility: 'public' | 'private',
    reason: string | null,
    correlationId: string | null,
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId: competition.organization_id,
      actor: principal,
      action:
        visibility === 'public'
          ? CompetitionActions.publishCompetition.id
          : CompetitionActions.unpublishCompetition.id,
      targetType: 'competition',
      targetId: competition.id,
      beforeRevision: competition.revision,
      afterRevision: competition.revision + 1,
      reason,
      correlationId,
      details: { visibility, previousVisibility: competition.public_visibility },
    });
    await this.outbox.enqueue(trx, CompetitionEvents.competitionPublicationChanged, {
      organizationId: competition.organization_id,
      aggregateType: 'competition',
      aggregateId: competition.id,
      payload: {
        competitionId: competition.id,
        visibility,
        revision: competition.revision + 1,
      },
      correlationId,
    });
  }

  private async teamNames(
    db: Reader,
    organizationId: string,
    entryIds: ReadonlyArray<string | null>,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(entryIds.filter((id): id is string => id !== null))];
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
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /** The official result of each fixture that has one with both scores. */
  private async officialScores(
    db: Reader,
    organizationId: string,
    fixtureIds: readonly string[],
  ): Promise<Map<string, PublicScore>> {
    if (fixtureIds.length === 0) return new Map();
    const rows = await db
      .selectFrom('result_revisions')
      .select(['fixture_id', 'home_score', 'away_score'])
      .where('organization_id', '=', organizationId)
      .where('fixture_id', 'in', [...fixtureIds])
      .where('status', '=', 'official')
      .execute();
    const out = new Map<string, PublicScore>();
    for (const row of rows) {
      if (row.home_score !== null && row.away_score !== null) {
        out.set(row.fixture_id, { home: row.home_score, away: row.away_score });
      }
    }
    return out;
  }

  /** The published bracket nodes of a tournament season, by round and slot. */
  private async bracket(
    db: Reader,
    organizationId: string,
    seasonId: string,
    divisions: ReadonlyArray<{ id: string; name: string }>,
    scores: ReadonlyMap<string, PublicScore>,
  ): Promise<PublicBracketMatch[] | null> {
    const nodes = await db
      .selectFrom('bracket_nodes')
      .select([
        'round',
        'slot',
        'division_id',
        'home_entry_id',
        'away_entry_id',
        'fixture_id',
        'winner_entry_id',
      ])
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .where('published', '=', true)
      .orderBy('round')
      .orderBy('slot')
      .execute();
    if (nodes.length === 0) return null;
    const teamNames = await this.teamNames(
      db,
      organizationId,
      nodes.flatMap((node) => [node.home_entry_id, node.away_entry_id]),
    );
    const fixtureIds = nodes.map((node) => node.fixture_id).filter((id): id is string => !!id);
    const starts =
      fixtureIds.length === 0
        ? []
        : await db
            .selectFrom('fixtures')
            .select(['id', 'scheduled_start'])
            .where('organization_id', '=', organizationId)
            .where('id', 'in', fixtureIds)
            .execute();
    const startOf = new Map(starts.map((fixture) => [fixture.id, fixture.scheduled_start]));
    const divisionName = new Map(divisions.map((division) => [division.id, division.name]));
    return nodes.map((node) => ({
      round: node.round,
      slot: node.slot,
      division: node.division_id ? (divisionName.get(node.division_id) ?? null) : null,
      home: node.home_entry_id ? (teamNames.get(node.home_entry_id) ?? null) : null,
      away: node.away_entry_id ? (teamNames.get(node.away_entry_id) ?? null) : null,
      score: node.fixture_id ? (scores.get(node.fixture_id) ?? null) : null,
      winner:
        node.winner_entry_id === null
          ? null
          : node.winner_entry_id === node.home_entry_id
            ? 'home'
            : node.winner_entry_id === node.away_entry_id
              ? 'away'
              : null,
      startsAt: node.fixture_id ? isoOrNull(startOf.get(node.fixture_id) ?? null) : null,
    }));
  }
}
