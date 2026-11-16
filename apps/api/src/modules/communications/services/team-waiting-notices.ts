import { Inject, Injectable } from '@nestjs/common';
import { systemPrincipal, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import { CLOCK, FacilityDirectory, type Clock, type Trx } from '../../../kernel';
import {
  TEAM_ENTRY_QUERY_PORT,
  type CompetitionEvents,
  type TeamEntryQueryPort,
  type TeamEntrySummary,
} from '../../competition';
import { noticeTitle, uniqueStrings } from '../communications.shared';
import { formatInstant } from './competition-notices';
import { NotificationsService } from './notifications.service';

type PlaceOfferedPayload = EventPayload<typeof CompetitionEvents.teamPlaceOffered>;
type PlaceOfferResolvedPayload = EventPayload<typeof CompetitionEvents.teamPlaceOfferResolved>;
type EntryStatusChangedPayload = EventPayload<typeof CompetitionEvents.teamEntryStatusChanged>;

/** The actor communications composes these notices as (an audit label, no authority). */
const ACTOR = 'communications.team_waiting_notices';

/**
 * SPK-COMP-006 (QA M-5, M-7): what a team's captain and co-captains are told about the team
 * waiting list. Composed by this module's own handlers from competition's facts (IF-22:
 * communications imports competition). Each notice is operational, protected (who captains which
 * team is participant-private, so recipients are re-checked before dispatch) and keyed on its
 * source event id: a replay composes nothing (the dispatcher's consumption record, the unique
 * source-event index, and the check below). The subjects are the people holding `captain` or
 * `co_captain` on the entry at the clock; whoever holds `receive_messages` over a youth captain
 * hears too, and each person's channel preferences apply as for any operational notice.
 *
 * - `communications.notify_team_place_offered`: one `team_place_offer` notice naming the team and
 *   the division, until when the offer is open (in the division's facility zone, SPK-SCHED-008;
 *   UTC when the division names no facility), and that it is answered in the app.
 * - `communications.notify_team_place_offer_resolved`: one short `team_waiting_list` notice when
 *   the offer was accepted, declined, withdrawn or expired. An offer closed because the entry
 *   itself left the list is covered by the notice below and composes nothing here.
 * - `communications.notify_team_waiting_status`: one `team_waiting_list` notice when the entry is
 *   moved onto the waiting list, and one when it leaves the list by withdrawal or rejection.
 *   Leaving it by accepting a place is told by the offer notice above; every other status change
 *   composes nothing.
 *
 * None of the handlers reads the `team_waitlist` capability: with the switch off competition
 * refuses to wait, offer and accept, so no such fact is announced; declining, withdrawing and
 * expiring stay possible then, and their notices are still due.
 */
@Injectable()
export class TeamWaitingNotices {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly facilities: FacilityDirectory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly entries: TeamEntryQueryPort,
  ) {}

  async onTeamPlaceOffered(trx: Trx, event: DomainEvent<PlaceOfferedPayload>): Promise<void> {
    const payload = event.payload;
    if (await this.alreadyComposed(trx, event)) return;
    const entry = await this.entries.findTeamEntry(event.organizationId, payload.teamEntryId, trx);
    if (!entry) return;
    const subjects = await this.captains(trx, entry);
    if (subjects.length === 0) return;
    const division = await this.entries.findDivision(event.organizationId, payload.divisionId, trx);
    const facility = division?.facilityId
      ? (await this.facilities.describe(event.organizationId, [division.facilityId], trx)).get(
          division.facilityId,
        )
      : undefined;
    const zone = facility?.timezone ?? 'UTC';
    const where = division ? division.name : 'a division';
    const until = `${formatInstant(payload.expiresAt, zone)}${facility ? '' : ' (UTC)'}`;
    await this.notifications.composeAndQueueIn(trx, systemPrincipal(event.organizationId, ACTOR), {
      kind: 'team_place_offer',
      category: 'operational',
      ...(facility ? { facilityId: facility.id } : {}),
      subject: { type: 'team_entry_place_offer', id: payload.offerId },
      audience: { subjectPersonIds: subjects },
      title: noticeTitle('Place offered: ', entry.teamName),
      body: `A place in ${where} is offered to ${entry.teamName}. The offer is open until ${until}. Accept or decline it in the app.`,
      detailsAfter: {
        offerId: payload.offerId,
        teamEntryId: payload.teamEntryId,
        seasonId: payload.seasonId,
        divisionId: payload.divisionId,
        expiresAt: payload.expiresAt,
        timezone: zone,
      },
      protected: true,
      sourceEventId: event.id,
      correlationId: event.correlationId,
    });
  }

  async onTeamPlaceOfferResolved(
    trx: Trx,
    event: DomainEvent<PlaceOfferResolvedPayload>,
  ): Promise<void> {
    const payload = event.payload;
    if (await this.alreadyComposed(trx, event)) return;
    const entry = await this.entries.findTeamEntry(event.organizationId, payload.teamEntryId, trx);
    if (!entry) return;
    // The offer was closed because the team itself was withdrawn or rejected from the list: the
    // status notice says so, once.
    if (payload.status === 'withdrawn' && isOffTheList(entry)) return;
    const subjects = await this.captains(trx, entry);
    if (subjects.length === 0) return;
    const division = await this.entries.findDivision(event.organizationId, payload.divisionId, trx);
    const where = division ? division.name : 'a division';
    const team = entry.teamName;
    const stays = entry.status === 'waiting' ? ` ${team} stays on the waiting list.` : '';
    const text: Record<PlaceOfferResolvedPayload['status'], { title: string; body: string }> = {
      accepted: {
        title: 'Place accepted: ',
        body: `${team} accepted the place offered in ${where}. The entry now follows the usual approval and payment steps.`,
      },
      declined: {
        title: 'Place declined: ',
        body: `The place offered to ${team} in ${where} was declined.${stays}`,
      },
      withdrawn: {
        title: 'Place offer withdrawn: ',
        body: `League staff withdrew the place offered to ${team} in ${where}.${stays}`,
      },
      expired: {
        title: 'Place offer expired: ',
        body: `The place offered to ${team} in ${where} was not answered in time and is no longer held.${stays}`,
      },
    };
    await this.notifications.composeAndQueueIn(trx, systemPrincipal(event.organizationId, ACTOR), {
      kind: 'team_waiting_list',
      category: 'operational',
      subject: { type: 'team_entry_place_offer', id: payload.offerId },
      audience: { subjectPersonIds: subjects },
      title: noticeTitle(text[payload.status].title, team),
      body: text[payload.status].body,
      detailsAfter: {
        offerId: payload.offerId,
        teamEntryId: payload.teamEntryId,
        seasonId: payload.seasonId,
        divisionId: payload.divisionId,
        offerStatus: payload.status,
      },
      protected: true,
      sourceEventId: event.id,
      correlationId: event.correlationId,
    });
  }

  async onTeamEntryStatusChanged(
    trx: Trx,
    event: DomainEvent<EntryStatusChangedPayload>,
  ): Promise<void> {
    const payload = event.payload;
    const joined = payload.status === 'waiting';
    const left =
      payload.previousStatus === 'waiting' &&
      (payload.status === 'withdrawn' || payload.status === 'rejected');
    if (!joined && !left) return;
    if (await this.alreadyComposed(trx, event)) return;
    const entry = await this.entries.findTeamEntry(event.organizationId, payload.teamEntryId, trx);
    if (!entry) return;
    const subjects = await this.captains(trx, entry);
    if (subjects.length === 0) return;
    const season = await this.entries.findSeason(event.organizationId, payload.seasonId, trx);
    const where = season ? `${season.competitionName}, ${season.name}` : 'the season';
    const team = entry.teamName;
    const body = joined
      ? `${team} is on the waiting list of ${where}. It holds no place and owes nothing while it waits; you will be told when a place is offered. Registrations players have already made are not changed by this.`
      : payload.status === 'withdrawn'
        ? `${team} was withdrawn and is no longer on the waiting list of ${where}.`
        : `The entry of ${team} was not accepted and it is no longer on the waiting list of ${where}.`;
    await this.notifications.composeAndQueueIn(trx, systemPrincipal(event.organizationId, ACTOR), {
      kind: 'team_waiting_list',
      category: 'operational',
      subject: { type: 'team_entry', id: payload.teamEntryId },
      audience: { subjectPersonIds: subjects },
      title: noticeTitle(joined ? 'On the waiting list: ' : 'No longer waiting: ', team),
      body,
      detailsAfter: {
        teamEntryId: payload.teamEntryId,
        seasonId: payload.seasonId,
        status: payload.status,
        previousStatus: payload.previousStatus,
      },
      protected: true,
      sourceEventId: event.id,
      correlationId: event.correlationId,
    });
  }

  /** The people holding captain or co-captain on the entry at the clock. */
  private async captains(trx: Trx, entry: TeamEntrySummary): Promise<string[]> {
    const holders = await this.entries.roleHolders(
      entry.organizationId,
      entry.id,
      ['captain', 'co_captain'],
      this.clock.now(),
      trx,
    );
    return uniqueStrings(holders.map((holder) => holder.personId));
  }

  /** A replayed event whose notice exists composes nothing (the unique source-event index). */
  private async alreadyComposed(trx: Trx, event: DomainEvent<unknown>): Promise<boolean> {
    const row = await trx
      .selectFrom('notifications')
      .select('id')
      .where('organization_id', '=', event.organizationId)
      .where('source_event_id', '=', event.id)
      .executeTakeFirst();
    return row !== undefined;
  }
}

function isOffTheList(entry: TeamEntrySummary): boolean {
  return entry.status === 'withdrawn' || entry.status === 'rejected';
}
