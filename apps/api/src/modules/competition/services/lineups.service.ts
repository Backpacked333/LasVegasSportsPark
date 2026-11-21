import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  formationPlaces,
  newId,
  type FixtureGameLogs,
  type GameLog,
  type GameLogEvent,
  type Lineup,
  type Principal,
  type RecordGameLogInput,
  type SaveLineupInput,
  type ShareLineupInput,
  type TeamSheet,
  type TeamSheetQuery,
} from '@sportspark/contracts';
import {
  json,
  type Db,
  type FixtureGameLogsTable,
  type FixtureLineupsTable,
  type GameLogEventRow,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  assertExpectedRevision,
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  executorFor,
  snapshotActor,
  type ActionDefinition,
  type Clock,
  type Trx,
} from '../../../kernel';
import { PeopleService } from '../../identity';
import { LineupActions } from '../competition-lineups.actions';
import { LineupEvents } from '../competition-lineups.events';
import { teamNamesOf, type Reader } from '../competition.queries';
import { iso, organizationOf, PLAYING_STATUSES } from '../competition.shared';
import { FixtureAttendanceService } from './fixture-attendance.service';
import { FixturesService } from './fixtures.service';
import { RosterService } from './roster.service';

type LineupRow = Selectable<FixtureLineupsTable>;
type GameLogRow = Selectable<FixtureGameLogsTable>;
type FixtureRow = NonNullable<Awaited<ReturnType<FixturesService['loadFixture']>>>;

/** Fixture states a lineup may still change in: before the game is recorded. */
const LINEUP_STATES: readonly string[] = ['scheduled', 'unscheduled', 'postponed'];
/** Fixture states a game log may be recorded in: the game was or is being played. */
const GAME_LOG_STATES: readonly string[] = ['scheduled', 'played'];

/**
 * The coach's team sheet (migration 0475; SPK-CAP-001 captain tools, SPK-CAP-003 availability,
 * SPK-UX-007 field-side work, SPK-RESULT-001; staff redesign Phase 8 "Coach · Lineup" and
 * "Coach · Live game day").
 *
 * - A side's captain (the team's coach) or league staff read the side's players at kickoff with
 *   their own availability answer (SPK-CAP-003, names and numbers only, §4.14) and their minutes
 *   in the side's earlier game logs this season, the lineup and the game log.
 * - The lineup (formation, who starts where) is saved with a revision (§4.9) while the fixture is
 *   not yet played; sharing records when and by whom and announces `competition.lineup_shared`
 *   (communications delivers it once it subscribes; nothing is sent before).
 * - The game log (the side's score, the timeline and each player's minutes) is recorded once and
 *   corrected with a revision; it never becomes the result (SPK-RESULT-001/002: the official's
 *   report, published by the league). An accepted official reads both sides' game log scores for
 *   the match check (ASSIGNMENT_CHECK_PORT through FixtureAttendanceService.sidesFor).
 * Anyone else gets protected NOT_FOUND (§4.10).
 */
