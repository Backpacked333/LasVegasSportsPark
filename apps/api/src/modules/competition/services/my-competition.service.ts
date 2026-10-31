import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  MY_FIXTURES_MAX_DAYS,
  type FixtureDetail,
  type MyFixturesQuery,
  type MyTeamEntriesQuery,
  type MyTeamEntry,
  type Principal,
  type RosterPlayingStatus,
  type TeamEntryStatus,
  type TeamRoleValue,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import { AuthorizationService, CLOCK, DATABASE, executorFor, type Clock } from '../../../kernel';
import { PERSON_DIRECTORY_PORT, type PersonDirectoryPort } from '../../identity';
import { CompetitionActions } from '../competition.actions';
import { loadEntryContext, teamNamesOf, type Reader } from '../competition.queries';
import { organizationOf } from '../competition.shared';
import { FixturesService } from './fixtures.service';
import { countsOf, ReadinessService } from './readiness.service';
import { TeamEntriesService } from './team-entries.service';

const DAY_MS = 86_400_000;
const LIVE_STATUSES: readonly TeamEntryStatus[] = ['applied', 'approved'];

interface Membership {
  /** The subject as the caller knows them (the surviving person after a merge). */
  personId: string;
  roles: Set<TeamRoleValue>;
  rosterStatus: RosterPlayingStatus | null;
}

/**
 * "My teams" and "my fixtures" (CMP-02; SPK-CAP-001, SPK-UX-002, SCR-C-04, SCR-C-21). The people
 * a customer list starts from are the kernel's `customerSubjects` of the team-entry read action
 * (themselves, and everyone over whom they hold `view`, IF-02), each expanded with the person
 * directory's merge history (`personIdsResolvingTo`, IF-09) so memberships recorded under a
 * merged person still show. A guardian without view over a child never lists that child's team.
 */
