import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  systemPrincipal,
  type AcceptTeamPlaceOfferInput,
  type DeclineTeamPlaceOfferInput,
  type OfferTeamPlaceInput,
  type Principal,
  type SeasonWaitingLists,
  type SeasonWaitingListsQuery,
  type TeamEntry,
  type TeamEntryPlaceOffer,
  type TeamPlaceOfferOutcome,
  type WaitingList,
  type WaitTeamEntryInput,
  type WithdrawTeamPlaceOfferInput,
} from '@sportspark/contracts';
import {
  isCheckViolation,
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
} from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CapabilityService,
  CLOCK,
  DATABASE,
  MODULE_SETTINGS,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  executorFor,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  divisionNames,
  divisionPlaces,
  freePlaces,
  isFull,
  openOfferOf,
  seasonDivisionPlaces,
  toPlaceOffer,
  waitingPosition,
  waitingRows,
  type DivisionPlaces,
  type PlaceOfferRow,
} from '../competition-waitlist.queries';
import { CompetitionActions } from '../competition.actions';
import { CompetitionEvents } from '../competition.events';
import { TEAM_PLACE_OFFER_DEFAULT_HOURS } from '../competition.policy';
import {
  effectiveRoles,
  loadEntryContext,
  loadSeasonRow,
  rosterRowsEffectiveAt,
  type EntryContext,
} from '../competition.queries';
import { CompetitionSettings, type CompetitionSettingsValue } from '../competition.settings';
import { organizationOf } from '../competition.shared';
import { TeamEntryMachine, TeamEntryPlaceOfferMachine } from '../competition.state-machines';
import { TeamEntriesService } from './team-entries.service';

const HOUR_MS = 3_600_000;
const OFFER_CAPACITY_CONSTRAINT = 'team_entry_place_offers_division_capacity';
const ENTRY_CAPACITY_CONSTRAINT = 'team_entries_division_capacity';
export const EXPIRE_TEAM_PLACE_OFFER_HANDLER = 'competition.expire_team_place_offer';

type Resolution = 'decline' | 'withdraw' | 'expire';

/**
 * Team waiting list (SPK-COMP-006, proposed amendment PA-10; capability `team_waitlist`, pending
 * DEC-104). Waiting is a state of the team entry; a freed place is offered through its own record
 * and held by the open offer until it is accepted, declined, withdrawn or expired. Waiting,
 * offering and accepting are refused while the capability is off; declining, withdrawing and
 * expiring never are, so an organization that turns the switch off can still wind its lists down.
 */
