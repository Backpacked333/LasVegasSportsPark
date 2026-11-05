import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../kernel';
import { TEST_CONFIG_ENV, type TestApp } from '../../../testing';
import { seedPitchWithHalves, type PitchFixture } from '../../scheduling';
import { WorkforceSettings } from '../workforce.settings';
import { createAssignmentFixture } from '../testing/workforce-fixtures';
import {
  adultCustomer,
  competitionWorld,
  expectPgError,
  post,
  scheduleFixture,
  staffMember,
  workforceTestApp,
  type Actor,
  type CompetitionWorld,
  type ScheduledFixture,
} from './support';

/**
 * Workforce policy values are configuration with no default (WRK-06; DEC-011, POL-033, rule
 * K-00 (i), IF-43). Absent, each applies its conservative behaviour: no turnaround (only overlaps
 * are refused, by the exclusion constraint), an uncovered required slot escalates at once, access
 * ends with the activity, no daily limit.
 */
describe('workforce policy settings without defaults (WRK-06)', () => {
  it('a malformed workforce setting refuses boot and an absent one reads as unset', () => {
    expect(WorkforceSettings.prefix).toBe('WORKFORCE_');
    expect(() =>
      loadConfig({ ...TEST_CONFIG_ENV, WORKFORCE_OFFICIAL_TURNAROUND_MINUTES: 'half an hour' }),
    ).toThrow(/WORKFORCE_OFFICIAL_TURNAROUND_MINUTES/);
    expect(() =>
      loadConfig({ ...TEST_CONFIG_ENV, WORKFORCE_OFFICIAL_MAX_ASSIGNMENTS_PER_DAY: '0' }),
    ).toThrow(/WORKFORCE_OFFICIAL_MAX_ASSIGNMENTS_PER_DAY/);
    expect(loadConfig({ ...TEST_CONFIG_ENV }).moduleSettings['workforce']).toEqual({});
  });

  /** Proposes, offers and lets the official accept; returns the final response. */
  async function acceptOfficial(
    t: TestApp,
    manager: Actor,
    official: Actor,
    game: ScheduledFixture,
    engagement: 'regular' | 'substitute' = 'regular',
  ) {
    const created = await post(t, '/v1/assignments', manager, {
      personId: official.personId,
      kind: 'official',
      targetType: 'fixture',
      targetId: game.fixtureId,
      role: 'referee',
      engagement,
      offer: true,
    });
    if (created.status !== 201) return created;
    return post(t, `/v1/assignments/${created.body.assignment.id}/accept`, official, {});
  }

  describe('with nothing configured', () => {
    let t: TestApp;
    let world: CompetitionWorld;
    let secondPitch: PitchFixture;
    let thirdPitch: PitchFixture;
    let referee: Actor;

    beforeAll(async () => {
      t = await workforceTestApp({ settings: {} });
      world = await competitionWorld(t);
      secondPitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Pitch 2',
      });
      thirdPitch = await seedPitchWithHalves(t.db, {
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        name: 'Pitch 3',
      });
      referee = await staffMember(t, ['official']);
    });
    afterAll(async () => {
      await t.close();
    });

    it('without settings back-to-back assignments are accepted and overlapping ones refused', async () => {
      const first = await scheduleFixture(t, world, {
        date: '2027-02-20',
        from: '18:00',
        to: '19:00',
      });
      // on other pitches, so only the official's own commitments can collide
      const next = await scheduleFixture(t, world, {
        date: '2027-02-20',
        from: '19:00',
        to: '20:00',
        resourceId: secondPitch.pitchId,
      });
      const clash = await scheduleFixture(t, world, {
        date: '2027-02-20',
        from: '18:30',
        to: '19:30',
        resourceId: thirdPitch.pitchId,
      });
      const a = await acceptOfficial(t, world.leagueManager, referee, first);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.assignment).toMatchObject({ turnaroundMinutes: 0, committedUntil: first.end });
      const b = await acceptOfficial(t, world.leagueManager, referee, next);
      expect(b.status, JSON.stringify(b.body)).toBe(200);
      // no daily limit either: two the same day are accepted

      const c = await acceptOfficial(t, world.leagueManager, referee, clash);
      expect(c.status, JSON.stringify(c.body)).toBe(409);
      expect(c.body.details.conflicts).toEqual([
        expect.objectContaining({ code: 'assignment_overlap' }),
      ]);
      // the database itself refuses the overlap (assignments_no_overlap)
      await expectPgError(
        createAssignmentFixture(t, {
          targetType: 'fixture',
          targetId: clash.fixtureId,
          personId: referee.personId,
          status: 'accepted',
          scheduledStart: clash.start,
          scheduledEnd: clash.end,
        }),
        '23P01',
      );
    });

    it('without an escalation window an uncovered slot raises its exception immediately', async () => {
      // five weeks ahead: far outside any window an operator might choose
      const game = await scheduleFixture(t, world, { date: '2027-02-27' });
      const requirement = await post(t, '/v1/assignment-requirements', world.leagueManager, {
        targetType: 'fixture',
        targetId: game.fixtureId,
        kind: 'official',
        role: 'referee',
        requiredCount: 1,
      });
      expect(requirement.status, JSON.stringify(requirement.body)).toBe(201);
      const accepted = await acceptOfficial(t, world.leagueManager, referee, game);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const withdrawn = await post(
        t,
        `/v1/assignments/${accepted.body.assignment.id}/withdraw`,
        world.leagueManager,
        { reason: 'Referee moved to the cup final' },
      );
      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
      expect(withdrawn.body.uncovered).toMatchObject({ role: 'referee', slot: 1 });
      const exception = await t.db
        .selectFrom('operational_exceptions')
        .select(['category', 'status', 'owner_queue'])
        .where('id', '=', withdrawn.body.uncovered.exceptionId)
        .executeTakeFirstOrThrow();
      expect(exception).toEqual({
        category: 'workforce.uncovered_assignment',
        status: 'open',
        owner_queue: 'league_manager',
      });
    });

    it('without trailing hours time-bounded access ends with the activity', async () => {
      const game = await scheduleFixture(t, world, { date: '2027-02-21' });
      const substitute = await adultCustomer(t);
      const accepted = await acceptOfficial(t, world.leagueManager, substitute, game, 'substitute');
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body.assignment.access).toMatchObject({
        status: 'granted',
        until: game.end,
      });
    });
  });

  describe('with a turnaround and a daily limit configured', () => {
    let t: TestApp;
    let world: CompetitionWorld;
    let referee: Actor;

    beforeAll(async () => {
      t = await workforceTestApp({
        settings: {
          WORKFORCE_OFFICIAL_TURNAROUND_MINUTES: '30',
          WORKFORCE_OFFICIAL_MAX_ASSIGNMENTS_PER_DAY: '1',
        },
      });
      world = await competitionWorld(t);
      referee = await staffMember(t, ['official']);
    });
    afterAll(async () => {
      await t.close();
    });

    it('with a turnaround configured an assignment inside it is refused', async () => {
      const first = await scheduleFixture(t, world, {
        date: '2027-03-01',
        from: '18:00',
        to: '19:00',
      });
      const tooSoon = await scheduleFixture(t, world, {
        date: '2027-03-02',
        from: '00:00',
        to: '01:00',
      });
      const a = await acceptOfficial(t, world.leagueManager, referee, first);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      expect(a.body.assignment.turnaroundMinutes).toBe(30);
      // 19:15 the same evening is inside the turnaround
      const inside = await scheduleFixture(t, world, {
        date: '2027-03-01',
        from: '19:15',
        to: '20:15',
      });
      const refused = await acceptOfficial(t, world.leagueManager, referee, inside);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.details.conflicts).toEqual([
        expect.objectContaining({ code: 'insufficient_turnaround' }),
      ]);
      // the held interval includes the turnaround, so the database refuses it as well
      await expectPgError(
        createAssignmentFixture(t, {
          targetType: 'fixture',
          targetId: inside.fixtureId,
          personId: referee.personId,
          status: 'accepted',
          scheduledStart: inside.start,
          scheduledEnd: inside.end,
        }),
        '23P01',
      );
      // after midnight is outside the turnaround (and another facility-local day)
      const later = await acceptOfficial(t, world.leagueManager, referee, tooSoon);
      expect(later.status, JSON.stringify(later.body)).toBe(200);
    });

    it('WRK-06: with a daily limit configured a further acceptance that facility-local day answers OFFICIAL_DAILY_LIMIT', async () => {
      const morning = await scheduleFixture(t, world, {
        date: '2027-03-06',
        from: '10:00',
        to: '11:00',
      });
      // 22:00 in Los Angeles is already the next day in UTC; it is the same facility-local day
      const lateEvening = await scheduleFixture(t, world, {
        date: '2027-03-06',
        from: '22:00',
        to: '23:00',
      });
      const nextDay = await scheduleFixture(t, world, {
        date: '2027-03-07',
        from: '10:00',
        to: '11:00',
      });
      const first = await acceptOfficial(t, world.leagueManager, referee, morning);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const refused = await acceptOfficial(t, world.leagueManager, referee, lateEvening);
      expect(refused.status, JSON.stringify(refused.body)).toBe(400);
      expect(refused.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: {
          code: 'OFFICIAL_DAILY_LIMIT',
          limit: 1,
          localDate: '2027-03-06',
          timezone: 'America/Los_Angeles',
          assignmentIds: [first.body.assignment.id],
        },
      });
      const allowed = await acceptOfficial(t, world.leagueManager, referee, nextDay);
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    });
  });
});