@Injectable()
export class MyCompetitionService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authorization: AuthorizationService,
    @Inject(PERSON_DIRECTORY_PORT) private readonly directory: PersonDirectoryPort,
    private readonly entries: TeamEntriesService,
    private readonly fixtures: FixturesService,
    private readonly readiness: ReadinessService,
  ) {}

  /** `GET /v1/me/team-entries`: live entries unless a status is asked for. */
  async teamEntries(principal: Principal, query: MyTeamEntriesQuery): Promise<MyTeamEntry[]> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const now = this.clock.now();
    const byEntry = await this.memberships(db, principal, now);
    const statuses = query.status ? [query.status] : LIVE_STATUSES;
    const out: MyTeamEntry[] = [];
    for (const [teamEntryId, members] of byEntry) {
      const context = await loadEntryContext(db, organizationId, teamEntryId);
      if (!context || !statuses.includes(context.entry.status)) continue;
      out.push({
        teamEntry: await this.entries.entryView(db, context, now),
        teamName: context.team.name,
        seasonId: context.season.id,
        seasonName: context.season.name,
        divisionName: context.division?.name ?? null,
        members: [...members.values()]
          .map((m) => ({
            personId: m.personId,
            roles: [...m.roles].sort(),
            rosterStatus: m.rosterStatus,
          }))
          .sort((a, b) => a.personId.localeCompare(b.personId)),
        nextFixture: await this.nextFixture(db, principal, teamEntryId, now),
      });
    }
    return out.sort(
      (a, b) =>
        a.teamName.localeCompare(b.teamName) || a.teamEntry.id.localeCompare(b.teamEntry.id),
    );
  }

  /**
   * `GET /v1/me/fixtures?from&to`: the fixtures of the live entries the caller and the people they
   * may view are on, scheduled in the window (at most MY_FIXTURES_MAX_DAYS days; from defaults to
   * now and to to the end of that span).
   */
  async fixturesOf(principal: Principal, query: MyFixturesQuery): Promise<FixtureDetail[]> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const now = this.clock.now();
    const from = query.from ? new Date(query.from) : now;
    const to = query.to
      ? new Date(query.to)
      : new Date(from.getTime() + MY_FIXTURES_MAX_DAYS * DAY_MS);
    if (to.getTime() <= from.getTime()) {
      throw errors.validation('to must be after from.', { code: 'WINDOW_INVALID' });
    }
    if (to.getTime() - from.getTime() > MY_FIXTURES_MAX_DAYS * DAY_MS) {
      throw errors.validation(`The window may span at most ${MY_FIXTURES_MAX_DAYS} days.`, {
        code: 'WINDOW_TOO_LONG',
        maxDays: MY_FIXTURES_MAX_DAYS,
      });
    }
    const byEntry = await this.memberships(db, principal, now);
    const entryIds: string[] = [];
    for (const teamEntryId of byEntry.keys()) {
      const entry = await db
        .selectFrom('team_entries')
        .select('status')
        .where('organization_id', '=', organizationId)
        .where('id', '=', teamEntryId)
        .executeTakeFirst();
      if (entry && LIVE_STATUSES.includes(entry.status)) entryIds.push(teamEntryId);
    }
    if (entryIds.length === 0) return [];
    const rows = await db
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where((eb) =>
        eb.or([eb('home_entry_id', 'in', entryIds), eb('away_entry_id', 'in', entryIds)]),
      )
      .where('scheduled_start', '<', to)
      .where('scheduled_end', '>', from)
      .orderBy('scheduled_start')
      .orderBy('id')
      .execute();
    const out: FixtureDetail[] = [];
    for (const row of rows) out.push(await this.fixtures.detail(db, principal, row));
    return out;
  }

  /** Entries the caller's subjects are effectively on now (roster rows or team roles). */
  private async memberships(
    db: Reader,
    principal: Principal,
    now: Date,
  ): Promise<Map<string, Map<string, Membership>>> {
    const organizationId = organizationOf(principal);
    const subjects = await this.authorization.customerSubjects(
      principal,
      CompetitionActions.readTeamEntry,
    );
    const byEntry = new Map<string, Map<string, Membership>>();
    for (const subject of subjects) {
      const resolving = await this.directory.personIdsResolvingTo(organizationId, subject);
      const ids = resolving.length > 0 ? resolving : [subject];
      for (const id of ids) {
        for (const membership of await this.entries.entriesOfPerson(organizationId, id, now)) {
          const members = byEntry.get(membership.teamEntryId) ?? new Map<string, Membership>();
          const member = members.get(subject) ?? {
            personId: subject,
            roles: new Set<TeamRoleValue>(),
            rosterStatus: null,
          };
          for (const role of membership.roles) member.roles.add(role);
          member.rosterStatus ??= membership.membershipStatus;
          members.set(subject, member);
          byEntry.set(membership.teamEntryId, members);
        }
      }
    }
    return byEntry;
  }

  /** The entry's next (or current) scheduled game with its venue and readiness counts. */
  private async nextFixture(
    db: Reader,
    principal: Principal,
    teamEntryId: string,
    now: Date,
  ): Promise<MyTeamEntry['nextFixture']> {
    const organizationId = organizationOf(principal);
    const row = await db
      .selectFrom('fixtures')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where((eb) =>
        eb.or([eb('home_entry_id', '=', teamEntryId), eb('away_entry_id', '=', teamEntryId)]),
      )
      .where('status', '=', 'scheduled')
      .where('scheduled_end', '>', now)
      .orderBy(sql`scheduled_start asc nulls last`)
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    const opponentId = row.home_entry_id === teamEntryId ? row.away_entry_id : row.home_entry_id;
    const names = await teamNamesOf(db, organizationId, [opponentId]);
    const detail = await this.fixtures.detail(db, principal, row);
    const readiness = await this.readiness.assess(organizationId, detail, { restricted: true });
    return {
      fixtureId: row.id,
      scheduledStart: row.scheduled_start ? new Date(row.scheduled_start).toISOString() : null,
      opponentTeamName: opponentId ? (names.get(opponentId) ?? 'Unknown team') : null,
      venue: detail.venue,
      readiness: countsOf(readiness),
    };
  }
}
