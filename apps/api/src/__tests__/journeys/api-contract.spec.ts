import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionRegistry } from '../../kernel/authorization/actions';
import type { TestApp } from '../../testing';
import { adult, get, journeyApp, ok, post, staff } from './support';

const GENERATED_MATRIX = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'package-a',
  'permission-matrix.generated.md',
);

/**
 * The API contract on the assembled application (K-02, K-03, K-05; §4.8, §4.9, §4.11, §6.7): the
 * generated permission matrix is the registry the application authorizes with, the permission
 * view a client reads follows the roles, keyset pages are complete and disjoint, an oversized
 * page is a validation error, and a browser preflight from a configured origin is answered for every
 * module's routes. OpenAPI parity, idempotency headers and SPK-AT-027 (426 before the idempotency
 * key is claimed) are proven by `openapi-parity.spec.ts` and `spk-at-027.spec.ts` on the same
 * assembled application.
 */
describe('API contract (assembled application)', () => {
  it('§6.7: the committed generated permission matrix lists exactly the registered actions (run pnpm build && pnpm permission-matrix)', async () => {
    const t: TestApp = await journeyApp();
    try {
      const registered = actionRegistry
        .list()
        .map((a) => a.id)
        .sort();
      const text = readFileSync(GENERATED_MATRIX, 'utf8');
      const documented = [...text.matchAll(/^\| `([a-z_]+\.[a-z0-9_.]+)` +\|/gm)]
        .map((m) => m[1]!)
        .filter((id) => !/^[a-z_]+$/.test(id))
        .sort();
      expect(documented).toEqual(registered);
      expect(text).toContain(`${registered.length} actions`);
    } finally {
      await t.close();
    }
  });

  it('K-05: /v1/me/permissions follows the roles; keyset pages are complete and disjoint; an oversized page is refused', async () => {
    const t: TestApp = await journeyApp();
    try {
      const desk = await staff(t, ['front_desk']);
      const customer = await adult(t);
      const view = await ok<{
        principalKind: string;
        actions: Array<{ id: string }>;
        conditionalActions: Array<{ id: string }>;
        areas: Array<{ id: string; visible: boolean }>;
      }>(get(t, '/v1/me/permissions', desk.header));
      expect(view.principalKind).toBe('staff');
      expect(view.actions.map((a) => a.id)).toContain('identity.create_person');
      expect(view.actions.map((a) => a.id)).not.toContain('core.manage_capabilities');
      const customerView = await ok<typeof view>(get(t, '/v1/me/permissions', customer.header));
      expect(customerView.actions).toEqual([]);
      expect(customerView.conditionalActions.length).toBeGreaterThan(0);
      expect(customerView.areas.every((a) => !a.visible)).toBe(true);

      // Five baskets, read one at a time: every basket once, newest first, then no cursor.
      const created: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        created.push(
          (
            await ok<{ id: string }>(
              post(t, '/v1/baskets', customer.header, { ownerPersonId: customer.personId }),
              201,
            )
          ).id,
        );
        t.clock.advance(1_000);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
        const body: { items: Array<{ id: string }>; nextCursor: string | null } = await ok(
          get(t, `/v1/me/baskets?limit=2${query}`, customer.header),
        );
        seen.push(...body.items.map((b) => b.id));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual([...created].reverse());
      const tooMany = await get(t, '/v1/me/baskets?limit=500', customer.header);
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.code).toBe('VALIDATION_FAILED');
    } finally {
      await t.close();
    }
  });

  it('K-03: a preflight from a configured origin is answered for module routes with the client headers; another origin gets nothing', async () => {
    const t: TestApp = await journeyApp({
      env: { CORS_ALLOWED_ORIGINS: 'https://staff.example.org' },
    });
    try {
      for (const route of ['/v1/baskets', '/v1/registration-checkouts', '/v1/pos-sales']) {
        const allowed = await t.http
          .options(route)
          .set('Origin', 'https://staff.example.org')
          .set('Access-Control-Request-Method', 'POST')
          .set(
            'Access-Control-Request-Headers',
            'authorization,idempotency-key,x-sportspark-client',
          );
        expect(allowed.status, route).toBe(204);
        expect(allowed.headers['access-control-allow-origin']).toBe('https://staff.example.org');
        const headers = String(allowed.headers['access-control-allow-headers']).toLowerCase();
        expect(headers).toContain('idempotency-key');
        expect(headers).toContain('x-sportspark-client');
        expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
        const other = await t.http
          .options(route)
          .set('Origin', 'https://elsewhere.example.org')
          .set('Access-Control-Request-Method', 'POST');
        expect(other.headers['access-control-allow-origin']).toBeUndefined();
      }
    } finally {
      await t.close();
    }
  });
});
