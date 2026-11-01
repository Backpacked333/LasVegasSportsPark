import { Inject, Injectable } from '@nestjs/common';
import { systemPrincipal } from '@sportspark/contracts';
import type { FixtureStatus } from '@sportspark/db';
import {
  CLOCK,
  FacilityDirectory,
  OperationalExceptions,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
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
    private readonly facilities: FacilityDirectory,
  ) {}

  async verify(check: FixtureObligationCheck): Promise<FixtureObligation[]> {
    const db = this.uow.reader();
    const obligations: FixtureObligation[] = [];
    const draftFixtureIds = new Set<string>();
    const seasonIds = new Set<string>();
    /** Fixtures whose published game this publication cancels, by season (R3-TRACE-A-04). */
    const unplaced = new Map<string, string>();
    /** Events this publication cancels: a fixture linked to one of them loses that game. */
    const canceledEventIds = new Set(
      check.changes.flatMap((c) =>
        c.kind === 'cancel' && c.targetEventId ? [c.targetEventId] : [],
      ),
    );
    /** Fixtures a create of this draft gives a game, with the change that does it. */
    const createdFor = new Map<string, number>();
    for (const change of check.changes) {
      const proposed = change.proposed;
      // R3-TRACE-A-04 (SPK-FIX-002): a change to a fixture's published game is about that fixture
      // whatever its payload names; a cancel carries no proposed fields at all.
      const linked = change.targetEventId
        ? await this.linkedFixture(db, check.organizationId, change.targetEventId)
        : null;
      if (linked) {
        if (change.kind === 'cancel') {
          // Only a scheduled fixture is postponed when the cancellation lands (the sync's own
          // rule) and so remains to be scheduled. A played, forfeit, abandoned or canceled
          // fixture keeps its outcome: canceling its game frees the resource and creates no
          // obligation.
          if (linked.status === 'scheduled') {
            seasonIds.add(linked.season_id);
            unplaced.set(linked.id, linked.season_id);
          }
          continue;
        }
        const sourceType = proposed.sourceType ?? 'fixture';
        const sourceId = proposed.sourceId ?? linked.id;
        if (sourceType !== 'fixture' || sourceId !== linked.id) {
          obligations.push({
            code: 'fixture_game_repurposed',
            message: `Change ${change.sequence} gives the published game of fixture ${linked.id} another source; cancel the game and schedule the other activity separately.`,
            owner: 'scheduler',
            deadline: null,
            blocking: true,
          });
          continue;
        }
      }
      // a cancel of an event that is no fixture's game creates no fixture obligation
      if (change.kind === 'cancel') continue;
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
        if (change.kind === 'create') {
          const earlier = createdFor.get(fixture.id);
          if (earlier !== undefined) {
            obligations.push({
              code: 'fixture_already_scheduled',
              message: `Changes ${earlier} and ${change.sequence} would both give fixture ${fixture.id} a published game.`,
              owner: 'league_manager',
              deadline: null,
              blocking: true,
            });
          } else {
            createdFor.set(fixture.id, change.sequence);
          }
        }
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
        // A draft that cancels the fixture's current game and creates its replacement leaves it
        // exactly one game (cancel + create is a move to another resource or day).
        if (
          change.kind === 'create' &&
          fixture.status === 'scheduled' &&
          fixture.scheduling_event_id !== null &&
          fixture.scheduling_event_id !== change.targetEventId &&
          !canceledEventIds.has(fixture.scheduling_event_id)
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
      const remaining = new Set((await q.execute()).map((r) => r.id));
      let canceled = 0;
      for (const [fixtureId, ofSeason] of unplaced) {
        if (ofSeason !== seasonId || draftFixtureIds.has(fixtureId) || remaining.has(fixtureId)) {
          continue;
        }
        remaining.add(fixtureId);
        canceled += 1;
      }
      const seasonEnd = season
        ? await this.dayAfter(db, check.organizationId, check.facilityId, season.ends_on)
        : null;
      const deadline = unscheduledFixtureDeadline(now, seasonEnd);
      if (remaining.size > 0) {
        obligations.push({
          code: 'unscheduled_fixtures',
          message: `${remaining.size} fixture(s) of the season remain unscheduled after this publication${canceled > 0 ? `, ${canceled} of them because it cancels their game` : ''}.`,
          owner: 'league_manager',
          deadline: deadline.toISOString(),
          blocking: false,
        });
      }
      if (trx) {
        await this.followUp(trx, check, seasonId, remaining.size, deadline);
      }
    }
    return obligations;
  }

  /** Opens or resolves the season's incomplete-season exception (same transaction as publication). */
  private async followUp(
    trx: Trx,
    check: { organizationId: string; facilityId: string | null; draftId?: string },
    seasonId: string,
    remaining: number,
    deadline: Date,
    options: { cause?: { fixtureId: string; eventId: string | null } } = {},
  ): Promise<void> {
    const dedupeKey = `incomplete_season:${seasonId}`;
    // a publication names its draft; a change outside one names the fixture and event that changed
    const origin = options.cause ?? { draftId: check.draftId ?? null };
    if (remaining > 0) {
      await this.exceptions.raise(trx, {
        organizationId: check.organizationId,
        facilityId: check.facilityId,
        category: INCOMPLETE_SEASON.category,
        severity: INCOMPLETE_SEASON.severity,
        title: options.cause
          ? 'Season fixture lost its scheduled game'
          : 'Season published with unscheduled fixtures',
        affectedType: 'season',
        affectedId: seasonId,
        ownerQueue: INCOMPLETE_SEASON.ownerQueue,
        deadlineAt: deadline,
        dedupeKey,
        details: { ...origin, unscheduledFixtures: remaining },
      });
      return;
    }
    // CMP-11 (§4.2): the season's open exception through the kernel's reads (IF-29).
    const open = (
      await this.exceptions.list(
        check.organizationId,
        {
          statuses: ['open', 'acknowledged'],
          category: INCOMPLETE_SEASON.category,
          affectedType: 'season',
          affectedId: seasonId,
          limit: 1,
        },
        trx,
      )
    ).items[0];
    if (open) {
      await this.exceptions.transition(
        trx,
        systemPrincipal(check.organizationId, 'competition.fixture_obligations'),
        open.id,
        'resolved',
        {
          reason: 'Every fixture of the season is scheduled.',
          resolution: { ...origin, unscheduledFixtures: 0 },
        },
      );
    }
  }

  /** The fixture whose current published game is `eventId`, if any (R3-TRACE-A-04). */
  private async linkedFixture(
    db: Reader,
    organizationId: string,
    eventId: string,
  ): Promise<{ id: string; season_id: string; status: FixtureStatus } | null> {
    return (
      (await db
        .selectFrom('fixtures')
        .select(['id', 'season_id', 'status'])
        .where('organization_id', '=', organizationId)
        .where('scheduling_event_id', '=', eventId)
        .executeTakeFirst()) ?? null
    );
  }

  /**
   * R3-TRACE-A-04 (SPK-FIX-002, SPK-AT-010 step 5): a fixture lost or regained its game, or left
   * the season's open work, outside a draft publication's obligation check: a competition fixture
   * command (schedule, reschedule, postpone, unschedule, cancel), a recorded outcome (a forfeit of
   * an unplaced fixture), or the fixture sync after a closure or a direct event cancellation.
   * Called inside the caller's transaction, after the fixture row is written. When the season now
   * has unscheduled fixtures and `lost` is true, the season's one `competition.incomplete_season`
   * exception is opened (or kept) with the league manager as owner and the remaining-fixture
   * deadline (capped at the end of the season's last local day when `facilityId` is known); when
   * nothing is unscheduled any more, the open one is resolved. A change that loses nothing never
   * opens one.
   */
  async seasonScheduleChanged(
    trx: Trx,
    input: {
      organizationId: string;
      facilityId: string | null;
      seasonId: string;
      fixtureId: string;
      eventId: string | null;
      lost: boolean;
    },
  ): Promise<void> {
    const remaining = await trx
      .selectFrom('fixtures')
      .select('id')
      .where('organization_id', '=', input.organizationId)
      .where('season_id', '=', input.seasonId)
      .where('status', 'in', ['unscheduled', 'postponed'])
      .where('away_entry_id', 'is not', null)
      .execute();
    const cause = { fixtureId: input.fixtureId, eventId: input.eventId };
    if (remaining.length === 0) {
      await this.followUp(trx, input, input.seasonId, 0, this.clock.now(), { cause });
      return;
    }
    if (!input.lost) return;
    const season = await loadSeasonRow(trx, input.organizationId, input.seasonId);
    const seasonEnd =
      season && input.facilityId
        ? await this.dayAfter(trx, input.organizationId, input.facilityId, season.ends_on)
        : null;
    await this.followUp(
      trx,
      input,
      input.seasonId,
      remaining.length,
      unscheduledFixtureDeadline(this.clock.now(), seasonEnd),
      { cause },
    );
  }

  /** The instant the season's last day ends at the facility (start of the following local day). */
  private async dayAfter(
    db: Reader,
    organizationId: string,
    facilityId: string,
    endsOn: string,
  ): Promise<Date | null> {
    // CMP-11 (§4.2): the facility's time zone through the kernel's directory (IF-03).
    const facility = (await this.facilities.describe(organizationId, [facilityId], db)).get(
      facilityId,
    );
    if (!facility) return null;
    return resolveLocal(addDays(endsOn, 1), '00:00', facility.timezone)?.instant ?? null;
  }
}
