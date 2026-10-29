import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../testing/test-app';
import type { AppConfig } from '../config';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import {
  PERIODIC_JOB_FAILING_CATEGORY,
  PeriodicJobRegistry,
  PeriodicJobRunner,
  type PeriodicJob,
} from '../jobs/periodic-jobs';
import { BackgroundWorkers } from '../workers/background-workers';
import { APP_CONFIG, CLOCK, DATABASE } from '../tokens';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('periodic jobs (K-06, §4.12)', () => {
  let t: TestApp;
  let registry: PeriodicJobRegistry;
  const counts = new Map<string, number>();
  let gate: { promise: Promise<void>; resolve: () => void } | null = null;
  let started: { promise: Promise<void>; resolve: () => void } | null = null;
  let failing = true;
  let remaining = 0;

  const job = (name: string, run: PeriodicJob['run'], intervalSeconds = 60): PeriodicJob => ({
    name,
    intervalSeconds,
    failureOwner: 'scheduler',
    run,
  });

  /** A second runner as another worker process would build it. */
  const otherRunner = (workerId: string) => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    return new PeriodicJobRunner(
      t.app.get(DATABASE),
      { ...config, WORKER_ID: workerId },
      t.app.get(CLOCK),
      registry,
      t.app.get(UnitOfWork),
      t.app.get(OperationalExceptions),
    );
  };

  beforeAll(async () => {
    t = await createTestApp({ clockStart: '2026-11-02T10:00:00Z' });
    registry = t.app.get(PeriodicJobRegistry);
    const count = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
    registry.register(
      job('kerneltest.gated', async () => {
        count('kerneltest.gated');
        started?.resolve();
        if (gate) await gate.promise;
        return { processed: 1, remaining: 0 };
      }),
    );
    registry.register(
      job('kerneltest.flaky', async () => {
        count('kerneltest.flaky');
        if (failing) throw new Error('sweep failed');
        return { processed: 0, remaining: 0 };
      }),
    );
    registry.register(
      job('kerneltest.batches', async ({ batchSize }) => {
        count('kerneltest.batches');
        const done = Math.min(batchSize, remaining);
        remaining -= done;
        return { processed: done, remaining };
      }),
    );
    registry.register(
      job('kerneltest.after_failure', async () => {
        count('kerneltest.after_failure');
        return { processed: 0, remaining: 0 };
      }),
    );
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(() => {
    gate = null;
    started = null;
  });

  it('runs in the worker process only: registered as the background worker kernel.periodic_jobs', () => {
    const workers = t.app.get(BackgroundWorkers);
    expect(workers.names()).toContain('kernel.periodic_jobs');
    expect(workers.isStarted()).toBe(false);
  });

  it('refuses duplicate and malformed job names', () => {
    expect(() =>
      registry.register(job('kerneltest.gated', async () => ({ processed: 0, remaining: 0 }))),
    ).toThrow(/already registered/);
    expect(() =>
      registry.register(job('Bad-Name', async () => ({ processed: 0, remaining: 0 }))),
    ).toThrow(/<module>.<job>/);
  });

  it('§4.12: two runners racing one job run it once (PGlite and TEST_DATABASE_URL)', async () => {
    counts.set('kerneltest.gated', 0);
    gate = deferred();
    started = deferred();
    const a = otherRunner('worker-a');
    const b = otherRunner('worker-b');
    // A claims the job and is still running it while B tries.
    const first = a.runOnce(['kerneltest.gated']);
    await started.promise;
    const second = await b.runOnce(['kerneltest.gated']);
    gate.resolve();
    const [summaryA] = await first;
    expect(summaryA).toMatchObject({ ran: true, processed: 1 });
    expect(second[0]).toMatchObject({ ran: false });
    expect(counts.get('kerneltest.gated')).toBe(1);

    // Racing without a gate: still once, because the interval has not elapsed for the loser.
    t.clock.advance(61_000);
    const raced = await Promise.all([
      otherRunner('worker-c').runOnce(['kerneltest.gated']),
      otherRunner('worker-d').runOnce(['kerneltest.gated']),
    ]);
    expect(raced.flat().filter((s) => s.ran)).toHaveLength(1);
    expect(counts.get('kerneltest.gated')).toBe(2);
    // Within the interval nobody runs it again.
    expect((await otherRunner('worker-e').runOnce(['kerneltest.gated']))[0]?.ran).toBe(false);
  });

  it('SPK-AT-023: an expired lease is taken over by another worker', async () => {
    // A worker claimed the job and died before releasing it.
    const now = t.clock.now();
    await t.db
      .updateTable('periodic_job_leases')
      .set({
        locked_by: 'dead-worker:lease',
        locked_until: new Date(now.getTime() + 300_000),
        last_started_at: now,
      })
      .where('job_name', '=', 'kerneltest.gated')
      .execute();
    t.clock.advance(120_000);
    expect((await otherRunner('worker-f').runOnce(['kerneltest.gated']))[0]?.ran).toBe(false);
    t.clock.advance(181_000);
    const takeover = await otherRunner('worker-g').runOnce(['kerneltest.gated']);
    expect(takeover[0]).toMatchObject({ ran: true });
    const lease = await t.db
      .selectFrom('periodic_job_leases')
      .selectAll()
      .where('job_name', '=', 'kerneltest.gated')
      .executeTakeFirstOrThrow();
    expect(lease.locked_by).toBeNull();
    expect(lease.consecutive_failures).toBe(0);
  });

  it('§4.12: a job failing three times raises one kernel.periodic_job_failing exception per active organization owned by its failure owner, resolved by the next success', async () => {
    const second = await seedOrganization(t.db);
    const suspended = await seedOrganization(t.db);
    await t.db
      .updateTable('organizations')
      .set({ status: 'suspended' })
      .where('id', '=', suspended.organizationId)
      .execute();
    const exceptions = () =>
      t.db
        .selectFrom('operational_exceptions')
        .select(['organization_id', 'owner_queue', 'status', 'severity'])
        .where('category', '=', PERIODIC_JOB_FAILING_CATEGORY)
        .where('dedupe_key', '=', 'periodic_job:kerneltest.flaky')
        .execute();
    failing = true;
    for (let i = 1; i <= 2; i += 1) {
      const [run] = await t.runPeriodicJobs(['kerneltest.flaky']);
      expect(run).toMatchObject({ ran: true, failed: true, error: 'Error: sweep failed' });
      expect(await exceptions()).toEqual([]);
    }
    await t.runPeriodicJobs(['kerneltest.flaky']);
    await t.runPeriodicJobs(['kerneltest.flaky']); // a fourth failure deduplicates
    const raised = await exceptions();
    expect(raised.map((e) => e.organization_id).sort()).toEqual(
      [t.organizationId, second.organizationId].sort(),
    );
    expect(raised.every((e) => e.owner_queue === 'scheduler' && e.severity === 'high')).toBe(true);
    expect(raised.every((e) => e.status === 'open')).toBe(true);
    const lease = await t.db
      .selectFrom('periodic_job_leases')
      .select(['consecutive_failures', 'last_error'])
      .where('job_name', '=', 'kerneltest.flaky')
      .executeTakeFirstOrThrow();
    expect(lease).toEqual({ consecutive_failures: 4, last_error: 'Error: sweep failed' });

    failing = false;
    const [ok] = await t.runPeriodicJobs(['kerneltest.flaky']);
    expect(ok).toMatchObject({ ran: true, failed: false });
    expect((await exceptions()).every((e) => e.status === 'resolved')).toBe(true);
  });

  it('a throwing job never stops the others, and a job with remaining work runs up to MAX_PASSES', async () => {
    failing = true;
    remaining = 1000;
    counts.set('kerneltest.after_failure', 0);
    counts.set('kerneltest.batches', 0);
    const summaries = await t.runPeriodicJobs([
      'kerneltest.flaky',
      'kerneltest.after_failure',
      'kerneltest.batches',
    ]);
    expect(summaries.map((s) => [s.name, s.ran, s.failed])).toEqual([
      ['kerneltest.flaky', true, true],
      ['kerneltest.after_failure', true, false],
      ['kerneltest.batches', true, false],
    ]);
    expect(counts.get('kerneltest.after_failure')).toBe(1);
    // 10 passes of 50 rows (PERIODIC_JOBS_MAX_PASSES, the default batch size).
    expect(summaries[2]).toMatchObject({ passes: 10, processed: 500, remaining: 500 });
    failing = false;
  });

  it('the database rejects a malformed job name and negative counters', async () => {
    await expect(
      t.db.insertInto('periodic_job_leases').values({ job_name: 'NoModule' }).execute(),
    ).rejects.toThrow();
    await expect(
      t.db
        .insertInto('periodic_job_leases')
        .values({ job_name: 'kerneltest.negative', consecutive_failures: -1 })
        .execute(),
    ).rejects.toThrow();
    await expect(
      t.db
        .insertInto('periodic_job_leases')
        .values({ job_name: 'kerneltest.half_lease', locked_by: 'x', locked_until: null })
        .execute(),
    ).rejects.toThrow();
  });
});
