import { SEASON_READINESS_MAX_FIXTURES } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../../testing';
import {
  createDivisionFixture,
  createFixtureFixture,
  createSeasonFixture,
  createTeamEntryFixture,
  ReadinessService,
} from '../../competition';
import { createPersonFixture } from '../../identity';
import { at } from '../../scheduling';
import { REPORTING_LIMITS } from '../reporting.policy';
import { get, post, reportingTestApp, staff, type Actor } from './support';

const WIDE_DAY = '2027-05-05';
const NARROW_DAY = '2027-05-06';

/**
 * R3-PERFORMANCE-03 (SPK-REPORT-002 match readiness): every fixture of the report window is
 * evaluated live by the competition rules, one after another, inside the request. The report is
 * bounded the way the competition module bounds its own season readiness work
 * (SEASON_READINESS_MAX_FIXTURES, CMP-01), and refuses a wider window before evaluating anything.
 */
describe('match readiness is bounded (SPK-REPORT-002, R3-PERFORMANCE-03)', () => {
  let t: TestApp;
  let manager: Actor;

  beforeAll(async () => {
    t = await reportingTestApp();
    manager = await staff(t, ['league_manager']);
    const season = await createSeasonFixture(t, { name: 'Busy league' });
    const divisionId = await createDivisionFixture(t, {
      seasonId: season.seasonId,
      facilityId: t.facilityId,
    });
    const captain = await createPersonFixture(t, { kind: 'adult' });
    const home = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      captainPersonId: captain,
    });
    const away = await createTeamEntryFixture(t, {
      seasonId: season.seasonId,
      divisionId,
      captainPersonId: captain,
    });
    const fixture = (day: string, minute: number) =>
      createFixtureFixture(t, {
        seasonId: season.seasonId,
        divisionId,
        homeEntryId: home.teamEntryId,
        awayEntryId: away.teamEntryId,
        // Postponed fixtures keep their slot and are not final: the report evaluates them.
        status: 'postponed',
        scheduledStart: new Date(Date.parse(at(day, '08:00')) + minute * 60_000),
        scheduledEnd: new Date(Date.parse(at(day, '08:00')) + (minute + 5) * 60_000),
      });
    for (let i = 0; i <= SEASON_READINESS_MAX_FIXTURES; i += 1) await fixture(WIDE_DAY, i * 5);
    await fixture(NARROW_DAY, 0);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SPK-REPORT-002 (R3-PERFORMANCE-03): the bound is the competition module’s own readiness bound', () => {
    expect(REPORTING_LIMITS.maxReadinessFixtures).toBe(SEASON_READINESS_MAX_FIXTURES);
  });

  it('SPK-REPORT-002 (R3-PERFORMANCE-03): more fixtures than the bound are refused with TOO_MANY_FIXTURES before any is evaluated, live and as a stored run', async () => {
    const evaluate = vi.spyOn(t.app.get(ReadinessService), 'evaluate');
    try {
      const params = { facilityId: t.facilityId, from: WIDE_DAY, to: NARROW_DAY };
      const live = await get(t, '/v1/reports/match-readiness', manager, params);
      expect(live.status, JSON.stringify(live.body)).toBe(400);
      expect(live.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { code: 'TOO_MANY_FIXTURES', limit: SEASON_READINESS_MAX_FIXTURES },
      });
      const run = await post(t, '/v1/reports/runs', manager, {
        report: 'match_readiness',
        parameters: params,
        reason: 'Season readiness review',
      });
      expect(run.status, JSON.stringify(run.body)).toBe(400);
      expect(run.body.details).toMatchObject({ code: 'TOO_MANY_FIXTURES' });
      expect(evaluate).not.toHaveBeenCalled();
      const stored = await t.db
        .selectFrom('report_runs')
        .select('id')
        .where('organization_id', '=', t.organizationId)
        .execute();
      expect(stored).toHaveLength(0);
    } finally {
      evaluate.mockRestore();
    }
  });

  it('SPK-REPORT-002 (R3-PERFORMANCE-03): a window within the bound is evaluated fixture by fixture', async () => {
    const res = await get(t, '/v1/reports/match-readiness', manager, {
      facilityId: t.facilityId,
      from: NARROW_DAY,
      to: NARROW_DAY,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect((res.body.disclosures as string[]).join(' ')).toContain(
      `At most ${SEASON_READINESS_MAX_FIXTURES} fixtures are evaluated per request`,
    );
  });
});
