import { newId, type EligibilityEvaluation } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../testing';
import { createPersonFixture } from '../../identity';
import { at as localAt, seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { EligibilityService, type RosterPlayer } from '../services/eligibility.service';
import { createSuspensionFixture } from '../testing/competition-matches-fixtures';
import {
  addRosterMemberFixture,
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  type SeasonFixture,
} from '../testing/competition-fixtures';
import { adultCustomer, competitionTestApp, key, staffMember, type Actor } from './support';

const ZONE = 'America/Los_Angeles';

/**
 * R4-CARRY-01 (R3-PERFORMANCE-01 part 1; §4.12, SPK-UX-006, SPK-STAFF-002): readiness evaluates a
 * whole roster in one eligibility evaluation whose reads do not grow with the roster, and that
 * evaluation decides exactly as the single-player evaluation does, rule by rule.
 */
describe('roster eligibility (R4-CARRY-01; SPK-CAP-004, SPK-COMP-003/005, SPK-AT-013)', () => {
  let t: TestApp;
  let leagueManager: Actor;
  let pitch: PitchFixture;
  let season: SeasonFixture;
  let eligibility: EligibilityService;
  let divisionId: string;
  let home: string;
  let fixtureId: string;
  let kickoff: Date;
  const players: Array<RosterPlayer & { label: string }> = [];

  async function entry(division: string, name: string): Promise<string> {
    const captain = await adultCustomer(t);
    const created = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      captainPersonId: captain.personId,
      teamName: name,
      divisionId: division,
    });
    return created.teamEntryId;
  }

  async function person(dateOfBirth: string | null, kind: 'adult' | 'child' = 'adult') {
    return createPersonFixture(t, { kind, dateOfBirth });
  }

  async function scheduled(
    homeEntryId: string,
    awayEntryId: string,
    resourceId: string,
  ): Promise<string> {
    const res = await t.http
      .post('/v1/fixtures')
      .set(leagueManager.header)
      .set('Idempotency-Key', key())
      .send({
        seasonId: season.seasonId,
        divisionId,
        homeEntryId,
        awayEntryId,
        schedule: {
          facilityId: t.facilityId,
          resourceIds: [resourceId],
          scheduledStart: localAt('2027-02-06', '18:00'),
          scheduledEnd: localAt('2027-02-06', '19:00'),
        },
      });
    expect(res.status).toBe(201);
    return res.body.fixture.id as string;
  }

  beforeAll(async () => {
    t = await competitionTestApp();
    eligibility = t.app.get(EligibilityService);
    leagueManager = await staffMember(t, ['league_manager']);
    pitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 1',
    });
    season = await createSeasonFixture(t, {
      status: 'active',
      startsOn: '2027-01-10',
      endsOn: '2027-04-30',
      ruleSet: {
        // Every rule that reads a player fact is switched on, so each one is exercised below.
        eligibilityReferenceDate: { rule: 'match_date' },
        multiTeamRestrictions: {
          maxEntriesPerSeason: 1,
          allowSameDivision: false,
          allowCrossDivision: false,
        },
        roster: {
          guestPlayersAllowed: false,
          guestMaxConcurrent: 3,
          substitutesAllowed: false,
          guestOrSubstituteRequiresApproval: true,
          coCaptainMayActAsCaptain: false,
        },
      },
    });
    divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Open 18-45',
      criteria: { ageBand: { minAge: 18, maxAge: 45 } },
    });
    const otherDivision = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Second division',
    });
    home = await entry(divisionId, 'Home');
    const away = await entry(divisionId, 'Away');
    const other = await entry(divisionId, 'Other');
    const fourth = await entry(divisionId, 'Fourth');
    const cross = await entry(otherDivision, 'Cross');

    const add = async (
      label: string,
      personId: string,
      membershipStatus: RosterPlayer['membershipStatus'] = 'active',
    ) => {
      await addRosterMemberFixture(t, { teamEntryId: home, personId, status: membershipStatus });
      players.push({ label, personId, membershipStatus });
      return personId;
    };
    await add('eligible', await person('1990-05-01'));
    await add('below age band', await person('2015-01-01', 'child'));
    await add('above age band', await person('1950-01-01'));
    await add('date of birth unknown', await person(null));
    const suspended = await add('suspended', await person('1990-05-01'));
    await createSuspensionFixture(t, { subjectPersonId: suspended });
    const sameDivision = await add('same division', await person('1990-05-01'));
    await addRosterMemberFixture(t, { teamEntryId: other, personId: sameDivision });
    const crossDivision = await add('cross division', await person('1990-05-01'));
    await addRosterMemberFixture(t, { teamEntryId: cross, personId: crossDivision });
    const opposing = await add('opposing roster', await person('1990-05-01'));
    await addRosterMemberFixture(t, { teamEntryId: away, personId: opposing });
    await add('guest', await person('1990-05-01'), 'guest');
    await add('substitute', await person('1990-05-01'), 'substitute');
    const inactive = await add('inactive person', await person('1990-05-01'));
    // Identity owns persons; this fixture sets the state its commands would leave.
    await t.db
      .updateTable('persons')
      .set({ status: 'inactive' })
      .where('id', '=', inactive)
      .execute();
    // CMP-08: a person merged into a rostered survivor brings their suspension and their other
    // team (which plays at the same time) with them.
    const survivor = await add('merged survivor', await person('1990-05-01'));
    const merged = await person('1990-05-01');
    await createSuspensionFixture(t, { subjectPersonId: merged });
    await addRosterMemberFixture(t, { teamEntryId: fourth, personId: merged });
    await t.db
      .updateTable('persons')
      .set({ status: 'merged', merged_into_person_id: survivor })
      .where('id', '=', merged)
      .execute();
    players.push({ label: 'unknown person', personId: newId(), membershipStatus: 'active' });

    fixtureId = await scheduled(home, away, pitch.northHalfId);
    await scheduled(other, fourth, pitch.southHalfId);
    const row = await t.db
      .selectFrom('fixtures')
      .select('scheduled_start')
      .where('id', '=', fixtureId)
      .executeTakeFirstOrThrow();
    kickoff = new Date(row.scheduled_start as Date | string);
  });
  afterAll(async () => {
    await t.close();
  });

  const single = async (
    options: Parameters<EligibilityService['evaluateRoster']>[4],
    when: Date,
  ): Promise<EligibilityEvaluation[]> => {
    const out: EligibilityEvaluation[] = [];
    for (const player of players) {
      out.push(
        await eligibility.evaluatePlayer(t.organizationId, home, player.personId, when, {
          ...options,
          membershipStatus: player.membershipStatus,
        }),
      );
    }
    return out;
  };
  const codesByLabel = (evaluations: EligibilityEvaluation[]) =>
    Object.fromEntries(
      evaluations.map((e, i) => [players[i]?.label, e.reasons.map((r) => r.code).sort()]),
    );

  it('R4-CARRY-01 / SPK-CAP-004 / SPK-READY-002: readiness of an existing roster: evaluateRoster decides every player exactly as evaluatePlayer does (age band, unknown date of birth, membership limits, suspension, roster status, opposing roster, conflicting fixture, merged persons, unknown and inactive people)', async () => {
    const options = { existingMembership: true, fixtureId, timezone: ZONE };
    const expected = await single(options, kickoff);
    const roster = await eligibility.evaluateRoster(
      t.organizationId,
      home,
      players,
      kickoff,
      options,
    );
    expect(roster).toEqual(expected);
    // Not a vacuous comparison: every rule fires for the player built to trigger it.
    expect(codesByLabel(roster)).toEqual({
      eligible: [],
      'below age band': ['below_division_age'],
      'above age band': ['above_division_age'],
      'date of birth unknown': ['date_of_birth_unknown'],
      suspended: ['suspended'],
      'same division': ['already_in_division', 'conflicting_fixture', 'multi_team_limit'],
      'cross division': ['cross_division_not_allowed', 'multi_team_limit'],
      'opposing roster': ['already_in_division', 'multi_team_limit', 'opposing_roster'],
      guest: ['guests_not_allowed'],
      substitute: ['substitutes_not_allowed'],
      'inactive person': ['person_inactive'],
      'merged survivor': [
        'already_in_division',
        'conflicting_fixture',
        'multi_team_limit',
        'suspended',
      ],
      'unknown person': ['person_not_found'],
    });
    expect(roster.map((e) => e.eligible)).toEqual(players.map((p) => p.label === 'eligible'));
  });

  it('R4-CARRY-01 / SPK-COMP-005 / SPK-CAP-002: the same players as backdated additions for a restricted caller decide alike (open roster rows, roster limits, approvals, suspensions checked now as well)', async () => {
    const yesterday = new Date(t.clock.now().getTime() - 24 * 3600_000);
    const options = { existingMembership: false, restricted: true, timezone: ZONE };
    const expected = await single(options, yesterday);
    const roster = await eligibility.evaluateRoster(
      t.organizationId,
      home,
      players,
      yesterday,
      options,
    );
    expect(roster).toEqual(expected);
    const codes = codesByLabel(roster);
    expect(codes['eligible']).toEqual(['already_on_roster']);
    // The suspension starts now: an addition dated yesterday is still checked against it.
    expect(codes['suspended']).toEqual(['already_on_roster', 'suspended']);
    expect(codes['guest']).toEqual([
      'already_on_roster',
      'approval_required',
      'guests_not_allowed',
    ]);
    // Restricted callers never see restricted record ids.
    const suspension = roster[players.findIndex((p) => p.label === 'suspended')]?.reasons.find(
      (r) => r.code === 'suspended',
    );
    expect(suspension?.source).toEqual({ type: 'suspension', id: null });
  });

  it('R4-CARRY-01 / §4.12 / SPK-STAFF-002: the competition reads of a roster evaluation do not grow with the roster; only identity’s per-person reads do (their many-ids form is deferred to identity)', async () => {
    const division = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      name: 'Query count',
    });
    const small = await entry(division, 'Small');
    const large = await entry(division, 'Large');
    const rosterOf = async (teamEntryId: string, size: number): Promise<RosterPlayer[]> => {
      const out: RosterPlayer[] = [];
      for (let i = 0; i < size; i += 1) {
        const personId = await person('1990-05-01');
        await addRosterMemberFixture(t, { teamEntryId, personId });
        out.push({ personId, membershipStatus: 'active' });
      }
      return out;
    };
    const smallRoster = await rosterOf(small, 3);
    const largeRoster = await rosterOf(large, 12);
    const match = await createFixtureFixture(t, {
      seasonId: season.seasonId,
      divisionId: division,
      homeEntryId: small,
      awayEntryId: large,
    });
    const executor = t.db.getExecutor();
    const count = async (teamEntryId: string, roster: RosterPlayer[]) => {
      const spy = vi.spyOn(executor, 'executeQuery');
      try {
        const evaluations = await eligibility.evaluateRoster(
          t.organizationId,
          teamEntryId,
          roster,
          kickoff,
          { existingMembership: true, fixtureId: match, timezone: ZONE },
        );
        expect(evaluations).toHaveLength(roster.length);
        const statements = spy.mock.calls.map(([query]) => query.sql);
        const identity = statements.filter((s) => /\bpersons\b/.test(s));
        return { competition: statements.length - identity.length, identity: identity.length };
      } finally {
        spy.mockRestore();
      }
    };
    const few = await count(small, smallRoster);
    const many = await count(large, largeRoster);
    expect(few.competition).toBeGreaterThan(0);
    expect(many.competition).toBe(few.competition);
    // Identity answers one person at a time today (R4-CARRY-01 deferred): proportional to the roster.
    expect(many.identity / largeRoster.length).toBe(few.identity / smallRoster.length);
  });
});
