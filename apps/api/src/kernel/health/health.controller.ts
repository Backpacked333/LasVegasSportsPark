import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { ReadyResponseValue } from '@sportspark/contracts';
import {
  loadMigrationFiles,
  migrationStatus,
  type Db,
  type MigrationFile,
  type MigrationStatus,
} from '@sportspark/db';
import type { Response } from 'express';
import { sql } from 'kysely';
import { Public } from '../auth/public.decorator';
import { AnyClientVersion } from '../http/client-compatibility.guard';
import type { AppConfig } from '../config';
import { APP_CONFIG, DATABASE } from '../tokens';
import { ReadinessState } from './readiness-state';

interface QueueBacklog {
  due: number;
  dead: number;
  oldestDueSeconds: number | null;
}

/**
 * Liveness and readiness answer every client build (SPK-AT-027 step 2).
 *
 * `GET /v1/health` is liveness: the process answers. `GET /v1/ready` is readiness (§5.11, §5.8):
 * 503 while the database is unavailable, while its schema does not match this build's migrations
 * (pending, changed or missing on disk: a deploy ahead of or behind its migrations), or while the
 * process drains for a stop. A backlog in the outbox or inbox, or a worker that has not finished a
 * periodic job recently, reads `degraded` with 200: the API still serves, and the backlog is an
 * operator signal, not a reason to take API instances out of rotation. Ages are measured by the
 * database clock.
 */
@AnyClientVersion()
@Controller()
export class HealthController {
  private migrationFiles: Promise<MigrationFile[]> | null = null;

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly readiness: ReadinessState,
  ) {}

  private async databaseStatus(): Promise<'ok' | 'unavailable'> {
    try {
      await sql`select 1`.execute(this.db);
      return 'ok';
    } catch {
      return 'unavailable';
    }
  }

  @Public()
  @Get('health')
  async health(): Promise<{ status: 'ok'; version: string; database: 'ok' | 'unavailable' }> {
    return {
      status: 'ok',
      version: this.config.APP_VERSION,
      database: await this.databaseStatus(),
    };
  }

  @Public()
  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const body = await this.readinessReport();
    res.status(body.status === 'not_ready' ? 503 : 200).json(body);
  }

  async readinessReport(): Promise<ReadyResponseValue> {
    const reasons: string[] = [];
    const database = await this.databaseStatus();
    let migrations: MigrationStatus | null = null;
    let outbox: QueueBacklog | null = null;
    let inbox: QueueBacklog | null = null;
    let worker: ReadyResponseValue['worker'] = null;
    if (database === 'unavailable') {
      reasons.push('database unavailable');
    } else {
      try {
        this.migrationFiles ??= loadMigrationFiles();
        migrations = await migrationStatus(this.db, { files: await this.migrationFiles });
        if (migrations.pending.length > 0) {
          reasons.push(`migrations pending: ${migrations.pending.join(', ')}`);
        }
        if (migrations.mismatched.length > 0) {
          reasons.push(
            `migrations changed after they were applied: ${migrations.mismatched.join(', ')}`,
          );
        }
        if (migrations.missingOnDisk.length > 0) {
          reasons.push(
            `migrations applied but missing from this build: ${migrations.missingOnDisk.join(', ')}`,
          );
        }
      } catch (error) {
        this.migrationFiles = null;
        reasons.push(`migration status unreadable: ${String(error)}`);
      }
      [outbox, inbox, worker] = await Promise.all([
        this.backlog('outbox'),
        this.backlog('inbox'),
        this.workerActivity(),
      ]);
    }
    if (this.readiness.draining) reasons.push('draining for shutdown');
    const notReady = database === 'unavailable' || !migrations?.current || this.readiness.draining;

    const lag = this.config.READY_QUEUE_LAG_SECONDS;
    const outboxAge = outbox?.oldestDueSeconds ?? 0;
    if (outboxAge > lag) reasons.push(`outbox backlog: oldest due event waited ${outboxAge}s`);
    const inboxAge = inbox?.oldestDueSeconds ?? 0;
    if (inboxAge > lag) reasons.push(`inbox backlog: oldest due event waited ${inboxAge}s`);
    const workerAge = worker?.secondsSinceSuccess ?? 0;
    if (workerAge > this.config.READY_WORKER_STALE_SECONDS) {
      reasons.push(`no periodic job succeeded for ${workerAge}s`);
    }
    return {
      status: notReady ? 'not_ready' : reasons.length > 0 ? 'degraded' : 'ready',
      version: this.config.APP_VERSION,
      database,
      migrations: migrations
        ? {
            current: migrations.current,
            applied: migrations.applied,
            pending: migrations.pending.length,
            mismatched: migrations.mismatched.length,
            missingOnDisk: migrations.missingOnDisk.length,
          }
        : null,
      outbox,
      inbox,
      worker,
      draining: this.readiness.draining,
      reasons,
    };
  }

  private async backlog(queue: 'outbox' | 'inbox'): Promise<QueueBacklog | null> {
    try {
      const due =
        queue === 'outbox' ? sql`status = 'pending'` : sql`status in ('received', 'failed')`;
      const table = queue === 'outbox' ? sql`outbox_events` : sql`inbox_events`;
      const { rows } = await sql<{ due: string; dead: string; oldest: string | null }>`
        select
          count(*) filter (where ${due} and available_at <= now()) as due,
          count(*) filter (where status = 'dead') as dead,
          extract(epoch from now() - min(available_at) filter (where ${due} and available_at <= now()))::bigint as oldest
        from ${table}
      `.execute(this.db);
      const row = rows[0];
      return {
        due: Number(row?.due ?? 0),
        dead: Number(row?.dead ?? 0),
        oldestDueSeconds: seconds(row?.oldest),
      };
    } catch {
      return null;
    }
  }

  private async workerActivity(): Promise<ReadyResponseValue['worker']> {
    try {
      const { rows } = await sql<{ last: Date | string | null; age: string | null }>`
        select max(last_succeeded_at) as last,
               extract(epoch from now() - max(last_succeeded_at))::bigint as age
        from periodic_job_leases
      `.execute(this.db);
      const row = rows[0];
      const last = row?.last ? new Date(row.last) : null;
      return {
        lastSucceededAt: last ? last.toISOString() : null,
        secondsSinceSuccess: seconds(row?.age),
      };
    } catch {
      return null;
    }
  }
}

/** A non-negative whole number of seconds from a database interval epoch; null when absent. */
export function seconds(value: string | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.max(0, Number(value));
}