@Injectable()
export class TeamWaitlistService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly capabilities: CapabilityService,
    private readonly entries: TeamEntriesService,
    @Inject(MODULE_SETTINGS(CompetitionSettings.module))
    private readonly settings: CompetitionSettingsValue,
  ) {}

  /** Hours an offer stands: configuration, 48 by proposed default (DEC-104). */
  offerHours(): number {
    return this.settings.TEAM_PLACE_OFFER_HOURS ?? TEAM_PLACE_OFFER_DEFAULT_HOURS;
  }

  // -------------------------------------------------------------------------------------------
  // Wait (staff). The automatic wait of a placement into a full division is in TeamEntriesService.
  // -------------------------------------------------------------------------------------------
  async wait(
    principal: Principal,
    id: string,
    input: WaitTeamEntryInput,
    correlationId: string | null,
  ): Promise<TeamEntry> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, id, { forUpdate: true });
      if (!context) throw errors.protectedNotFound('team_entry');
      const { entry, season } = context;
      await this.authorization.require(principal, CompetitionActions.waitTeamEntry, {
        type: 'team_entry',
        id,
        organizationId,
      });
      await this.capabilities.require(organizationId, 'team_waitlist', trx);
      assertExpectedRevision(input.expectedRevision, entry.revision);
      TeamEntryMachine.next(entry.status, 'wait');
      if (season.status === 'completed' || season.status === 'archived') {
        throw errors.invalidTransition('Season', season.status, 'accept_waiting_entry');
      }
      // A team waits only where there is no free place: the named division, or every division of
      // the season when none is named.
      if (input.divisionId) {
        const places = await divisionPlaces(
          trx,
          organizationId,
          entry.season_id,
          input.divisionId,
          {
            forUpdate: true,
          },
        );
        if (!places) throw errors.notFound('division', input.divisionId);
        if (!isFull(places)) {
          throw new DomainError(
            'INVALID_TRANSITION',
            'The division has a free place; place the entry instead of making it wait.',
            {
              details: {
                code: 'DIVISION_HAS_ROOM',
                divisionId: places.divisionId,
                capacity: places.capacity,
                occupied: places.placed + places.openOffers,
              },
            },
          );
        }
      } else {
        const divisions = await seasonDivisionPlaces(trx, organizationId, entry.season_id, {
          forUpdate: true,
        });
        const open = divisions.filter((division) => !isFull(division));
        if (divisions.length === 0 || open.length > 0) {
          throw new DomainError(
            'INVALID_TRANSITION',
            divisions.length === 0
              ? 'The season has no division yet; there is nothing to wait for.'
              : 'A division of this season has a free place; place the entry instead of making it wait.',
            {
              details: {
                code: 'SEASON_HAS_ROOM',
                seasonId: entry.season_id,
                divisionsWithRoom: open.map((division) => division.divisionId),
              },
            },
          );
        }
      }
      return this.entries.moveToWaiting(
        trx,
        principal,
        context,
        input.divisionId ?? null,
        input.reason ?? null,
        correlationId,
        'staff',
      );
    });
  }

  // -------------------------------------------------------------------------------------------
  // Offer (staff choose the entry; the order is recorded with the offer)
  // -------------------------------------------------------------------------------------------
  async offer(
    principal: Principal,
    entryId: string,
    input: OfferTeamPlaceInput,
    correlationId: string | null,
  ): Promise<TeamPlaceOfferOutcome> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    const offerId = newId();
    return this.uow.run(async ({ trx }) => {
      const context = await loadEntryContext(trx, organizationId, entryId, { forUpdate: true });
      if (!context) throw errors.protectedNotFound('team_entry');
      const { entry } = context;
      await this.authorization.require(principal, CompetitionActions.offerTeamPlace, {
        type: 'team_entry',
        id: entryId,
        organizationId,
      });
      await this.capabilities.require(organizationId, 'team_waitlist', trx);
      assertExpectedRevision(input.expectedRevision, entry.revision);
      if (entry.status !== 'waiting') {
        throw errors.invalidTransition('TeamEntry', entry.status, 'offer_place');
      }
      if (await openOfferOf(trx, organizationId, entryId)) throw offerAlreadyOpen(entryId);
      const divisionId = input.divisionId ?? entry.waiting_division_id;
      if (!divisionId) {
        throw errors.validation(
          'Name the division whose place is offered: this entry waits for the season.',
          { field: 'divisionId' },
        );
      }
      const places = await divisionPlaces(trx, organizationId, entry.season_id, divisionId, {
        forUpdate: true,
      });
      if (!places) throw errors.notFound('division', divisionId);
      if (isFull(places)) throw noPlaceToOffer(places);
      const { position, listLength } = await waitingPosition(trx, entry);
      const expiresAt = new Date(now.getTime() + this.offerHours() * HOUR_MS);
      try {
        await trx
          .insertInto('team_entry_place_offers')
          .values({
            id: offerId,
            organization_id: organizationId,
            season_id: entry.season_id,
            team_entry_id: entryId,
            division_id: divisionId,
            position_at_offer: position,
            offered_at: now,
            offered_by: json(snapshotActor(principal)),
            expires_at: expiresAt,
            note: input.note ?? null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error)) throw offerAlreadyOpen(entryId);
        if (isCheckViolation(error) && pgConstraintName(error) === OFFER_CAPACITY_CONSTRAINT) {
          throw noPlaceToOffer(places);
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.offerTeamPlace.id,
        targetType: 'team_entry_place_offer',
        targetId: offerId,
        afterRevision: 1,
        reason: input.reason ?? input.note ?? null,
        correlationId,
        details: {
          teamEntryId: entryId,
          divisionId,
          // The order staff were shown and whether the offer followed it (SPK-COMP-006).
          positionAtOffer: position,
          listLength,
          followedOrder: position === 1,
          expiresAt: expiresAt.toISOString(),
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.teamPlaceOffered, {
        organizationId,
        aggregateType: 'team_entry',
        aggregateId: entryId,
        payload: {
          offerId,
          teamEntryId: entryId,
          seasonId: entry.season_id,
          divisionId,
          positionAtOffer: position,
          expiresAt: expiresAt.toISOString(),
        },
        correlationId,
      });
      // Server-owned expiry: a timer the worker runs at expiresAt closes the offer if still open.
      await this.outbox.enqueue(trx, CompetitionEvents.teamPlaceOfferExpiryDue, {
        organizationId,
        aggregateType: 'team_entry_place_offer',
        aggregateId: offerId,
        payload: { offerId, teamEntryId: entryId, expiresAt: expiresAt.toISOString() },
        correlationId,
        availableAt: expiresAt,
      });
      return this.outcome(trx, organizationId, offerId, entryId, now);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Accept: the entry returns to `applied` in the offered division (SPK-COMP-004 from there)
  // -------------------------------------------------------------------------------------------
  async accept(
    principal: Principal,
    offerId: string,
    input: AcceptTeamPlaceOfferInput,
    correlationId: string | null,
  ): Promise<TeamPlaceOfferOutcome> {
    const organizationId = organizationOf(principal);
    const now = this.clock.now();
    return this.uow.run(async ({ trx }) => {
      const { context, offer } = await this.lockOffer(trx, organizationId, offerId);
      const { entry } = context;
      await this.authorization.require(principal, CompetitionActions.acceptTeamPlaceOffer, {
        type: 'team_entry',
        id: entry.id,
        organizationId,
        teamEntryId: entry.id,
        protected: true,
      });
      await this.capabilities.require(organizationId, 'team_waitlist', trx);
      assertExpectedRevision(input.expectedRevision, offer.revision);
      const offerStatus = TeamEntryPlaceOfferMachine.next(offer.status, 'accept');
      if (now.getTime() >= new Date(offer.expires_at).getTime()) {
        throw new DomainError('INVALID_TRANSITION', 'The offer has expired.', {
          details: {
            code: 'OFFER_EXPIRED',
            offerId,
            expiresAt: new Date(offer.expires_at).toISOString(),
          },
        });
      }
      const entryStatus = TeamEntryMachine.next(entry.status, 'accept_place');
      // The offer is settled first: the entry may leave the list only with no open offer, and the
      // capacity trigger then counts the entry in the place its offer held.
      await this.resolveRow(trx, principal, offer, offerStatus, input.reason ?? null);
      try {
        await trx
          .updateTable('team_entries')
          .set({
            status: entryStatus,
            division_id: offer.division_id,
            waiting_since: null,
            waiting_division_id: null,
            revision: entry.revision + 1,
          })
          .where('organization_id', '=', organizationId)
          .where('id', '=', entry.id)
          .where('revision', '=', entry.revision)
          .execute();
      } catch (error) {
        if (isCheckViolation(error) && pgConstraintName(error) === ENTRY_CAPACITY_CONSTRAINT) {
          throw errors.capacityUnavailable('The division is full.', {
            divisionId: offer.division_id,
          });
        }
        throw error;
      }
      await this.recordResolution(trx, principal, entry, offer, 'accepted', input.reason, {
        action: CompetitionActions.acceptTeamPlaceOffer.id,
        correlationId,
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: CompetitionActions.acceptTeamPlaceOffer.id,
        targetType: 'team_entry',
        targetId: entry.id,
        beforeRevision: entry.revision,
        afterRevision: entry.revision + 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          status: entryStatus,
          previousStatus: entry.status,
          divisionId: offer.division_id,
          offerId,
        },
      });
      await this.outbox.enqueue(trx, CompetitionEvents.teamEntryStatusChanged, {
        organizationId,
        aggregateType: 'team_entry',
        aggregateId: entry.id,
        payload: {
          teamEntryId: entry.id,
          seasonId: entry.season_id,
          teamId: entry.team_id,
          status: entryStatus,
          previousStatus: entry.status,
          divisionId: offer.division_id,
          reason: input.reason ?? null,
        },
        correlationId,
      });
      return this.outcome(trx, organizationId, offerId, entry.id, now);
    });
  }

  /** The captain (or league staff) declines; the entry keeps its place in the order. */
  async decline(
    principal: Principal,
    offerId: string,
    input: DeclineTeamPlaceOfferInput,
    correlationId: string | null,
  ): Promise<TeamPlaceOfferOutcome> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const { context, offer } = await this.lockOffer(trx, organizationId, offerId);
      await this.authorization.require(principal, CompetitionActions.declineTeamPlaceOffer, {
        type: 'team_entry',
        id: context.entry.id,
        organizationId,
        teamEntryId: context.entry.id,
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, offer.revision);
      await this.resolve(trx, principal, context, offer, 'decline', input.reason ?? null, {
        action: CompetitionActions.declineTeamPlaceOffer.id,
        correlationId,
      });
      return this.outcome(trx, organizationId, offerId, context.entry.id, this.clock.now());
    });
  }

  /** League staff withdraw an open offer; the entry keeps its place in the order. */
  async withdrawOffer(
    principal: Principal,
    offerId: string,
    input: WithdrawTeamPlaceOfferInput,
    correlationId: string | null,
  ): Promise<TeamPlaceOfferOutcome> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const { context, offer } = await this.lockOffer(trx, organizationId, offerId);
      await this.authorization.require(principal, CompetitionActions.withdrawTeamPlaceOffer, {
        type: 'team_entry',
        id: context.entry.id,
        organizationId,
      });
      assertExpectedRevision(input.expectedRevision, offer.revision);
      await this.resolve(trx, principal, context, offer, 'withdraw', input.reason, {
        action: CompetitionActions.withdrawTeamPlaceOffer.id,
        correlationId,
      });
      return this.outcome(trx, organizationId, offerId, context.entry.id, this.clock.now());
    });
  }

  /**
   * The expiry timer (`competition.team_place_offer_expiry_due`): closes the offer when it is
   * still open and its expiry has passed. Idempotent under replay: an offer already accepted,
   * declined, withdrawn or expired is left alone, and so is one whose expiry is still ahead.
   * Runs in the dispatcher's transaction.
   */
  async expireIfDue(
    trx: Trx,
    organizationId: string,
    offerId: string,
    correlationId: string | null,
  ): Promise<boolean> {
    const found = await trx
      .selectFrom('team_entry_place_offers')
      .select('team_entry_id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', offerId)
      .executeTakeFirst();
    if (!found) return false;
    const { context, offer } = await this.lockOffer(trx, organizationId, offerId);
    if (offer.status !== 'offered') return false;
    if (this.clock.now().getTime() < new Date(offer.expires_at).getTime()) return false;
    await this.resolve(
      trx,
      systemPrincipal(organizationId, EXPIRE_TEAM_PLACE_OFFER_HANDLER),
      context,
      offer,
      'expire',
      'The offer was not answered before its expiry.',
      { action: CompetitionActions.expireTeamPlaceOffer.id, correlationId },
    );
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------
  /** The waiting lists of a season, per division and in order (staff). */
  async seasonLists(
    principal: Principal,
    seasonId: string,
    query: SeasonWaitingListsQuery,
  ): Promise<SeasonWaitingLists> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, CompetitionActions.listTeamEntries, {
      type: 'team_entry',
      organizationId,
    });
    const db = executorFor(this.db);
    const season = await loadSeasonRow(db, organizationId, seasonId);
    if (!season) throw errors.notFound('season', seasonId);
    const divisions = (await seasonDivisionPlaces(db, organizationId, seasonId)).filter(
      (division) => !query.divisionId || division.divisionId === query.divisionId,
    );
    if (query.divisionId && divisions.length === 0) {
      throw errors.notFound('division', query.divisionId);
    }
    const rows = await waitingRows(db, organizationId, seasonId);
    const offers = await db
      .selectFrom('team_entry_place_offers')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('season_id', '=', seasonId)
      .where('status', '=', 'offered')
      .execute();
    const offerByEntry = new Map(offers.map((offer) => [offer.team_entry_id, offer]));
    const names = await divisionNames(
      db,
      organizationId,
      offers.map((offer) => offer.division_id),
    );
    const entriesOf = (divisionId: string | null): WaitingList['entries'] =>
      rows
        .filter((row) => row.waiting_division_id === divisionId)
        .map((row, index) => {
          const offer = offerByEntry.get(row.id);
          return {
            position: index + 1,
            teamEntryId: row.id,
            teamId: row.team_id,
            teamName: row.team_name,
            waitingSince: row.waiting_since.toISOString(),
            revision: row.revision,
            openOffer: offer
              ? toPlaceOffer(offer, names.get(offer.division_id) ?? 'Unknown division')
              : null,
          };
        });
    const lists: WaitingList[] = divisions.map((division) => ({
      division: { id: division.divisionId, name: division.name },
      capacity: division.capacity,
      placed: division.placed,
      openOffers: division.openOffers,
      freePlaces: freePlaces(division),
      entries: entriesOf(division.divisionId),
    }));
    if (!query.divisionId) {
      const seasonWide = entriesOf(null);
      if (seasonWide.length > 0) {
        lists.push({
          division: null,
          capacity: null,
          placed: null,
          openOffers: null,
          freePlaces: null,
          entries: seasonWide,
        });
      }
    }
    return { seasonId, offerHours: this.offerHours(), lists };
  }

  /**
   * Every offer made to an entry, newest first: staff, the captain and co-captains. Anybody else
   * gets the answer an unknown entry gets (§4.10; security review L-5): whether an id names a
   * team entry is not something this read tells a person outside it.
   */
  async offersOfEntry(principal: Principal, entryId: string): Promise<TeamEntryPlaceOffer[]> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const context = await loadEntryContext(db, organizationId, entryId);
    if (!context) throw errors.protectedNotFound('team_entry');
    const now = this.clock.now();
    const viewer = await this.entries.viewerOf(
      principal,
      context,
      await rosterRowsEffectiveAt(db, organizationId, entryId, now),
      await effectiveRoles(db, organizationId, entryId, now),
      now,
    );
    if (!viewer.canManage) throw errors.protectedNotFound('team_entry');
    const rows = await db
      .selectFrom('team_entry_place_offers')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('team_entry_id', '=', entryId)
      .orderBy('offered_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const names = await divisionNames(
      db,
      organizationId,
      rows.map((row) => row.division_id),
    );
    return rows.map((row) => toPlaceOffer(row, names.get(row.division_id) ?? 'Unknown division'));
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------
  /** Locks the entry, then its offer (the order every offer command and the triggers take). */
  private async lockOffer(
    trx: Trx,
    organizationId: string,
    offerId: string,
  ): Promise<{ context: EntryContext; offer: PlaceOfferRow }> {
    const found = await trx
      .selectFrom('team_entry_place_offers')
      .select('team_entry_id')
      .where('organization_id', '=', organizationId)
      .where('id', '=', offerId)
      .executeTakeFirst();
    if (!found) throw errors.protectedNotFound('team_entry_place_offer');
    const context = await loadEntryContext(trx, organizationId, found.team_entry_id, {
      forUpdate: true,
    });
    if (!context) throw errors.protectedNotFound('team_entry_place_offer');
    const offer = await trx
      .selectFrom('team_entry_place_offers')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', offerId)
      .forUpdate()
      .executeTakeFirst();
    if (!offer) throw errors.protectedNotFound('team_entry_place_offer');
    return { context, offer };
  }

  private async resolveRow(
    trx: Trx,
    principal: Principal,
    offer: PlaceOfferRow,
    status: PlaceOfferRow['status'],
    reason: string | null,
  ): Promise<void> {
    await trx
      .updateTable('team_entry_place_offers')
      .set({
        status,
        resolved_at: this.clock.now(),
        resolved_by: json(snapshotActor(principal)),
        resolution_reason: reason,
        revision: offer.revision + 1,
      })
      .where('organization_id', '=', offer.organization_id)
      .where('id', '=', offer.id)
      .where('revision', '=', offer.revision)
      .execute();
  }

  private async recordResolution(
    trx: Trx,
    principal: Principal,
    entry: EntryContext['entry'],
    offer: PlaceOfferRow,
    status: 'accepted' | 'declined' | 'expired' | 'withdrawn',
    reason: string | null | undefined,
    meta: { action: string; correlationId: string | null },
  ): Promise<void> {
    await this.audit.record(trx, {
      organizationId: offer.organization_id,
      actor: principal,
      action: meta.action,
      targetType: 'team_entry_place_offer',
      targetId: offer.id,
      beforeRevision: offer.revision,
      afterRevision: offer.revision + 1,
      reason: reason ?? null,
      correlationId: meta.correlationId,
      details: { status, teamEntryId: entry.id, divisionId: offer.division_id },
    });
    await this.outbox.enqueue(trx, CompetitionEvents.teamPlaceOfferResolved, {
      organizationId: offer.organization_id,
      aggregateType: 'team_entry',
      aggregateId: entry.id,
      payload: {
        offerId: offer.id,
        teamEntryId: entry.id,
        seasonId: entry.season_id,
        divisionId: offer.division_id,
        status,
      },
      correlationId: meta.correlationId,
    });
  }

  /** Decline, withdraw or expire: the offer closes and the place it held is free again. */
  private async resolve(
    trx: Trx,
    principal: Principal,
    context: EntryContext,
    offer: PlaceOfferRow,
    event: Resolution,
    reason: string | null,
    meta: { action: string; correlationId: string | null },
  ): Promise<void> {
    const status = TeamEntryPlaceOfferMachine.next(offer.status, event);
    await this.resolveRow(trx, principal, offer, status, reason);
    await this.recordResolution(
      trx,
      principal,
      context.entry,
      offer,
      status as 'declined' | 'expired' | 'withdrawn',
      reason,
      meta,
    );
  }

  private async outcome(
    trx: Trx,
    organizationId: string,
    offerId: string,
    entryId: string,
    at: Date,
  ): Promise<TeamPlaceOfferOutcome> {
    const offer = await trx
      .selectFrom('team_entry_place_offers')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', offerId)
      .executeTakeFirstOrThrow();
    const names = await divisionNames(trx, organizationId, [offer.division_id]);
    return {
      offer: toPlaceOffer(offer, names.get(offer.division_id) ?? 'Unknown division'),
      entry: await this.entries.entryViewById(trx, organizationId, entryId, at),
    };
  }
}

function offerAlreadyOpen(teamEntryId: string): DomainError {
  return new DomainError('INVALID_TRANSITION', 'This entry already has an open place offer.', {
    details: { code: 'OFFER_ALREADY_OPEN', teamEntryId },
  });
}

function noPlaceToOffer(places: DivisionPlaces): DomainError {
  return errors.capacityUnavailable('The division has no free place to offer.', {
    divisionId: places.divisionId,
    capacity: places.capacity,
    occupied: places.placed + places.openOffers,
    ...(places.openOffers > 0 ? { heldByOffers: places.openOffers } : {}),
  });
}
