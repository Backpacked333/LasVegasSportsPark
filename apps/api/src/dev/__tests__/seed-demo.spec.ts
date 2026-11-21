import type { INestApplicationContext } from '@nestjs/common';
import { CAPABILITIES, CAPABILITY_IDS, type Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilityService } from '../../kernel/capabilities/capability.service';
import { DOMAIN_MODULES } from '../../modules';
import {
  OfferingExtrasService,
  OfferingsService,
  PoliciesService,
  PriceRulesService,
  SessionsService,
  WaiversService,
} from '../../modules/catalog';
import { MessageScheduleService } from '../../modules/communications';
import { SeasonsService, StandingsService } from '../../modules/competition';
import { TeamWaitlistService } from '../../modules/competition/services/team-waitlist.service';
import { BookingRostersService } from '../../modules/enrollment/services/booking-rosters.service';
import { PosOpenAmountService } from '../../modules/finance';
import { PrincipalResolver } from '../../modules/identity';
import { localDateOf } from '../../modules/scheduling';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { WAIVER_KEY } from '../demo/catalog';
import { DEMO_TIMEZONE, seedDemo, type DemoSeedSummary } from '../seed-demo';

/**
 * The demo dataset (ADR-007; design section 4 "Demo mode"): `seedDemo` on a fully migrated
 * database with every domain module, read back through the modules' own read services and, for
 * what a visitor or the seeded parent sees, through the HTTP routes. The clock stands at a
 * Wednesday morning at the facility; the last test runs the seed late on a Sunday evening, when
 * today's class and tonight's rental are already over.
 */
type Json = Record<string, unknown>;

/** The record id in a staff dashboard path of the summary (`/leagues/seasons/<id>/results`). */
function idIn(path: string | undefined): string {
  const id = (path ?? '').split('/').find((part) => /^[0-9a-f-]{36}$/.test(part));
  if (!id) throw new Error(`no record id in ${path}`);
  return id;
}

/**
 * Row counts of every table of the test database's schema. `current_schema()`, not `public`: on
 * PostgreSQL (`TEST_DATABASE_URL`) each test file migrates into a schema of its own.
 */
