import { newId } from '@sportspark/contracts';
import type { Database } from '@sportspark/db';
import { Kysely, PostgresDialect, sql, type PostgresDialectConfig } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { HealthController } from '../health/health.controller';
import { ReadinessState } from '../health/readiness-state';
import { DATABASE } from '../tokens';

/**
 * A database handle whose every connection attempt fails: what the probe sees when the database
 * is down or unreachable (§5.11). Kysely's PostgreSQL dialect accepts any pool with `connect` and
 * `end`, so no server and no driver are involved.
 */
function unreachableDatabase(): Kysely<Database> {
  const pool = {
    connect: async () => {
      throw new Error('connection refused (test)');
    },
    end: async () => undefined,
  } as unknown as PostgresDialectConfig['pool'];
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

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
      // §5.11: a worker that has not succeeded yet is reported as null, not as a readiness reason
      // (the first periodic job may not have run on a fresh deployment).
      worker: { lastSucceededAt: null, secondsSinceSuccess: null },
      draining: false,
      reasons: [],
    });
    expect(res.body.migrations.applied).toBeGreaterThan(100);
  });

  it('§5.8 / §6.8 item 11: liveness and readiness name the build (version is APP_VERSION, derived from the build commit)', async () => {
    const sha = 'c'.repeat(40);
    const built = await createTestApp({ env: { SOURCE_COMMIT: sha } });
    try {
      expect((await built.http.get('/v1/health')).body).toMatchObject({
        status: 'ok',
        version: sha,
      });
      expect((await built.http.get('/v1/ready')).body).toMatchObject({
        status: 'ready',
        version: sha,
      });
    } finally {
      await built.close();
    }
    // The shared app has no build commit: a developer build.
    expect((await t.http.get('/v1/health')).body.version).toBe('0.1.0');
  });

  it('§5.11 / §5.8: a database that cannot be reached makes readiness 503 (database unavailable) while liveness still answers 200 with database: unavailable', async () => {
    const dead = unreachableDatabase();
    const down = await createTestApp({
      configure: (b) => b.overrideProvider(DATABASE).useValue(dead),
    });
    try {
      const ready = await down.http.get('/v1/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({
        status: 'not_ready',
        database: 'unavailable',
        migrations: null,
        outbox: null,
        inbox: null,
        worker: null,
        draining: false,
        reasons: ['database unavailable'],
      });
      const health = await down.http.get('/v1/health');
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({ status: 'ok', database: 'unavailable' });
    } finally {
      await down.close();
      await dead.destroy();
    }
    // The same report without an HTTP layer, for a process whose module did not boot.
    const direct = unreachableDatabase();
    try {
      const report = await new HealthController(
        direct,
        t.config,
        new ReadinessState(),
      ).readinessReport();
      expect(report).toMatchObject({ status: 'not_ready', database: 'unavailable' });
    } finally {
      await direct.destroy();
    }
  });

  it('§5.8: a migration this build has that the database has not applied is not ready (deploy ahead of its migrations)', async () => {
    const latest = await sql<{ version: string; name: string; checksum: string }>`
      select version, name, checksum from schema_migrations order by version desc limit 1
    `.execute(t.db);
    const row = latest.rows[0];
    if (!row) throw new Error('no applied migration');
    await sql`delete from schema_migrations where version = ${row.version}`.execute(t.db);
    try {
      const res = await t.http.get('/v1/ready');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.migrations).toMatchObject({ current: false, pending: 1 });
      expect(res.body.reasons.join(' ')).toMatch(
        new RegExp(`migrations pending: ${row.version}_${row.name}\\.sql`),
      );
    } finally {
      await sql`insert into schema_migrations (version, name, checksum) values (${row.version}, ${row.name}, ${row.checksum})`.execute(
        t.db,
      );
    }
  });

  it('§4.1 / §5.8: an applied migration whose file changed after it was applied is not ready (checksum mismatch)', async () => {
    const first = await sql<{ checksum: string }>`
      select checksum from schema_migrations where version = '0001'
    `.execute(t.db);
    const checksum = first.rows[0]?.checksum;
    if (!checksum) throw new Error('migration 0001 not applied');
    await sql`update schema_migrations set checksum = 'tampered' where version = '0001'`.execute(
      t.db,
    );
    try {
      const res = await t.http.get('/v1/ready');
      expect(res.status).toBe(503);
      expect(res.body.migrations).toMatchObject({ current: false, mismatched: 1 });
      expect(res.body.reasons).toContain(
        'migrations changed after they were applied: 0001_core_schema.sql',
      );
    } finally {
      await sql`update schema_migrations set checksum = ${checksum} where version = '0001'`.execute(
        t.db,
      );
    }
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

  it('§5.11 worker age and retries: an outbox event due longer than READY_QUEUE_LAG_SECONDS reads degraded, still serving (200)', async () => {
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

  it('§5.11 worker age and retries: an inbox event due longer than READY_QUEUE_LAG_SECONDS reads degraded (200) and names the inbox backlog', async () => {
    const received = newId();
    const failed = newId();
    await sql`
      insert into inbox_events (id, provider, provider_event_id, organization_id, event_type, payload, available_at)
      values (${received}, 'test-provider', ${`evt-${received}`}, ${t.organizationId}, 'test.waiting', '{}'::jsonb, now() - interval '1 hour')
    `.execute(t.db);
    await sql`
      insert into inbox_events (id, provider, provider_event_id, organization_id, event_type, payload, status, attempts, last_error, available_at)
      values (${failed}, 'test-provider', ${`evt-${failed}`}, ${t.organizationId}, 'test.retrying', '{}'::jsonb, 'failed', 1, 'boom', now() - interval '10 minutes')
    `.execute(t.db);
    try {
      const res = await t.http.get('/v1/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      // Both a received and a failed-and-retrying event are due work for the worker.
      expect(res.body.inbox.due).toBe(2);
      expect(res.body.inbox.oldestDueSeconds).toBeGreaterThanOrEqual(3599);
      expect(res.body.reasons.join(' ')).toMatch(/inbox backlog/);
    } finally {
      await sql`delete from inbox_events where id in (${received}, ${failed})`.execute(t.db);
    }
  });

  it('§5.11 / §4.12: no periodic job succeeded for longer than READY_WORKER_STALE_SECONDS reads degraded and reports the last success', async () => {
    await sql`
      insert into periodic_job_leases (job_name, last_succeeded_at)
      values ('kerneltest.stale', now() - interval '2 hours')
    `.execute(t.db);
    try {
      const stale = await t.http.get('/v1/ready');
      expect(stale.status).toBe(200);
      expect(stale.body.status).toBe('degraded');
      expect(typeof stale.body.worker.lastSucceededAt).toBe('string');
      expect(stale.body.worker.secondsSinceSuccess).toBeGreaterThanOrEqual(7199);
      expect(stale.body.reasons.join(' ')).toMatch(/no periodic job succeeded for \d+s/);

      await sql`update periodic_job_leases set last_succeeded_at = now() where job_name = 'kerneltest.stale'`.execute(
        t.db,
      );
      const fresh = await t.http.get('/v1/ready');
      expect(fresh.body.status).toBe('ready');
      expect(fresh.body.worker.secondsSinceSuccess).toBeLessThan(60);
    } finally {
      await sql`delete from periodic_job_leases where job_name = 'kerneltest.stale'`.execute(t.db);
    }
  });

  it('§5.11: dead letters are counted in the report but do not change readiness (they are owned operational exceptions)', async () => {
    const outbox = newId();
    const inbox = newId();
    await sql`
      insert into outbox_events (id, organization_id, event_type, aggregate_type, aggregate_id, payload, status, attempts, last_error, failure_owner)
      values (${outbox}, ${t.organizationId}, 'test.failed', 'test', ${newId()}, '{}'::jsonb, 'dead', 10, 'boom', 'finance_operator')
    `.execute(t.db);
    await sql`
      insert into inbox_events (id, provider, provider_event_id, organization_id, event_type, payload, status, attempts, last_error)
      values (${inbox}, 'test-provider', ${`evt-${inbox}`}, ${t.organizationId}, 'test.failed', '{}'::jsonb, 'dead', 10, 'boom')
    `.execute(t.db);
    try {
      const res = await t.http.get('/v1/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.outbox).toMatchObject({ due: 0, dead: 1 });
      expect(res.body.inbox).toMatchObject({ due: 0, dead: 1 });
      expect(res.body.reasons).toEqual([]);
    } finally {
      await sql`delete from outbox_events where id = ${outbox}`.execute(t.db);
      await sql`delete from inbox_events where id = ${inbox}`.execute(t.db);
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
