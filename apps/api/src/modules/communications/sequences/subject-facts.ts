import { Inject, Injectable } from '@nestjs/common';
import {
  MESSAGE_PLACEHOLDER_NAMES,
  type FixtureStatus,
  type MessageAnchor,
  type MessagePlaceholderName,
  type MessageSubject,
} from '@sportspark/contracts';
import { CLOCK, UnitOfWork, type Clock } from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import {
  FIXTURE_PORT,
  TEAM_ENTRY_QUERY_PORT,
  type FixturePort,
  type TeamEntryQueryPort,
} from '../../competition';
import { localDateOf } from '../../scheduling';
import { SESSION_AUDIENCE_PORT, type SessionAudiencePort } from '../ports';
import type { AnchorValue } from './due-time';
import { MESSAGE_SEQUENCE_POLICY, type MessageSequencePolicy } from './message-sequences.policy';

/**
 * What a season or an offering says about itself right now (SPK-COMMS-009): the facts that fill
 * placeholders and that due times are counted from. Read through the owning module's port every
 * time; nothing here is stored by this module.
 */
export interface SubjectFacts {
  subject: MessageSubject;
  name: string;
  /** The competition of a season, the program of an offering: what a sequence may be limited to. */
  scopeId: string;
  /** The offering's facility; null for a season (a season belongs to no facility). */
  facilityId: string | null;
  /** Archived: its unsent messages are canceled. */
  closed: boolean;
  competitionName: string | null;
  startsOn: string;
  endsOn: string;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
  /** A season's earliest game that is still to be played as scheduled, with its field. */
  firstGame: { start: Date; field: string | null } | null;
  /** The offering's own location label. */
  locationLabel: string | null;
}

/** A game that still stands at its scheduled time (not canceled, postponed or abandoned). */
const STANDING_FIXTURES: readonly FixtureStatus[] = ['scheduled', 'played', 'forfeit'];

/** The anchor of the record the step counts from, or null while the record has no such date. */
export function anchorOf(facts: SubjectFacts, anchor: MessageAnchor): AnchorValue | null {
  switch (anchor) {
    case 'starts':
      return { date: facts.startsOn };
    case 'ends':
      return { date: facts.endsOn };
    case 'registration_opens':
      return facts.registrationOpensAt ? { at: facts.registrationOpensAt } : null;
    case 'registration_closes':
      return facts.registrationClosesAt ? { at: facts.registrationClosesAt } : null;
    case 'first_game':
      return facts.firstGame ? { at: facts.firstGame.start } : null;
  }
}

/** ICU may separate the time from AM or PM with a narrow no-break space; messages use a space. */
const plainSpaces = (text: string): string => text.replace(/[\u202f\u00a0]/g, ' ');

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
};

/** A calendar date of the record's own (`YYYY-MM-DD`), written out. */
function dateText(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return plainSpaces(
    new Intl.DateTimeFormat('en-US', { ...DATE_FORMAT, timeZone: 'UTC' }).format(
      new Date(Date.UTC(year, month - 1, day)),
    ),
  );
}

/** The facility-local date of an instant, written out (SPK-SCHED-008). */
function localDateText(instant: Date, timezone: string): string {
  return dateText(localDateOf(timezone, instant));
}

function localTimeText(instant: Date, timezone: string): string {
  return plainSpaces(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(instant),
  );
}

/**
 * The value of every placeholder for this record, in the facility's zone; null where the record
 * cannot fill it (another kind of record, or a date it does not have yet).
 */
export function placeholderValues(
  facts: SubjectFacts,
  timezone: string,
  facilityName: string | null,
): Record<MessagePlaceholderName, string | null> {
  const season = facts.subject.type === 'season';
  const values: Record<MessagePlaceholderName, string | null> = {
    season_name: season ? facts.name : null,
    competition_name: facts.competitionName,
    offering_name: season ? null : facts.name,
    start_date: dateText(facts.startsOn),
    end_date: dateText(facts.endsOn),
    registration_opens_date: facts.registrationOpensAt
      ? localDateText(facts.registrationOpensAt, timezone)
      : null,
    registration_closes_date: facts.registrationClosesAt
      ? localDateText(facts.registrationClosesAt, timezone)
      : null,
    first_game_date: facts.firstGame ? localDateText(facts.firstGame.start, timezone) : null,
    first_game_time: facts.firstGame ? localTimeText(facts.firstGame.start, timezone) : null,
    field: season ? (facts.firstGame?.field ?? null) : facts.locationLabel,
    facility_name: facilityName,
  };
  // Every name of the vocabulary is answered, so a new placeholder cannot be forgotten here.
  for (const name of MESSAGE_PLACEHOLDER_NAMES) {
    if (!(name in values)) throw new Error(`no value rule for placeholder ${name}`);
  }
  return values;
}

