import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  DomainError,
  errors,
  systemPrincipal,
  type Principal,
  type RecoveryBlocker,
  type RecoveryStatus,
} from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import { AuditWriter } from '../audit/audit.writer';
import { defineActions } from '../authorization/actions';
import { AuthorizationService } from '../authorization/authorization.service';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { UnitOfWork, type Trx } from '../database/unit-of-work';
import {
  ExceptionActions,
  OperationalExceptions,
} from '../exceptions/operational-exceptions.service';
import { APP_CONFIG, CLOCK, DATABASE } from '../tokens';

/** The operational exception that records a recovery after a restore (§5.8, SPK-AT-028). */
export const RECOVERY_EXCEPTION_CATEGORY = 'reliability.recovery_mode';

export const RecoveryActions = defineActions({
  resume: {
    id: 'operations.resume_after_recovery',
    description:
      'Resume normal operation after a database restore, once provider facts are reconciled (hand back authority, §5.8)',
    // The named recovery decision owner is pending (DEC-068); the conservative holder is the
    // general manager alone (the acceptance fixture's actor).
    staffRoles: ['general_manager'],
    requirements: ['§5.8', 'SPK-AT-028', '§4.11'],
  },
});

/**
 * A module's answer to "are the external facts it depends on reconciled since the restore?"
 * (§5.8). `since` is when recovery began. Each returned blocker keeps normal operation paused.
 */
export type RecoveryCheck = (
  db: Db | Trx,
  organizationId: string,
  since: Date,
) => Promise<RecoveryBlocker[]>;

/** Modules register their reconciliation checks here (finance: payment and refund facts). */
@Injectable()
export class RecoveryChecks {
  private readonly checks = new Map<string, RecoveryCheck>();

  register(name: string, check: RecoveryCheck): void {
    if (this.checks.has(name)) throw new Error(`recovery check ${name} already registered`);
    this.checks.set(name, check);
  }

  async run(db: Db | Trx, organizationId: string, since: Date): Promise<RecoveryBlocker[]> {
    const out: RecoveryBlocker[] = [];
    for (const check of this.checks.values()) out.push(...(await check(db, organizationId, since)));
    return out;
  }
}

/**
 * Recovery mode after a restore (spec §5.8 "Restoring an older database cannot undo payments or
 * valid customer activity. After live transactions, recovery must preserve journals, reconcile
 * external facts, and explicitly hand back authority"; SPK-AT-028 "External facts reconciled
 * before normal operations resume").
 *
 * - Entered at boot when `RECOVERY_RESTORE_REFERENCE` is set: every organization gets one critical
 *   `reliability.recovery_mode` exception (general manager queue) for that restore. A restore
 *   already resumed is never re-entered by a restart with the same reference.
 * - While it is open, routes marked `@RefusedDuringRecovery()` (finance's money commands) answer
 *   503 INTEGRATION_UNAVAILABLE `details.reason = recovery_mode`; reads, provider webhooks and the
 *   reconciliation commands stay available, and the finance worker starts no new charge.
 * - It ends only through `resume`: a general manager (DEC-068 pending), with a reason, once every
 *   registered reconciliation check passes. The generic exception commands cannot resolve it.
 *
 * Pending: a provider feed that recreates post-restore facts (DEC-019), the recovery environment
 * (DEC-021) and the named decision owner (DEC-068).
 */
