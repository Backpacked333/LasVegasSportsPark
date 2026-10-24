import { Inject, Injectable } from '@nestjs/common';
import {
  DivisionCriteriaSchema,
  errors,
  newId,
  type CreateDivisionInput,
  type CreateSeasonInput,
  type Division,
  type ListSeasonsQuery,
  type Principal,
  type Season,
  type UpdateDivisionInput,
  type UpdateSeasonInput,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  snapshotActor,
  type Trx,
} from '../../../kernel';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import {
  divisionEntryCount,
  loadRuleSetRow,
  loadSeasonRow,
  type Reader,
} from '../competition.queries';
import { organizationOf, seasonColumns, toDivision, toSeason } from '../competition.shared';
import { SeasonMachine, eventTo } from '../competition.state-machines';
import { readTarget } from './competitions.service';

/**
 * Seasons and divisions (SPK-COMP-001/003). A season adopts exactly one rule-set version of its
 * competition's format; divisions carry documented placement criteria and an optional capacity
 * that the database enforces on placement (§4.7 invariant 3).
 */
@Injectable()
export class SeasonsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async createSeason(
    principal: Principal,
    input: CreateSeasonInput,
    correlationId: string | null,
  ): Promise<Season> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.manageCompetitions, {
      type: 'season',
      organizationId,
    });
    const id = newId();
    return this.uow.run(async ({ trx }) => {
      const competition = await trx
        .selectFrom('competitions')
        .select(['id', 'sport_format', 'status'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.competitionId)
        .executeTakeFirst();
      if (!competition) throw errors.notFound('competition', input.competitionId);
      if (competition.status === 'archived') {
        throw errors.invalidTransition('Competition', 'archived', 'add_season');
      }
      await this.assertRuleSetMatches(
        trx,
        organizationId,
        input.ruleSetId,
        competition.sport_format,
      );
      try {
        await trx
          .insertInto('seasons')
          .values({
            id,
            organization_id: organizationId,
            competition_id: input.competitionId,
            name: input.name,
            rule_set_id: input.ruleSetId,
            starts_on: input.startsOn,
            ends_on: input.endsOn,
            registration_offering_ref: input.registrationOfferingRef ?? null,
            registration_opens_at: input.registrationOpensAt ?? null,
            registration_closes_at: input.registrationClosesAt ?? null,
            created_by: json(snapshotActor(principal)),
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict(
            'A season with this name already exists in the competition.',
          );
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.manageCompetitions.id,
        targetType: 'season',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: {
          operation: 'create',
          competitionId: input.competitionId,
          ruleSetId: input.ruleSetId,
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.seasonCreated, {
        organizationId,
        aggregateType: 'season',
        aggregateId: id,
        payload: { seasonId: id, competitionId: input.competitionId, ruleSetId: input.ruleSetId },
        correlationId,
      });
      const row = await loadSeasonRow(trx, organizationId, id);
      if (!row) throw errors.internal('season vanished after insert');
      return toSeason(row);
    });
  }

  async getSeason(principal: Principal, id: string): Promise<Season> {
    const organizationId = organizationOf(principal);
    const row = await loadSeasonRow(this.db, organizationId, id);
    if (!row) throw errors.notFound('season', id);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'season', id, organizationId),
    );
    return toSeason(row);
  }

  async listSeasons(principal: Principal, query: ListSeasonsQuery): Promise<Season[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'season', null, organizationId),
    );
    let q = this.db
      .selectFrom('seasons')
      .select(seasonColumns)
      .where('seasons.organization_id', '=', organizationId)
      .orderBy('seasons.starts_on', 'desc')
      .orderBy('seasons.name');
    if (query.competitionId) q = q.where('seasons.competition_id', '=', query.competitionId);
    if (query.status) q = q.where('seasons.status', '=', query.status);
    const rows = await q.execute();
    return rows.map((r) => toSeason(r as Parameters<typeof toSeason>[0]));
  }

  async updateSeason(
    principal: Principal,
    id: string,
    input: UpdateSeasonInput,
    correlationId: string | null,
  ): Promise<Season> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await loadSeasonRow(trx, organizationId, id);
      if (!current) throw errors.notFound('season', id);
      await this.authorization.require(principal, CompetitionActions.manageCompetitions, {
        type: 'season',
        id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      let status = current.status;
      if (input.status !== undefined && input.status !== current.status) {
        status = SeasonMachine.next(
          current.status,
          eventTo(SeasonMachine, current.status, input.status),
        );
      }
      if (input.ruleSetId !== undefined && input.ruleSetId !== current.rule_set_id) {
        if (current.status !== 'draft') {
          throw errors.invalidTransition('Season', current.status, 'change_rule_set');
        }
        const competition = await trx
          .selectFrom('competitions')
          .select('sport_format')
          .where('organization_id', '=', organizationId)
          .where('id', '=', current.competition_id)
          .executeTakeFirstOrThrow();
        await this.assertRuleSetMatches(
          trx,
          organizationId,
          input.ruleSetId,
          competition.sport_format,
        );
      }
      const startsOn = input.startsOn ?? current.starts_on;
      const endsOn = input.endsOn ?? current.ends_on;
      if (startsOn > endsOn) throw errors.validation('startsOn must not be after endsOn.');
      const result = await trx
        .updateTable('seasons')
        .set({
          name: input.name ?? current.name,
          rule_set_id: input.ruleSetId ?? current.rule_set_id,
          starts_on: startsOn,
          ends_on: endsOn,
          registration_offering_ref:
            input.registrationOfferingRef === undefined
              ? current.registration_offering_ref
              : input.registrationOfferingRef,
          registration_opens_at:
            input.registrationOpensAt === undefined
              ? current.registration_opens_at
              : input.registrationOpensAt,
          registration_closes_at:
            input.registrationClosesAt === undefined
              ? current.registration_closes_at
              : input.registrationClosesAt,
          status,
          revision: current.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', current.revision)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        throw errors.staleRevision(current.revision, current.revision + 1);
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.manageCompetitions.id,
        targetType: 'season',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          operation: 'update',
          fields: Object.keys(input),
          status,
          previousStatus: current.status,
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.seasonUpdated, {
        organizationId,
        aggregateType: 'season',
        aggregateId: id,
        payload: {
          seasonId: id,
          competitionId: current.competition_id,
          status,
          previousStatus: current.status,
          revision: current.revision + 1,
        },
        correlationId,
      });
      const row = await loadSeasonRow(trx, organizationId, id);
      if (!row) throw errors.internal('season vanished after update');
      return toSeason(row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Divisions (SPK-COMP-003)
  // -------------------------------------------------------------------------------------------
  async createDivision(
    principal: Principal,
    input: CreateDivisionInput,
    correlationId: string | null,
  ): Promise<Division> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.manageCompetitions, {
      type: 'division',
      organizationId,
    });
    const id = newId();
    return this.uow.run(async ({ trx }) => {
      const season = await loadSeasonRow(trx, organizationId, input.seasonId);
      if (!season) throw errors.notFound('season', input.seasonId);
      if (season.status === 'archived' || season.status === 'completed') {
        throw errors.invalidTransition('Season', season.status, 'add_division');
      }
      if (input.facilityId) await this.assertFacility(trx, organizationId, input.facilityId);
      const criteria = DivisionCriteriaSchema.parse(input.criteria ?? {});
      try {
        await trx
          .insertInto('divisions')
          .values({
            id,
            organization_id: organizationId,
            season_id: input.seasonId,
            name: input.name,
            criteria: json(criteria),
            facility_id: input.facilityId ?? null,
            capacity_team_entries: input.capacityTeamEntries ?? null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A division with this name already exists in the season.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.manageCompetitions.id,
        targetType: 'division',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: { operation: 'create', seasonId: input.seasonId, criteria },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.divisionCreated, {
        organizationId,
        aggregateType: 'division',
        aggregateId: id,
        payload: { divisionId: id, seasonId: input.seasonId },
        correlationId,
      });
      return this.divisionView(trx, organizationId, id);
    });
  }

  async getDivision(principal: Principal, id: string): Promise<Division> {
    const organizationId = organizationOf(principal);
    const row = await this.db
      .selectFrom('divisions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.notFound('division', id);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'division', id, organizationId),
    );
    return this.divisionView(this.db, organizationId, id);
  }

  async listDivisions(principal: Principal, seasonId: string): Promise<Division[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(
      principal,
      CompetitionActions.readCompetitions,
      readTarget(principal, 'division', null, organizationId),
    );
    const rows = await this.db
      .selectFrom('divisions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .orderBy('name')
      .execute();
    const out: Division[] = [];
    for (const row of rows) {
      out.push(toDivision(row, await divisionEntryCount(this.db, organizationId, row.id)));
    }
    return out;
  }

  async updateDivision(
    principal: Principal,
    id: string,
    input: UpdateDivisionInput,
    correlationId: string | null,
  ): Promise<Division> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const current = await trx
        .selectFrom('divisions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) throw errors.notFound('division', id);
      await this.authorization.require(principal, CompetitionActions.manageCompetitions, {
        type: 'division',
        id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, current.revision);
      const facilityId = input.facilityId === undefined ? current.facility_id : input.facilityId;
      if (facilityId) await this.assertFacility(trx, organizationId, facilityId);
      const capacity =
        input.capacityTeamEntries === undefined
          ? current.capacity_team_entries
          : input.capacityTeamEntries;
      if (capacity !== null) {
        const occupied = await divisionEntryCount(trx, organizationId, id);
        if (occupied > capacity) {
          throw errors.validation(
            `Capacity ${capacity} is below the ${occupied} entries already placed in this division.`,
            { occupied, capacity },
          );
        }
      }
      const criteria =
        input.criteria === undefined
          ? current.criteria
          : DivisionCriteriaSchema.parse(input.criteria);
      try {
        await trx
          .updateTable('divisions')
          .set({
            name: input.name ?? current.name,
            criteria: json(criteria),
            facility_id: facilityId,
            capacity_team_entries: capacity,
            revision: current.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', id)
          .where('revision', '=', current.revision)
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw errors.resourceConflict('A division with this name already exists in the season.');
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.manageCompetitions.id,
        targetType: 'division',
        targetId: id,
        beforeRevision: current.revision,
        afterRevision: current.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: { operation: 'update', fields: Object.keys(input) },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.divisionUpdated, {
        organizationId,
        aggregateType: 'division',
        aggregateId: id,
        payload: { divisionId: id, seasonId: current.season_id, revision: current.revision + 1 },
        correlationId,
      });
      return this.divisionView(trx, organizationId, id);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  private async divisionView(db: Reader, organizationId: string, id: string): Promise<Division> {
    const row = await db
      .selectFrom('divisions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return toDivision(row, await divisionEntryCount(db, organizationId, id));
  }

  private async assertRuleSetMatches(
    trx: Trx,
    organizationId: string,
    ruleSetId: string,
    sportFormat: string,
  ): Promise<void> {
    const ruleSet = await loadRuleSetRow(trx, organizationId, ruleSetId);
    if (!ruleSet) throw errors.notFound('rule_set', ruleSetId);
    if (ruleSet.format !== sportFormat) {
      throw errors.validation(
        `Rule set '${ruleSet.name}' is for ${ruleSet.format}; the competition plays ${sportFormat}.`,
        { ruleSetFormat: ruleSet.format, sportFormat },
      );
    }
  }

  private async assertFacility(
    db: Reader,
    organizationId: string,
    facilityId: string,
  ): Promise<void> {
    const facility = await db
      .selectFrom('facilities')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!facility) throw errors.notFound('facility', facilityId);
  }
}
