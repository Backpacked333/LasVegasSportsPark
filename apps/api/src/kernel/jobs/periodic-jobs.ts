import { Inject, Injectable, Logger } from '@nestjs/common';
import { newId, systemPrincipal, type StaffRole } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { UnitOfWork } from '../database/unit-of-work';
import { OperationalExceptions } from '../exceptions/operational-exceptions.service';
import { APP_CONFIG, CLOCK, DATABASE } from '../tokens';
import type { BackgroundWorker } from '../workers/background-workers';

/**
 * Periodic jobs (K-06, IF-24; §4.12 durable, interruption-tolerant background work with a failure
 * owner). Every time-based sweep (expiry, window ends, reminders, outage detection) is a periodic
 * job; continuous provider-facing pollers (message delivery, the payment provider worker) stay
 * `BackgroundWorker`s.
 *
 * Job contract (overview.md, Proposed): a job is idempotent; it selects due rows with
 * `FOR UPDATE SKIP LOCKED` and changes each in one small transaction under
 * `systemPrincipal(row organization, '<job name>')`, with audit and outbox, through its state
 * machine; it never calls a provider inside a transaction; it returns how many rows it processed
 * and how many remain. Row-level failures are the job's own owned exceptions; a job that throws
 * is a failing job, and after PERIODIC_JOBS_FAILURE_THRESHOLD consecutive failures its failure
 * owner gets one `kernel.periodic_job_failing` exception per active organization, resolved by the
 * next success.
 *
 * Lease (SPK-AT-023, ASYNC-06), as the runner implements it: a run holds the job's lease for
 * PERIODIC_JOBS_LEASE_SECONDS. While a pass runs, the runner renews it every third of that time,
 * but only while the run shows progress: a pass started, or the job called
 * `renewJobLease(context)`, within the last PERIODIC_JOBS_LEASE_SECONDS. The runner gives up on a
 * run that shows no progress for that long, or that has run for PERIODIC_JOBS_MAX_RUN_SECONDS: it
 * stops renewing, aborts `context.lease.signal`, stops waiting for the pass and counts the run as
 * a failure (so a job that keeps hanging reaches its failure owner, §4.12); the lease then lapses,
 * within one lease of its last renewal, and another worker (or this one) takes the job over. So a
 * pass that outlives a lease keeps the job only by calling `renewJobLease(context)` as it goes,
 * and a pass stuck on a call that never returns loses it. `renewJobLease` returns false once
 * another runner holds the job or the run was given up. The lease keeps two live runners from
 * working one job; it does not fence a row whose runner was paused past its lease, nor a given-up
 * pass that is still running.
 *
 * A job that calls a provider once per row calls `renewJobLease(context)` before each call,
 * outside any transaction, and stops when it returns false. `entry.deliver_device_commands` and
 * `finance.reconcile_accounting_exports` do (Verified: entry `access-hardware.spec.ts` and
 * finance `accounting-export.spec.ts`, "K-06 / ASYNC-06: ..."), so a pass of theirs keeps the job
 * while it makes provider calls and sends nothing more once another runner holds it. Proposed, and
 * not yet done by any registered job (pending, owners entry and finance): such a job also claims
 * each row it sends with its own in-flight marker, checked when the outcome is recorded; without
 * it, the one call in flight when a paused runner loses its lease may overlap the run that takes
 * the job over.
 */
export interface PeriodicJobLease {
  /**
   * Aborted once this run may not go on: another runner holds the job, or the runner gave up on
   * the run (no progress for PERIODIC_JOBS_LEASE_SECONDS, or PERIODIC_JOBS_MAX_RUN_SECONDS).
   */
  readonly signal: AbortSignal;
  /**
   * Renews the lease now and counts as progress; false (and `signal` aborted) once another runner
   * holds the job or the run was given up.
   */
  renew(): Promise<boolean>;
}

export interface PeriodicJobContext {
  now: Date;
  batchSize: number;
  /**
   * The run's lease on the job. The runner always passes it; a test that calls a job's `run`
   * directly may leave it out (there is no lease to keep then).
   */
  lease?: PeriodicJobLease;
}

