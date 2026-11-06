import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ActorSnapshot,
  type ListPlayerProfilesQuery,
  type PlayerProfile,
  type Principal,
  type RecordPlayerProfileInput,
  type SeasonPlayerProfiles,
  type TeamBalance,
} from '@sportspark/contracts';
import { json, type Db, type SeasonPlayerProfilesTable } from '@sportspark/db';
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
  type Clock,
} from '../../../kernel';
import { PeopleService } from '../../identity';
import { FieldActions } from '../competition-field.actions';
import { FieldEvents } from '../competition-field.events';
import { SKILL_RATING_SCALE } from '../competition.policy';
import {
  loadSeasonRow,
  rosterRowsEffectiveAt,
  statusAt,
  type Reader,
} from '../competition.queries';
import { iso, organizationOf, PLAYING_STATUSES } from '../competition.shared';

function toPlayerProfile(row: Selectable<SeasonPlayerProfilesTable>): PlayerProfile {
  return {
    id: row.id,
    seasonId: row.season_id,
    personId: row.person_id,
    position: row.position,
    skillRating: row.skill_rating,
    note: row.note,
    recordedBy: row.recorded_by as unknown as ActorSnapshot,
    recordedAt: iso(row.recorded_at),
    revision: row.revision,
  };
}

/**
 * Staff player profiles for placement (SPK-PLACE-002 "staff receive eligible candidate teams with
 * explainable reasons", SPK-PLACE-005 operator-mediated placement, no public profiles; migration
 * 0464). A profile is a staff record per season and person: the position staff recorded
 * (goalkeeper or an outfield line) and a skill rating on the placeholder scale
 * `SKILL_RATING_SCALE`. The read gives each team of the season its playing roster now, its
 * goalkeepers and its skill average, so the placement board checks "at least one keeper" and skill
 * balance from records instead of guessing. Staff-only: no customer basis reads or writes it.
 * What a registrant declared (level, position preferences, requested teammates) stays on
 * enrollment's placement request (DEC-051 pending).
 */
