import { Inject, Injectable } from '@nestjs/common';
import { systemPrincipal } from '@sportspark/contracts';
import { CLOCK, OperationalExceptions, UnitOfWork, type Clock, type Trx } from '../../../kernel';
import {
  resolveLocal,
  type FixtureObligation,
  type FixtureObligationCheck,
  type FixtureObligationPort,
} from '../../scheduling';
import { INCOMPLETE_SEASON, unscheduledFixtureDeadline } from '../competition-matches.policy';
import { addDays } from '../matches/fixture-generator';
import { loadSeasonRow, type Reader } from '../competition.queries';

/**
 * FIXTURE_OBLIGATION_IMPL (SPK-SCHED-006 step 4, SPK-FIX-002): called by the scheduling module
 * inside its publication transaction, so reads go through the ambient transaction
 * (`UnitOfWork.reader()`). Every published game event that names a fixture must correspond to a
 * live fixture of this organization (blocking otherwise); game events without a fixture source are
 * recorded as a remaining obligation; and for every season the draft touches, the fixtures still
 * unscheduled after this publication are reported with their owner and deadline
 * (`unscheduledFixtureDeadline`, proposed default 7 days, capped at the season end).
 *
 * Follow-up (SPK-AT-010 step 5): inside the publication transaction, a season left incomplete
 * opens (or keeps) one `competition.incomplete_season` exception owned by the league manager with
 * that deadline; a later publication that leaves nothing unscheduled resolves it. Both commit or
 * roll back with the publication itself.
 */
@Injectable()
export class FixtureObligationsService implements FixtureObligationPort {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly exceptions: OperationalExceptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

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

    const trx = this.uow.current();
    const now = this.clock.now();
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
      const seasonEnd = season
        ? await this.dayAfter(db, check.organizationId, check.facilityId, season.ends_on)
        : null;
      const deadline = unscheduledFixtureDeadline(now, seasonEnd);
      if (remaining.length > 0) {
        obligations.push({
          code: 'unscheduled_fixtures',
          message: `${remaining.length} fixture(s) of the season remain unscheduled after this publication.`,
          owner: 'league_manager',
          deadline: deadline.toISOString(),
          blocking: false,
        });
      }
      if (trx) {
        await this.followUp(trx, check, seasonId, remaining.length, deadline);
      }
    }
    return obligations;
  }

  /** Opens or resolves the season's incomplete-season exception (same transaction as publication). */
  private async followUp(
    trx: Trx,
    check: FixtureObligationCheck,
    seasonId: string,
    remaining: number,
    deadline: Date,
  ): Promise<void> {
    const dedupeKey = `incomplete_season:${seasonId}`;
    if (remaining > 0) {
      await this.exceptions.raise(trx, {
        organizationId: check.organizationId,
        facilityId: check.facilityId,
        category: INCOMPLETE_SEASON.category,
        severity: INCOMPLETE_SEASON.severity,
        title: 'Season published with unscheduled fixtures',
        affectedType: 'season',
        affectedId: seasonId,
        ownerQueue: INCOMPLETE_SEASON.ownerQueue,
        deadlineAt: deadline,
        dedupeKey,
        details: { draftId: check.draftId, unscheduledFixtures: remaining },
      });
      return;
    }
    const open = await trx
      .selectFrom('operational_exceptions')
      .select('id')
      .where('organization_id', '=', check.organizationId)
      .where('dedupe_key', '=', dedupeKey)
      .where('status', 'in', ['open', 'acknowledged'])
      .executeTakeFirst();
    if (open) {
      await this.exceptions.transition(
        trx,
        systemPrincipal(check.organizationId, 'competition.fixture_obligations'),
        open.id,
        'resolved',
        {
          reason: 'Every fixture of the season is scheduled.',
          resolution: { draftId: check.draftId, unscheduledFixtures: 0 },
        },
      );
    }
  }

  /** The instant the season's last day ends at the facility (start of the following local day). */
  private async dayAfter(
    db: Reader,
    organizationId: string,
    facilityId: string,
    endsOn: string,
  ): Promise<Date | null> {
    const facility = await db
      .selectFrom('facilities')
      .select('timezone')
      .where('organization_id', '=', organizationId)
      .where('id', '=', facilityId)
      .executeTakeFirst();
    if (!facility) return null;
    return resolveLocal(addDays(endsOn, 1), '00:00', facility.timezone)?.instant ?? null;
  }
}
