import { Inject, Injectable } from '@nestjs/common';
import { errors, type MatchSheet, type Principal } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuthorizationService, CLOCK, DATABASE, executorFor, type Clock } from '../../../kernel';
import { PeopleService } from '../../identity';
import { MatchActions } from '../competition-matches.actions';
import { ASSIGNMENT_CHECK_PORT, type AssignmentCheckPort } from '../competition-matches.ports';
import { teamNamesOf } from '../competition.queries';
import { organizationOf } from '../competition.shared';
import { FixturesService } from './fixtures.service';
import { RosterService } from './roster.service';

/** League staff who read the full match sheet by their role alone. */
const LEAGUE_STAFF = ['league_manager', 'general_manager', 'system_administrator'] as const;

/**
 * The field-limited match sheet (CMP-06; SPK-UX-007, SPK-STAFF-002/005, SPK-CAP-002, §4.14,
 * SCR-W-03, SCR-W-05): the effective rosters at kickoff with display names, jersey numbers,
 * playing status and team roles; never dates of birth, contacts, eligibility reasons, suspension
 * details or guardian data. League staff read it by role; an official only with an accepted
 * assignment for the fixture (ASSIGNMENT_CHECK_PORT; proposed or offered do not count, and
 * without workforce no official is accepted); a captain of either side reads names and numbers
 * only. Anyone else gets protected NOT_FOUND (§4.10).
 */
@Injectable()
export class MatchSheetService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
    private readonly fixtures: FixturesService,
    private readonly roster: RosterService,
    private readonly people: PeopleService,
    @Inject(ASSIGNMENT_CHECK_PORT) private readonly assignments: AssignmentCheckPort,
  ) {}

  async get(principal: Principal, fixtureId: string): Promise<MatchSheet> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const fixture = await this.fixtures.loadFixture(db, organizationId, fixtureId);
    if (!fixture) throw errors.protectedNotFound('fixture');
    const view = await this.viewOf(principal, fixture);
    if (!view) throw errors.protectedNotFound('fixture');
    const at = fixture.scheduled_start ? new Date(fixture.scheduled_start) : this.clock.now();
    const sides = [fixture.home_entry_id, fixture.away_entry_id].filter(
      (id): id is string => id !== null,
    );
    const names = await teamNamesOf(db, organizationId, sides);
    const out: MatchSheet['sides'] = [];
    for (const entryId of sides) {
      const members = await this.roster.effectiveRoster(organizationId, entryId, at);
      const players: MatchSheet['sides'][number]['players'] = [];
      for (const member of members) {
        const person = await this.people.loadPerson(db, organizationId, member.personId);
        const displayName = person
          ? `${person.given_name} ${person.family_name}`.trim()
          : 'Unknown person';
        players.push(
          view === 'full'
            ? {
                personId: member.personId,
                displayName,
                jerseyNumber: member.jerseyNumber,
                playingStatus: member.status,
                roles: member.roles,
              }
            : {
                // SPK-CAP-002: a captain sees names and numbers only.
                personId: null,
                displayName,
                jerseyNumber: member.jerseyNumber,
                playingStatus: null,
                roles: [],
              },
        );
      }
      players.sort(
        (a, b) =>
          (a.jerseyNumber ?? Number.MAX_SAFE_INTEGER) -
            (b.jerseyNumber ?? Number.MAX_SAFE_INTEGER) ||
          a.displayName.localeCompare(b.displayName),
      );
      out.push({ entryId, teamName: names.get(entryId) ?? 'Unknown team', players });
    }
    return {
      fixtureId: fixture.id,
      scheduledStart: fixture.scheduled_start
        ? new Date(fixture.scheduled_start).toISOString()
        : null,
      status: fixture.status,
      venue: await this.fixtures.venueOf(db, fixture),
      view,
      sides: out,
    };
  }

  /** Which view the principal holds, or null (no basis: protected NOT_FOUND). */
  private async viewOf(
    principal: Principal,
    fixture: {
      id: string;
      organization_id: string;
      home_entry_id: string;
      away_entry_id: string | null;
    },
  ): Promise<MatchSheet['view'] | null> {
    const organizationId = fixture.organization_id;
    const base = { type: 'fixture', id: fixture.id, organizationId, protected: true };
    if (principal.kind === 'system') return 'full';
    if (principal.kind === 'staff') {
      const staffDecision = await this.authorization.decide(
        principal,
        MatchActions.readMatchSheet,
        base,
      );
      if (staffDecision.allowed) {
        if (principal.staffRoles.some((r) => (LEAGUE_STAFF as readonly string[]).includes(r))) {
          return 'full';
        }
        // An official needs an accepted assignment for this fixture (SPK-STAFF-002).
        if (
          principal.personId &&
          (await this.assignments.isAcceptedOfficial(
            organizationId,
            fixture.id,
            principal.personId,
          ))
        ) {
          return 'full';
        }
      }
    }
    for (const entryId of [fixture.home_entry_id, fixture.away_entry_id]) {
      if (!entryId) continue;
      const captain = await this.authorization.decide(principal, MatchActions.readMatchSheet, {
        ...base,
        teamEntryId: entryId,
      });
      if (captain.allowed && captain.basis.startsWith('team_role')) return 'captain';
    }
    return null;
  }
}
