import { encodeCursor, newId } from '@sportspark/contracts';
import { seedOrganization, type ExceptionSeverity } from '@sportspark/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { UnitOfWork } from '../database/unit-of-work';
import {
  EXCEPTION_SEVERITY_RANK,
  OperationalExceptions,
  type OperationalExceptionRow,
  type QueueServiceLevel,
  type RaiseExceptionInput,
} from '../exceptions/operational-exceptions.service';

/**
 * R4-CARRY-02 (R3-PERFORMANCE-01 part 3, SPK-UX-006, §4.12, §5.10): the open exceptions of an
 * organization are read a bounded keyset page at a time in an order the database computes (most
 * severe first by the stored `severity_rank`, then soonest due, then id), and the rest are counted
 * in one aggregate read, so a Today read never loads every open exception of the organization.
 */
describe('bounded open-exception reads (R4-CARRY-02, SPK-UX-006)', () => {
  let t: TestApp;
  let exceptions: OperationalExceptions;
  let uow: UnitOfWork;

  const DAY = '2026-11-05';
  const at = (time: string) => new Date(`${DAY}T${time}:00.000Z`);

  /** A fresh organization per test, so every count below is the test's own. */
  const organization = () => seedOrganization(t.db);
  const managerOf = (organizationId: string) => staffPrincipal(organizationId, ['general_manager']);

  const raiseIn =
    (organizationId: string) =>
    async (
      input: Partial<RaiseExceptionInput> & { severity: ExceptionSeverity; openedAt?: string },
    ) => {
      t.clock.set(at(input.openedAt ?? '09:00'));
      const { id } = await uow.run(({ trx }) =>
        exceptions.raise(trx, {
          organizationId,
          category: 'kerneltest.open_read',
          title: 'Probe',
          ownerQueue: 'general_manager',
          ...input,
        }),
      );
      return id;
    };

  const ids = (rows: readonly Pick<OperationalExceptionRow, 'id'>[]) => rows.map((r) => r.id);

  beforeAll(async () => {
    t = await createTestApp({ clockStart: at('09:00') });
    exceptions = t.app.get(OperationalExceptions);
    uow = t.app.get(UnitOfWork);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('R4-CARRY-02 / SPK-UX-006: listOpenPage reads most severe first (not severity text order), then soonest due, then id, a bounded page at a time with a more flag', async () => {
    const org = await organization();
    const raise = raiseIn(org.organizationId);
    const manager = managerOf(org.organizationId);
    // Raised in an order unrelated to the expected one.
    const info = await raise({ severity: 'info', deadlineAt: at('10:30') });
    const warningNever = await raise({ severity: 'warning' });
    const warningFirst = await raise({ severity: 'warning', deadlineAt: at('11:00') });
    const highLater = await raise({ severity: 'high', deadlineAt: at('12:00') });
    const highSooner = await raise({ severity: 'high', deadlineAt: at('11:00') });
    const critical = await raise({ severity: 'critical' });
    // Same severity and due time as warningFirst: the id decides between them.
    const warningSecond = await raise({ severity: 'warning', deadlineAt: at('11:00') });
    const settled = await raise({ severity: 'critical', deadlineAt: at('09:30') });
    await uow.run(({ trx }) => exceptions.transition(trx, manager, settled, 'resolved'));

    const expected = [
      critical,
      highSooner,
      highLater,
      ...[warningFirst, warningSecond].sort(),
      warningNever,
      info,
    ];
    const first = await exceptions.listOpenPage(manager, org.organizationId, { limit: 3 });
    expect(ids(first.items)).toEqual(expected.slice(0, 3));
    expect(first.more).toBe(true);
    const second = await exceptions.listOpenPage(manager, org.organizationId, {
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(ids(second.items)).toEqual(expected.slice(3, 6));
    expect(second.more).toBe(true);
    const last = await exceptions.listOpenPage(manager, org.organizationId, {
      limit: 3,
      cursor: second.nextCursor,
    });
    expect(ids(last.items)).toEqual(expected.slice(6));
    expect(last).toMatchObject({ more: false, nextCursor: null });

    // The order is the database's: every row carries the stored rank, and the unbounded form
    // (kept for its last caller) reads the same order.
    expect(first.items.map((r) => r.severity_rank)).toEqual([0, 1, 1]);
    expect(ids(await exceptions.listOpen(manager, org.organizationId))).toEqual(expected);
    // An unreadable cursor, or one whose due time is not an exact instant, reads the first page.
    const forged = encodeCursor({ r: 0, d: 'tomorrow', i: newId() });
    expect(
      ids(
        (await exceptions.listOpenPage(manager, org.organizationId, { limit: 3, cursor: forged }))
          .items,
      ),
    ).toEqual(expected.slice(0, 3));
    expect(
      ids(
        (await exceptions.listOpenPage(manager, org.organizationId, { limit: 3, cursor: 'x' }))
          .items,
      ),
    ).toEqual(expected.slice(0, 3));
  });

  it('R4-CARRY-02 / §5.10: one page holds at most 200 exceptions (default 50), however many are open', async () => {
    const org = await organization();
    const manager = managerOf(org.organizationId);
    const severities: ExceptionSeverity[] = ['info', 'warning', 'high', 'critical'];
    await t.db
      .insertInto('operational_exceptions')
      .values(
        Array.from({ length: 205 }, (_, n) => ({
          id: newId(),
          organization_id: org.organizationId,
          category: 'kerneltest.bulk',
          severity: severities[n % severities.length]!,
          title: `Bulk ${n}`,
          owner_queue: 'general_manager',
          opened_at: at('09:00'),
        })),
      )
      .execute();
    const huge = await exceptions.listOpenPage(manager, org.organizationId, { limit: 10_000 });
    expect(huge.items).toHaveLength(200);
    expect(huge.more).toBe(true);
    expect(
      huge.items.every((r, n, all) => n === 0 || all[n - 1]!.severity_rank <= r.severity_rank),
    ).toBe(true);
    const rest = await exceptions.summarizeOpen(manager, org.organizationId, {
      after: huge.nextCursor,
    });
    expect(rest.count).toBe(5);
    expect(await exceptions.listOpenPage(manager, org.organizationId)).toMatchObject({
      more: true,
    });
    expect((await exceptions.listOpenPage(manager, org.organizationId)).items).toHaveLength(50);
    expect(
      (await exceptions.listOpenPage(manager, org.organizationId, { limit: 0 })).items,
    ).toHaveLength(1);
  });

  it('R4-CARRY-02 / SPK-UX-006: a queue resolution window passed as a service level sets the due time of an exception without its own deadline, in SQL', async () => {
    const org = await organization();
    const raise = raiseIn(org.organizationId);
    const manager = managerOf(org.organizationId);
    const windowed = await raise({ severity: 'warning', ownerQueue: 'front_desk' });
    const deadline = await raise({
      severity: 'warning',
      ownerQueue: 'league_manager',
      deadlineAt: at('09:45'),
    });
    const never = await raise({ severity: 'warning', ownerQueue: 'scheduler' });
    const ordered = [windowed, deadline, never].sort();

    // Without service levels only deadlines count: the two without one follow, by id.
    expect(ids((await exceptions.listOpenPage(manager, org.organizationId)).items)).toEqual([
      deadline,
      ...ordered.filter((id) => id !== deadline),
    ]);
    const serviceLevels = new Map<string, QueueServiceLevel>([
      ['front_desk', { resolveWithinMinutes: 30, acknowledgeWithinMinutes: null }],
      ['league_manager', { resolveWithinMinutes: 5, acknowledgeWithinMinutes: 10 }],
    ]);
    // front_desk's window makes `windowed` due at 09:30, before the 09:45 deadline; a deadline
    // wins over its queue's window (league_manager's 5 minutes do not apply to `deadline`).
    const paged = await exceptions.listOpenPage(manager, org.organizationId, {
      serviceLevels,
      limit: 1,
    });
    expect(ids(paged.items)).toEqual([windowed]);
    const next = await exceptions.listOpenPage(manager, org.organizationId, {
      serviceLevels,
      cursor: paged.nextCursor,
    });
    expect(ids(next.items)).toEqual([deadline, never]);

    // At 09:35: `windowed` is past due, `deadline` is open past league_manager's acknowledgment
    // window (09:10) though not yet due.
    const summary = await exceptions.summarizeOpen(manager, org.organizationId, {
      serviceLevels,
      asOf: at('09:35'),
    });
    expect(summary).toEqual({
      count: 3,
      first: { id: windowed, severity: 'warning', ownerQueue: 'front_desk' },
      bySeverity: { warning: 3 },
      byQueue: { front_desk: 1, league_manager: 1, scheduler: 1 },
      earliestDueAt: at('09:30'),
      overdue: 2,
    });
    // Acknowledged, it is no longer overdue for acknowledgment, and not yet due.
    await uow.run(({ trx }) => exceptions.transition(trx, manager, deadline, 'acknowledged'));
    expect(
      (
        await exceptions.summarizeOpen(manager, org.organizationId, {
          serviceLevels,
          asOf: at('09:35'),
        })
      ).overdue,
    ).toBe(1);
  });

  it('R4-CARRY-02 / SPK-UX-006: summarizeOpen after a page counts exactly the open exceptions the page left out, as the full list does', async () => {
    const org = await organization();
    const raise = raiseIn(org.organizationId);
    const manager = managerOf(org.organizationId);
    await raise({ severity: 'critical', ownerQueue: 'front_desk', deadlineAt: at('12:00') });
    await raise({ severity: 'high', ownerQueue: 'front_desk' });
    await raise({ severity: 'high', ownerQueue: 'scheduler', deadlineAt: at('10:00') });
    await raise({ severity: 'warning', ownerQueue: 'scheduler', deadlineAt: at('09:20') });
    await raise({ severity: 'info', ownerQueue: 'front_desk', deadlineAt: at('09:10') });
    await raise({ severity: 'warning', ownerQueue: 'league_manager' });

    const page = await exceptions.listOpenPage(manager, org.organizationId, { limit: 2 });
    const all = await exceptions.listOpen(manager, org.organizationId);
    const left = all.slice(2);
    expect(ids(page.items)).toEqual(ids(all.slice(0, 2)));
    const tally = (key: (r: OperationalExceptionRow) => string) =>
      left.reduce<Record<string, number>>((acc, r) => {
        acc[key(r)] = (acc[key(r)] ?? 0) + 1;
        return acc;
      }, {});
    const summary = await exceptions.summarizeOpen(manager, org.organizationId, {
      after: page.nextCursor,
      asOf: at('09:30'),
    });
    expect(summary).toEqual({
      count: left.length,
      first: { id: left[0]!.id, severity: left[0]!.severity, ownerQueue: left[0]!.owner_queue },
      bySeverity: tally((r) => r.severity),
      byQueue: tally((r) => r.owner_queue),
      earliestDueAt: at('09:10'),
      // 09:10 and 09:20 are past at 09:30.
      overdue: 2,
    });
    expect(summary.count).toBe(4);
    // Without a cursor, every open exception is counted.
    expect((await exceptions.summarizeOpen(manager, org.organizationId)).count).toBe(6);
  });

  it('R4-CARRY-02 / SPK-UX-006: the bounded reads keep to the viewer facility scope and narrow by facilities and queues', async () => {
    const org = await organization();
    const raise = raiseIn(org.organizationId);
    const annex = await t.db
      .insertInto('facilities')
      .values({
        id: newId(),
        organization_id: org.organizationId,
        slug: 'annex',
        name: 'Annex',
        timezone: 'America/Los_Angeles',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const own = await raise({
      severity: 'high',
      facilityId: org.facilityId,
      ownerQueue: 'front_desk',
    });
    const elsewhere = await raise({
      severity: 'high',
      facilityId: annex.id,
      ownerQueue: 'front_desk',
    });
    const orgWide = await raise({ severity: 'warning', ownerQueue: 'scheduler' });

    const scoped = staffPrincipal(org.organizationId, ['front_desk'], {
      facilityIds: [org.facilityId],
    });
    const sortedIds = (rows: readonly { id: string }[]) => ids(rows).sort();
    expect(sortedIds((await exceptions.listOpenPage(scoped, org.organizationId)).items)).toEqual(
      [own, orgWide].sort(),
    );
    expect((await exceptions.summarizeOpen(scoped, org.organizationId)).count).toBe(2);
    // Asking for the annex as well never widens the viewer's scope.
    expect(
      sortedIds(
        (
          await exceptions.listOpenPage(scoped, org.organizationId, {
            facilityIds: [org.facilityId, annex.id],
          })
        ).items,
      ),
    ).toEqual([own, orgWide].sort());

    const manager = managerOf(org.organizationId);
    expect(
      sortedIds(
        (await exceptions.listOpenPage(manager, org.organizationId, { facilityIds: [annex.id] }))
          .items,
      ),
    ).toEqual([elsewhere, orgWide].sort());
    expect(
      ids((await exceptions.listOpenPage(manager, org.organizationId, { facilityIds: [] })).items),
    ).toEqual([orgWide]);
    expect(
      sortedIds(
        (
          await exceptions.listOpenPage(manager, org.organizationId, {
            ownerQueues: ['front_desk'],
          })
        ).items,
      ),
    ).toEqual([own, elsewhere].sort());
    expect(
      await exceptions.summarizeOpen(manager, org.organizationId, { ownerQueues: [] }),
    ).toMatchObject({ count: 0, first: null, bySeverity: {}, byQueue: {}, earliestDueAt: null });
    expect(
      ids(
        (await exceptions.listOpenPage(manager, org.organizationId, { facilityId: annex.id }))
          .items,
      ),
    ).toEqual([elsewhere]);
    await expect(
      exceptions.listOpenPage(scoped, org.organizationId, { facilityId: annex.id }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    await expect(
      exceptions.summarizeOpen(scoped, org.organizationId, { facilityId: annex.id }),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  });

  it('R4-CARRY-02: the keyset cursor keeps the exact due time, so exceptions due within the same millisecond are neither skipped nor repeated', async () => {
    const org = await organization();
    const raise = raiseIn(org.organizationId);
    const manager = managerOf(org.organizationId);
    const a = await raise({ severity: 'warning', deadlineAt: at('10:00') });
    const b = await raise({ severity: 'warning', deadlineAt: at('10:00') });
    // Microseconds the JavaScript Date cannot hold: b falls due 100 µs before a.
    await sql`update operational_exceptions set deadline_at = ${`${DAY}T10:00:00.000200Z`}::timestamptz where id = ${a}`.execute(
      t.db,
    );
    await sql`update operational_exceptions set deadline_at = ${`${DAY}T10:00:00.000100Z`}::timestamptz where id = ${b}`.execute(
      t.db,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 4; n += 1) {
      const page = await exceptions.listOpenPage(manager, org.organizationId, { limit: 1, cursor });
      seen.push(...ids(page.items));
      cursor = page.nextCursor;
      if (!page.more) break;
    }
    expect(seen).toEqual([b, a]);
  });

  it('R4-CARRY-02 (migration 0017): the database derives severity_rank from severity and refuses to have it written', async () => {
    const org = await organization();
    const raise = raiseIn(org.organizationId);
    for (const severity of ['critical', 'high', 'warning', 'info'] as const) {
      const id = await raise({ severity });
      const row = await exceptions.get(org.organizationId, id);
      expect(row?.severity_rank, severity).toBe(EXCEPTION_SEVERITY_RANK[severity]);
    }
    const id = newId();
    await expect(
      sql`insert into operational_exceptions (id, organization_id, category, severity, severity_rank, title, owner_queue)
          values (${id}, ${org.organizationId}, 'kerneltest.rank', 'info', 0, 'Forged rank', 'general_manager')`.execute(
        t.db,
      ),
    ).rejects.toThrow(/severity_rank/);
    const raised = await raise({ severity: 'info' });
    await expect(
      sql`update operational_exceptions set severity_rank = 0 where id = ${raised}`.execute(t.db),
    ).rejects.toThrow(/severity_rank/);
    // Changing the severity changes the rank with it.
    await sql`update operational_exceptions set severity = 'critical' where id = ${raised}`.execute(
      t.db,
    );
    expect((await exceptions.get(org.organizationId, raised))?.severity_rank).toBe(0);
  });

  it('R4-CARRY-02 / §5.10 (migration 0017): the open order is served by a partial index keyed by organization, rank, deadline and id that carries the summary columns', async () => {
    // This test database's own schema: under TEST_DATABASE_URL every test file migrates its own
    // schema in one PostgreSQL database, so pg_indexes also lists the other files' copies.
    const rows = await sql<{ indexname: string; indexdef: string }>`
      select indexname, indexdef from pg_indexes
      where schemaname = current_schema()
        and tablename = 'operational_exceptions'
        and indexname in ('operational_exceptions_open_rank_idx', 'operational_exceptions_open_idx')
    `.execute(t.db);
    expect(rows.rows.map((r) => r.indexname)).toEqual(['operational_exceptions_open_rank_idx']);
    const definition = rows.rows[0]!.indexdef;
    expect(definition).toMatch(/\(organization_id, severity_rank, deadline_at, id\)/);
    expect(definition).toMatch(/INCLUDE \(facility_id, owner_queue, opened_at, status\)/);
    expect(definition).toMatch(
      /WHERE \(status = ANY \(ARRAY\['open'::text, 'acknowledged'::text\]\)\)/,
    );
  });
});
