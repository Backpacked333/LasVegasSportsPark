import { newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staffPrincipal } from '../../testing/principals';
import { createTestApp, type TestApp } from '../../testing/test-app';

const TOKEN = 'metrics-token-for-tests-only-0123456789';

describe('operational signal snapshot (§5.11)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ env: { METRICS_TOKEN: TOKEN } });
    await sql`
      insert into outbox_events (id, organization_id, event_type, aggregate_type, aggregate_id, payload, status, attempts, last_error, failure_owner)
      values (${newId()}, ${t.organizationId}, 'test.failed', 'test', ${newId()}, '{}'::jsonb, 'dead', 10, 'boom', 'finance_operator')
    `.execute(t.db);
    await sql`
      insert into operational_exceptions (id, organization_id, category, severity, title, owner_queue)
      values (${newId()}, ${t.organizationId}, 'finance.payment_outcome_unknown', 'high', 'Payment outcome unknown', 'finance_operator')
    `.execute(t.db);
  });
  afterAll(async () => {
    await t?.close();
  });

  it("§5.11: managers read their organization's dead letters and open exceptions; front desk may not", async () => {
    const gm = await t.authHeader(staffPrincipal(t.organizationId, ['general_manager']));
    const res = await t.http.get('/v1/admin/metrics').set(gm);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('organization');
    expect(res.body.outbox).toMatchObject({ dead: 1, due: 0 });
    expect(res.body.openExceptions).toEqual([
      {
        category: 'finance.payment_outcome_unknown',
        severity: 'high',
        ownerQueue: 'finance_operator',
        count: 1,
      },
    ]);
    // Another organization's manager sees none of it.
    const other = newId();
    await sql`insert into organizations (id, slug, name) values (${other}, ${`org-${other}`}, 'Other')`.execute(
      t.db,
    );
    const otherGm = await t.authHeader(staffPrincipal(other, ['general_manager']));
    const theirs = await t.http.get('/v1/admin/metrics').set(otherGm);
    expect(theirs.body.outbox.dead).toBe(0);
    expect(theirs.body.openExceptions).toEqual([]);
    const desk = await t.authHeader(staffPrincipal(t.organizationId, ['front_desk']));
    expect((await t.http.get('/v1/admin/metrics').set(desk)).status).toBe(403);
  });

  it('§5.11: a scraper reads the global counts in Prometheus text only with the metrics token', async () => {
    expect((await t.http.get('/v1/metrics')).status).toBe(401);
    expect(
      (await t.http.get('/v1/metrics').set('X-Metrics-Token', 'wrong-token-of-some-length')).status,
    ).toBe(401);
    const res = await t.http.get('/v1/metrics').set('X-Metrics-Token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toContain('sportspark_queue_dead_events{queue="outbox"} 1');
    expect(res.text).toContain(
      'sportspark_open_operational_exceptions{category="finance.payment_outcome_unknown",severity="high",owner_queue="finance_operator"} 1',
    );
  });

  it('§5.11: without METRICS_TOKEN the scrape route does not exist', async () => {
    const plain = await createTestApp();
    try {
      expect((await plain.http.get('/v1/metrics').set('X-Metrics-Token', TOKEN)).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