@Injectable()
export class RecoveryMode implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryMode.name);

  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    private readonly exceptions: OperationalExceptions,
    private readonly audit: AuditWriter,
    private readonly authorization: AuthorizationService,
    private readonly checks: RecoveryChecks,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const reference = this.config.RECOVERY_RESTORE_REFERENCE;
    if (!reference) return;
    const entered = await this.enterAll(reference);
    this.logger.warn(
      `recovery mode for restore "${reference}": ${entered} organization(s) entered; financial commands are paused until resumed (§5.8)`,
    );
  }

  /** Enters recovery for every organization (the boot path). Returns how many newly entered. */
  async enterAll(restoreReference: string): Promise<number> {
    const organizations = await this.db.selectFrom('organizations').select('id').execute();
    let entered = 0;
    for (const { id } of organizations) {
      if (await this.uow.run(({ trx }) => this.enter(trx, id, restoreReference))) entered += 1;
    }
    return entered;
  }

  /** Opens the recovery record for one organization unless this restore was already entered. */
  async enter(trx: Trx, organizationId: string, restoreReference: string): Promise<boolean> {
    const dedupeKey = `recovery:${restoreReference}`;
    const seen = await trx
      .selectFrom('operational_exceptions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('dedupe_key', '=', dedupeKey)
      .executeTakeFirst();
    if (seen) return false;
    const enteredAt = this.clock.now();
    const raised = await this.exceptions.raise(trx, {
      organizationId,
      category: RECOVERY_EXCEPTION_CATEGORY,
      severity: 'critical',
      title: `Recovery after restore ${restoreReference}: financial commands paused until provider facts are reconciled`,
      ownerQueue: 'general_manager',
      dedupeKey,
      details: { restoreReference, enteredAt: enteredAt.toISOString() },
    });
    await this.audit.record(trx, {
      organizationId,
      actor: systemPrincipal(organizationId, 'kernel.recovery'),
      action: 'operations.recovery_entered',
      targetType: 'operational_exception',
      targetId: raised.id,
      reason: `Database restored (${restoreReference})`,
      details: { restoreReference },
    });
    return !raised.deduplicated;
  }

  private open(db: Db | Trx, organizationId: string) {
    return db
      .selectFrom('operational_exceptions')
      .select(['id', 'opened_at', 'details', 'revision'])
      .where('organization_id', '=', organizationId)
      .where('category', '=', RECOVERY_EXCEPTION_CATEGORY)
      .where('status', 'in', ['open', 'acknowledged'])
      .orderBy('opened_at');
  }

  /** Whether the organization is recovering from a restore (financial commands paused). */
  async isActive(organizationId: string, db: Db | Trx = this.db): Promise<boolean> {
    return (await this.open(db, organizationId).executeTakeFirst()) !== undefined;
  }

  async status(principal: Principal): Promise<RecoveryStatus> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, ExceptionActions.read, {
      type: 'operational_exception',
      organizationId,
    });
    return this.describe(this.db, organizationId);
  }

  private async describe(db: Db | Trx, organizationId: string): Promise<RecoveryStatus> {
    const row = await this.open(db, organizationId).executeTakeFirst();
    if (!row) {
      return {
        active: false,
        restoreReference: null,
        enteredAt: null,
        exceptionId: null,
        blockers: [],
      };
    }
    const details = (row.details ?? {}) as { restoreReference?: unknown };
    return {
      active: true,
      restoreReference:
        typeof details.restoreReference === 'string' ? details.restoreReference : null,
      enteredAt: new Date(row.opened_at).toISOString(),
      exceptionId: row.id,
      blockers: await this.checks.run(db, organizationId, new Date(row.opened_at)),
    };
  }

  /**
   * Hands authority back to normal operation (§5.8): refused until every registered check passes
   * (RESOURCE_CONFLICT `recovery_reconciliation_incomplete` naming the blockers).
   */
  async resume(
    principal: Principal,
    input: { reason: string },
    correlationId: string | null,
  ): Promise<RecoveryStatus> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, RecoveryActions.resume, {
      type: 'recovery',
      organizationId,
    });
    return this.uow.run(async ({ trx }) => {
      const row = await this.open(trx, organizationId).forUpdate().executeTakeFirst();
      if (!row) throw errors.invalidTransition('RecoveryMode', 'normal_operation', 'resume');
      const blockers = await this.checks.run(trx, organizationId, new Date(row.opened_at));
      if (blockers.length > 0) {
        throw new DomainError(
          'RESOURCE_CONFLICT',
          'External facts are not reconciled since the restore yet; normal operation cannot resume.',
          { details: { code: 'recovery_reconciliation_incomplete', blockers } },
        );
      }
      await this.exceptions.transition(trx, principal, row.id, 'resolved', {
        reason: input.reason,
        resolution: {
          resumedAt: this.clock.now().toISOString(),
          resumedByPersonId: principal.personId,
          reason: input.reason,
        },
        correlationId: correlationId ?? undefined,
        recoveryResume: true,
      });
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: RecoveryActions.resume.id,
        targetType: 'operational_exception',
        targetId: row.id,
        reason: input.reason,
        correlationId,
        details: {
          restoreReference: (row.details as { restoreReference?: unknown })?.restoreReference,
        },
      });
      return this.describe(trx, organizationId);
    });
  }
}

function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}
