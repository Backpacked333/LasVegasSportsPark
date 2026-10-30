import { Logger } from '@nestjs/common';
import { seedOrganization } from '@sportspark/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, TEST_CONFIG_ENV, type TestApp } from '../../testing/test-app';
import { loadConfig, type AppConfig } from '../config';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import {
  PERIODIC_JOB_FAILING_CATEGORY,
  PeriodicJobRegistry,
  PeriodicJobRunner,
  renewJobLease,
  type PeriodicJob,
  type PeriodicJobContext,
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
  /** kerneltest.per_row: the rows "sent to a provider" and a hook run after each one. */
  let sent: number[] = [];
  let afterRow: ((row: number) => Promise<void>) | null = null;
  let perRowContext: PeriodicJobContext | null = null;
  /** kerneltest.hung: while `hang`, a pass waits on a call that never returns. */
  let hang = false;
  let hungContext: PeriodicJobContext | null = null;
  /** kerneltest.slow_passes: how long each pass takes on the FixedClock. */
  let slowPassMs = 0;

  const job = (name: string, run: PeriodicJob['run'], intervalSeconds = 60): PeriodicJob => ({
    name,
    intervalSeconds,
    failureOwner: 'scheduler',
    run,
  });

  /** A second runner as another worker process would build it (with its own technical values). */
  const otherRunner = (workerId: string, overrides: Partial<AppConfig> = {}) => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    return new PeriodicJobRunner(
      t.app.get(DATABASE),
      { ...config, ...overrides, WORKER_ID: workerId },
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
    // A job that calls a provider once per row (as entry.deliver_device_commands does): it renews
    // its lease before each call and stops once another runner holds the job.
    registry.register(
      job('kerneltest.per_row', async (context) => {
        perRowContext ??= context;
        let processed = 0;
        for (let row = 0; row < 4; row += 1) {
          if (!(await renewJobLease(context))) break;
          sent.push(row);
          processed += 1;
          if (afterRow) await afterRow(row);
        }
        return { processed, remaining: 0 };
      }),
    );
    registry.register(
      job('kerneltest.hung', async (context) => {
        hungContext = context;
        started?.resolve();
        if (hang) await new Promise<never>(() => undefined);
        return { processed: 1, remaining: 0 };
      }),
    );
    registry.register(
      job('kerneltest.slow_passes', async () => {
        t.clock.advance(slowPassMs);
        return { processed: 1, remaining: 5 };
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
    sent = [];
    afterRow = null;
    perRowContext = null;
    hang = false;
    hungContext = null;
    slowPassMs = 0;
  });

  const leaseOf = (name: string) =>
    t.db
      .selectFrom('periodic_job_leases')
      .selectAll()
      .where('job_name', '=', name)
      .executeTakeFirstOrThrow();

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

  it('SPK-AT-023, ASYNC-06: a pass running past the lease it was claimed with keeps the lease on a timer while it shows progress, so no other worker takes the job over mid-pass (PGlite and TEST_DATABASE_URL)', async () => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    const leaseMs = config.PERIODIC_JOBS_LEASE_SECONDS * 1000;
    counts.set('kerneltest.gated', 0);
    gate = deferred();
    started = deferred();
    // Only the runner's keep-alive interval is faked; database I/O keeps its real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const first = otherRunner('worker-slow').runOnce(['kerneltest.gated'], {
        ignoreInterval: true,
      });
      await started.promise;
      const claimedAt = t.clock.now().getTime();
      // The pass is still running (one slow provider call after another) at 5/6 of the lease.
      t.clock.advance((leaseMs * 5) / 6);
      await vi.advanceTimersByTimeAsync(leaseMs / 3);
      await vi.waitFor(
        async () => {
          const lease = await leaseOf('kerneltest.gated');
          expect(new Date(lease.locked_until!).getTime()).toBeGreaterThan(claimedAt + leaseMs);
        },
        { timeout: 5000 },
      );
      // Past the lease the run first took, inside the renewed one: another worker stays out.
      t.clock.advance(leaseMs / 3);
      expect(t.clock.now().getTime()).toBeGreaterThan(claimedAt + leaseMs);
      const second = await otherRunner('worker-eager').runOnce(['kerneltest.gated'], {
        ignoreInterval: true,
      });
      expect(second[0]).toMatchObject({ ran: false });
      gate.resolve();
      const [summary] = await first;
      expect(summary).toMatchObject({ ran: true, failed: false, leaseLost: false, processed: 1 });
      expect(counts.get('kerneltest.gated')).toBe(1);
      const released = await leaseOf('kerneltest.gated');
      expect(released.locked_by).toBeNull();
      expect(released.locked_until).toBeNull();
    } finally {
      gate?.resolve();
      vi.useRealTimers();
    }
  });

  it('SPK-AT-023, ASYNC-06: a job that renews its lease before each provider call keeps the job while its rows outlive the lease', async () => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    const leaseMs = config.PERIODIC_JOBS_LEASE_SECONDS * 1000;
    const intruders: boolean[] = [];
    let intruding = false;
    afterRow = async () => {
      if (intruding) return;
      // Each provider call takes two thirds of the lease; another worker tries after each one.
      t.clock.advance((leaseMs * 2) / 3);
      intruding = true;
      try {
        const [attempt] = await otherRunner('worker-intruder').runOnce(['kerneltest.per_row'], {
          ignoreInterval: true,
        });
        intruders.push(attempt!.ran);
      } finally {
        intruding = false;
      }
    };
    const [summary] = await otherRunner('worker-rows').runOnce(['kerneltest.per_row'], {
      ignoreInterval: true,
    });
    expect(sent).toEqual([0, 1, 2, 3]);
    expect(intruders).toEqual([false, false, false, false]);
    expect(summary).toMatchObject({ ran: true, failed: false, leaseLost: false, processed: 4 });
    expect(perRowContext?.lease?.signal.aborted).toBe(false);
    expect((await leaseOf('kerneltest.per_row')).locked_by).toBeNull();
  });

  it('SPK-AT-023, ASYNC-06: once another worker holds the job, the lease renewal says so, the signal aborts, no further provider call is made and the run records nothing', async () => {
    afterRow = async (row) => {
      if (row !== 1) return;
      // This run's lease lapsed (the process was paused) and another worker claimed the job.
      const now = t.clock.now();
      await t.db
        .updateTable('periodic_job_leases')
        .set({ locked_by: 'worker-other:lease', locked_until: new Date(now.getTime() + 300_000) })
        .where('job_name', '=', 'kerneltest.per_row')
        .execute();
    };
    const before = await leaseOf('kerneltest.per_row');
    const [summary] = await otherRunner('worker-paused').runOnce(['kerneltest.per_row'], {
      ignoreInterval: true,
    });
    expect(sent).toEqual([0, 1]);
    expect(summary).toMatchObject({ ran: true, failed: false, leaseLost: true, processed: 2 });
    expect(perRowContext?.lease?.signal.aborted).toBe(true);
    expect(await renewJobLease(perRowContext!)).toBe(false);
    // The other worker's hold and the job's bookkeeping are left as they were.
    const after = await leaseOf('kerneltest.per_row');
    expect(after.locked_by).toBe('worker-other:lease');
    expect(after.last_finished_at).toEqual(before.last_finished_at);
    expect(after.consecutive_failures).toBe(before.consecutive_failures);
    await t.db
      .updateTable('periodic_job_leases')
      .set({ locked_by: null, locked_until: null })
      .where('job_name', '=', 'kerneltest.per_row')
      .execute();
  });

  it('SPK-AT-023, ASYNC-06: a takeover the run never noticed (it made no renewal afterwards) is still reported as leaseLost and logged, and the run records nothing', async () => {
    gate = deferred();
    started = deferred();
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const before = await leaseOf('kerneltest.gated');
      const run = otherRunner('worker-unaware').runOnce(['kerneltest.gated'], {
        ignoreInterval: true,
      });
      await started.promise;
      // The pass never renews; meanwhile its lease lapsed (a pause) and another worker claimed it.
      await t.db
        .updateTable('periodic_job_leases')
        .set({
          locked_by: 'worker-other:lease',
          locked_until: new Date(t.clock.now().getTime() + 300_000),
        })
        .where('job_name', '=', 'kerneltest.gated')
        .execute();
      gate.resolve();
      const [summary] = await run;
      expect(summary).toMatchObject({ ran: true, failed: false, leaseLost: true, processed: 1 });
      const after = await leaseOf('kerneltest.gated');
      expect(after.locked_by).toBe('worker-other:lease');
      expect(after.last_finished_at).toEqual(before.last_finished_at);
      expect(after.consecutive_failures).toBe(before.consecutive_failures);
      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes('kerneltest.gated: another runner took the job over'),
        ),
      ).toBe(true);
    } finally {
      gate?.resolve();
      warn.mockRestore();
      await t.db
        .updateTable('periodic_job_leases')
        .set({ locked_by: null, locked_until: null })
        .where('job_name', '=', 'kerneltest.gated')
        .execute();
    }
  });

  it('§4.12, ASYNC-06: a pass that never returns and shows no progress is given up after PERIODIC_JOBS_LEASE_SECONDS: the runner stops waiting, counts a failure its failure owner hears about, and the job is taken over once the lease lapses (PGlite and TEST_DATABASE_URL)', async () => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    const leaseMs = config.PERIODIC_JOBS_LEASE_SECONDS * 1000;
    const exceptions = () =>
      t.db
        .selectFrom('operational_exceptions')
        .select(['owner_queue', 'status'])
        .where('category', '=', PERIODIC_JOB_FAILING_CATEGORY)
        .where('dedupe_key', '=', 'periodic_job:kerneltest.hung')
        .execute();
    hang = true;
    started = deferred();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const first = otherRunner('worker-hung', { PERIODIC_JOBS_FAILURE_THRESHOLD: 1 }).runOnce(
        ['kerneltest.hung'],
        { ignoreInterval: true },
      );
      await started.promise;
      const claimedAt = t.clock.now().getTime();
      // Two thirds of a lease after the pass started: still within the progress window, renewed.
      t.clock.advance((leaseMs * 2) / 3);
      await vi.advanceTimersByTimeAsync(leaseMs / 3);
      await vi.waitFor(
        async () => {
          const lease = await leaseOf('kerneltest.hung');
          expect(new Date(lease.locked_until!).getTime()).toBe(claimedAt + (leaseMs * 5) / 3);
        },
        { timeout: 5000 },
      );
      // A whole lease without progress: the next tick gives up instead of renewing.
      t.clock.advance(leaseMs / 3);
      await vi.advanceTimersByTimeAsync(leaseMs / 3);
      const [summary] = await first;
      expect(summary).toMatchObject({
        ran: true,
        passes: 0,
        failed: true,
        abandoned: true,
        leaseLost: false,
      });
      expect(summary?.error).toMatch(/^PeriodicJobAbandoned: .*no progress/);
      expect(hungContext?.lease?.signal.aborted).toBe(true);
      expect(await renewJobLease(hungContext!)).toBe(false);
      // Counted as a failure, the hold left to lapse (the pass may still be running).
      const given = await leaseOf('kerneltest.hung');
      expect(given.locked_by).toMatch(/^worker-hung:/);
      expect(new Date(given.locked_until!).getTime()).toBe(claimedAt + (leaseMs * 5) / 3);
      expect(given.consecutive_failures).toBe(1);
      expect(given.last_error).toMatch(/no progress for PERIODIC_JOBS_LEASE_SECONDS/);
      const raised = await exceptions();
      expect(raised.length).toBeGreaterThan(0);
      expect(raised.every((e) => e.owner_queue === 'scheduler' && e.status === 'open')).toBe(true);
      // Until the lease lapses nobody takes the job over; then another worker does.
      const early = await otherRunner('worker-next').runOnce(['kerneltest.hung'], {
        ignoreInterval: true,
      });
      expect(early[0]).toMatchObject({ ran: false });
      t.clock.advance((leaseMs * 2) / 3 + 1000);
      hang = false;
      const [takeover] = await otherRunner('worker-next').runOnce(['kerneltest.hung'], {
        ignoreInterval: true,
      });
      expect(takeover).toMatchObject({ ran: true, failed: false, abandoned: false, processed: 1 });
      const after = await leaseOf('kerneltest.hung');
      expect(after.locked_by).toBeNull();
      expect(after.consecutive_failures).toBe(0);
      expect((await exceptions()).every((e) => e.status === 'resolved')).toBe(true);
    } finally {
      hang = false;
      vi.useRealTimers();
    }
  });

  it('§4.12, ASYNC-06: a pass that keeps renewing is still given up at PERIODIC_JOBS_MAX_RUN_SECONDS (PGlite and TEST_DATABASE_URL)', async () => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    const leaseMs = config.PERIODIC_JOBS_LEASE_SECONDS * 1000;
    hang = true;
    started = deferred();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const first = otherRunner('worker-capped', {
        PERIODIC_JOBS_MAX_RUN_SECONDS: config.PERIODIC_JOBS_LEASE_SECONDS * 2,
      }).runOnce(['kerneltest.hung'], { ignoreInterval: true });
      await started.promise;
      const context = hungContext!;
      for (let step = 1; step <= 3; step += 1) {
        // The job renews before each provider call, well within the progress window.
        t.clock.advance((leaseMs * 2) / 3);
        expect(await renewJobLease(context)).toBe(true);
        await vi.advanceTimersByTimeAsync(leaseMs / 3);
      }
      const [summary] = await first;
      expect(summary).toMatchObject({ ran: true, failed: true, abandoned: true, leaseLost: false });
      expect(summary?.error).toMatch(/PERIODIC_JOBS_MAX_RUN_SECONDS/);
      expect(context.lease?.signal.aborted).toBe(true);
      expect(await renewJobLease(context)).toBe(false);
      const given = await leaseOf('kerneltest.hung');
      expect(given.locked_by).toMatch(/^worker-capped:/);
      expect(given.consecutive_failures).toBe(1);
    } finally {
      hang = false;
      vi.useRealTimers();
      await t.db
        .updateTable('periodic_job_leases')
        .set({ locked_by: null, locked_until: null, consecutive_failures: 0, last_error: null })
        .where('job_name', '=', 'kerneltest.hung')
        .execute();
    }
  });

  it('§4.12, ASYNC-06: a run that reaches PERIODIC_JOBS_MAX_RUN_SECONDS at a pass boundary starts no further pass and is not a failure', async () => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    // Each pass takes one lease (renewing as it goes); the run may last two.
    slowPassMs = config.PERIODIC_JOBS_LEASE_SECONDS * 1000;
    const [summary] = await otherRunner('worker-slow-passes', {
      PERIODIC_JOBS_MAX_RUN_SECONDS: config.PERIODIC_JOBS_LEASE_SECONDS * 2,
    }).runOnce(['kerneltest.slow_passes'], { ignoreInterval: true });
    expect(summary).toMatchObject({
      ran: true,
      passes: 2,
      processed: 2,
      remaining: 5,
      failed: false,
      abandoned: false,
      leaseLost: false,
    });
    expect((await leaseOf('kerneltest.slow_passes')).locked_by).toBeNull();
  });

  it('PERIODIC_JOBS_MAX_RUN_SECONDS below PERIODIC_JOBS_LEASE_SECONDS is refused at boot', () => {
    expect(() =>
      loadConfig({
        ...TEST_CONFIG_ENV,
        PERIODIC_JOBS_LEASE_SECONDS: '300',
        PERIODIC_JOBS_MAX_RUN_SECONDS: '299',
      }),
    ).toThrow(/PERIODIC_JOBS_MAX_RUN_SECONDS must be at least PERIODIC_JOBS_LEASE_SECONDS/);
    expect(
      loadConfig({ ...TEST_CONFIG_ENV, PERIODIC_JOBS_MAX_RUN_SECONDS: '300' })
        .PERIODIC_JOBS_MAX_RUN_SECONDS,
    ).toBe(300);
  });

  it('renewJobLease is true for a job called without a runner (no lease to keep)', async () => {
    expect(await renewJobLease({ now: t.clock.now(), batchSize: 50 })).toBe(true);
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
