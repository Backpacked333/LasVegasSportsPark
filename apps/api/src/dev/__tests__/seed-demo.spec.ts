import { systemPrincipal } from '@sportspark/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OperationsService, UnitOfWork } from '../../kernel';
import { DOMAIN_MODULES } from '../../modules';
import { localDateOf } from '../../modules/scheduling';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { seedDevelopment, type SeedSummary } from '../seed-dev';
import { DEMO_SEED_OPERATION, seedDemo, type DemoSummary } from '../seed-demo';

type Auth = { Authorization: string };

/**
 * The opt-in demo dataset (`seed:dev -- --demo`) on the assembled application and a freshly
 * migrated database. The clock is fixed at a Monday morning in the facility's zone and advanced
 * only where the seed asks for it.
 */
describe('demo dataset (K-14, §1.4, §5.2)', () => {
  const TIMEZONE = 'America/Los_Angeles';
  const TODAY = '2026-11-09';
  let t: TestApp;
  let base: SeedSummary;
  let demo: DemoSummary;
  let league: Auth;
  let parent: Auth;
  let admin: Auth;
  let desk: Auth;

  const run = () =>
    seedDemo(t.app, base, {
      // The fixed test clock is advanced explicitly, never by waiting.
      waitUntil: async (instant) => {
        if (t.clock.now() < instant) t.clock.set(instant);
      },
    });
  const signIn = async (subject: string): Promise<Auth> => {
    const account = base.accounts.find((a) => a.subject === subject);
    const minted = await t.http.post('/v1/dev/tokens').send({ accountId: account?.accountId });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    return { Authorization: `Bearer ${minted.body.token as string}` };
  };
  const get = async <T = Record<string, unknown>>(path: string, auth: Auth): Promise<T> => {
    const res = await t.http.get(`/v1${path}`).set(auth);
    expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body as T;
  };
  const rowCounts = async (): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const table of [
      'persons',
      'accounts',
      'audit_records',
      'outbox_events',
      'operations',
      'fixtures',
      'enrollments',
      'payment_attempts',
      'notifications',
    ] as const) {
      const row = await t.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow();
      counts[table] = Number(row.count);
    }
    return counts;
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      // A new organization: no Package G capability is enabled, and the demo enables none.
      capabilities: [],
      clockStart: '2026-11-09T19:30:00Z',
    });
    base = await seedDevelopment(t.app, { timezone: TIMEZONE });
    demo = await run();
    league = await signIn('dev-league');
    parent = await signIn('dev-parent');
    admin = await signIn('dev-admin');
    desk = await signIn('dev-desk');
  }, 240_000);
  afterAll(async () => {
    await t?.close();
  });

  it('§1.4: the summary says the data is synthetic and names what it created', () => {
    expect(demo.status).toBe('created');
    expect(demo.message).toMatch(/^Demo dataset created, anchored on 2026-11-09\. Synthetic/);
    expect(demo.notice).toMatch(/synthetic/i);
    expect(demo.notice).toMatch(/not operator policy/);
    expect(demo).toMatchObject({ anchoredOn: TODAY, timezone: TIMEZONE });
    expect(demo.counts).toEqual({
      resources: 8,
      demoStaffAccounts: 8,
      customerAccounts: 10,
      teams: 6,
      rosterPlayers: 31,
      fixtures: 30,
      fixturesToday: 3,
      officialResults: 12,
      youthSessions: 20,
      enrolledChildren: 10,
      waitlistedChildren: 1,
      completedCheckouts: 5,
      teamFees: 6,
      paidTeamFees: 5,
      outstandingObligations: 1,
      arrivals: 7,
      sessionCheckins: 5,
      openSupportCases: 2,
      staffNotices: 1,
      staffAssignments: 4,
    });
    expect(demo.accounts.map((a) => a.subject)).toEqual(
      expect.arrayContaining(['demo-finance', 'demo-coach-2', 'demo-official-2', 'demo-parent-2']),
    );
  });

  it('K-14: the six seeded accounts keep their roles and no capability is switched on', async () => {
    const roles = await t.db
      .selectFrom('staff_memberships')
      .select(['person_id', 'roles'])
      .where('organization_id', '=', base.organization.id)
      .execute();
    for (const account of base.accounts) {
      const held = roles.filter((r) => r.person_id === account.personId).flatMap((r) => r.roles);
      expect(held, account.subject).toEqual(account.roles);
    }
    const switches = await t.db
      .selectFrom('organization_capabilities')
      .select('capability')
      .where('organization_id', '=', base.organization.id)
      .where('enabled', '=', true)
      .execute();
    expect(switches).toEqual([]);
  });

  it('SPK-COMP-004 / SPK-RESULT-003: six approved teams, and standings from twelve official results', async () => {
    const entries = await get<Array<{ teamName: string; status: string }>>(
      `/team-entries?seasonId=${demo.records.seasonId}`,
      league,
    );
    expect(entries.map((e) => e.teamName).sort()).toEqual([
      'Demo United',
      'Example City',
      'Mock Wanderers',
      'Placeholder Rovers',
      'Sample Athletic',
      'Specimen Town',
    ]);
    expect(entries.every((e) => e.status === 'approved')).toBe(true);
    const standings = await get<{
      sourceResultIds: string[];
      rows: Array<{ teamName: string; played: number; points: number }>;
    }>(`/seasons/${demo.records.seasonId}/standings?divisionId=${demo.records.divisionId}`, league);
    expect(standings.sourceResultIds).toHaveLength(12);
    expect(standings.rows).toHaveLength(6);
    expect(standings.rows.every((row) => row.played === 4)).toBe(true);
    expect(standings.rows.reduce((sum, row) => sum + row.points, 0)).toBeGreaterThan(0);
  });

  it('SPK-SCHED-008: three fixtures are played today in the facility time zone, with past and future weeks around them', async () => {
    const fixtures = await get<{
      items: Array<{ id: string; scheduledStart: string; status: string }>;
    }>(`/seasons/${demo.records.seasonId}/fixtures?limit=100`, league);
    expect(fixtures.items).toHaveLength(30);
    const today = fixtures.items.filter(
      (f) => localDateOf(TIMEZONE, new Date(f.scheduledStart)) === TODAY,
    );
    expect(today.map((f) => f.id).sort()).toEqual([...demo.records.todayFixtureIds].sort());
    expect(today).toHaveLength(3);
    expect(fixtures.items.filter((f) => f.status === 'played')).toHaveLength(12);
    const now = t.clock.now().getTime();
    expect(fixtures.items.filter((f) => Date.parse(f.scheduledStart) > now)).toHaveLength(18);
  });

  it('SPK-REG-003: dev-parent is guardian of two children with confirmed enrollments, and captain of a team', async () => {
    const households = await get<{
      items: Array<{ members: Array<{ personId: string; kind: string }> }>;
    }>('/me/households', parent);
    const children = (households.items[0]?.members ?? []).filter((m) => m.kind === 'child');
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.personId)).toContain(base.child.personId);
    for (const child of children) {
      const enrollments = await get<{ items: Array<{ status: string; offeringId: string }> }>(
        `/enrollments?participantPersonId=${child.personId}`,
        parent,
      );
      expect(enrollments.items).toEqual([
        expect.objectContaining({
          status: 'confirmed',
          offeringId: demo.records.youthOfferingId,
        }),
      ]);
    }
    const teams = await get<
      Array<{ teamName: string; members: Array<{ personId: string; roles: string[] }> }>
    >('/me/team-entries', parent);
    expect(teams).toHaveLength(1);
    expect(teams[0]?.teamName).toBe('Demo United');
    const parentPersonId = base.accounts.find((a) => a.subject === 'dev-parent')?.personId;
    expect(teams[0]?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ personId: parentPersonId, roles: ['captain'] }),
      ]),
    );
    const calendar = await get<{ items: Array<{ sessionId: string }> }>(
      '/me/family-calendar?from=2026-11-09T08:00:00Z&to=2026-11-10T08:00:00Z',
      parent,
    );
    expect(calendar.items.map((i) => i.sessionId)).toEqual([
      demo.records.todaySessionId,
      demo.records.todaySessionId,
    ]);
  });

  it('SPK-REG-008: the term is full at its capacity and one child waits', async () => {
    const summaries = await get<{
      items: Array<{ enrolled: { confirmed: number }; waitlist: { waiting: number } }>;
    }>(`/offering-enrollment-summaries?offeringIds=${demo.records.youthOfferingId}`, league);
    expect(summaries.items[0]).toMatchObject({
      enrolled: { confirmed: 10 },
      waitlist: { waiting: 1 },
    });
    const offerings = await get<{
      items: Array<{ id: string; name: string; price: { basePriceMinor: number } | null }>;
    }>('/offerings?organization=dev', parent);
    // SPK-PAY-001: both prices come from the catalog's price rules. §1.4: every name says so.
    expect(offerings.items.map((o) => [o.id, o.price?.basePriceMinor]).sort()).toEqual(
      [
        [demo.records.youthOfferingId, 12_000],
        [demo.records.leagueOfferingId, 4_500],
      ].sort(),
    );
    expect(offerings.items.every((o) => /synthetic/.test(o.name))).toBe(true);
  });

  it('§5.2: payments completed through the fake provider, and one team fee is outstanding', async () => {
    const mine = await get<{ items: Array<{ status: string; provider: string }> }>(
      '/me/payments',
      parent,
    );
    expect(mine.items).toEqual([
      expect.objectContaining({ status: 'succeeded', provider: 'fake-payments' }),
    ]);
    const all = await get<{ items: Array<{ status: string; provider: string }> }>(
      '/payments?limit=100',
      admin,
    );
    // five registration checkouts and five team fees
    expect(all.items).toHaveLength(10);
    expect(all.items.every((p) => p.status === 'succeeded' && p.provider === 'fake-payments')).toBe(
      true,
    );
    const owed = await get<{ status: string; totals: { remainingMinor: number } }>(
      `/obligations/${demo.records.outstandingObligationId}`,
      parent,
    );
    expect(owed).toMatchObject({ status: 'open', totals: { remainingMinor: 60_000 } });
  });

  it('SPK-ENTRY-003 / SPK-SUPPORT-001 / SPK-COMMS-004: arrivals and check-ins today, open cases, a delivered notice, nothing failed', async () => {
    const visits = await get<{ items: Array<{ status: string }> }>(
      `/visits?facilityId=${base.facility.id}&limit=100`,
      desk,
    );
    expect(visits.items).toHaveLength(7);
    const checkins = await t.db
      .selectFrom('session_checkins')
      .select(['status', 'activity_id'])
      .where('organization_id', '=', base.organization.id)
      .execute();
    expect(checkins).toHaveLength(5);
    expect(
      checkins.every(
        (c) => c.status === 'admitted' && c.activity_id === demo.records.todaySessionId,
      ),
    ).toBe(true);
    const mine = await get<{ items: Array<{ status: string }> }>('/me/cases', parent);
    expect(mine.items).toEqual([expect.objectContaining({ status: 'open' })]);
    const cases = await get<{ items: Array<{ status: string }> }>('/cases', desk);
    expect(cases.items.filter((c) => c.status === 'open')).toHaveLength(2);
    const inbox = await get<{ items: Array<{ kind: string; status: string; title: string }> }>(
      '/me/inbox?limit=50',
      parent,
    );
    expect(inbox.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'staff_broadcast', status: 'delivered' }),
        expect.objectContaining({ kind: 'result_published', status: 'delivered' }),
        expect.objectContaining({ kind: 'registration_outcome', status: 'delivered' }),
      ]),
    );
    // Follow-ups ran to the end (§4.12): nothing is waiting, nothing was dead-lettered, and no
    // delivery failed.
    const unfinished = await t.db
      .selectFrom('outbox_events')
      .select(['event_type', 'status', 'attempts'])
      .where('organization_id', '=', base.organization.id)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'dead'),
          eb.and([eb('status', '=', 'pending'), eb('available_at', '<=', t.clock.now())]),
        ]),
      )
      .execute();
    expect(unfinished).toEqual([]);
    const exceptions = await get<{ items: unknown[] }>('/exceptions', admin);
    expect(exceptions.items).toEqual([]);
    const today = await get<{ items: Array<{ category: string }> }>(
      `/today?facilityId=${base.facility.id}`,
      league,
    );
    expect(today.items.map((i) => i.category)).toEqual(
      expect.arrayContaining(['workforce.uncovered_assignment']),
    );
  });

  it('K-14: a second run finds the dataset and changes nothing', async () => {
    const before = await rowCounts();
    const again = await run();
    expect(again).toEqual({
      ...demo,
      status: 'existing',
      message: expect.stringMatching(/already present .* nothing was changed\. Synthetic/),
    });
    expect(await rowCounts()).toEqual(before);
    // On a later day the dataset still says which day it is anchored on (SPK-SCHED-008).
    t.clock.set('2026-11-12T19:30:00Z');
    expect((await run()).message).toMatch(
      /anchored on 2026-11-09: .* not 2026-11-12\. .* empty development database/,
    );
    expect(await rowCounts()).toEqual(before);
    // --demo after a plain seed: the base seed is unchanged by the demo having run.
    expect(await seedDevelopment(t.app, { timezone: TIMEZONE })).toEqual(base);
  });

  it('K-14: a dataset an earlier run left part-way is refused with the way out, never resumed', async () => {
    // Another organization of the same database whose demo operation ended failed.
    const operations = t.app.get(OperationsService);
    const operationId = await t.app.get(UnitOfWork).run(({ trx }) =>
      operations.create(trx, {
        organizationId: t.organizationId,
        kind: DEMO_SEED_OPERATION,
        requestedBy: systemPrincipal(t.organizationId, 'test.fixture'),
        status: 'running',
      }),
    );
    const other: SeedSummary = {
      ...base,
      organization: { id: t.organizationId, slug: 'other' },
    };
    const before = await rowCounts();
    await expect(seedDemo(t.app, other)).rejects.toThrow(
      new RegExp(`incomplete.*${operationId}.*empty development database`),
    );
    expect(await rowCounts()).toEqual(before);
  });

  it('K-14: the demo seed refuses production and a managed identity provider', async () => {
    const appWith = (config: { NODE_ENV: string; AUTH_MODE: string }) =>
      ({ get: () => config }) as unknown as TestApp['app'];
    await expect(
      seedDemo(appWith({ NODE_ENV: 'production', AUTH_MODE: 'local' }), base),
    ).rejects.toThrow(/NODE_ENV=production/);
    await expect(
      seedDemo(appWith({ NODE_ENV: 'development', AUTH_MODE: 'oidc' }), base),
    ).rejects.toThrow(/AUTH_MODE=local/);
  });
});