/** Who a schedule's messages are addressed to, as an audience definition (never a stored list). */
export interface SubjectAudience {
  teamEntryIds: string[];
  subjectPersonIds: string[];
}

/**
 * Reads a season's or an offering's facts and audience through the owning module's ports
 * (competition's team entry and fixture ports, the catalog's offering lookup, enrollment's session
 * audience port; §4.2: never their tables). The field of a season's first game comes from this
 * module's own calendar projection of the scheduling event behind the fixture.
 */
@Injectable()
export class SubjectFactsReader {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(TEAM_ENTRY_QUERY_PORT) private readonly entries: TeamEntryQueryPort,
    @Inject(FIXTURE_PORT) private readonly fixtures: FixturePort,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    @Inject(SESSION_AUDIENCE_PORT) private readonly sessionAudience: SessionAudiencePort,
    @Inject(MESSAGE_SEQUENCE_POLICY) private readonly policy: MessageSequencePolicy,
    private readonly uow: UnitOfWork,
  ) {}

  /** The record's facts, or null for an unknown or cross-organization id. */
  async read(organizationId: string, subject: MessageSubject): Promise<SubjectFacts | null> {
    return subject.type === 'season'
      ? this.season(organizationId, subject.id)
      : this.offering(organizationId, subject.id);
  }

  private async season(organizationId: string, seasonId: string): Promise<SubjectFacts | null> {
    const season = await this.entries.findSeason(organizationId, seasonId);
    if (!season) return null;
    const fixtures = await this.fixtures.listSeasonFixtures(organizationId, seasonId);
    const first = fixtures
      .filter((f) => f.scheduledStart !== null && STANDING_FIXTURES.includes(f.status))
      .sort(
        (a, b) =>
          (a.scheduledStart as Date).getTime() - (b.scheduledStart as Date).getTime() ||
          (a.id < b.id ? -1 : 1),
      )[0];
    let field: string | null = null;
    if (first?.schedulingEventId) {
      const entry = await this.uow
        .reader()
        .selectFrom('calendar_entries')
        .select('resources')
        .where('organization_id', '=', organizationId)
        .where('event_id', '=', first.schedulingEventId)
        .executeTakeFirst();
      const names = (entry?.resources ?? []).map((r) => r.name).filter((n) => n.length > 0);
      field = names.length > 0 ? names.join(', ') : null;
    }
    return {
      subject: { type: 'season', id: season.id },
      name: season.name,
      scopeId: season.competitionId,
      facilityId: null,
      closed: season.status === 'archived',
      competitionName: season.competitionName,
      startsOn: season.startsOn,
      endsOn: season.endsOn,
      registrationOpensAt: season.registrationOpensAt,
      registrationClosesAt: season.registrationClosesAt,
      firstGame: first ? { start: new Date(first.scheduledStart as Date), field } : null,
      locationLabel: null,
    };
  }

  private async offering(organizationId: string, offeringId: string): Promise<SubjectFacts | null> {
    const snapshot = await this.offerings.getOffering(organizationId, offeringId, this.clock.now());
    if (!snapshot) return null;
    const offering = snapshot.offering;
    return {
      subject: { type: 'offering', id: offering.id },
      name: offering.name,
      scopeId: offering.programId,
      facilityId: offering.facilityId,
      closed: offering.publicationState === 'archived',
      competitionName: null,
      startsOn: offering.startsOn,
      endsOn: offering.endsOn,
      registrationOpensAt: offering.registrationOpensAt
        ? new Date(offering.registrationOpensAt)
        : null,
      registrationClosesAt: offering.registrationClosesAt
        ? new Date(offering.registrationClosesAt)
        : null,
      firstGame: null,
      locationLabel: offering.locationLabel,
    };
  }

  /**
   * The audience of the record's messages right now: the teams entered in a season (their
   * rosters, captains and the guardians of child players are resolved by the notification path),
   * or the participants enrolled in an offering (themselves, or their guardians). Called when a
   * message is previewed and again when it is sent; nothing is stored (SPK-COMMS-003).
   */
  async audience(organizationId: string, subject: MessageSubject): Promise<SubjectAudience> {
    if (subject.type === 'season') {
      const entries = await this.entries.listSeasonEntries(organizationId, subject.id);
      return {
        teamEntryIds: entries
          .filter((e) => this.policy.seasonAudienceEntryStatuses.includes(e.status))
          .map((e) => e.id)
          .sort(),
        subjectPersonIds: [],
      };
    }
    return {
      teamEntryIds: [],
      subjectPersonIds: await this.sessionAudience.participantsOfOffering(
        this.uow.reader(),
        organizationId,
        subject.id,
      ),
    };
  }
}
