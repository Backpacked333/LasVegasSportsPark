import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { systemPrincipal } from '@sportspark/contracts';
import type { Db } from '@sportspark/db';
import {
  DATABASE,
  PeriodicJobRegistry,
  UnitOfWork,
  type PeriodicJobContext,
  type PeriodicJobResult,
} from '../../../kernel';
import { AccessReviewsService } from './access-reviews.service';
import { ClaimsService } from './claims.service';
import { InvitationsService } from './invitations.service';

export const EXPIRE_INVITATIONS_AND_CLAIMS_JOB = 'identity.expire_invitations_and_claims';
export const END_ELAPSED_RESTRICTIONS_JOB = 'identity.end_elapsed_restrictions';

/**
 * Identity's periodic jobs (§4.12, K-06 contract: idempotent, due rows claimed with
 * `FOR UPDATE SKIP LOCKED`, one small transaction per row under a system principal, audit and
 * outbox, state machines only, no provider call).
 *
 * - identity.expire_invitations_and_claims (ID-07, SPK-IAM-002/004): pending invitations, then
 *   claims, whose `expires_at` has passed move to `expired` with the system-only actions
 *   identity.expire_invitation / identity.expire_claim and one identity.invitation_expired /
 *   identity.claim_expired event (`via: 'sweep'`). An acceptance attempt that reaches a row first
 *   records the same expiry (`via: 'acceptance_attempt'`) and still answers INVALID_TRANSITION.
 *   Expiry durations are unchanged (POL-044, pending).
 * - identity.end_elapsed_restrictions (ID-08, SPK-IAM-005): records the end of every time-bounded
 *   restriction whose window has passed (AccessReviewsService.endElapsedWindows).
 *
 * Both are owned by the support operator queue when they keep failing.
 */
@Injectable()
export class IdentityJobs implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    private readonly registry: PeriodicJobRegistry,
    private readonly uow: UnitOfWork,
    private readonly invitations: InvitationsService,
    private readonly claims: ClaimsService,
    private readonly reviews: AccessReviewsService,
  ) {}

  onModuleInit(): void {
    this.registry.register({
      name: EXPIRE_INVITATIONS_AND_CLAIMS_JOB,
      intervalSeconds: 60,
      failureOwner: 'support_operator',
      run: (context) => this.expireInvitationsAndClaims(context),
    });
    this.registry.register({
      name: END_ELAPSED_RESTRICTIONS_JOB,
      intervalSeconds: 60,
      failureOwner: 'support_operator',
      run: (context) => this.endElapsedRestrictions(context),
    });
  }

  async expireInvitationsAndClaims({
    now,
    batchSize,
  }: PeriodicJobContext): Promise<PeriodicJobResult> {
    let processed = 0;
    const invitations = await this.db
      .selectFrom('invitations')
      .select(['id', 'organization_id'])
      .where('status', '=', 'pending')
      .where('expires_at', '<=', now)
      .orderBy('expires_at')
      .orderBy('id')
      .limit(batchSize)
      .execute();
    for (const due of invitations) {
      const expired = await this.uow.run(async ({ trx }) => {
        const row = await trx
          .selectFrom('invitations')
          .selectAll()
          .where('organization_id', '=', due.organization_id)
          .where('id', '=', due.id)
          .where('status', '=', 'pending')
          .where('expires_at', '<=', now)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return false;
        await this.invitations.expire(
          trx,
          systemPrincipal(due.organization_id, EXPIRE_INVITATIONS_AND_CLAIMS_JOB),
          row,
          null,
          'sweep',
        );
        return true;
      });
      if (expired) processed += 1;
    }
    const claimBudget = Math.max(0, batchSize - invitations.length);
    const claims =
      claimBudget === 0
        ? []
        : await this.db
            .selectFrom('claims')
            .select(['id', 'organization_id'])
            .where('status', '=', 'pending')
            .where('expires_at', '<=', now)
            .orderBy('expires_at')
            .orderBy('id')
            .limit(claimBudget)
            .execute();
    for (const due of claims) {
      const expired = await this.uow.run(async ({ trx }) => {
        const row = await trx
          .selectFrom('claims')
          .selectAll()
          .where('organization_id', '=', due.organization_id)
          .where('id', '=', due.id)
          .where('status', '=', 'pending')
          .where('expires_at', '<=', now)
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (!row) return false;
        await this.claims.expire(
          trx,
          systemPrincipal(due.organization_id, EXPIRE_INVITATIONS_AND_CLAIMS_JOB),
          row,
          null,
          'sweep',
        );
        return true;
      });
      if (expired) processed += 1;
    }
    const remaining =
      (await this.countDue('invitations', now)) + (await this.countDue('claims', now));
    // A row another transaction holds is skipped now and found on the next run.
    return { processed, remaining: processed === 0 ? 0 : remaining };
  }

  async endElapsedRestrictions({ now, batchSize }: PeriodicJobContext): Promise<PeriodicJobResult> {
    let processed = 0;
    const due = await this.reviews.reviewsWithElapsedWindows(now, batchSize);
    for (const review of due) {
      if (await this.reviews.endElapsedWindows(review.organizationId, review.reviewId, now)) {
        processed += 1;
      }
    }
    const remaining =
      due.length < batchSize ? 0 : (await this.reviews.reviewsWithElapsedWindows(now, 1)).length;
    return { processed, remaining: processed === 0 ? 0 : remaining };
  }

  private async countDue(table: 'invitations' | 'claims', now: Date): Promise<number> {
    const row = await this.db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('status', '=', 'pending')
      .where('expires_at', '<=', now)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }
}
