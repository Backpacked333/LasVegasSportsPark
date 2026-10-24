import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../../kernel';
import type {
  FixtureObligation,
  FixtureObligationCheck,
  FixtureObligationPort,
} from '../../scheduling';
import { loadSeasonRow } from '../competition.queries';

/**
 * FIXTURE_OBLIGATION_IMPL (SPK-SCHED-006 step 4, SPK-FIX-002): called by the scheduling module
 * inside its publication transaction, so reads go through the ambient transaction
 * (`UnitOfWork.reader()`). Every published game event that names a fixture must correspond to a
 * live fixture of this organization (blocking otherwise); game events without a fixture source are
 * recorded as a remaining obligation; and for every season the draft touches, the fixtures still
 * unscheduled after this publication are reported with their owner and deadline.
 */
@Injectable()
export class FixtureObligationsService implements FixtureObligationPort {
  constructor(private readonly uow: UnitOfWork) {}

  async verify(check: FixtureObligationCheck): Promise<FixtureObligation[]> {
    const db = this.uow.reader();
    const obligations: FixtureObligation[] = [];
    const draftFixtureIds = new Set<string>();
    const seasonIds = new Set<string>();
    for (const change of check.changes) {
      const proposed = change.proposed;
      const namesFixture = proposed.sourceType === 'fixture';
      if (namesFixture) {
        if (!proposed.sourceId) {
          obligations.push({
            code: 'fixture_source_missing',
            message: `Change ${change.sequence} names a fixture source without a fixture id.`,
            owner: 'league_manager',
            deadline: null,
            blocking: true,
          });
          continue;
        }
        const fixture = await db
          .selectFrom('fixtures')
          .select(['id', 'season_id', 'status', 'scheduling_event_id', 'away_entry_id'])
          .where('organization_id', '=', check.organizationId)
          .where('id', '=', proposed.sourceId)
          .executeTakeFirst();
        if (!fixture) {
          obligations.push({
            code: 'unknown_fixture',
            message: `Change ${change.sequence} names fixture ${proposed.sourceId}, which does not exist in this organization.`,
            owner: 'league_manager',
            deadline: null,
            blocking: true,
          });
          continue;
        }
        draftFixtureIds.add(fixture.id);
        seasonIds.add(fixture.season_id);
        if (fixture.away_entry_id === null) {
          obligations.push({
            code: 'bye_has_no_game',
            message: `Change ${change.sequence} schedules a game for fixture ${fixture.id}, which is a bye.`,
            owner: 'league_manager',
            deadline: null,
            blocking: true,
          });
        }
        if (
          fixture.status === 'canceled' ||
          fixture.status === 'played' ||
          fixture.status === 'forfeit'
        ) {
          obligations.push({
            code: 'fixture_closed',
            message: `Change ${change.sequence} schedules fixture ${fixture.id}, which is ${fixture.status}.`,
            owner: 'league_manager',
            deadline: null,
            blocking: true,
          });
        }
        if (
          change.kind === 'create' &&
          fixture.status === 'scheduled' &&
          fixture.scheduling_event_id !== null &&
          fixture.scheduling_event_id !== change.targetEventId
        ) {
          obligations.push({
            code: 'fixture_already_scheduled',
            message: `Change ${change.sequence} would give fixture ${fixture.id} a second published game.`,
            owner: 'league_manager',
            deadline: null,
            blocking: true,
          });
        }
      } else if (proposed.kind === 'game' && change.kind === 'create') {
        obligations.push({
          code: 'game_without_fixture',
          message: `Change ${change.sequence} publishes a game that corresponds to no fixture.`,
          owner: 'scheduler',
          deadline: null,
          blocking: false,
        });
      }
    }

    for (const seasonId of seasonIds) {
      const season = await loadSeasonRow(db, check.organizationId, seasonId);
      let q = db
        .selectFrom('fixtures')
        .select('id')
        .where('organization_id', '=', check.organizationId)
        .where('season_id', '=', seasonId)
        .where('status', 'in', ['unscheduled', 'postponed'])
        .where('away_entry_id', 'is not', null);
      if (draftFixtureIds.size > 0) q = q.where('id', 'not in', [...draftFixtureIds]);
      const remaining = await q.execute();
      if (remaining.length > 0) {
        obligations.push({
          code: 'unscheduled_fixtures',
          message: `${remaining.length} fixture(s) of the season remain unscheduled after this publication.`,
          owner: 'league_manager',
          deadline: season ? `${season.starts_on}T00:00:00.000Z` : null,
          blocking: false,
        });
      }
    }
    return obligations;
  }
}