@Injectable()
export class LineupsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly fixtures: FixturesService,
    private readonly roster: RosterService,
    private readonly people: PeopleService,
    private readonly sides: FixtureAttendanceService,
  ) {}

  /** `GET /v1/fixtures/{id}/lineup?teamEntryId=`. */
  async teamSheet(
    principal: Principal,
    fixtureId: string,
    query: TeamSheetQuery,
  ): Promise<TeamSheet> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const fixture = await this.fixtures.loadFixture(db, organizationId, fixtureId);
    if (!fixture) throw errors.protectedNotFound('fixture');
    const visible = await this.sides.sidesFor(db, principal, fixture, LineupActions.readTeamSheet);
    const teamEntryId = query.teamEntryId ?? (visible.length === 1 ? visible[0] : undefined);
    if (!teamEntryId || !visible.includes(teamEntryId)) throw errors.protectedNotFound('fixture');

    const names = await teamNamesOf(db, organizationId, [
      fixture.home_entry_id,
      fixture.away_entry_id,
    ]);
    const side = teamEntryId === fixture.home_entry_id ? 'home' : 'away';
    const opponentId = side === 'home' ? fixture.away_entry_id : fixture.home_entry_id;
    const members = await this.playersAtKickoff(organizationId, fixture, teamEntryId);
    const answers = await db
      .selectFrom('availability_responses')
      .select(['person_id', 'state'])
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixture.id)
      .where('team_entry_id', '=', teamEntryId)
      .execute();
    const season = await db
      .selectFrom('fixture_player_minutes as m')
      .innerJoin('fixture_game_logs as g', (j) =>
        j.onRef('g.organization_id', '=', 'm.organization_id').onRef('g.id', '=', 'm.game_log_id'),
      )
      .select(['m.person_id', 'm.minutes'])
      .where('m.organization_id', '=', organizationId)
      .where('m.team_entry_id', '=', teamEntryId)
      .where('g.fixture_id', '<>', fixture.id)
      .execute();
    const minutesOf = (personId: string) =>
      season.filter((r) => r.person_id === personId).reduce((sum, r) => sum + r.minutes, 0);
    const gamesOf = (personId: string) =>
      season.filter((r) => r.person_id === personId && r.minutes > 0).length;
    const players: TeamSheet['players'] = [];
    for (const member of members) {
      const person = await this.people.loadPerson(db, organizationId, member.personId);
      players.push({
        personId: member.personId,
        displayName: person ? `${person.given_name} ${person.family_name}`.trim() : 'Player',
        jerseyNumber: member.jerseyNumber,
        availability: answers.find((a) => a.person_id === member.personId)?.state ?? 'no_response',
        minutesThisSeason: minutesOf(member.personId),
        gamesThisSeason: gamesOf(member.personId),
      });
    }
    const total = players.reduce((sum, p) => sum + p.minutesThisSeason, 0);
    const lineup = await this.loadLineup(db, organizationId, fixture.id, teamEntryId);
    const log = await this.loadGameLog(db, organizationId, fixture.id, teamEntryId);
    const official = await db
      .selectFrom('result_revisions')
      .select(['home_score', 'away_score'])
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixture.id)
      .where('status', '=', 'official')
      .executeTakeFirst();
    const venue = await this.fixtures.venueOf(db, fixture);
    const actions: TeamSheet['availableActions'] = [];
    const manage = await this.sides.sidesFor(db, principal, fixture, LineupActions.manageLineup);
    if (manage.includes(teamEntryId) && LINEUP_STATES.includes(fixture.status)) {
      actions.push('save_lineup');
      if (lineup) actions.push('share_lineup');
    }
    const record = await this.sides.sidesFor(db, principal, fixture, LineupActions.recordGameLog);
    if (record.includes(teamEntryId) && GAME_LOG_STATES.includes(fixture.status)) {
      actions.push('record_game_log');
    }
    return {
      fixtureId: fixture.id,
      teamEntryId,
      side,
      teamName: names.get(teamEntryId) ?? 'Team',
      opponentName: opponentId ? (names.get(opponentId) ?? null) : null,
      scheduledStart: fixture.scheduled_start ? iso(fixture.scheduled_start) : null,
      scheduledEnd: fixture.scheduled_end ? iso(fixture.scheduled_end) : null,
      fixtureStatus: fixture.status,
      timezone: venue?.timezone ?? null,
      venueName: venue ? venue.resources.map((r) => r.name).join(', ') || venue.facilityName : null,
      players,
      teamAverageMinutes: players.length > 0 ? Math.round((total / players.length) * 10) / 10 : 0,
      lineup: lineup ? await this.lineupView(db, lineup) : null,
      gameLog: log ? await this.gameLogView(db, log) : null,
      officialResult: official
        ? {
            homeScore: official.home_score,
            awayScore: official.away_score,
            matchesGameLog: log
              ? log.home_score === official.home_score && log.away_score === official.away_score
              : null,
          }
        : null,
      availableActions: actions,
    };
  }

  /** `POST /v1/fixtures/{id}/lineup`. */
  async saveLineup(
    principal: Principal,
    fixtureId: string,
    input: SaveLineupInput,
    correlationId: string | null,
  ): Promise<Lineup> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const fixture = await this.lockSide(
        trx,
        principal,
        fixtureId,
        input.teamEntryId,
        LineupActions.manageLineup,
      );
      if (!LINEUP_STATES.includes(fixture.status)) {
        throw errors.invalidTransition('Fixture', fixture.status, 'save_lineup');
      }
      const places = formationPlaces(input.formation);
      if (places > 11) {
        throw errors.validation('A formation holds at most eleven players.', {
          code: 'FORMATION_TOO_LARGE',
          formation: input.formation,
        });
      }
      const slots = new Set<number>();
      const persons = new Set<string>();
      for (const s of input.slots) {
        if (s.slot > places) {
          throw errors.validation(`This formation has ${places} places.`, {
            code: 'SLOT_OUTSIDE_FORMATION',
            slot: s.slot,
            places,
          });
        }
        if (slots.has(s.slot) || persons.has(s.personId)) {
          throw errors.validation('A place holds one player and a player one place.', {
            code: 'DUPLICATE_PLACE',
            slot: s.slot,
            personId: s.personId,
          });
        }
        slots.add(s.slot);
        persons.add(s.personId);
      }
      await this.assertOnRoster(trx, organizationId, fixture, input.teamEntryId, [...persons]);
      const current = await this.loadLineup(trx, organizationId, fixture.id, input.teamEntryId, {
        forUpdate: true,
      });
      const actor = json(snapshotActor(principal));
      let lineupId: string;
      if (!current) {
        lineupId = newId();
        await trx
          .insertInto('fixture_lineups')
          .values({
            id: lineupId,
            organization_id: organizationId,
            fixture_id: fixture.id,
            team_entry_id: input.teamEntryId,
            formation: input.formation,
            updated_by: actor,
          })
          .execute();
      } else {
        if (input.expectedRevision === undefined) {
          throw errors.validation('expectedRevision is required to change a saved lineup.', {
            code: 'expected_revision_required',
            lineupId: current.id,
            revision: current.revision,
          });
        }
        assertExpectedRevision(input.expectedRevision, current.revision);
        lineupId = current.id;
        await trx
          .updateTable('fixture_lineups')
          .set({ formation: input.formation, updated_by: actor, revision: current.revision + 1 })
          .where('organization_id', '=', organizationId)
          .where('id', '=', current.id)
          .where('revision', '=', current.revision)
          .execute();
        await trx
          .deleteFrom('fixture_lineup_slots')
          .where('organization_id', '=', organizationId)
          .where('lineup_id', '=', current.id)
          .execute();
      }
      if (input.slots.length > 0) {
        await trx
          .insertInto('fixture_lineup_slots')
          .values(
            input.slots.map((s) => ({
              organization_id: organizationId,
              lineup_id: lineupId,
              slot: s.slot,
              person_id: s.personId,
            })),
          )
          .execute();
      }
      const row = (await this.loadLineup(trx, organizationId, fixture.id, input.teamEntryId))!;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: LineupActions.manageLineup.id,
        targetType: 'fixture_lineup',
        targetId: row.id,
        beforeRevision: current?.revision ?? null,
        afterRevision: row.revision,
        reason: input.reason ?? null,
        correlationId,
        details: {
          fixtureId: fixture.id,
          teamEntryId: input.teamEntryId,
          formation: input.formation,
          starters: input.slots.length,
        },
      });
      return this.lineupView(trx, row);
    });
  }

  /** `POST /v1/fixtures/{id}/lineup/share`. */
  async shareLineup(
    principal: Principal,
    fixtureId: string,
    input: ShareLineupInput,
    correlationId: string | null,
  ): Promise<Lineup> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const fixture = await this.lockSide(
        trx,
        principal,
        fixtureId,
        input.teamEntryId,
        LineupActions.manageLineup,
      );
      if (!LINEUP_STATES.includes(fixture.status)) {
        throw errors.invalidTransition('Fixture', fixture.status, 'share_lineup');
      }
      const current = await this.loadLineup(trx, organizationId, fixture.id, input.teamEntryId, {
        forUpdate: true,
      });
      if (!current) throw errors.invalidTransition('Lineup', 'none', 'share');
      assertExpectedRevision(input.expectedRevision, current.revision);
      const slots = await this.slotsOf(trx, organizationId, current.id);
      if (slots.length === 0) throw errors.invalidTransition('Lineup', 'empty', 'share');
      await trx
        .updateTable('fixture_lineups')
        .set({
          shared_at: this.clock.now(),
          shared_by: json(snapshotActor(principal)),
          shared_revision: current.revision + 1,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', current.id)
        .where('revision', '=', current.revision)
        .execute();
      const row = (await this.loadLineup(trx, organizationId, fixture.id, input.teamEntryId))!;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'competition.lineup_shared',
        targetType: 'fixture_lineup',
        targetId: row.id,
        beforeRevision: current.revision,
        afterRevision: row.revision,
        reason: input.reason ?? null,
        correlationId,
        details: { fixtureId: fixture.id, teamEntryId: input.teamEntryId },
      });
      await this.outbox.enqueue(trx, LineupEvents.lineupShared, {
        organizationId,
        aggregateType: 'fixture',
        aggregateId: fixture.id,
        payload: {
          lineupId: row.id,
          fixtureId: fixture.id,
          teamEntryId: input.teamEntryId,
          formation: row.formation,
          starterPersonIds: slots.map((s) => s.person_id),
          revision: row.revision,
        },
        correlationId,
      });
      return this.lineupView(trx, row);
    });
  }

  /** `POST /v1/fixtures/{id}/game-log`. */
  async recordGameLog(
    principal: Principal,
    fixtureId: string,
    input: RecordGameLogInput,
    correlationId: string | null,
  ): Promise<GameLog> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const fixture = await this.lockSide(
        trx,
        principal,
        fixtureId,
        input.teamEntryId,
        LineupActions.recordGameLog,
      );
      if (!GAME_LOG_STATES.includes(fixture.status)) {
        throw errors.invalidTransition('Fixture', fixture.status, 'record_game_log');
      }
      if (fixture.scheduled_start && new Date(fixture.scheduled_start) > this.clock.now()) {
        throw errors.validation('A game log is recorded once the game has started.', {
          code: 'GAME_NOT_STARTED',
          scheduledStart: iso(fixture.scheduled_start),
        });
      }
      const people = new Set<string>();
      for (const e of input.events) {
        if (e.kind === 'goal') {
          if (e.personId) people.add(e.personId);
          if (e.assistPersonId) people.add(e.assistPersonId);
        }
        if (e.kind === 'substitution') {
          people.add(e.offPersonId);
          people.add(e.onPersonId);
        }
      }
      const minutePeople = input.minutes.map((m) => m.personId);
      if (new Set(minutePeople).size !== minutePeople.length) {
        throw errors.validation('Each player has one minutes entry.', {
          code: 'DUPLICATE_MINUTES',
        });
      }
      for (const p of minutePeople) people.add(p);
      await this.assertOnRoster(trx, organizationId, fixture, input.teamEntryId, [...people]);
      const current = await this.loadGameLog(trx, organizationId, fixture.id, input.teamEntryId, {
        forUpdate: true,
      });
      const now = this.clock.now();
      const values = {
        home_score: input.homeScore,
        away_score: input.awayScore,
        events: json(input.events as GameLogEventRow[]),
        recorded_by: json(snapshotActor(principal)),
        recorded_by_person_id: principal.personId,
        recorded_at: now,
      };
      let logId: string;
      if (!current) {
        logId = newId();
        await trx
          .insertInto('fixture_game_logs')
          .values({
            id: logId,
            organization_id: organizationId,
            fixture_id: fixture.id,
            team_entry_id: input.teamEntryId,
            ...values,
          })
          .execute();
      } else {
        if (input.expectedRevision === undefined) {
          throw errors.validation('expectedRevision is required to correct a game log.', {
            code: 'expected_revision_required',
            gameLogId: current.id,
            revision: current.revision,
          });
        }
        assertExpectedRevision(input.expectedRevision, current.revision);
        logId = current.id;
        await trx
          .updateTable('fixture_game_logs')
          .set({ ...values, revision: current.revision + 1 })
          .where('organization_id', '=', organizationId)
          .where('id', '=', current.id)
          .where('revision', '=', current.revision)
          .execute();
        await trx
          .deleteFrom('fixture_player_minutes')
          .where('organization_id', '=', organizationId)
          .where('game_log_id', '=', current.id)
          .execute();
      }
      if (input.minutes.length > 0) {
        await trx
          .insertInto('fixture_player_minutes')
          .values(
            input.minutes.map((m) => ({
              organization_id: organizationId,
              game_log_id: logId,
              team_entry_id: input.teamEntryId,
              person_id: m.personId,
              minutes: m.minutes,
            })),
          )
          .execute();
      }
      const row = (await this.loadGameLog(trx, organizationId, fixture.id, input.teamEntryId))!;
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: LineupActions.recordGameLog.id,
        targetType: 'fixture_game_log',
        targetId: row.id,
        beforeRevision: current?.revision ?? null,
        afterRevision: row.revision,
        reason: input.reason ?? null,
        correlationId,
        details: {
          fixtureId: fixture.id,
          teamEntryId: input.teamEntryId,
          homeScore: input.homeScore,
          awayScore: input.awayScore,
          events: input.events.length,
          isCorrection: current !== undefined,
        },
      });
      await this.outbox.enqueue(trx, LineupEvents.gameLogRecorded, {
        organizationId,
        aggregateType: 'fixture',
        aggregateId: fixture.id,
        payload: {
          gameLogId: row.id,
          fixtureId: fixture.id,
          teamEntryId: input.teamEntryId,
          homeScore: row.home_score,
          awayScore: row.away_score,
          revision: row.revision,
        },
        correlationId,
      });
      return this.gameLogView(trx, row);
    });
  }

  /** `GET /v1/fixtures/{id}/game-logs`: the sides the viewer may see, for the match check. */
  async gameLogs(principal: Principal, fixtureId: string): Promise<FixtureGameLogs> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const fixture = await this.fixtures.loadFixture(db, organizationId, fixtureId);
    if (!fixture) throw errors.protectedNotFound('fixture');
    const visible = await this.sides.sidesFor(db, principal, fixture, LineupActions.readGameLogs);
    if (visible.length === 0) throw errors.protectedNotFound('fixture');
    const rows = await db
      .selectFrom('fixture_game_logs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixture.id)
      .where('team_entry_id', 'in', visible)
      .orderBy('recorded_at')
      .execute();
    const names = await teamNamesOf(db, organizationId, visible);
    return {
      fixtureId: fixture.id,
      logs: rows.map((r) => ({
        teamEntryId: r.team_entry_id,
        teamName: names.get(r.team_entry_id) ?? 'Team',
        homeScore: r.home_score,
        awayScore: r.away_score,
        recordedAt: iso(r.recorded_at),
      })),
    };
  }

  /** Locks the fixture (serializing the side's commands) and checks the viewer acts for the side. */
  private async lockSide(
    trx: Trx,
    principal: Principal,
    fixtureId: string,
    teamEntryId: string,
    action: ActionDefinition,
  ): Promise<FixtureRow> {
    const organizationId = organizationOf(principal);
    const fixture = await this.fixtures.loadFixture(trx, organizationId, fixtureId, {
      forUpdate: true,
    });
    if (!fixture) throw errors.protectedNotFound('fixture');
    if (teamEntryId !== fixture.home_entry_id && teamEntryId !== fixture.away_entry_id) {
      throw errors.protectedNotFound('fixture');
    }
    const allowed = await this.sides.sidesFor(trx, principal, fixture, action);
    if (!allowed.includes(teamEntryId)) throw errors.protectedNotFound('fixture');
    return fixture;
  }

  private async playersAtKickoff(
    organizationId: string,
    fixture: FixtureRow,
    teamEntryId: string,
    trx?: Trx,
  ) {
    const at = fixture.scheduled_start ? new Date(fixture.scheduled_start) : this.clock.now();
    const members = await this.roster.effectiveRoster(organizationId, teamEntryId, at, trx);
    return members.filter((m) => PLAYING_STATUSES.includes(m.status));
  }

  private async assertOnRoster(
    trx: Trx,
    organizationId: string,
    fixture: FixtureRow,
    teamEntryId: string,
    personIds: readonly string[],
  ): Promise<void> {
    if (personIds.length === 0) return;
    const members = await this.playersAtKickoff(organizationId, fixture, teamEntryId, trx);
    const missing = personIds.filter((p) => !members.some((m) => m.personId === p));
    if (missing.length > 0) {
      throw errors.validation('A player named is not on this side’s roster at kickoff.', {
        code: 'NOT_ON_ROSTER',
        personIds: missing,
        teamEntryId,
      });
    }
  }

  private async loadLineup(
    db: Reader,
    organizationId: string,
    fixtureId: string,
    teamEntryId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<LineupRow | undefined> {
    let q = db
      .selectFrom('fixture_lineups')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .where('team_entry_id', '=', teamEntryId);
    if (options.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async slotsOf(db: Reader, organizationId: string, lineupId: string) {
    return db
      .selectFrom('fixture_lineup_slots')
      .select(['slot', 'person_id'])
      .where('organization_id', '=', organizationId)
      .where('lineup_id', '=', lineupId)
      .orderBy('slot')
      .execute();
  }

  private async lineupView(db: Reader, row: LineupRow): Promise<Lineup> {
    const slots = await this.slotsOf(db, row.organization_id, row.id);
    return {
      id: row.id,
      formation: row.formation,
      slots: slots.map((s) => ({ slot: s.slot, personId: s.person_id })),
      sharedAt: row.shared_at ? iso(row.shared_at) : null,
      // Sharing records the revision it shared; any later save moves the revision past it.
      changedSinceShared: row.shared_revision !== null && row.revision > row.shared_revision,
      revision: row.revision,
      updatedAt: iso(row.updated_at),
    };
  }

  private async loadGameLog(
    db: Reader,
    organizationId: string,
    fixtureId: string,
    teamEntryId: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<GameLogRow | undefined> {
    let q = db
      .selectFrom('fixture_game_logs')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('fixture_id', '=', fixtureId)
      .where('team_entry_id', '=', teamEntryId);
    if (options.forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async gameLogView(db: Reader, row: GameLogRow): Promise<GameLog> {
    const minutes = await db
      .selectFrom('fixture_player_minutes')
      .select(['person_id', 'minutes'])
      .where('organization_id', '=', row.organization_id)
      .where('game_log_id', '=', row.id)
      .orderBy('person_id')
      .execute();
    return {
      id: row.id,
      teamEntryId: row.team_entry_id,
      homeScore: row.home_score,
      awayScore: row.away_score,
      events: row.events as unknown as GameLogEvent[],
      minutes: minutes.map((m) => ({ personId: m.person_id, minutes: m.minutes })),
      recordedAt: iso(row.recorded_at),
      revision: row.revision,
    };
  }
}