async function tableCounts(t: TestApp): Promise<Record<string, number>> {
  const tables = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = current_schema() order by tablename
  `.execute(t.db);
  const counts: Record<string, number> = {};
  for (const { tablename } of tables.rows) {
    const rows = await sql<{
      n: string;
    }>`select count(*) as n from ${sql.table(tablename)}`.execute(t.db);
    counts[tablename] = Number(rows.rows[0]?.n ?? 0);
  }
  return counts;
}

describe('demo dataset (ADR-007)', () => {
  let t: TestApp;
  let first: DemoSeedSummary;
  let manager: Principal;
  let league: Principal;
  let desk: Principal;

  const principal = async (subject: string): Promise<Principal> => {
    const now = t.clock.now();
    const resolved = await t.app.get(PrincipalResolver).resolve({
      issuer: t.config.AUTH_ISSUER,
      subject,
      sessionId: null,
      issuedAt: now,
      expiresAt: now,
      claims: {},
    });
    if (!resolved) throw new Error(`no account ${subject}`);
    return resolved;
  };
  /** Signs in the way the role picker does and reads a route as that account. */
  const as = async (subject: string) => {
    const account = first.accounts.find((a) => a.subject === subject);
    const minted = await t.http.post('/v1/dev/tokens').send({ accountId: account?.accountId });
    expect(minted.status).toBe(201);
    const header = { Authorization: `Bearer ${minted.body.token as string}` };
    return async <T = Json>(path: string): Promise<T> => {
      const res = await t.http.get(path).set(header);
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(200);
      return res.body as T;
    };
  };

  beforeAll(async () => {
    t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      capabilities: [],
      clockStart: '2026-11-18T18:20:00Z',
    });
    first = await seedDemo(t.app);
    manager = await principal('demo-manager');
    league = await principal('dev-league');
    desk = await principal('dev-desk');
  }, 300_000);
  afterAll(async () => {
    await t?.close();
  });

  it('runs on a fresh database and keeps the summary the launcher reads', () => {
    expect(first.organization.slug).toBe('dev');
    expect(first.facility).toMatchObject({ slug: 'dev-facility', timezone: DEMO_TIMEZONE });
    // The same six sign-in accounts as the development seed, in the same order.
    expect(first.accounts.map((a) => [a.subject, a.roles])).toEqual([
      ['dev-admin', ['system_administrator']],
      ['dev-desk', ['front_desk']],
      ['dev-league', ['league_manager']],
      ['dev-coach', ['coach']],
      ['dev-official', ['official']],
      ['dev-parent', []],
    ]);
    expect(first.devTokens.path).toBe('/v1/dev/tokens');
    // The dataset adds two sign-in accounts: the general manager, who approves and sees money,
    // and the field crew (demo/staff-crew.ts, Phase 8), whose home is Fields.
    expect(first.demo.accounts.map((a) => [a.subject, a.roles])).toEqual([
      [
        'demo-manager',
        [
          'facilities_operator',
          'finance_operator',
          'general_manager',
          'program_manager',
          'scheduler',
        ],
      ],
      ['demo-crew', ['facilities_operator']],
    ]);
    // Nothing the services refused: every part of the dataset was created.
    expect(first.demo.notCreated).toEqual([]);
    // The names apps/staff/src/demo/links.ts knows (its test holds the shape of each).
    expect(Object.keys(first.demo.publicLinks).sort()).toEqual([
      'lobby',
      'publicFixtures',
      'publicSchedule',
      'publicStandings',
    ]);
    expect(Object.keys(first.demo.tourLinks).sort()).toEqual([
      'camp',
      'campUniforms',
      'competition',
      'memberClass',
      'messageSchedule',
      'missingWaiverPerson',
      'openAmountSale',
      'paperWaiverPerson',
      'perSessionClass',
      'registerSession',
      'rentalRoster',
      'season',
      'seasonResults',
      'standings',
      'teamEntries',
      'waitlist',
    ]);
    // The summary is the JSON the launcher parses: it starts with the organization.
    expect(JSON.stringify(first).startsWith('{"organization"')).toBe(true);
  });

  it('runs a second time without creating anything twice', async () => {
    const before = await tableCounts(t);
    const second = await seedDemo(t.app);
    const after = await tableCounts(t);
    expect(Object.keys(before).length).toBeGreaterThan(150);
    const changed = Object.keys(after).filter((table) => after[table] !== before[table]);
    expect(changed.map((table) => `${table}: ${before[table]} -> ${after[table]}`)).toEqual([]);
    // The second run found every record again: the same ids, links and public codes.
    expect(second).toEqual(first);
    // What the count stands on: the main tables are populated, not empty.
    for (const table of [
      'persons',
      'offerings',
      'offering_sessions',
      'enrollments',
      'team_entries',
      'fixtures',
      'result_revisions',
      'bookings',
      'pos_sales',
      'scheduled_messages',
      'notifications',
    ]) {
      expect(before[table], table).toBeGreaterThan(0);
    }
  }, 120_000);

  it('refuses outside development and without local identity, before touching anything', async () => {
    const appWith = (config: Json) =>
      ({
        get: () => config,
      }) as unknown as INestApplicationContext;
    await expect(seedDemo(appWith({ NODE_ENV: 'production', AUTH_MODE: 'local' }))).rejects.toThrow(
      /NODE_ENV=production/,
    );
    await expect(seedDemo(appWith({ NODE_ENV: 'development', AUTH_MODE: 'oidc' }))).rejects.toThrow(
      /AUTH_MODE=local/,
    );
  });

  it('leaves every capability enabled, each on one of its own applicability decisions', async () => {
    const switches = await t.app.get(CapabilityService).list(first.organization.id);
    expect(switches.map((s) => s.capability).sort()).toEqual([...CAPABILITY_IDS].sort());
    for (const view of switches) {
      expect(view.enabled, view.capability).toBe(true);
      expect(CAPABILITIES[view.capability].applicabilityReferences, view.capability).toContain(
        view.decisionReference,
      );
    }
    expect(first.enabledCapabilities).toEqual([...CAPABILITY_IDS]);
  });

  it('SPK-CAT-004, SPK-PAY-013/014/015, SPK-REG-012: published classes with sessions today, a per-session price, a member price, and a camp with tiers, add-ons and a uniform', async () => {
    const offerings = t.app.get(OfferingsService);
    const sessions = t.app.get(SessionsService);
    const priceRules = t.app.get(PriceRulesService);
    const today = localDateOf(DEMO_TIMEZONE, t.clock.now());

    // A published class, registration open, with a session on today's local date.
    const listed = await offerings.listPublic(manager, {
      organization: 'dev',
      limit: 50,
      view: 'public',
    });
    const term = listed.items.find((o) => o.name.startsWith('Mini kickers'));
    expect(term).toMatchObject({ publicationState: 'registration_open' });
    const termSessions = await sessions.list(manager, term?.id as string);
    expect(termSessions).toHaveLength(8);
    expect(
      termSessions.filter((s) => localDateOf(DEMO_TIMEZONE, new Date(s.scheduledStart)) === today),
    ).toHaveLength(1);
    expect(termSessions.every((s) => s.schedulingEventId !== null)).toBe(true);

    // A per-session rule, three sessions into the term: five classes are left to pay for.
    const perSessionId = idIn(first.demo.tourLinks['perSessionClass']);
    const perSessionRules = await priceRules.list(manager, perSessionId);
    expect(perSessionRules).toEqual([
      expect.objectContaining({ pricingBasis: 'per_session', basePriceMinor: 2_400 }),
    ]);
    const perSession = await offerings.get(manager, perSessionId);
    expect(perSession.price).toMatchObject({
      pricingBasis: 'per_session',
      remainingSessionCount: 5,
      remainingSessionsPriceMinor: 12_000,
    });

    // A member price that needs the membership.
    const memberRules = await priceRules.list(manager, idIn(first.demo.tourLinks['memberClass']));
    expect(memberRules[0]).toMatchObject({
      basePriceMinor: 16_000,
      memberPriceMinor: 12_000,
      memberEntitlementName: 'Park membership benefit',
    });

    // The camp: two tiers, three add-ons (one with limited places) and a jersey in three sizes.
    const options = await t.app
      .get(OfferingExtrasService)
      .purchaseOptions(manager, idIn(first.demo.tourLinks['camp']));
    expect(options.tiers.map((tier) => [tier.code, tier.attendance, tier.priceMinor])).toEqual([
      ['full_week', 'all_sessions', 32_000],
      ['single_day', 'chosen_sessions', 7_500],
    ]);
    expect(options.addons.map((addon) => [addon.code, addon.selection, addon.capacity])).toEqual([
      ['lunch', 'per_session', null],
      ['early_drop_off', 'per_session', null],
      ['friday_trophy_photo', 'per_registration', 6],
    ]);
    expect(options.uniform).toMatchObject({
      name: 'Camp jersey',
      sizes: ['Youth S', 'Youth M', 'Youth L'],
      priceMinor: 2_200,
    });
  });

  it('SPK-REG-011: an approved waiver version is required on the offerings; one acceptance came from paper and one child has none', async () => {
    const versions = await t.app
      .get(PoliciesService)
      .list(manager, { kind: 'waiver', key: WAIVER_KEY, limit: 10 });
    expect(versions.items).toEqual([expect.objectContaining({ approvalStatus: 'approved' })]);
    const waivers = t.app.get(WaiversService);
    const required = await waivers.offeringRequiredWaivers(
      manager,
      idIn(first.demo.tourLinks['camp']),
    );
    expect(JSON.stringify(required)).toContain(WAIVER_KEY);

    const paper = await waivers.personWaivers(
      desk,
      idIn(first.demo.tourLinks['paperWaiverPerson']),
    );
    expect(paper.waivers[0]).toMatchObject({
      policyKey: WAIVER_KEY,
      status: 'current',
      acceptance: { method: 'paper', paperDatedOn: '2026-11-09' },
    });
    const missing = await waivers.personWaivers(
      desk,
      idIn(first.demo.tourLinks['missingWaiverPerson']),
    );
    expect(missing.waivers[0]).toMatchObject({ status: 'missing', acceptance: null });
  });

  it('SPK-RESULT-003, SPK-COMP-006: standings are populated, a division is full, one team waits and one holds an open place offer', async () => {
    const seasonId = idIn(first.demo.tourLinks['season']);
    const divisions = await t.app.get(SeasonsService).listDivisions(league, seasonId);
    expect(divisions.map((d) => [d.name, d.entryCount]).sort()).toEqual([
      ['Premier', 4],
      ['Recreational', 4],
    ]);
    for (const division of divisions) {
      const table = await t.app
        .get(StandingsService)
        .get(league, seasonId, { divisionId: division.id });
      expect(table.rows).toHaveLength(4);
      // Five published results per division: ten team appearances.
      expect(table.rows.reduce((played, row) => played + row.played, 0)).toBe(10);
      expect(table.rows[0]?.points).toBeGreaterThan(0);
    }

    const lists = await t.app.get(TeamWaitlistService).seasonLists(league, seasonId, {});
    const premier = lists.lists.find((list) => list.entries.length > 0);
    // Four placed, a fifth place added and held by the open offer: nothing is free.
    expect(premier).toMatchObject({ capacity: 5, placed: 4, freePlaces: 0 });
    expect(premier?.entries.map((e) => [e.position, e.teamName, e.openOffer?.status])).toEqual([
      [1, 'Canyon Comets', 'offered'],
      [2, 'Sunset Strikers', undefined],
    ]);
  });

  it('SPK-SCHED-010: the competition is public and the facility schedule is enabled; the public reads answer without sign-in', async () => {
    const seasonCode = (first.demo.publicLinks['publicStandings'] ?? '').split('/')[4];
    const facilityCode = (first.demo.publicLinks['publicSchedule'] ?? '').split('/')[4];
    const season = await t.http.get(`/v1/public/dev/seasons/${seasonCode}`);
    expect(season.status).toBe(200);
    expect(season.body).toMatchObject({
      competitionName: 'Friday night league',
      seasonName: 'Winter season',
    });
    const publicDivisions = season.body.divisions as Array<{ fixtures: Json[]; standings: Json[] }>;
    expect(publicDivisions).toHaveLength(2);
    expect(publicDivisions[0]?.fixtures).toHaveLength(12);
    expect(publicDivisions[0]?.standings).toHaveLength(4);
    expect(publicDivisions[0]?.fixtures.filter((f) => f['status'] === 'played')).toHaveLength(5);

    // The lobby display of the day: the class of today, by field.
    const day = await t.http.get(`/v1/public/dev/schedule/${facilityCode}`);
    expect(day.status).toBe(200);
    expect((day.body.entries as Json[]).length).toBeGreaterThan(0);
    expect(day.body.fields).toEqual(expect.arrayContaining(['Field 1 north half']));
    const directory = await t.http.get('/v1/public/dev/directory');
    expect(directory.status).toBe(200);
    // The second competition is still private: only one is listed.
    expect(directory.body.competitions).toHaveLength(1);
    expect(directory.body.schedules).toHaveLength(1);
    // The same season by its record id opens nothing publicly.
    const byId = await t.http.get(`/v1/public/dev/seasons/${idIn(first.demo.tourLinks['season'])}`);
    expect(byId.status).toBe(404);
  });

  it('SPK-COND-005: a rental has a group roster with joined members, one of them without a waiver, and open invitations', async () => {
    const roster = await t.app
      .get(BookingRostersService)
      .roster(desk, idIn(first.demo.tourLinks['rentalRoster']));
    expect(roster.counts).toEqual({ joined: 2, invited: 2, waiverOutstanding: 1 });
    expect(roster.members.filter((m) => m.status === 'joined')).toHaveLength(2);
    expect(roster.members.filter((m) => m.invitation?.status === 'pending')).toHaveLength(2);
  });

  it('SPK-PAY-016: the register session has an open-amount line below the ceiling, one approved above it and one still waiting', async () => {
    const sessionId = idIn(first.demo.tourLinks['registerSession']);
    const lines = await t.app.get(PosOpenAmountService).listForSession(desk, sessionId, {
      limit: 50,
    });
    const summary = lines.items
      .map((l) => [
        l.reasonCategory,
        l.amountMinor,
        l.approvalRequired,
        l.approval !== null,
        l.saleStatus,
      ])
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    expect(summary).toEqual([
      ['lost_key', 1_500, false, false, 'paid'],
      ['one_off_service', 9_000, true, false, 'open'],
      ['field_damage_fee', 12_000, true, true, 'paid'],
    ]);
    // The approval names a second person, never the one who entered the line.
    const approved = lines.items.find((l) => l.approval !== null);
    expect(approved?.approval?.approvedByPersonId).toBe(manager.personId);
    expect(approved?.enteredByPersonId).toBe(desk.personId);
    // The sale that waits is the one the tour opens.
    expect(lines.items.find((l) => l.saleStatus === 'open')?.saleId).toBe(
      idIn(first.demo.tourLinks['openAmountSale']),
    );
  });

  it('SPK-COMMS-009: the season has a message schedule with one sent, one skipped and two waiting for confirmation', async () => {
    const schedule = await t.app
      .get(MessageScheduleService)
      .schedule(league, { type: 'season', id: idIn(first.demo.tourLinks['season']) });
    expect(schedule.sequences.map((s) => s.name)).toEqual(['League season messages']);
    expect(schedule.messages.map((m) => m.status).sort()).toEqual([
      'needs_confirmation',
      'needs_confirmation',
      'sent',
      'skipped',
    ]);
    const sent = schedule.messages.find((m) => m.status === 'sent');
    // Sent to the people of the eight approved teams (captains and players).
    expect(sent?.delivery?.recipientCount).toBeGreaterThanOrEqual(32);
  });

  it('gives each staff role rows on its main screens and the seeded parent a populated app', async () => {
    const seasonId = idIn(first.demo.tourLinks['season']);
    const facility = first.facility.id;
    const deskReads = await as('dev-desk');
    const queue = await deskReads<{ items: Json[] }>('/v1/applications?status=awaiting_review');
    expect(queue.items).toHaveLength(2);
    const rentals = await deskReads<{ items: Json[] }>(
      `/v1/bookings?kind=rental&facilityId=${facility}`,
    );
    // Three from the rentals seed and the regular Saturday renter of the staff schedule (S 5a).
    expect(rentals.items).toHaveLength(4);
    const payments = await deskReads<{ items: Array<{ status: string }> }>(
      '/v1/payments?limit=100',
    );
    expect(payments.items.map((p) => p.status)).toEqual(
      expect.arrayContaining(['succeeded', 'failed', 'unknown']),
    );
    const uniforms = await deskReads<Json[]>(
      `/v1/uniform-orders?offeringId=${idIn(first.demo.tourLinks['camp'])}`,
    );
    expect(uniforms).toHaveLength(2);

    const leagueReads = await as('dev-league');
    // The adult league, the cup being planned, and the parent app's youth league (parent-core).
    expect(await leagueReads<Json[]>('/v1/competitions')).toHaveLength(3);
    const awaiting = await leagueReads<{ items: Json[] }>(
      `/v1/seasons/${seasonId}/result-revisions?status=submitted`,
    );
    expect(awaiting.items).toHaveLength(2);
    const disputes = await leagueReads<{ items: Json[] }>(`/v1/disputes?seasonId=${seasonId}`);
    expect(disputes.items).toHaveLength(1);
    const drafts = await leagueReads<Json[]>(`/v1/schedule-drafts?facilityId=${facility}`);
    // Two from the league seed, and the staff schedule's make-up and clinic drafts (S 1b).
    expect(drafts).toHaveLength(4);

    const adminReads = await as('dev-admin');
    expect((await adminReads<{ items: Json[] }>('/v1/message-templates')).items).toHaveLength(4);
    expect((await adminReads<{ items: Json[] }>('/v1/reports/runs')).items.length).toBeGreaterThan(
      0,
    );
    const waiting = await adminReads<Json[]>(
      `/v1/waitlist-entries?offeringId=${idIn(first.demo.tourLinks['waitlist'])}`,
    );
    expect(waiting).toHaveLength(1);
    // Finance has exceptions to work: the unknown payment and the cancellation to settle.
    const exceptions = await adminReads<{ items: Array<{ category: string }> }>(
      '/v1/exceptions?status=open&limit=100',
    );
    expect(exceptions.items.map((e) => e.category).sort()).toEqual([
      'enrollment.cancellation_consequence_pending',
      'finance.unknown_payment_outcome',
    ]);

    // The general manager signs in like the others and sees what the five roles above cannot:
    // the finance queue, the refund in flight, the stored sales report and the facilities work.
    const managerAccount = first.demo.accounts[0];
    const minted = await t.http
      .post('/v1/dev/tokens')
      .send({ accountId: managerAccount?.accountId });
    expect(minted.status).toBe(201);
    const managerHeader = { Authorization: `Bearer ${minted.body.token as string}` };
    const managerRead = async <T>(path: string): Promise<T> => {
      const res = await t.http.get(path).set(managerHeader);
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(200);
      return res.body as T;
    };
    const refunds = await managerRead<{ items: Array<{ status: string }> }>('/v1/refunds?limit=10');
    expect(refunds.items.map((r) => r.status)).toEqual(['processing']);
    const runs = await managerRead<{ items: Array<{ reportKey: string }> }>('/v1/reports/runs');
    expect(runs.items.map((r) => r.reportKey).sort()).toEqual([
      'outstanding_obligations',
      'registration_funnel',
      'sales_by_product_line',
    ]);
    const tasks = await managerRead<{ items: Json[] }>(
      `/v1/maintenance-tasks?facilityId=${facility}`,
    );
    // The torn net on Field 3, and the field crew's three tasks (demo/staff-crew.ts, Phase 8).
    expect(tasks.items).toHaveLength(4);
    const closures = await managerRead<Json[]>(`/v1/closures?facilityId=${facility}`);
    // The planned Field 3 closure, and Field 4 closed for its repair during the busy hour that
    // Today shows (demo/staff-today.ts; the clock of this suite is inside opening hours), and
    // tomorrow's Field 4 repair on the week by use (demo/staff-schedule.ts).
    expect(closures).toHaveLength(3);

    // "My assignments" of the coach and the official.
    const coachReads = await as('dev-coach');
    type Mine = { items: Array<{ assignment: { status: string } }> };
    const coach = await coachReads<Mine>('/v1/me/assignments');
    // demo/assignments.ts: today's class and the futsal club accepted, next week's class offered;
    // demo/staff-coach.ts: the Sunday class the coach declined (the swap to approve), and Little
    // Kickers now when the coach is free at the seed's clock.
    expect(coach.items.map((a) => a.assignment.status).sort()).toEqual(
      expect.arrayContaining(['accepted', 'accepted', 'declined', 'offered']),
    );
    const officialReads = await as('dev-official');
    const official = await officialReads<Mine>('/v1/me/assignments');
    // The next league night (accepted and offered), and the request for the coach's game today
    // (demo/staff-crew.ts, Phase 8).
    expect(official.items.map((a) => a.assignment.status).sort()).toEqual([
      'accepted',
      'offered',
      'offered',
    ]);

    // The seeded parent: a class today, a team, an amount owed, a waiver to accept, notices in
    // the inbox, an invitation to a rental roster and a register receipt.
    const parent = first.accounts.find((a) => a.subject === 'dev-parent');
    const parentReads = await as('dev-parent');
    const child = first.child.personId;
    const enrollments = await parentReads<{ items: Array<{ status: string }> }>(
      `/v1/enrollments?participantPersonId=${child}`,
    );
    // The term class, plus the front desk's training today and camp week (front-desk.ts: the desk
    // scans this same family). The camp week may already be cancelled by the refund the desk shows.
    expect(enrollments.items.filter((e) => e.status === 'confirmed').length).toBeGreaterThanOrEqual(
      2,
    );
    const from = new Date(t.clock.now().getTime() - 12 * 3_600_000).toISOString();
    const to = new Date(t.clock.now().getTime() + 12 * 3_600_000).toISOString();
    const calendar = await parentReads<{ items: Json[] }>(
      `/v1/me/family-calendar?from=${from}&to=${to}`,
    );
    expect(calendar.items.length).toBeGreaterThan(0);
    // The parent's own team and the child's youth team (parent-core).
    expect(await parentReads<Json[]>('/v1/me/team-entries')).toHaveLength(2);
    const owed = await parentReads<{
      items: Array<{ status: string; totals: { remainingMinor: number } }>;
    }>(`/v1/obligations?debtorPersonId=${parent?.personId}&status=open`);
    // The register's amount owed and the front desk's two league instalments (front-desk.ts).
    expect(owed.items.map((o) => o.totals.remainingMinor).sort((a, b) => a - b)).toEqual([
      2_200, 4_000, 4_000,
    ]);
    const waivers = await parentReads<{ waivers: Array<{ status: string }> }>(
      `/v1/people/${child}/waivers`,
    );
    expect(waivers.waivers).toEqual([expect.objectContaining({ status: 'missing' })]);
    expect((await parentReads<{ items: Json[] }>('/v1/me/inbox')).items.length).toBeGreaterThan(0);
    expect(await parentReads<Json[]>('/v1/me/booking-roster-invitations')).toHaveLength(1);
    expect((await parentReads<{ items: Json[] }>('/v1/me/pos-receipts')).items).toHaveLength(1);
  });
});

describe('demo dataset late on a Sunday evening', () => {
  it("builds every part when today's class and tonight's rental are already over", async () => {
    // 23:30 on Sunday at the facility: the next class is next week, the unpaid rental moves on.
    const t = await createTestApp({
      imports: DOMAIN_MODULES,
      principalResolver: 'module',
      capabilities: [],
      clockStart: '2026-11-16T07:30:00Z',
    });
    try {
      const summary = await seedDemo(t.app);
      expect(summary.demo.notCreated).toEqual([]);
      expect(Object.keys(summary.demo.tourLinks)).toHaveLength(16);
      const assignments = await t.db.selectFrom('assignments').select(['status']).execute();
      // demo/staff-coach.ts adds next Sunday's class: its duty manager (accepted), the coach's
      // decline and the replacement proposed for it (the swap); Little Kickers "now" would cross
      // midnight, so it is skipped at this hour.
      // The coach's next game is tomorrow then, with its referee request (demo/staff-crew.ts).
      expect(assignments.map((a) => a.status).sort()).toEqual([
        'accepted',
        'accepted',
        'accepted',
        'accepted',
        'declined',
        'offered',
        'offered',
        'offered',
        'proposed',
      ]);
    } finally {
      await t.close();
    }
  }, 300_000);
});