/**
 * Renews the run's lease before a provider call (which also tells the runner the run is making
 * progress) and says whether the run may go on (always true when the job was called without a
 * runner). Call it outside any transaction.
 */
export async function renewJobLease(context: PeriodicJobContext): Promise<boolean> {
  if (!context.lease) return true;
  if (context.lease.signal.aborted) return false;
  return context.lease.renew();
}

export interface PeriodicJobResult {
  processed: number;
  remaining: number;
}

export interface PeriodicJob {
  /** `<module>.<job>` (`^[a-z]+\.[a-z0-9_]+$`). */
  name: string;
  /** Minimum time between two runs. */
  intervalSeconds: number;
  /** The staff queue that owns a repeatedly failing job (§4.12 failure owner). */
  failureOwner: StaffRole;
  /** Rows per pass (technical value; default 50). */
  batchSize?: number;
  run(context: PeriodicJobContext): Promise<PeriodicJobResult>;
}

export const PERIODIC_JOB_NAME = /^[a-z]+\.[a-z0-9_]+$/;
export const PERIODIC_JOB_FAILING_CATEGORY = 'kernel.periodic_job_failing';
const DEFAULT_BATCH_SIZE = 50;

/** Modules register their periodic jobs here in `onModuleInit`. */
@Injectable()
export class PeriodicJobRegistry {
  private readonly jobs = new Map<string, PeriodicJob>();

  register(job: PeriodicJob): void {
    if (!PERIODIC_JOB_NAME.test(job.name)) {
      throw new Error(`periodic job name ${job.name} must read <module>.<job>`);
    }
    if (this.jobs.has(job.name)) throw new Error(`periodic job ${job.name} is already registered`);
    if (!Number.isInteger(job.intervalSeconds) || job.intervalSeconds < 1) {
      throw new Error(`periodic job ${job.name} needs an interval of at least one second`);
    }
    this.jobs.set(job.name, job);
  }

  get(name: string): PeriodicJob | undefined {
    return this.jobs.get(name);
  }

