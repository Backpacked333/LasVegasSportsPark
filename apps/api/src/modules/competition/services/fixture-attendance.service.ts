import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ActorSnapshot,
  type FixtureAttendance,
  type FixtureAttendanceMark,
  type Principal,
  type RecordFixtureAttendanceInput,
} from '@sportspark/contracts';
import { json, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  executorFor,
  snapshotActor,
  type ActionDefinition,
  type Clock,
} from '../../../kernel';
import { FieldActions } from '../competition-field.actions';
import { FieldEvents } from '../competition-field.events';
import {
  latestAttendanceMarks,
  currentAttendanceMark,
  type AttendanceMarkRow,
} from '../competition-field.queries';
import { ASSIGNMENT_CHECK_PORT, type AssignmentCheckPort } from '../competition-matches.ports';
import { fixtureFacilityId, type Reader } from '../competition.queries';
import { iso, organizationOf, PLAYING_STATUSES } from '../competition.shared';
import { FixturesService } from './fixtures.service';
import { RosterService } from './roster.service';

/** League staff who act on any side of a fixture by their role alone. */
const LEAGUE_STAFF = ['league_manager', 'general_manager', 'system_administrator'] as const;

interface FixtureSides {
  id: string;
  organization_id: string;
  home_entry_id: string;
  away_entry_id: string | null;
  venue_facility_id: string | null;
  division_id: string | null;
}

export function toAttendanceMark(row: AttendanceMarkRow): FixtureAttendanceMark {
  return {
    id: row.id,
    fixtureId: row.fixture_id,
    teamEntryId: row.team_entry_id,
    personId: row.person_id,
    state: row.state,
    recordedBy: row.recorded_by as unknown as ActorSnapshot,
    recordedAt: iso(row.recorded_at),
  };
}

/**
 * Fixture attendance: player check-in on the match sheet (SPK-UX-007 field-side work,
 * SPK-STAFF-005 required confirmation, SPK-CAP-003 RSVP is neither attendance nor eligibility;
 * migration 0465). League staff and an official holding an accepted assignment for the fixture
 * (SPK-STAFF-002, ASSIGNMENT_CHECK_PORT; proposed or offered do not count) mark either side; a
 * captain marks their own side only. Anyone else gets protected NOT_FOUND (§4.10). A mark names
 * a player on the side's roster at kickoff (SPK-COMP-005) and is taken while the fixture is
 * scheduled; each mark supersedes the player's previous one (append-only chain).
 */
