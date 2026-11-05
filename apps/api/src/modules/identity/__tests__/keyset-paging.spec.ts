import { encodeCursor, newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../../testing';
import { IdentityModule } from '../identity.module';
import { authHeaderForPerson, createStaffMemberFixture } from '../testing/identity-fixtures';

/**
 * R2-API-CONTRACT-01b (§4.5): identity's keyset lists carry the boundary row's instant at the
 * database's precision. `created_at` is stamped by `default now()`, with microseconds on
 * PostgreSQL, and a cursor built from a JavaScript Date (milliseconds) skipped every later row of
 * that millisecond: all the rows one transaction wrote among them.
 */
describe('identity keyset paging at microsecond precision (R2-API-CONTRACT-01b, §4.5)', () => {
  let t: TestApp;
  let admin: { Authorization: string };

  beforeAll(async () => {
    t = await createTestApp({
      imports: [IdentityModule],
      principalResolver: 'module',
      clockStart: '2026-10-31T12:00:00Z',
    });
    const staff = await createStaffMemberFixture(t, { roles: ['system_administrator'] });
    admin = await authHeaderForPerson(t, staff.personId);
  });
  afterAll(async () => {
    await t?.close();
  });

  const page = async (path: string, limit: number) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i += 1) {
      const res = await t.http
        .get(path)
        .query({ limit, ...(cursor ? { cursor } : {}) })
        .set(admin);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      ids.push(...(res.body.items as Array<{ id: string }>).map((r) => r.id));
      cursor = res.body.nextCursor as string | null;
      if (!cursor) return ids;
    }
    throw new Error('paging did not end');
  };

  it('§4.5: GET /v1/staff-memberships paged one at a time returns every membership written at one microsecond instant, once', async () => {
    for (let i = 0; i < 4; i += 1) {
      await createStaffMemberFixture(t, { roles: ['front_desk'] });
    }
    // rows one transaction writes share its now(); give them one instant below the millisecond
    await sql`update staff_memberships set created_at = '2026-10-31T11:00:00.123456Z'::timestamptz
               where organization_id = ${t.organizationId}`.execute(t.db);
    const all = await page('/v1/staff-memberships', 100);
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(await page('/v1/staff-memberships', 1)).toEqual(all);
    expect(await page('/v1/staff-memberships', 2)).toEqual(all);
  });

  it('§4.5 / §4.10: a cursor whose instant PostgreSQL cannot represent reads as the first page, never a server fault', async () => {
    const first = await t.http.get('/v1/staff-memberships').query({ limit: 2 }).set(admin);
    expect(first.status).toBe(200);
    for (const c of ['0000-01-01T00:00:00Z', '2026-13-40T00:00:00Z', 'not a date']) {
      const res = await t.http
        .get('/v1/staff-memberships')
        .query({ limit: 2, cursor: encodeCursor({ c, id: newId() }) })
        .set(admin);
      expect(res.status, c).toBe(200);
      expect(res.body.items, c).toEqual(first.body.items);
    }
  });
});
