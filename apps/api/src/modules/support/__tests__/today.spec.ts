import type { TodayFeed, TodayItem } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationalExceptions } from '../../../kernel';
import type { TestApp } from '../../../testing';
import { RestrictionsService, createActiveRestriction } from '../../facilities';
import { at, seedPitchWithHalves } from '../../scheduling';
import { createRequirementFixture, uncoveredDedupeKey } from '../../workforce';
import {
  competitionWorld,
  get,
  otherOrganization,
  post,
  scheduleFixture,
  secondFacility,
  staffMember,
  supportTestApp,
  type Actor,
} from './support';

const TODAY = '2027-01-16';

/**
 * SPK-UX-006 Today workspace: composition from the owning modules, permission filtering by source
 * authorization and queue scope, the required fields of every item, and the rule that closing an
 * exception never marks the underlying problem resolved.
 */
describe('Today workspace (SPK-UX-006)', () => {
  let t: TestApp;
  let manager: Actor;
  let desk: Actor;
  let finance: Actor;
  let fixture: Awaited<ReturnType<typeof scheduleFixture>>;
  let restrictedPitch: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await supportTestApp();
    manager = await staffMember(t, ['general_manager']);
    desk = await staffMember(t, ['front_desk']);
    finance = await staffMember(t, ['finance_operator']);
    const world = await competitionWorld(t);
    // Tonight's game: its event is still a draft, so readiness reports a blocking issue.
    fixture = await scheduleFixture(t, world, { date: TODAY, from: '18:00', to: '19:00' });
    // It needs one accepted referee and has none (SPK-STAFF-002).
    await createRequirementFixture(t, {
      targetType: 'fixture',
      targetId: fixture.fixtureId,
      role: 'referee',
      requiredCount: 1,
      schedulingEventId: fixture.eventId,
    });
    await createRequirementFixture(t, {
      targetType: 'fixture',
      targetId: fixture.fixtureId,
      role: 'assistant_referee',
      requiredCount: 1,
      schedulingEventId: fixture.eventId,
    });
    // A turf restriction on another pitch in effect today (facilities, through scheduling).
    const pitch2 = await seedPitchWithHalves(t.db, {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      name: 'Pitch 2',
    });
    restrictedPitch = pitch2.southHalfId;
    await createActiveRestriction(t.app.get(RestrictionsService), {
      organizationId: t.organizationId,
      facilityId: t.facilityId,
      resourceId: restrictedPitch,
      start: at(TODAY, '06:00'),
      end: at(TODAY, '23:00'),
      reason: 'Turf repair on the south half',
    });
    // Exceptions the owning modules raise (same categories, queues and dedupe keys they use).
    const raise = (input: Parameters<OperationalExceptions['raise']>[1]) =>
      t.db.transaction().execute((trx) => t.app.get(OperationalExceptions).raise(trx, input));
    ids.finance = (
      await raise({
        organizationId: t.organizationId,
        category: 'finance.unknown_payment_outcome',
        severity: 'critical',
        title: 'A payment outcome is unknown; reconcile before charging the customer again',
        affectedType: 'payment_attempt',
        affectedId: '01890000-0000-7000-8000-000000000001',
        ownerQueue: 'finance_operator',
        dedupeKey: 'payment-unknown:test',
      })
    ).id;
    ids.delivery = (
      await raise({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        category: 'communications.delivery_failed',
        severity: 'warning',
        title: 'sms delivery of "Game moved" failed (PROVIDER_REJECTED)',
        affectedType: 'delivery_attempt',
        affectedId: '01890000-0000-7000-8000-000000000002',
        ownerQueue: 'front_desk',
        details: { notificationId: '01890000-0000-7000-8000-000000000003' },
      })
    ).id;
    ids.uncovered = (
      await raise({
        organizationId: t.organizationId,
        facilityId: t.facilityId,
        category: 'workforce.uncovered_assignment',
        severity: 'high',
        title: 'Uncovered referee (slot 1) for tonight’s game',
        affectedType: 'fixture',
        affectedId: fixture.fixtureId,
        ownerQueue: 'league_manager',
        deadlineAt: new Date(fixture.start),
        dedupeKey: uncoveredDedupeKey('fixture', fixture.fixtureId, 'referee', 1),
      })
    ).id;
    // The exceptions are 45 minutes old when the feed is read.
    t.clock.advance(45 * 60_000);
  });
  afterAll(async () => {
    await t.close();
  });

  const feedOf = async (actor: Actor, query = ''): Promise<TodayFeed> => {
    const res = await get(t, `/v1/today${query}`, actor);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as TodayFeed;
  };
  const byId = (feed: TodayFeed, id: string): TodayItem | undefined =>
    feed.items.find((i) => i.id === id);
  const sourceStatus = (feed: TodayFeed, source: string) =>
    feed.sources.find((s) => s.source === source)?.status;

  it('SPK-UX-006: composes exceptions, readiness blockers, uncovered assignments and maintenance restrictions with every required field', async () => {
    const feed = await feedOf(manager);
    expect(
      feed.sources.every((s) => s.status === 'ok'),
      JSON.stringify(feed.sources),
    ).toBe(true);
    expect(feed.facilities).toHaveLength(1);
    expect(feed.facilities[0]).toMatchObject({
      facilityId: t.facilityId,
      localDate: TODAY,
      window: { start: at(TODAY, '00:00'), end: at('2027-01-17', '00:00') },
      activities: { visible: true },
    });
    expect(feed.facilities[0]!.activities.total).toBeGreaterThanOrEqual(1);

    const financeItem = byId(feed, `exception:${ids.finance}`);
    expect(financeItem).toMatchObject({
      source: 'exception',
      group: 'financial',
      severity: 'critical',
      title: 'A payment outcome is unknown; reconcile before charging the customer again',
      affected: { type: 'payment_attempt', id: '01890000-0000-7000-8000-000000000001' },
      ownerQueue: 'finance_operator',
      status: 'open',
      ageMinutes: 45,
    });
    expect(financeItem!.history[0]).toMatchObject({ action: 'exceptions.opened' });
    expect(financeItem!.nextActions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['finance.reconcile_payment', 'exceptions.manage']),
    );

    const readiness = byId(feed, `readiness:${fixture.fixtureId}`);
    expect(readiness).toMatchObject({
      source: 'readiness',
      group: 'match_readiness',
      severity: 'high',
      affected: { type: 'fixture', id: fixture.fixtureId },
      deadlineAt: fixture.start,
      status: 'unresolved',
    });
    expect(readiness!.nextActions[0]).toMatchObject({
      action: 'competition.read_readiness',
      href: `/v1/fixtures/${fixture.fixtureId}/readiness`,
    });
    // Officials are reported once, by the coverage source, not again inside readiness.
    const issueCodes = (readiness!.details['issues'] as Array<{ code: string }>).map((i) => i.code);
    expect(issueCodes).not.toContain('required_officials_not_accepted');

    // The referee slot has an open exception (the manager sees it); the assistant slot is derived.
    expect(byId(feed, `exception:${ids.uncovered}`)).toMatchObject({ group: 'staffing' });
    expect(
      byId(feed, `coverage:fixture:${fixture.fixtureId}:referee:1`),
      'the open exception owns the referee slot',
    ).toBeUndefined();
    const assistant = byId(feed, `coverage:fixture:${fixture.fixtureId}:assistant_referee:1`);
    expect(assistant).toMatchObject({
      source: 'coverage',
      group: 'staffing',
      severity: 'high',
      ownerQueue: 'league_manager',
      deadlineAt: fixture.start,
    });
    expect(assistant!.nextActions.map((a) => a.action)).toContain('workforce.propose_assignment');

    const restriction = feed.items.find((i) => i.source === 'restriction');
    expect(restriction).toMatchObject({
      group: 'maintenance',
      severity: 'warning',
      affected: { type: 'resource', id: restrictedPitch },
      ownerQueue: 'facilities_operator',
      deadlineAt: at(TODAY, '23:00'),
    });
    expect(restriction!.nextActions.map((a) => a.action)).toContain(
      'facilities.release_to_service',
    );
    expect(restriction!.history.map((h) => h.action)).toContain('facilities.restriction_approved');

    // Most severe first.
    expect(feed.items[0]!.severity).toBe('critical');
  });

  it('permission filtering: each viewer sees the queues they own and the sources they may read', async () => {
    const financeFeed = await feedOf(finance);
    expect(byId(financeFeed, `exception:${ids.finance}`)).toBeDefined();
    expect(byId(financeFeed, `exception:${ids.delivery}`)).toBeUndefined();
    expect(byId(financeFeed, `exception:${ids.uncovered}`)).toBeUndefined();
    // Finance operators read neither assignment coverage nor maintenance restrictions.
    expect(sourceStatus(financeFeed, 'workforce.coverage')).toBe('not_permitted');
    expect(sourceStatus(financeFeed, 'facilities.restrictions')).toBe('not_permitted');
    expect(
      financeFeed.items.some((i) => i.source === 'coverage' || i.source === 'restriction'),
    ).toBe(false);
    // They may reconcile, but managing the exception itself is the kernel's exceptions.manage.
    const actions = byId(financeFeed, `exception:${ids.finance}`)!.nextActions.map((a) => a.action);
    expect(actions).toContain('finance.reconcile_payment');
    expect(actions).not.toContain('exceptions.manage');

    const deskFeed = await feedOf(desk);
    expect(byId(deskFeed, `exception:${ids.delivery}`)).toMatchObject({
      group: 'communications',
      nextActions: [expect.objectContaining({ action: 'communications.read_notification' })],
    });
    expect(byId(deskFeed, `exception:${ids.finance}`)).toBeUndefined();
    // The desk does not see the league manager's exception, so the derived referee gap shows.
    expect(byId(deskFeed, `exception:${ids.uncovered}`)).toBeUndefined();
    expect(byId(deskFeed, `coverage:fixture:${fixture.fixtureId}:referee:1`)).toBeDefined();
    expect(sourceStatus(deskFeed, 'facilities.restrictions')).toBe('ok');
    // The desk may not propose assignments or release areas: no such next action is offered.
    const deskActions = deskFeed.items.flatMap((i) => i.nextActions.map((a) => a.action));
    expect(deskActions).not.toContain('workforce.propose_assignment');
    expect(deskActions).not.toContain('facilities.release_to_service');

    // Coaches and officials have no Today workspace; customers neither.
    const coach = await staffMember(t, ['coach']);
    expect((await get(t, '/v1/today', coach)).status).toBe(403);
  });

  it('§4.3: a facility-scoped viewer sees only their facility (and organization-wide exceptions)', async () => {
    const annex = await secondFacility(t);
    const annexManager = await staffMember(t, ['general_manager'], { facilityIds: [annex] });
    const feed = await feedOf(annexManager);
    expect(feed.facilities.map((f) => f.facilityId)).toEqual([annex]);
    expect(byId(feed, `exception:${ids.finance}`)).toBeDefined(); // no facility: organization-wide
    expect(byId(feed, `exception:${ids.delivery}`)).toBeUndefined();
    expect(feed.items.some((i) => i.facilityId === t.facilityId)).toBe(false);
    expect((await get(t, `/v1/today?facilityId=${t.facilityId}`, annexManager)).status).toBe(403);
  });

  it('SPK-UX-006: closing an exception never resolves the underlying problem — the uncovered slot stays on the feed', async () => {
    const closed = await post(t, `/v1/exceptions/${ids.uncovered}/close`, manager, {
      reason: 'Closing the alert to tidy the queue',
      expectedRevision: 1,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toMatchObject({ status: 'closed', underlyingRecordUnchanged: true });
    const feed = await feedOf(manager);
    expect(byId(feed, `exception:${ids.uncovered}`)).toBeUndefined();
    // Workforce still reports the referee slot uncovered, so the feed derives it again.
    const slot = byId(feed, `coverage:fixture:${fixture.fixtureId}:referee:1`);
    expect(slot).toMatchObject({ status: 'unresolved', severity: 'high' });
    const coverage = await get(
      t,
      `/v1/assignment-requirements?targetType=fixture&targetId=${fixture.fixtureId}`,
      manager,
    );
    expect(coverage.status, JSON.stringify(coverage.body)).toBe(200);
    const referee = (
      coverage.body as Array<{ role: string; coverage: { uncoveredSlots: number[] } }>
    ).find((r) => r.role === 'referee');
    expect(referee?.coverage.uncoveredSlots).toEqual([1]);
  });

  it('§4.3: a facility filter that names another organization’s facility is not found', async () => {
    const other = await otherOrganization(t);
    const res = await get(t, `/v1/today?facilityId=${other.facilityId}`, manager);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