  list(): PeriodicJob[] {
    return [...this.jobs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export interface PeriodicJobRunSummary {
  name: string;
  /** False when another runner held the lease or the interval had not elapsed. */
  ran: boolean;
  passes: number;
  processed: number;
  remaining: number;
  failed: boolean;
  error: string | null;
  /**
   * True when the runner gave up on the run (no progress for PERIODIC_JOBS_LEASE_SECONDS, or
   * PERIODIC_JOBS_MAX_RUN_SECONDS): it counts as a failure and its lease is left to lapse.
   */
  abandoned: boolean;
  /**
   * True when this run no longer held the job's lease when it ended: another runner took the job
   * over, and this run recorded nothing.
   */
  leaseLost: boolean;
}

/** The runner gave up on a run (ASYNC-06): it ran too long, or showed no progress for a lease. */
class PeriodicJobAbandoned extends Error {
  override readonly name = 'PeriodicJobAbandoned';
}

/** What the runner holds while a run works (see `guardRun`). */
interface RunGuard {
  readonly lease: PeriodicJobLease;
  /** Rejects with PeriodicJobAbandoned when the runner gives up on the run; never resolves. */
  readonly abandoned: Promise<never>;
  /** A pass starts (progress); throws PeriodicJobAbandoned when the run was given up. */
  passStarting(): void;
  /** True once the run has lasted PERIODIC_JOBS_MAX_RUN_SECONDS. */
  outOfTime(): boolean;
  /** Stops the keep-alive timer; a renewal still in flight lands first. */
  stop(): Promise<void>;
}

export interface RunOnceOptions {
  /** Tests: run a job whose interval has not elapsed yet (the lease is still respected). */
  ignoreInterval?: boolean;
}

/**
 * Runs the registered periodic jobs (the background worker `kernel.periodic_jobs`). `worker.ts`
 * starts it through `BackgroundWorkers.startAll()`; the API process and tests never do (tests call
 * `runOnce` after advancing the FixedClock). Each job is claimed with one statement, so two
 * runners racing one job run it once; a running pass keeps renewing its lease while it shows
 * progress, a run without progress or past PERIODIC_JOBS_MAX_RUN_SECONDS is given up as a
 * failure, and only an expired lease is taken over (SPK-AT-023, ASYNC-06).
 */
@Injectable()
export class PeriodicJobRunner implements BackgroundWorker {
  readonly name = 'kernel.periodic_jobs';
  private readonly logger = new Logger(PeriodicJobRunner.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: PeriodicJobRegistry,
    private readonly uow: UnitOfWork,
    private readonly exceptions: OperationalExceptions,
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error(`periodic jobs failed: ${String(error)}`);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), this.config.PERIODIC_JOBS_TICK_MS);
    void tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Runs every due job (or the named ones) once; one failing job never stops the others. */
  async runOnce(
    names?: readonly string[],
    options: RunOnceOptions = {},
  ): Promise<PeriodicJobRunSummary[]> {
    const jobs = names
      ? names.map((name) => {
          const job = this.registry.get(name);
          if (!job) throw new Error(`no periodic job ${name} is registered`);
          return job;
        })
      : this.registry.list();
    const summaries: PeriodicJobRunSummary[] = [];
    for (const job of jobs) {
      try {
        summaries.push(await this.runJob(job, options));
      } catch (error) {
        // Bookkeeping failed (the database is unavailable): the next tick tries again.
        this.logger.error(`periodic job ${job.name} could not be run: ${String(error)}`);
        summaries.push({
          name: job.name,
          ran: false,
          passes: 0,
          processed: 0,
          remaining: 0,
          failed: true,
          error: String(error),
          abandoned: false,
          leaseLost: false,
        });
      }
    }
    return summaries;
  }

  private async runJob(job: PeriodicJob, options: RunOnceOptions): Promise<PeriodicJobRunSummary> {
    const token = `${this.config.WORKER_ID}:${newId()}`;
    const claimed = await this.claim(job, token, options);
    const summary: PeriodicJobRunSummary = {
      name: job.name,
      ran: false,
      passes: 0,
      processed: 0,
      remaining: 0,
      failed: false,
      error: null,
      abandoned: false,
      leaseLost: false,
    };
    if (!claimed) return summary;
    summary.ran = true;
    const guard = this.guardRun(job, token);
    try {
      for (;;) {
        guard.passStarting();
        // A pass that never settles cannot hold the runner: it stops waiting once it gives up.
        const result = await Promise.race([
          job.run({
            now: this.clock.now(),
            batchSize: job.batchSize ?? DEFAULT_BATCH_SIZE,
            lease: guard.lease,
          }),
          guard.abandoned,
        ]);
        summary.passes += 1;
        summary.processed += result.processed;
        summary.remaining = result.remaining;
        if (result.remaining <= 0 || summary.passes >= this.config.PERIODIC_JOBS_MAX_PASSES) break;
        if (guard.outOfTime()) break;
        if (!(await guard.lease.renew())) break;
      }
    } catch (error) {
      summary.failed = true;
      summary.abandoned = error instanceof PeriodicJobAbandoned;
      summary.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.warn(`periodic job ${job.name} failed: ${summary.error}`);
    } finally {
      await guard.stop();
    }
    // Whether this run still held the lease is what its release matched, not only what a renewal
    // happened to see: a takeover after the last renewal is a lost lease too.
    summary.leaseLost = !(await this.release(job, token, claimed.consecutiveFailures, summary));
    if (summary.leaseLost) {
      this.logger.warn(
        `periodic job ${job.name}: another runner took the job over during this run; this run recorded nothing`,
      );
    }
    return summary;
  }

  /**
   * Keeps this run's lease while it works and gives up on a run that hangs (SPK-AT-023, ASYNC-06).
   * The lease is renewed on demand (`lease.renew()`, before each further pass and by the job before
   * a provider call), and on a timer every third of PERIODIC_JOBS_LEASE_SECONDS while the run
   * shows progress (a pass start or a `lease.renew()` by the job) within the last lease period;
   * one renewal at a time. A renewal that finds another holder aborts `lease.signal`; a renewal
   * that fails (the database is unavailable) is retried on the next tick and lets the lease lapse
   * rather than claiming a hold it cannot prove. When a tick finds no progress for a lease period,
   * or the run at PERIODIC_JOBS_MAX_RUN_SECONDS, the runner gives up: the timer stops, the signal
   * is aborted and `abandoned` rejects, so the runner stops waiting, records a failure and leaves
   * the lease to lapse for another worker.
   */
  private guardRun(job: PeriodicJob, token: string): RunGuard {
    const leaseMs = this.config.PERIODIC_JOBS_LEASE_SECONDS * 1000;
    const maxRunMs = this.config.PERIODIC_JOBS_MAX_RUN_SECONDS * 1000;
    const startedAt = this.clock.now().getTime();
    let lastProgressAt = startedAt;
    const progress = () => {
      lastProgressAt = this.clock.now().getTime();
    };
    const held = new AbortController();
    let givenUp: PeriodicJobAbandoned | null = null;
    let reject!: (reason: PeriodicJobAbandoned) => void;
    const abandoned = new Promise<never>((_, r) => {
      reject = r;
    });
    // Raced against each pass; this handler keeps a give-up between passes from going unhandled.
    abandoned.catch(() => undefined);
    let inFlight: Promise<boolean> | null = null;
    const renewNow = (): Promise<boolean> => {
      if (held.signal.aborted) return Promise.resolve(false);
      inFlight ??= this.renew(job, token)
        .then((still) => {
          if (!still) held.abort(new Error(`another runner holds periodic job ${job.name}`));
          return still;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    };
    const giveUp = (why: string) => {
      givenUp = new PeriodicJobAbandoned(`gave up on the run: ${why}`);
      clearInterval(timer);
      held.abort(givenUp);
      this.logger.warn(
        `periodic job ${job.name}: ${givenUp.message}; its lease is left to lapse for another worker`,
      );
      reject(givenUp);
    };
    const everyMs = Math.max(1000, Math.floor(leaseMs / 3));
    const timer = setInterval(() => {
      if (givenUp) return;
      const now = this.clock.now().getTime();
      if (now - startedAt >= maxRunMs) {
        giveUp(
          `it has run for PERIODIC_JOBS_MAX_RUN_SECONDS (${this.config.PERIODIC_JOBS_MAX_RUN_SECONDS} s)`,
        );
      } else if (now - lastProgressAt >= leaseMs) {
        giveUp(
          `it showed no progress for PERIODIC_JOBS_LEASE_SECONDS (${this.config.PERIODIC_JOBS_LEASE_SECONDS} s)`,
        );
      } else {
        renewNow().catch((error: unknown) => {
          this.logger.warn(`periodic job ${job.name}: lease renewal failed: ${String(error)}`);
        });
      }
    }, everyMs);
    timer.unref();
    return {
      lease: {
        signal: held.signal,
        renew: () => {
          progress();
          return renewNow();
        },
      },
      abandoned,
      passStarting: () => {
        if (givenUp) throw givenUp;
        progress();
      },
      outOfTime: () => this.clock.now().getTime() - startedAt >= maxRunMs,
      stop: async () => {
        clearInterval(timer);
        // A renewal still in flight lands before the lease is released.
        await inFlight?.catch(() => false);
      },
    };
  }

  /** One statement: the lease is free or expired and the interval has elapsed (or no row yet). */
  private async claim(
    job: PeriodicJob,
    token: string,
    options: RunOnceOptions,
  ): Promise<{ consecutiveFailures: number } | null> {
    const now = this.clock.now();
    const until = new Date(now.getTime() + this.config.PERIODIC_JOBS_LEASE_SECONDS * 1000);
    const due = options.ignoreInterval ? now : new Date(now.getTime() - job.intervalSeconds * 1000);
    const result = await sql<{ consecutive_failures: number }>`
      insert into periodic_job_leases (job_name, locked_by, locked_until, last_started_at, run_count)
      values (${job.name}, ${token}, ${until}, ${now}, 1)
      on conflict (job_name) do update
        set locked_by = excluded.locked_by,
            locked_until = excluded.locked_until,
            last_started_at = excluded.last_started_at,
            run_count = periodic_job_leases.run_count + 1
        where (periodic_job_leases.locked_until is null or periodic_job_leases.locked_until < ${now})
          and (periodic_job_leases.last_started_at is null
               or periodic_job_leases.last_started_at <= ${due})
      returning consecutive_failures
    `.execute(this.db);
    const row = result.rows[0];
    return row ? { consecutiveFailures: Number(row.consecutive_failures) } : null;
  }

  /** Extends this run's lease; false when another runner took the job over. */
  private async renew(job: PeriodicJob, token: string): Promise<boolean> {
    const until = new Date(
      this.clock.now().getTime() + this.config.PERIODIC_JOBS_LEASE_SECONDS * 1000,
    );
    const renewed = await this.db
      .updateTable('periodic_job_leases')
      .set({ locked_until: until })
      .where('job_name', '=', job.name)
      .where('locked_by', '=', token)
      .executeTakeFirst();
    return Number(renewed.numUpdatedRows) > 0;
  }

  /**
   * Records how the run ended, only while this run still holds the lease; returns whether it did
   * (false: another runner took the job over and nothing was recorded). A run the runner gave up
   * on counts as a failure but keeps its hold, so the lease lapses rather than being freed while
   * its pass may still be running.
   */
  private async release(
    job: PeriodicJob,
    token: string,
    failuresBefore: number,
    summary: PeriodicJobRunSummary,
  ): Promise<boolean> {
    const now = this.clock.now();
    const released = await this.db
      .updateTable('periodic_job_leases')
      .set((eb) => ({
        ...(summary.abandoned
          ? {}
          : { locked_by: null, locked_until: null, last_finished_at: now }),
        last_succeeded_at: summary.failed ? eb.ref('last_succeeded_at') : now,
        last_error: summary.failed ? (summary.error ?? 'failed').slice(0, 4000) : null,
        consecutive_failures: summary.failed ? eb('consecutive_failures', '+', 1) : 0,
      }))
      .where('job_name', '=', job.name)
      .where('locked_by', '=', token)
      .returning('consecutive_failures')
      .executeTakeFirst();
    // A run whose lease lapsed (another runner owns the job now) records nothing.
    if (!released) return false;
    const failures = Number(released.consecutive_failures);
    if (summary.failed && failures >= this.config.PERIODIC_JOBS_FAILURE_THRESHOLD) {
      await this.raiseFailing(job, failures, summary.error);
    } else if (!summary.failed && failuresBefore > 0) {
      await this.resolveFailing(job);
    }
    return true;
  }

  private async activeOrganizations(): Promise<string[]> {
    const rows = await this.db
      .selectFrom('organizations')
      .select('id')
      .where('status', '=', 'active')
      .orderBy('id')
      .execute();
    return rows.map((r) => r.id);
  }

  /** §4.12: the failure owner hears about a job that keeps failing, once per organization. */
  private async raiseFailing(job: PeriodicJob, failures: number, error: string | null) {
    for (const organizationId of await this.activeOrganizations()) {
      await this.uow.run(({ trx }) =>
        this.exceptions.raise(trx, {
          organizationId,
          category: PERIODIC_JOB_FAILING_CATEGORY,
          severity: 'high',
          title: `Background job ${job.name} has failed ${failures} times in a row`,
          affectedType: 'periodic_job',
          affectedId: job.name,
          ownerQueue: job.failureOwner,
          dedupeKey: `periodic_job:${job.name}`,
          details: { job: job.name, consecutiveFailures: failures, lastError: error },
        }),
      );
    }
  }

  private async resolveFailing(job: PeriodicJob) {
    const open = await this.db
      .selectFrom('operational_exceptions')
      .select(['id', 'organization_id'])
      .where('category', '=', PERIODIC_JOB_FAILING_CATEGORY)
      .where('dedupe_key', '=', `periodic_job:${job.name}`)
      .where('status', 'in', ['open', 'acknowledged'])
      .execute();
    for (const row of open) {
      await this.uow.run(({ trx }) =>
        this.exceptions.transition(
          trx,
          systemPrincipal(row.organization_id, 'kernel.periodic_jobs'),
          row.id,
          'resolved',
          {
            reason: `Background job ${job.name} succeeded again`,
            resolution: { resolvedBy: 'kernel.periodic_jobs', job: job.name },
          },
        ),
      );
    }
  }
}