@Injectable()
export class PlayerProfilesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly people: PeopleService,
  ) {}

  /** `GET /v1/seasons/{id}/player-profiles`. */
  async list(
    principal: Principal,
    seasonId: string,
    query: ListPlayerProfilesQuery,
  ): Promise<SeasonPlayerProfiles> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const season = await loadSeasonRow(db, organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    await this.authorization.require(principal, FieldActions.readPlayerProfiles, {
      type: 'season',
      id: seasonId,
      organizationId,
    });
    let q = db
      .selectFrom('season_player_profiles')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId);
    if (query.personIds) q = q.where('person_id', 'in', query.personIds);
    const rows = await q.orderBy('person_id').execute();
    const now = this.clock.now();
    return {
      seasonId,
      evaluatedAt: iso(now),
      skillScale: { min: SKILL_RATING_SCALE.min, max: SKILL_RATING_SCALE.max },
      profiles: rows.map(toPlayerProfile),
      teams: await this.balanceOf(db, organizationId, seasonId, now),
    };
  }

  /** `POST /v1/seasons/{id}/player-profiles`: record or change one person's profile. */
  async record(
    principal: Principal,
    seasonId: string,
    input: RecordPlayerProfileInput,
    correlationId: string | null,
  ): Promise<PlayerProfile> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const season = await loadSeasonRow(trx, organizationId, seasonId);
      if (!season) throw errors.notFound('season', seasonId);
      await this.authorization.require(principal, FieldActions.recordPlayerProfile, {
        type: 'season',
        id: seasonId,
        organizationId,
        subjectPersonIds: [input.personId],
      });
      const person = await this.people.loadPerson(trx, organizationId, input.personId);
      if (!person) throw errors.notFound('person', input.personId);
      const existing = await trx
        .selectFrom('season_player_profiles')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('season_id', '=', seasonId)
        .where('person_id', '=', input.personId)
        .forUpdate()
        .executeTakeFirst();
      const now = this.clock.now();
      const facts = {
        position: input.position,
        skill_rating: input.skillRating,
        note: input.note ?? null,
        recorded_by: json(snapshotActor(principal)),
        recorded_by_person_id: principal.personId,
        recorded_at: now,
      };
      let row: Selectable<SeasonPlayerProfilesTable>;
      if (existing) {
        // §4.9: a change names the revision it was made from; a caller who believed there was no
        // profile yet (no expectedRevision) is stale too (0 = "none").
        if (input.expectedRevision === undefined) throw errors.staleRevision(0, existing.revision);
        assertExpectedRevision(input.expectedRevision, existing.revision);
        const updated = await trx
          .updateTable('season_player_profiles')
          .set({ ...facts, revision: existing.revision + 1 })
          .where('organization_id', '=', organizationId)
          .where('id', '=', existing.id)
          .where('revision', '=', existing.revision)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw errors.staleRevision(input.expectedRevision, existing.revision + 1);
        row = updated;
      } else {
        if (input.expectedRevision !== undefined) {
          throw errors.staleRevision(input.expectedRevision, 0);
        }
        row = await trx
          .insertInto('season_player_profiles')
          .values({
            id: newId(),
            organization_id: organizationId,
            season_id: seasonId,
            person_id: input.personId,
            ...facts,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FieldActions.recordPlayerProfile.id,
        targetType: 'season_player_profile',
        targetId: row.id,
        beforeRevision: existing?.revision ?? null,
        afterRevision: row.revision,
        reason: input.reason ?? null,
        correlationId,
        details: {
          seasonId,
          personId: input.personId,
          before: existing
            ? { position: existing.position, skillRating: existing.skill_rating }
            : null,
          after: { position: row.position, skillRating: row.skill_rating },
        },
      });
      await this.outbox.enqueue(trx, FieldEvents.playerProfileRecorded, {
        organizationId,
        aggregateType: 'season_player_profile',
        aggregateId: row.id,
        payload: {
          profileId: row.id,
          seasonId,
          personId: input.personId,
          position: row.position,
          revision: row.revision,
        },
        correlationId,
      });
      return toPlayerProfile(row);
    });
  }

  /** Each live entry of the season: playing roster now, goalkeepers, rated players, average. */
  private async balanceOf(
    db: Reader,
    organizationId: string,
    seasonId: string,
    at: Date,
  ): Promise<TeamBalance[]> {
    const entries = await db
      .selectFrom('team_entries')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .where('status', 'in', ['applied', 'approved'])
      .orderBy('id')
      .execute();
    const playersOf = new Map<string, string[]>();
    for (const entry of entries) {
      const rows = await rosterRowsEffectiveAt(db, organizationId, entry.id, at);
      const players = new Set<string>();
      for (const row of rows) {
        const status = statusAt(row);
        if (status && PLAYING_STATUSES.includes(status)) players.add(row.person_id);
      }
      playersOf.set(entry.id, [...players]);
    }
    const everyone = [...new Set([...playersOf.values()].flat())];
    const profiles =
      everyone.length === 0
        ? []
        : await db
            .selectFrom('season_player_profiles')
            .select(['person_id', 'position', 'skill_rating'])
            .where('organization_id', '=', organizationId)
            .where('season_id', '=', seasonId)
            .where('person_id', 'in', everyone)
            .execute();
    const byPerson = new Map(profiles.map((p) => [p.person_id, p]));
    return entries.map((entry) => {
      const players = playersOf.get(entry.id) ?? [];
      const ratings = players
        .map((p) => byPerson.get(p)?.skill_rating)
        .filter((r): r is number => typeof r === 'number');
      return {
        teamEntryId: entry.id,
        players: players.length,
        goalkeepers: players.filter((p) => byPerson.get(p)?.position === 'goalkeeper').length,
        rated: ratings.length,
        averageSkill:
          ratings.length === 0
            ? null
            : Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10,
      };
    });
  }
}
