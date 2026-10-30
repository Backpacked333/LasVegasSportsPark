import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { systemPrincipal } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  DATABASE,
  MODULE_SETTINGS,
  PeriodicJobRegistry,
  UnitOfWork,
  type PeriodicJobContext,
  type PeriodicJobResult,
} from '../../../kernel';
import type { EnrollmentSettingsValue } from '../enrollment.settings';
import { BookingsService } from './bookings.service';
import { MembershipsService } from './memberships.service';
import { PackageEntitlementsService } from './package-entitlements.service';
import { ASSIGN_PLACEMENT_KIND, PlacementService } from './placement.service';

export const RECONCILE_PLACEMENTS_JOB = 'enrollment.reconcile_placements';
export const EXPIRE_PACKAGES_JOB = 'enrollment.expire_package_entitlements';
export const MEMBERSHIP_LIFECYCLE_JOB = 'enrollment.membership_lifecycle';
export const BOOKING_LIFECYCLE_JOB = 'enrollment.booking_lifecycle';

/**
 * Enrollment's periodic jobs (K-06, IF-24; §4.12 durable, interruption-tolerant background work
 * with a failure owner). Each job selects due rows, then changes each in its own small
 * transaction under `systemPrincipal(organization, '<job>')` with audit and outbox; a row another
 * runner holds is skipped and found on the next run. No job calls a provider.
 *
 * - enrollment.reconcile_placements (ENR-08, SPK-AT-023): placement assignments whose operation is
 *   still `running` longer than ENROLLMENT_PLACEMENT_RECONCILE_AFTER_SECONDS are resumed.
 * - enrollment.expire_package_entitlements (ENR-11, POL-039): active packages past their expiry.
 * - enrollment.membership_lifecycle (ENR-12): completes memberships whose term ended, ends
 *   elapsed suspensions and composes the one renewal notice a definition asks for.
 * - enrollment.booking_lifecycle (ENR-13): undecided requests expire at their start, an unstaffed
 *   booking that starts raises a critical exception for the scheduler, ended bookings complete.
 * Expiry and lifecycle work is never capability-gated (DEC-016).
 */
@Injectable()
export class EnrollmentJobs implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(MODULE_SETTINGS('enrollment')) private readonly settings: EnrollmentSettingsValue,
    private readonly registry: PeriodicJobRegistry,
    private readonly uow: UnitOfWork,
    private readonly placements: PlacementService,
    private readonly packages: PackageEntitlementsService,
    private readonly memberships: MembershipsService,
    private readonly bookings: BookingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: RECONCILE_PLACEMENTS_JOB,
      intervalSeconds: 60,
      failureOwner: 'program_manager',
      run: (context) => this.reconcilePlacements(context),
    });
    this.registry.register({
      name: EXPIRE_PACKAGES_JOB,
      intervalSeconds: 300,
      failureOwner: 'program_manager',
      run: (context) => this.expirePackages(context),
    });
    this.registry.register({
      name: MEMBERSHIP_LIFECYCLE_JOB,
      intervalSeconds: 900,
      failureOwner: 'program_manager',
      run: (context) => this.membershipLifecycle(context),
    });
    this.registry.register({
      name: BOOKING_LIFECYCLE_JOB,
      intervalSeconds: 300,
      failureOwner: 'scheduler',
      run: (context) => this.bookingLifecycle(context),
    });
  }

  async bookingLifecycle({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    const due = await this.bookings.lifecycleDue(now, batchSize);
    let processed = 0;
    for (const row of due) {
      if (
        await this.uow.run(({ trx }) => this.bookings.advance(trx, row.organization_id, row.id))
      ) {
        processed += 1;
      }
    }
    return { processed, remaining: processed > 0 && due.length === batchSize ? 1 : 0 };
  }

  async expirePackages({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    const due = await this.packages.dueForExpiry(now, batchSize);
    let processed = 0;
    for (const row of due) {
      const expired = await this.uow.run(({ trx }) =>
        this.packages.expireIfDue(trx, row.organization_id, row.id, null),
      );
      if (expired) processed += 1;
    }
    return { processed, remaining: processed > 0 && due.length === batchSize ? 1 : 0 };
  }

  async membershipLifecycle({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    let processed = 0;
    let full = false;
    const ended = await this.memberships.endedTerms(now, batchSize);
    full ||= ended.length === batchSize;
    for (const row of ended) {
      if (
        await this.uow.run(({ trx }) =>
          this.memberships.completeIfEnded(trx, row.organization_id, row.id),
        )
      ) {
        processed += 1;
      }
    }
    const suspensions = await this.memberships.elapsedSuspensions(now, batchSize);
    full ||= suspensions.length === batchSize;
    for (const row of suspensions) {
      if (
        await this.uow.run(({ trx }) =>
          this.memberships.endIfElapsed(trx, row.organization_id, row.id),
        )
      ) {
        processed += 1;
      }
    }
    // Candidates are the never-evaluated and the due (ASYNC-03): a membership not due yet records
    // its due instant and leaves the set until then, so it never holds the batch.
    const candidates = await this.memberships.renewalCandidates(now, batchSize);
    full ||= candidates.length === batchSize;
    for (const row of candidates) {
      const outcome = await this.uow.run(({ trx }) =>
        this.memberships.renewalNoticeIfDue(trx, row.organization_id, row.id),
      );
      if (outcome !== 'skipped') processed += 1;
    }
    return { processed, remaining: full && processed > 0 ? 1 : 0 };
  }

  async reconcilePlacements({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    const before = new Date(now.getTime() - this.settings.PLACEMENT_RECONCILE_AFTER_SECONDS * 1000);
    const due = await this.db
      .selectFrom('operations')
      .select(['id', 'organization_id'])
      .where('kind', '=', ASSIGN_PLACEMENT_KIND)
      .where('status', '=', 'running')
      .where('updated_at', '<=', before)
      .orderBy('updated_at')
      .orderBy('id')
      .limit(batchSize)
      .execute();
    let processed = 0;
    for (const operation of due) {
      const outcome = await this.uow.run(({ trx }) =>
        this.placements.reconcileAssignment(
          trx,
          operation.organization_id,
          operation.id,
          systemPrincipal(operation.organization_id, RECONCILE_PLACEMENTS_JOB),
        ),
      );
      if (outcome) processed += 1;
    }
    return { processed, remaining: processed === 0 || due.length < batchSize ? 0 : 1 };
  }
}
