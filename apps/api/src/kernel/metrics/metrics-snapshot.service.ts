import { Inject, Injectable } from '@nestjs/common';
import type { MetricsSnapshot } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { sql } from 'kysely';
import { seconds } from '../health/health.controller';
import { DATABASE } from '../tokens';

/**
 * The §5.11 signals the kernel can count from its own records, for dashboards and alerting before
 * any monitoring vendor is chosen (DEC-021): durable queue backlog and dead letters (worker age
 * and retries), periodic job health, failed handler attempts in the last hour, and open
 * operational exceptions by category and severity (which carry unknown financial outcomes,
 * delivery failures, capacity anomalies, stale readiness and the other owned signals). Organization
 * scoped when an organization is given; global (all organizations, counts only) otherwise.
 * Ages come from the database clock.
 */
@Injectable()
export class MetricsSnapshotService {
  constructor(@Inject(DATABASE) private readonly db: Db) {}

  async snapshot(organizationId: string | null): Promise<MetricsSnapshot> {
    const orgFilter = organizationId ? sql`and organization_id = ${organizationId}` : sql``;
    const [outbox, inbox, jobs, attempts, exceptions, clock] = await Promise.all([
      sql<{ due: string; dead: string; waiting: string; oldest: string | null }>`
        select
          count(*) filter (where status = 'pending' and available_at <= now()) as due,
          count(*) filter (where status = 'dead') as dead,
          count(*) filter (where status = 'pending' and waiting_since is not null) as waiting,
          extract(epoch from now() - min(available_at) filter (where status = 'pending' and available_at <= now()))::bigint as oldest
        from outbox_events where true ${orgFilter}
      `.execute(this.db),
      sql<{ due: string; dead: string; waiting: string; oldest: string | null }>`
        select
          count(*) filter (where status in ('received', 'failed') and available_at <= now()) as due,
          count(*) filter (where status = 'dead') as dead,
          count(*) filter (where status in ('received', 'failed') and waiting_since is not null) as waiting,
          extract(epoch from now() - min(available_at) filter (where status in ('received', 'failed') and available_at <= now()))::bigint as oldest
        from inbox_events where true ${orgFilter}
      `.execute(this.db),
      sql<{
        job_name: string;
        last_succeeded_at: Date | string | null;
        age: string | null;
        consecutive_failures: number;
      }>`
        select job_name, last_succeeded_at, consecutive_failures,
               extract(epoch from now() - last_succeeded_at)::bigint as age
        from periodic_job_leases order by job_name
      `.execute(this.db),
      sql<{ failed: string }>`
        select count(*) as failed from job_attempts
        where outcome = 'failed' and started_at > now() - interval '1 hour' ${orgFilter}
      `.execute(this.db),
      sql<{ category: string; severity: string; owner_queue: string; count: string }>`
        select category, severity, owner_queue, count(*) as count
        from operational_exceptions
        where status in ('open', 'acknowledged') ${orgFilter}
        group by category, severity, owner_queue
        order by category, severity, owner_queue
      `.execute(this.db),
      sql<{ now: Date | string }>`select now() as now`.execute(this.db),
    ]);
    const queue = (
      row: { due: string; dead: string; waiting: string; oldest: string | null } | undefined,
    ) => ({
      due: Number(row?.due ?? 0),
      dead: Number(row?.dead ?? 0),
      waitingForHandler: Number(row?.waiting ?? 0),
      oldestDueSeconds: seconds(row?.oldest),
    });
    return {
      takenAt: new Date(clock.rows[0]?.now ?? Date.now()).toISOString(),
      scope: organizationId ? 'organization' : 'global',
      outbox: queue(outbox.rows[0]),
      inbox: queue(inbox.rows[0]),
      periodicJobs: jobs.rows.map((j) => ({
        name: j.job_name,
        lastSucceededAt: j.last_succeeded_at ? new Date(j.last_succeeded_at).toISOString() : null,
        secondsSinceSuccess: seconds(j.age),
        consecutiveFailures: j.consecutive_failures,
      })),
      failedHandlerAttemptsLastHour: Number(attempts.rows[0]?.failed ?? 0),
      openExceptions: exceptions.rows.map((e) => ({
        category: e.category,
        severity: e.severity,
        ownerQueue: e.owner_queue,
        count: Number(e.count),
      })),
    };
  }
}

/** Prometheus text exposition of a snapshot (no labels that identify a person or record). */
export function toPrometheusText(snapshot: MetricsSnapshot): string {
  const lines: string[] = [];
  const metric = (name: string, help: string, type: 'gauge' | 'counter') => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  };
  const label = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  metric(
    'sportspark_queue_due_events',
    'Durable queue events due now and not yet processed',
    'gauge',
  );
  for (const q of ['outbox', 'inbox'] as const) {
    lines.push(`sportspark_queue_due_events{queue="${q}"} ${snapshot[q].due}`);
  }
  metric('sportspark_queue_dead_events', 'Dead-lettered durable queue events', 'gauge');
  for (const q of ['outbox', 'inbox'] as const) {
    lines.push(`sportspark_queue_dead_events{queue="${q}"} ${snapshot[q].dead}`);
  }
  metric(
    'sportspark_queue_waiting_for_handler_events',
    'Events waiting for a handler this build lacks',
    'gauge',
  );
  for (const q of ['outbox', 'inbox'] as const) {
    lines.push(
      `sportspark_queue_waiting_for_handler_events{queue="${q}"} ${snapshot[q].waitingForHandler}`,
    );
  }
  metric(
    'sportspark_queue_oldest_due_seconds',
    'Age of the oldest due event (0 when none)',
    'gauge',
  );
  for (const q of ['outbox', 'inbox'] as const) {
    lines.push(
      `sportspark_queue_oldest_due_seconds{queue="${q}"} ${snapshot[q].oldestDueSeconds ?? 0}`,
    );
  }
  metric(
    'sportspark_periodic_job_seconds_since_success',
    'Seconds since the job last succeeded (-1 when never)',
    'gauge',
  );
  for (const job of snapshot.periodicJobs) {
    lines.push(
      `sportspark_periodic_job_seconds_since_success{job="${label(job.name)}"} ${job.secondsSinceSuccess ?? -1}`,
    );
  }
  metric(
    'sportspark_periodic_job_consecutive_failures',
    'Consecutive failed runs of the job',
    'gauge',
  );
  for (const job of snapshot.periodicJobs) {
    lines.push(
      `sportspark_periodic_job_consecutive_failures{job="${label(job.name)}"} ${job.consecutiveFailures}`,
    );
  }
  metric(
    'sportspark_handler_failed_attempts_last_hour',
    'Failed outbox, inbox and job handler attempts in the last hour',
    'gauge',
  );
  lines.push(
    `sportspark_handler_failed_attempts_last_hour ${snapshot.failedHandlerAttemptsLastHour}`,
  );
  metric(
    'sportspark_open_operational_exceptions',
    'Open or acknowledged operational exceptions',
    'gauge',
  );
  for (const e of snapshot.openExceptions) {
    lines.push(
      `sportspark_open_operational_exceptions{category="${label(e.category)}",severity="${label(e.severity)}",owner_queue="${label(e.ownerQueue)}"} ${e.count}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
