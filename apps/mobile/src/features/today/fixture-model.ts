/**
 * The SCR-C-04 card and SCR-C-20 detail of a fixture as the customer sees it (SPK-UX-004,
 * SPK-CAP-003, SPK-SCHED-008), from what the API answers:
 *
 * - `GET /v1/me/fixtures` and `GET /v1/fixtures/{id}` (FixtureDetail): the teams, time, state,
 *   `venue` (facility name, IANA zone and pitches, CMP-04), `rosterStatus` (the viewer's playing
 *   status, null when not on a roster) and `responses` (the viewer's answer and those of people
 *   they hold `register` over, each with the revision to send back, CMP-04);
 * - `GET /v1/me/team-entries`: which entries the viewer and the people they may view are on, so
 *   the card can say whose fixture it is and who the opponent is (CMP-02).
 *
 * Nothing here decides who may see or answer what; the API's answers do.
 */
import type { Schema } from '@sportspark/api-client';
import type { ActivityCardModel } from './NextActivityCard';
import type { ScheduleChange } from './notices';
import { UNNAMED_PERSON } from './queries';
import { fixtureAcceptsRsvp, fixtureStatus } from './status';
import { zoneOf } from './time';

type FixtureDetail = Schema<'FixtureDetail'>;
type FixtureSide = Schema<'FixtureSide'>;
type FixtureVenue = Schema<'FixtureVenue'>;
type FixtureResponse = Schema<'FixtureResponse'>;
type MyTeamEntry = Schema<'MyTeamEntry'>;

export function awayOf(fixture: FixtureDetail): FixtureSide | null {
  return fixture.away ?? null;
}

export function venueOf(fixture: FixtureDetail): FixtureVenue | null {
  return fixture.venue ?? null;
}

export function fixtureTitle(fixture: FixtureDetail): string {
  const away = awayOf(fixture);
  return away ? `${fixture.home.teamName} vs ${away.teamName}` : `${fixture.home.teamName} (bye)`;
}

/** "Main Park, Pitch 2": the facility and pitches as the venue states them; null without one. */
export function venueLocation(
  venue: FixtureVenue | null,
  resourceNames?: readonly string[],
): string | null {
  const pitches = resourceNames && resourceNames.length > 0 ? resourceNames : null;
  const parts = [venue?.facilityName, ...(pitches ?? venue?.resources.map((r) => r.name) ?? [])];
  const text = parts.filter((p): p is string => !!p).join(', ');
  return text || null;
}

/** The side of `fixture` whose entry is one of the viewer's teams (`GET /v1/me/team-entries`). */
export function mySide(
  fixture: FixtureDetail,
  teams: readonly MyTeamEntry[] | undefined,
): { side: 'home' | 'away'; team: MyTeamEntry } | null {
  if (!teams) return null;
  const home = teams.find((t) => t.teamEntry.id === fixture.home.entryId);
  if (home) return { side: 'home', team: home };
  const awayId = awayOf(fixture)?.entryId;
  const away = awayId ? teams.find((t) => t.teamEntry.id === awayId) : undefined;
  return away ? { side: 'away', team: away } : null;
}

/** "You", "Sam", "You and Sam", "You, Sam and Jo". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The viewer's own recorded answer (CMP-04 `responses`), or null when none is listed. */
export function ownResponse(
  fixture: FixtureDetail,
  viewerId: string | null | undefined,
): FixtureResponse | null {
  if (!viewerId) return null;
  return (fixture.responses ?? []).find((r) => r.personId === viewerId) ?? null;
}

/** Answers the API lists for other people (children the viewer holds `register` over). */
export function otherResponses(
  fixture: FixtureDetail,
  viewerId: string | null | undefined,
): FixtureResponse[] {
  return (fixture.responses ?? []).filter((r) => r.personId !== viewerId);
}

/**
 * Whether the viewer is on a roster of the fixture: `rosterStatus` is null when not; a fixture
 * read without the field says nothing, and the API still decides when an answer is sent.
 */
export function viewerOnRoster(fixture: FixtureDetail): boolean | null {
  if (fixture.rosterStatus === undefined) return null;
  return fixture.rosterStatus !== null;
}

/** SCR-C-04 "required action" for an open availability request the viewer has not answered. */
export const AVAILABILITY_REQUEST_ACTION = 'Answer the availability request for this fixture.';

/**
 * The card's required action (SCR-C-04, SPK-UX-003 "actions required before participation"): an
 * open `availability_request` notice about the fixture (COM-06) while the fixture still takes
 * answers and the viewer, on a roster, has not answered. A viewer the fixture read places on no
 * roster (a guardian; answering for a child is DEC-090) is told so by the RSVP control instead.
 */
export function fixtureRequiredAction(
  fixture: FixtureDetail,
  viewerId: string | null | undefined,
  request: { kind: string } | null,
): string | null {
  if (!request || !fixtureAcceptsRsvp(fixture.status)) return null;
  if (viewerOnRoster(fixture) === false) return null;
  const answer = ownResponse(fixture, viewerId)?.state ?? fixture.myResponse ?? null;
  if (answer && answer !== 'no_response') return null;
  return AVAILABILITY_REQUEST_ACTION;
}

export interface FixtureCardInput {
  fixture: FixtureDetail;
  teams: readonly MyTeamEntry[] | undefined;
  names: Map<string, string>;
  /** The newest schedule notice about the fixture's event, for old and new details. */
  change: ScheduleChange | null;
  /** From `fixtureRequiredAction`; none when absent. */
  requiredAction?: string | null;
}

/** The SCR-C-04 card of a fixture: whose it is, opponent, venue, time on the facility clock. */
export function fixtureCardModel({
  fixture,
  teams,
  names,
  change,
  requiredAction = null,
}: FixtureCardInput): ActivityCardModel {
  const mine = mySide(fixture, teams);
  const away = awayOf(fixture);
  const venue = venueOf(fixture);
  const members = mine?.team.members.map((m) => names.get(m.personId) ?? UNNAMED_PERSON) ?? [];
  const participant = mine
    ? members.length > 0
      ? `${joinNames(members)} (${mine.team.teamName})`
      : mine.team.teamName
    : 'Your team';
  const opponent = mine
    ? mine.side === 'home'
      ? (away?.teamName ?? null)
      : fixture.home.teamName
    : null;
  const after = change?.after ?? null;
  const noticePitches = after?.resources.map((r) => r.name) ?? [];
  return {
    participant,
    title: fixtureTitle(fixture),
    opponent,
    location: venueLocation(venue, noticePitches),
    // The fixture read is the current state; a notice only fills in what it lacks.
    start: fixture.scheduledStart ?? after?.scheduledStart ?? null,
    end: fixture.scheduledEnd ?? after?.scheduledEnd ?? null,
    zone: zoneOf(after?.timezone, change?.before?.timezone, venue?.timezone),
    status: fixtureStatus(fixture.status),
    change,
    requiredAction,
  };
}
