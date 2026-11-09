import { newId } from '@sportspark/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { ReadinessState } from '../health/readiness-state';

describe('readiness probe (§5.11, §5.8, R3-OPERATIONS-10)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('§5.11: a migrated database with no backlog is ready; the report names every check', async () => {
    const res = await t.http.get('/v1/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ready',
      database: 'ok',
      migrations: { current: true, pending: 0, mismatched: 0, missingOnDisk: 0 },
      outbox: { due: 0, dead: 0, oldestDueSeconds: null },
      inbox: { due: 0, dead: 0, oldestDueSeconds: null },
      draining: false,
      reasons: [],
    });
    expect(res.body.migrations.applied).toBeGreaterThan(100);
  });

  it('§5.8: a schema with a migration this build does not have is not ready (deploy behind its database)', async () => {
    await sql`insert into schema_migrations (version, name, checksum) values ('9999', 'from_a_newer_build', 'x')`.execute(
      t.db,
    );
    try {
      const res = await t.http.get('/v1/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.migrations).toMatchObject({ current: false, missingOnDisk: 1 });
      expect(res.body.reasons).toContain('migrations applied but missing from this build: 9999');
    } finally {
      await sql`delete from schema_migrations where version = '9999'`.execute(t.db);
    }
  });

  it('§5.11 worker age: an outbox event due for an hour reads degraded, still serving (200)', async () => {
    const id = newId();
    await sql`
      insert into outbox_events (id, organization_id, event_type, aggregate_type, aggregate_id, payload, available_at)
      values (${id}, ${t.organizationId}, 'test.waiting', 'test', ${newId()}, '{}'::jsonb, now() - interval '1 hour')
    `.execute(t.db);
    try {
      const res = await t.http.get('/v1/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.outbox.due).toBe(1);
      expect(res.body.outbox.oldestDueSeconds).toBeGreaterThanOrEqual(3599);
      expect(res.body.reasons.join(' ')).toMatch(/outbox backlog/);
    } finally {
      await sql`delete from outbox_events where id = ${id}`.execute(t.db);
    }
  });

  it('R3-OPERATIONS-10: a draining process answers 503 so the load balancer routes elsewhere', async () => {
    const state = t.app.get(ReadinessState);
    state.draining = true;
    try {
      const res = await t.http.get('/v1/ready');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: 'not_ready', draining: true });
      expect(res.body.reasons).toContain('draining for shutdown');
      // Liveness is unaffected: the process still answers.
      expect((await t.http.get('/v1/health')).status).toBe(200);
    } finally {
      state.draining = false;
    }
  });
});
