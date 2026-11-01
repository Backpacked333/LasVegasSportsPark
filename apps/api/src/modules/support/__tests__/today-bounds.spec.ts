import type { TodayFeed, TodayItem, TodaySource } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OperationalExceptions } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { ReadinessService } from '../../competition';
import { at, seedPitchWithHalves } from '../../scheduling';
import { createRequirementFixture, uncoveredDedupeKey } from '../../workforce';
import {
  competitionWorld,
  get,
  post,
  scheduleFixture,
  secondFacility,
  staffMember,
  supportTestApp,
  type Actor,
  type CompetitionWorld,
} from './support';

const TODAY = '2027-01-16';
const EXCEPTION_LIMIT = 2;
const READINESS_LIMIT = 2;

/**
 * R3-PERFORMANCE-01 (SPK-UX-006, SPK-READY-001/002, §5.9): one read of Today does a bounded amount
 * of work however busy the day is. It lists at most `todayExceptionLimit` exceptions (each with its
 * resolution history) and evaluates the readiness of at most `todayReadinessLimit` fixtures across
 * the facilities it covers; what the bound leaves out is counted on the source and named by an
 * `*-omitted` item, never silently dropped and never shown as ready.
 */
describe('Today workspace bounds (R3-PERFORMANCE-01, SPK-UX-006)', () => {
  let t: TestApp;
  let manager: Actor;
  let world: CompetitionWorld;
  let annex: string;
  const fixtures: Record<string, Awaited<ReturnType<typeof scheduleFixture>>> = {};
  let annexFixture: { fixtureId: string; eventId: string; start: string };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await supportTestApp({
      policy: { todayExceptionLimit: EXCEPTION_LIMIT, todayReadinessLimit: READINESS_LIMIT },
    });
    manager = await staffMember(t, ['general_manager']);
    world = await competitionWorld(t);
    // The clock reads 12:00 in the facility's zone. Draft events: every fixture evaluated has a
    // blocking readiness issue, so each evaluation shows as an item.
    fixtures.finished = await scheduleFixture(t, world, {
      date: TODAY,
      from: '08:00',
      to: '09:00',
    });
    fixtures.inProgress = await scheduleFixture(t, world, {
      date: TODAY,
      from: '11:30',
      to: '12:30',
    });
    fixtures.next = await scheduleFixture(t, world, { date: TODAY, from: '13:00', to: '14:00' });
    fixtures.later = await scheduleFixture(t, world, { date: TODAY, from: '15:00', to: '16:00' });
    fixtures.evening = await scheduleFixture(t, world, { date: TODAY, from: '17:00', to: '18:00' });

    // A second facility with a fixture at 12:15: the readiness budget is shared by the whole read.
    annex = await secondFacility(t);
    const annexPitch = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: annex,
      name: 'Annex pitch',
    });
    const annexWorld: CompetitionWorld = { ...world, pitch: annexPitch };
    annexFixture = await scheduleFixture(
      t,
      annexWorld,
      { date: TODAY, from: '12:15', to: '13:15' },
      { facilityId: annex },
    );

    // The referee slot of the evening fixture is owned by an exception the bound leaves out: the
    // slot must then still show, as a derived coverage item.
    await createRequirementFixture(t, {
      targetType: 'fixture',
      targetId: fixtures.evening.fixtureId,
      role: 'referee',
      requiredCount: 1,
      schedulingEventId: fixtures.evening.eventId,
    });
    const raise = (input: Parameters<OperationalExceptions['raise']>[1]) =>
      t.db.transaction().execute((trx) => t.app.get(OperationalExceptions).raise(trx, input));
    ids.critical = (
      await raise({
        organizationId: t.organizationId,
        category: 'finance.unknown_payment_outcome',
        severity: 'critical',
        title: 'A payment outcome is unknown',
        ownerQueue: 'finance_operator',
      })
    ).id;
    ids.high = (
      await raise({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        category: 'entry.attendance_conflict',
        severity: 'high',
        title: 'Two check-ins for one pass',
        ownerQueue: 'front_desk',
      })
    ).id;
    ids.warning = (
      await raise({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        category: 'communications.delivery_failed',
        severity: 'warning',
        title: 'sms delivery failed',
        ownerQueue: 'front_desk',
        deadlineAt: new Date(at(TODAY, '13:00')),
      })
    ).id;
    ids.info = (
      await raise({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        category: 'workforce.uncovered_assignment',
        severity: 'info',
        title: 'Uncovered referee (slot 1) for the evening game',
        affectedType: 'fixture',
        affectedId: fixtures.evening.fixtureId,
        ownerQueue: 'league_manager',
        dedupeKey: uncoveredDedupeKey('fixture', fixtures.evening.fixtureId, 'referee', 1),
      })
    ).id;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const feedOf = async (query = ''): Promise<TodayFeed> => {
    const res = await get(t, `/v1/today${query}`, manager);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as TodayFeed;
  };
  const byId = (feed: TodayFeed, id: string): TodayItem | undefined =>
    feed.items.find((i) => i.id === id);
  const source = (feed: TodayFeed, name: string, facilityId: string | null = null) =>
    feed.sources.find((s) => s.source === name && s.facilityId === facilityId) as TodaySource;

  it('R3-PERFORMANCE-01 / SPK-UX-006: one read lists at most todayExceptionLimit exceptions with their history, most severe first, and names the rest', async () => {
    const history = vi.spyOn(t.app.get(OperationalExceptions), 'history');
    const feed = await feedOf();
    // One audit read per listed exception, never one per open exception of the organization.
    expect(history.mock.calls.map((c) => c[1]).sort()).toEqual([ids.critical, ids.high].sort());
    history.mockRestore();

    expect(byId(feed, `exception:${ids.critical}`)).toBeDefined();
    expect(byId(feed, `exception:${ids.high}`)).toBeDefined();
    expect(byId(feed, `exception:${ids.warning}`)).toBeUndefined();
    expect(byId(feed, `exception:${ids.info}`)).toBeUndefined();
    expect(source(feed, 'kernel.operational_exceptions')).toEqual({
      source: 'kernel.operational_exceptions',
      facilityId: null,
      status: 'ok',
      count: EXCEPTION_LIMIT,
      truncated: true,
      omitted: 2,
    });
    const omitted = byId(feed, 'exceptions-omitted');
    expect(omitted).toMatchObject({
      source: 'exception',
      category: 'support.today_exceptions_omitted',
      // As severe as the most severe exception left out, and due when the first of them is.
      severity: 'warning',
      status: 'unresolved',
      deadlineAt: at(TODAY, '13:00'),
      revision: null,
      details: {
        omitted: 2,
        listed: EXCEPTION_LIMIT,
        bySeverity: { warning: 1, info: 1 },
        byQueue: { front_desk: 1, league_manager: 1 },
      },
    });
    expect(omitted!.nextActions).toEqual([
      expect.objectContaining({ action: 'exceptions.read', verb: 'view', href: '/v1/exceptions' }),
    ]);
    // The exceptions left out stay in the paged exception list.
    const list = await get(t, '/v1/exceptions?limit=50', manager);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect((list.body.items as Array<{ id: string }>).map((e) => e.id)).toEqual(
      expect.arrayContaining([ids.critical, ids.high, ids.warning, ids.info]),
    );
    // An exception left out does not hide the slot it owns: the derived coverage item shows.
    expect(byId(feed, `coverage:fixture:${fixtures.evening!.fixtureId}:referee:1`)).toMatchObject({
      source: 'coverage',
      severity: 'high',
    });
  });

  it('R3-PERFORMANCE-01 / SPK-READY-002: one read evaluates at most todayReadinessLimit fixtures across its facilities, soonest still to finish first, and names the rest as not checked', async () => {
    const evaluate = vi.spyOn(t.app.get(ReadinessService), 'evaluate');
    const feed = await feedOf();
    // In progress (11:30, main) and the annex game at 12:15: the budget is shared by the read
    // (each facility then evaluates its own share, in the feed's facility order).
    expect(evaluate.mock.calls.map((c) => c[1]).sort()).toEqual(
      [fixtures.inProgress!.fixtureId, annexFixture.fixtureId].sort(),
    );
    evaluate.mockRestore();

    expect(byId(feed, `readiness:${fixtures.inProgress!.fixtureId}`)).toMatchObject({
      severity: 'high',
    });
    expect(byId(feed, `readiness:${annexFixture.fixtureId}`)).toMatchObject({ facilityId: annex });
    for (const name of ['next', 'later', 'evening', 'finished']) {
      expect(byId(feed, `readiness:${fixtures[name]!.fixtureId}`), name).toBeUndefined();
    }
    expect(source(feed, 'competition.readiness', t.facilityId)).toEqual({
      source: 'competition.readiness',
      facilityId: t.facilityId,
      status: 'ok',
      count: 1,
      truncated: true,
      omitted: 4,
    });
    expect(source(feed, 'competition.readiness', annex)).toMatchObject({
      status: 'ok',
      count: 1,
      truncated: false,
      omitted: 0,
    });
    expect(byId(feed, `readiness-omitted:${annex}`)).toBeUndefined();
    const omitted = byId(feed, `readiness-omitted:${t.facilityId}`);
    // Unknown readiness is a warning that points at the next fixture to check, never "ready".
    expect(omitted).toMatchObject({
      source: 'readiness',
      group: 'match_readiness',
      category: 'competition.readiness_not_evaluated',
      severity: 'warning',
      facilityId: t.facilityId,
      affected: { type: 'fixture', id: fixtures.next!.fixtureId },
      deadlineAt: fixtures.next!.start,
      status: 'unresolved',
      details: { omitted: 4, evaluated: 1, limit: READINESS_LIMIT },
    });
    expect(
      (omitted!.details['fixtures'] as Array<{ fixtureId: string }>).map((f) => f.fixtureId),
    ).toEqual([
      fixtures.next!.fixtureId,
      fixtures.later!.fixtureId,
      fixtures.evening!.fixtureId,
      fixtures.finished!.fixtureId,
    ]);
    expect(omitted!.nextActions).toEqual([
      expect.objectContaining({
        action: 'competition.read_readiness',
        verb: 'view',
        href: `/v1/fixtures/${fixtures.next!.fixtureId}/readiness`,
      }),
    ]);
    // A source the bound did not cut says so.
    expect(source(feed, 'facilities.restrictions', t.facilityId)).toMatchObject({
      truncated: false,
      omitted: 0,
    });
  });

  it('R3-PERFORMANCE-01: a read of one facility spends the whole budget on that facility', async () => {
    const evaluate = vi.spyOn(t.app.get(ReadinessService), 'evaluate');
    const feed = await feedOf(`?facilityId=${t.facilityId}`);
    expect(evaluate.mock.calls.map((c) => c[1])).toEqual([
      fixtures.inProgress!.fixtureId,
      fixtures.next!.fixtureId,
    ]);
    evaluate.mockRestore();
    expect(source(feed, 'competition.readiness', t.facilityId)).toMatchObject({
      count: 2,
      truncated: true,
      omitted: 3,
    });
    expect(byId(feed, `readiness-omitted:${t.facilityId}`)).toMatchObject({
      affected: { type: 'fixture', id: fixtures.later!.fixtureId },
    });
  });

  it('R3-PERFORMANCE-01: within the bounds the feed is complete and names nothing as left out', async () => {
    // Closing the two exceptions the bound left out leaves two: within the bound.
    for (const id of [ids.warning, ids.info]) {
      const closed = await post(t, `/v1/exceptions/${id}/close`, manager, {
        reason: 'Handled at the desk',
        expectedRevision: 1,
      });
      expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    }
    const main = await feedOf(`?facilityId=${t.facilityId}`);
    expect(source(main, 'kernel.operational_exceptions')).toMatchObject({
      count: 2,
      truncated: false,
      omitted: 0,
    });
    expect(byId(main, 'exceptions-omitted')).toBeUndefined();
    // The annex has one fixture today: evaluated, nothing left out.
    const annexFeed = await feedOf(`?facilityId=${annex}`);
    expect(source(annexFeed, 'competition.readiness', annex)).toMatchObject({
      count: 1,
      truncated: false,
      omitted: 0,
    });
    expect(annexFeed.items.some((i) => i.id.startsWith('readiness-omitted:'))).toBe(false);
  });
});
