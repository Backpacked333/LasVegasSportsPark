import { Inject, Injectable } from '@nestjs/common';
import { systemPrincipal, type DomainEvent, type EventPayload } from '@sportspark/contracts';
import { FacilityDirectory, type Trx } from '../../../kernel';
import {
  FIXTURE_PORT,
  TEAM_ENTRY_QUERY_PORT,
  type CompetitionEvents,
  type FixturePort,
  type MatchEvents,
  type TeamEntryQueryPort,
} from '../../competition';
import { uniqueStrings } from '../communications.shared';
import { NotificationsService } from './notifications.service';

type InvitationCreatedPayload = EventPayload<typeof CompetitionEvents.teamInvitationCreated>;
type ResultPublishedPayload = EventPayload<typeof MatchEvents.resultPublished>;
type AvailabilityRequestedPayload = EventPayload<typeof CompetitionEvents.availabilityRequested>;

/** The actor communications composes competition notices as (an audit label, no authority). */
const ACTOR = 'communications.competition_notices';

/**
 * SPK-COMMS-002 notices about competition facts, composed by this module's own handlers (IF-22:
 * communications imports competition, so competition adds no edge into communications). Each
 * notice is keyed on its source event id: a replay composes nothing (the dispatcher's consumption
 * record, the unique source-event index, and the check below).
 *
 * - `communications.notify_team_invitation` (COM-03, SPK-CAP-001): an invitation to a known person
 *   is one protected `team_invitation` notice with the invitee as its subject (the invitee when an
 *   active adult, and whoever holds `receive_messages` over them); an invitation addressed only to
 *   a contact detail is not messaged here (the inviter hands the code over; DEC-012 pending).
 * - `communications.notify_result_published` (COM-03): one `result_published` notice to both
 *   entries' team audiences (roster and captain/co-captain holders at the clock).
 * - `communications.notify_availability_request` (COM-06, SPK-CAP-001, IF-45): one protected
 *   `availability_request` notice per request to the asked players as subjects (adult players and
 *   holders of `receive_messages`, so a guardian hears about their child), with the fixture start
 *   in the facility's zone (SPK-SCHED-008).
 */
@Injectable()
export class CompetitionNotices {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly facilities: FacilityDirectory,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly entries: TeamEntryQueryPort,
    @Inject(FIXTURE_PORT) private readonly fixtures: FixturePort,
  ) {}

  async onTeamInvitationCreated(
    trx: Trx,
    event: DomainEvent<InvitationCreatedPayload>,
  ): Promise<void> {
    const payload = event.payload;
    if (!payload.recipientPersonId) return; // contact-only invitations are not messaged
    if (await this.alreadyComposed(trx, event)) return;
    const entry = await this.entries.findTeamEntry(event.organizationId, payload.teamEntryId, trx);
    const team = entry?.teamName ?? 'a team';
    await this.notifications.composeAndQueueIn(trx, systemPrincipal(event.organizationId, ACTOR), {
      kind: 'team_invitation',
      category: 'operational',
      subject: { type: 'team_invitation', id: payload.invitationId },
      audience: { subjectPersonIds: [payload.recipientPersonId] },
      title: `Team invitation: ${team}`,
      body: `An invitation to join ${team} is waiting for a response. It expires ${formatInstant(payload.expiresAt, 'UTC')} (UTC).`,
      // Who is invited to which team is participant-private: re-checked before dispatch.
      protected: true,
      sourceEventId: event.id,
      correlationId: event.correlationId,
    });
  }

  async onResultPublished(trx: Trx, event: DomainEvent<ResultPublishedPayload>): Promise<void> {
    const payload = event.payload;
    if (await this.alreadyComposed(trx, event)) return;
    const fixture = await this.fixtures.findFixture(event.organizationId, payload.fixtureId, trx);
    if (!fixture) return;
    const entryIds = uniqueStrings(
      [fixture.homeEntryId, fixture.awayEntryId].filter((id): id is string => id !== null),
    );
    const names: string[] = [];
    for (const id of entryIds) {
      const entry = await this.entries.findTeamEntry(event.organizationId, id, trx);
      names.push(entry?.teamName ?? 'a team');
    }
    const facilityId = fixture.schedulingEventId
      ? await this.facilityOfEvent(trx, event.organizationId, fixture.schedulingEventId)
      : null;
    const matchup = names.join(' vs ');
    const corrected = payload.supersededRevisionId !== null;
    await this.notifications.composeAndQueueIn(trx, systemPrincipal(event.organizationId, ACTOR), {
      kind: 'result_published',
      category: 'operational',
      ...(facilityId ? { facilityId } : {}),
      subject: { type: 'fixture', id: payload.fixtureId },
      audience: { teamEntryIds: entryIds, facilityId },
      title: `${corrected ? 'Corrected result' : 'Result'} published: ${matchup}`,
      body: corrected
        ? `The official result of ${matchup} was corrected. Standings reflect the corrected result.`
        : `The official result of ${matchup} is published.`,
      protected: false,
      sourceEventId: event.id,
      correlationId: event.correlationId,
    });
  }

  async onAvailabilityRequested(
    trx: Trx,
    event: DomainEvent<AvailabilityRequestedPayload>,
  ): Promise<void> {
    const payload = event.payload;
    const subjects = uniqueStrings(payload.recipientPersonIds);
    if (subjects.length === 0) return;
    if (await this.alreadyComposed(trx, event)) return;
    const entry = await this.entries.findTeamEntry(event.organizationId, payload.teamEntryId, trx);
    const team = entry?.teamName ?? 'Your team';
    const facility = payload.facilityId
      ? (await this.facilities.describe(event.organizationId, [payload.facilityId], trx)).get(
          payload.facilityId,
        )
      : undefined;
    const zone = facility?.timezone ?? 'UTC';
    const when = formatInstant(payload.scheduledStart, zone);
    await this.notifications.composeAndQueueIn(trx, systemPrincipal(event.organizationId, ACTOR), {
      kind: 'availability_request',
      category: 'operational',
      ...(facility ? { facilityId: facility.id } : {}),
      subject: { type: 'fixture', id: payload.fixtureId },
      audience: { subjectPersonIds: subjects },
      title: `${team}: are you available?`,
      body: `${team} plays ${when}${facility ? ` at ${facility.name}` : ' (UTC)'}. Please answer the availability request in the app.`,
      detailsAfter: {
        requestId: payload.requestId,
        fixtureId: payload.fixtureId,
        teamEntryId: payload.teamEntryId,
        scheduledStart: payload.scheduledStart,
        timezone: zone,
      },
      // Who plays on which team is participant-private: re-checked before dispatch.
      protected: true,
      sourceEventId: event.id,
      correlationId: event.correlationId,
    });
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

  /** The facility of a scheduled event, from this module's own calendar projection. */
  private async facilityOfEvent(
    trx: Trx,
    organizationId: string,
    eventId: string,
  ): Promise<string | null> {
    const entry = await trx
      .selectFrom('calendar_entries')
      .select('facility_id')
      .where('organization_id', '=', organizationId)
      .where('event_id', '=', eventId)
      .executeTakeFirst();
    return entry?.facility_id ?? null;
  }
}

/** Wall-clock rendering of an instant in a zone (SPK-SCHED-008); deterministic for a given zone. */
export function formatInstant(instant: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}