@Injectable()
export class FixtureAttendanceService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly fixtures: FixturesService,
    private readonly roster: RosterService,
    @Inject(ASSIGNMENT_CHECK_PORT) private readonly assignments: AssignmentCheckPort,
  ) {}

  /** `GET /v1/fixtures/{id}/attendance`: the sides the caller may see, each player's current mark. */
  async get(principal: Principal, fixtureId: string): Promise<FixtureAttendance> {
    const organizationId = organizationOf(principal);
    const db = executorFor(this.db);
    const fixture = await this.fixtures.loadFixture(db, organizationId, fixtureId);
    if (!fixture) throw errors.protectedNotFound('fixture');
    const sides = await this.sidesFor(db, principal, fixture, FieldActions.readFixtureAttendance);
    if (sides.length === 0) throw errors.protectedNotFound('fixture');
    const marks = (await latestAttendanceMarks(db, organizationId, [fixtureId])).filter(
      (m) => m.state !== 'cleared',
    );
    return {
      fixtureId,
      sides: sides.map((teamEntryId) => {
        const own = marks.filter((m) => m.team_entry_id === teamEntryId);
        return {
          teamEntryId,
          present: own.filter((m) => m.state === 'present').length,
          absent: own.filter((m) => m.state === 'absent').length,
          marks: own.map(toAttendanceMark),
        };
      }),
    };
  }

  /** `POST /v1/fixtures/{id}/attendance`: mark a player present or absent, or clear the mark. */
  async record(
    principal: Principal,
    fixtureId: string,
    input: RecordFixtureAttendanceInput,
    correlationId: string | null,
  ): Promise<FixtureAttendanceMark> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      // The fixture row lock serializes marks of the fixture; the chain indexes are the guarantee.
      const fixture = await this.fixtures.loadFixture(trx, organizationId, fixtureId, {
        forUpdate: true,
      });
      if (!fixture) throw errors.protectedNotFound('fixture');
      if (
        input.teamEntryId !== fixture.home_entry_id &&
        input.teamEntryId !== fixture.away_entry_id
      ) {
        throw errors.protectedNotFound('fixture');
      }
      const sides = await this.sidesFor(
        trx,
        principal,
        fixture,
        FieldActions.recordFixtureAttendance,
      );
      if (!sides.includes(input.teamEntryId)) throw errors.protectedNotFound('fixture');
      if (fixture.status !== 'scheduled') {
        throw errors.invalidTransition('Fixture', fixture.status, 'record_attendance');
      }
      const at = fixture.scheduled_start ? new Date(fixture.scheduled_start) : this.clock.now();
      const members = await this.roster.effectiveRoster(organizationId, input.teamEntryId, at, trx);
      const member = members.find(
        (m) => m.personId === input.personId && PLAYING_STATUSES.includes(m.status),
      );
      if (!member) {
        throw errors.validation('The person is not on this side’s roster at kickoff.', {
          code: 'NOT_ON_ROSTER',
          personId: input.personId,
          teamEntryId: input.teamEntryId,
        });
      }
      const previous = await currentAttendanceMark(
        trx,
        organizationId,
        fixtureId,
        input.teamEntryId,
        input.personId,
      );
      if (!previous && input.state === 'cleared') {
        throw errors.invalidTransition('FixtureAttendance', 'unmarked', 'clear');
      }
      const now = this.clock.now();
      const id = newId();
      const row = await trx
        .insertInto('fixture_attendance_marks')
        .values({
          id,
          organization_id: organizationId,
          fixture_id: fixtureId,
          team_entry_id: input.teamEntryId,
          person_id: input.personId,
          state: input.state,
          supersedes_mark_id: previous?.id ?? null,
          recorded_by: json(snapshotActor(principal)),
          recorded_by_person_id: principal.personId,
          recorded_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: FieldActions.recordFixtureAttendance.id,
        targetType: 'fixture_attendance_mark',
        targetId: id,
        afterRevision: 1,
        reason: input.reason ?? null,
        correlationId,
        details: {
          fixtureId,
          teamEntryId: input.teamEntryId,
          personId: input.personId,
          state: input.state,
          previousState: previous?.state ?? null,
          supersedesMarkId: previous?.id ?? null,
        },
      });
      await this.outbox.enqueue(trx, FieldEvents.fixtureAttendanceRecorded, {
        organizationId,
        aggregateType: 'fixture',
        aggregateId: fixtureId,
        payload: {
          markId: id,
          fixtureId,
          teamEntryId: input.teamEntryId,
          personId: input.personId,
          state: input.state,
        },
        correlationId,
      });
      return toAttendanceMark(row);
    });
  }

  /**
   * The sides the principal may act on for `action`: both for league staff (by role, in the
   * fixture's facility) and for an official with an accepted assignment for the fixture; a
   * captain's own side; otherwise none.
   */
  async sidesFor(
    db: Reader,
    principal: Principal,
    fixture: FixtureSides,
    action: ActionDefinition,
  ): Promise<string[]> {
    const organizationId = fixture.organization_id;
    const all = [fixture.home_entry_id, fixture.away_entry_id].filter(
      (id): id is string => id !== null,
    );
    if (principal.kind === 'system') return principal.organizationId === organizationId ? all : [];
    const base = { type: 'fixture', id: fixture.id, organizationId, protected: true };
    if (principal.kind === 'staff') {
      const staff = await this.authorization.decide(principal, action, {
        ...base,
        facilityId: await fixtureFacilityId(db, organizationId, fixture),
      });
      if (staff.allowed) {
        if (principal.staffRoles.some((r) => (LEAGUE_STAFF as readonly string[]).includes(r))) {
          return all;
        }
        if (
          principal.personId &&
          (await this.assignments.isAcceptedOfficial(
            organizationId,
            fixture.id,
            principal.personId,
          ))
        ) {
          return all;
        }
      }
    }
    const own: string[] = [];
    for (const teamEntryId of all) {
      const captain = await this.authorization.decide(principal, action, {
        ...base,
        teamEntryId,
      });
      if (captain.allowed && captain.basis.startsWith('team_role')) own.push(teamEntryId);
    }
    return own;
  }
}
