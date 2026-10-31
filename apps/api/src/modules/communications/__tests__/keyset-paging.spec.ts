import { systemPrincipal, type Principal } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnitOfWork } from '../../../kernel';
import { createTestApp, type TestApp } from '../../../testing';
import {
  authHeaderForPerson,
  createOrganizationPeople,
  type OrganizationPeople,
} from '../../identity';
import { CommunicationsModule } from '../communications.module';
import { NotificationsService } from '../services/notifications.service';
import { composeAndDispatch } from '../testing/communications-fixtures';
import { withDeclaredPortDoubles } from './support';

/**
 * §4.5 keyset pages (api-and-events.md "Pagination": pages are complete and disjoint) for the
 * communications lists, R2-API-CONTRACT-01. `notifications.created_at` and
 * `delivery_attempts.created_at` are stamped by the database (`default now()`), which keeps
 * microseconds on PostgreSQL and gives every row of one transaction the same instant. A client
 * that follows `nextCursor` with any page size sees every row exactly once, including rows that
 * share the boundary row's millisecond or its exact instant.
 *
 * Under TEST_DATABASE_URL the rows written in one transaction carry PostgreSQL's own microsecond
 * `now()`. PGlite's `now()` has millisecond precision, so there the test moves the same rows to a
 * microsecond instant, which is what the production database writes.
 */
describe('keyset paging of notices and the inbox (§4.5, R2-API-CONTRACT-01)', () => {
  let t: TestApp;
  let org: string;
  let people: OrganizationPeople;
  let system: Principal;
  let staff: { Authorization: string };
  let parent: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      configure: withDeclaredPortDoubles,
      imports: [CommunicationsModule],
      principalResolver: 'module',
      clockStart: '2026-10-23T12:00:00Z',
    });
    org = t.organizationId;
    system = systemPrincipal(org, 'test');
    people = await createOrganizationPeople(t, { staffRoles: ['front_desk'] });
    staff = await authHeaderForPerson(t, people.staff.personId);
    parent = await authHeaderForPerson(t, people.adult.personId);
  });
  afterAll(async () => {
    await t.close();
  });

  const notice = (title: string) => ({
    kind: 'placement' as const,
    audience: { subjectPersonIds: [people.child.personId] },
    title,
    body: 'See the app for details.',
  });

  /** Follows nextCursor from the first page until it is null; returns the ids in page order. */
  async function pageThrough(
    path: string,
    header: { Authorization: string },
    idOf: (item: Record<string, unknown>) => string,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const url: string = cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path;
      const response = await t.http.get(url).set(header);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      ids.push(...(response.body.items as Record<string, unknown>[]).map(idOf));
      cursor = response.body.nextCursor as string | null;
      if (!cursor) return ids;
    }
    throw new Error(`${path} did not finish paging`);
  }

  const createdAtText = async (table: 'notifications' | 'delivery_attempts', ids: string[]) =>
    (
      await t.db
        .selectFrom(table)
        .select(sql<string>`created_at::text`.as('at'))
        .where('organization_id', '=', org)
        .where('id', 'in', ids)
        .execute()
    ).map((r) => r.at);

  it('SPK-COMMS-006 / §4.5: GET /notifications paged one at a time returns every notice one transaction composed, once', async () => {
    const service = t.app.get(NotificationsService);
    const group = await t.app.get(UnitOfWork).run(async ({ trx }) => {
      const ids: string[] = [];
      for (const title of ['First of three', 'Second of three', 'Third of three']) {
        ids.push((await service.composeAndQueueIn(trx, system, notice(title))).id);
      }
      return ids;
    });
    // one transaction, one database instant
    expect(new Set(await createdAtText('notifications', group)).size).toBe(1);
    if (!t.database.concurrent) {
      await t.db
        .updateTable('notifications')
        .set({ created_at: sql<Date>`'2030-01-01 00:00:00.123456+00'::timestamptz` })
        .where('organization_id', '=', org)
        .where('id', 'in', group)
        .execute();
    }
    const everything = await t.http.get('/v1/notifications?limit=100').set(staff);
    expect(everything.status).toBe(200);
    expect(everything.body.nextCursor).toBeNull();
    const expected = (everything.body.items as { id: string }[]).map((i) => i.id);
    expect(expected).toEqual(expect.arrayContaining(group));

    const paged = await pageThrough('/v1/notifications?limit=1', staff, (i) => i['id'] as string);
    expect(paged).toEqual(expected);
    const pairs = await pageThrough('/v1/notifications?limit=2', staff, (i) => i['id'] as string);
    expect(pairs).toEqual(expected);
  });

  it('SPK-UX-003 / §4.5: GET /me/inbox paged one at a time returns every notice delivered within one millisecond, once', async () => {
    const delivered = [];
    for (const title of ['Inbox one', 'Inbox two', 'Inbox three']) {
      delivered.push((await composeAndDispatch(t.app, system, notice(title))).id);
    }
    const attempts = await t.db
      .selectFrom('delivery_attempts as a')
      .innerJoin('notification_recipients as r', (join) =>
        join
          .onRef('r.organization_id', '=', 'a.organization_id')
          .onRef('r.id', '=', 'a.recipient_id'),
      )
      .select(['a.id'])
      .where('a.organization_id', '=', org)
      .where('a.channel', '=', 'in_app')
      .where('r.person_id', '=', people.adult.personId)
      .where('a.notification_id', 'in', delivered)
      .orderBy('a.id')
      .execute();
    expect(attempts).toHaveLength(3);
    // three deliveries inside one millisecond, at the database's microsecond precision
    for (const [index, attempt] of attempts.entries()) {
      await t.db
        .updateTable('delivery_attempts')
        .set({
          created_at: sql<Date>`${`2030-01-01 00:00:00.123${['456', '400', '300'][index]}+00`}::timestamptz`,
        })
        .where('id', '=', attempt.id)
        .execute();
    }
    const everything = await t.http.get('/v1/me/inbox?limit=100').set(parent);
    expect(everything.status).toBe(200);
    expect(everything.body.nextCursor).toBeNull();
    const expected = (everything.body.items as { attemptId: string }[]).map((i) => i.attemptId);
    expect(expected.slice(0, 3)).toEqual(attempts.map((a) => a.id));

    const paged = await pageThrough(
      '/v1/me/inbox?limit=1',
      parent,
      (i) => i['attemptId'] as string,
    );
    expect(paged).toEqual(expected);
  });
});
