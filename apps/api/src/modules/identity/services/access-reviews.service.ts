import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type AccessReview,
  type AccessReviewDecisionInput,
  type OpenAccessReviewInput,
  type Principal,
} from '@sportspark/contracts';
import { isUniqueViolation, json, type AccessReviewStatus, type Db } from '@sportspark/db';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  ensureUpdated,
  snapshotActor,
  type Clock,
  type Trx,
} from '../../../kernel';
import { IdentityActions } from '../identity.actions';
import { runInTransaction } from '../identity.transaction-context';
import { IdentityEvents } from '../identity.events';
import { AccessReviewMachine } from '../identity.machines';
import { isSuspendedAt, toAccessReview } from '../identity.shared';

interface LiveSuspension {
  id: string;
  grant_id: string;
  suspended_at: Date;
  suspended_until: Date | null;
}

/**
 * Disputed-access reviews (SPK-IAM-005). A restricted set of staff roles owns the workflow;
 * temporary restrictions suspend grants without deleting them (until the restriction's
 * `effectiveTo`, or until lifted), every decision is an append-only history row, and nothing here
 * consults household membership to resolve a dispute. Decisions on one review are serialized by
 * a row lock (§4.9).
 *
 * Each review records its own suspension of a grant (`access_grant_suspensions`, migration 0103):
 * a grant stays suspended while any review's suspension is in force, and lifting one review ends
 * only that review's suspensions (§4.6: independent facts never overwrite one another). The
 * `access_grants.suspended_*` columns are the projection of the suspensions in force, rewritten
 * under the grant's row lock whenever one of them changes.
 */
@Injectable()
export class AccessReviewsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
  ) {}

  async open(
    principal: Principal,
    input: OpenAccessReviewInput,
    correlationId: string | null,
  ): Promise<AccessReview> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      const subject = await trx
        .selectFrom('persons')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', input.subjectPersonId)
        .executeTakeFirst();
      if (!subject) throw errors.protectedNotFound('person');
      // §4.10: the target is the person, so a denial reads exactly like a missing person.
      await this.authorization.require(principal, IdentityActions.openAccessReview, {
        type: 'person',
        organizationId,
        subjectPersonIds: [input.subjectPersonId],
        protected: true,
      });
      const now = this.clock.now();
      const id = newId();
      await trx
        .insertInto('access_reviews')
        .values({
          id,
          organization_id: organizationId,
          subject_person_id: input.subjectPersonId,
          opened_by: json(snapshotActor(principal)),
          opened_by_person_id: principal.personId,
          reason: input.reason,
          parties: json(input.parties),
          evidence: json(input.evidence),
          owner_role: input.ownerRole,
          owner_person_id: null,
          effective_from: now,
          effective_to: input.effectiveTo ? new Date(input.effectiveTo) : null,
          escalated_at: null,
          decided_at: null,
          closed_at: null,
          outcome: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.openAccessReview.id,
        targetType: 'access_review',
        targetId: id,
        afterRevision: 1,
        reason: input.reason,
        correlationId,
        details: { subjectPersonId: input.subjectPersonId, ownerRole: input.ownerRole },
      });
      await this.outbox.enqueue(trx, IdentityEvents.accessReviewOpened, {
        organizationId,
        aggregateType: 'access_review',
        aggregateId: id,
        payload: {
          reviewId: id,
          subjectPersonId: input.subjectPersonId,
          ownerRole: input.ownerRole,
        },
        correlationId,
      });
      return this.detail(trx, organizationId, id);
    });
  }

  async get(principal: Principal, id: string): Promise<AccessReview> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    const row = await this.db
      .selectFrom('access_reviews')
      .select(['opened_by'])
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('access_review');
    const decision = await this.authorization.decide(principal, IdentityActions.readAccessReview, {
      type: 'access_review',
      id,
      organizationId,
      protected: true,
    });
    const opener = row.opened_by as { accountId?: string | null };
    const isOpener = principal.accountId !== null && opener.accountId === principal.accountId;
    if (!decision.allowed && !isOpener) throw errors.protectedNotFound('access_review');
    const review = await this.detail(this.db, organizationId, id);
    if (decision.allowed) return review;
    // SPK-IAM-005 (restricted review workflow), §4.14 field-level authorization, §4.7 invariant 1:
    // an opener who is not a review decider (a customer, or desk staff without the read action)
    // sees their own submission (reason, parties, evidence) and the review's progress (status and
    // dates), never staff decision notes, affected grants (which can belong to another household),
    // the owning staff member or the recorded outcome. How parties learn the outcome is a pending
    // operator decision and goes through communications, not this read.
    return { ...review, ownerPersonId: null, outcome: null, decisions: [] };
  }

  async decide(
    principal: Principal,
    id: string,
    input: AccessReviewDecisionInput,
    correlationId: string | null,
  ): Promise<AccessReview> {
    const organizationId = principal.organizationId;
    if (!organizationId) throw errors.authenticationRequired();
    return runInTransaction(this.uow, async ({ trx }) => {
      // §4.9: decisions on one review are serialized, so the decision sequence is exact and a
      // concurrent decision made against the same revision fails with STALE_REVISION.
      const review = await trx
        .selectFrom('access_reviews')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!review) throw errors.protectedNotFound('access_review');
      await this.authorization.require(principal, IdentityActions.decideAccessReview, {
        type: 'access_review',
        id,
        organizationId,
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, review.revision);
      // SPK-IAM-005: a closed review takes no further decisions except lifting the restrictions it
      // left in place (closing never lifts them silently; the lift is its own recorded decision).
      if (review.status === 'closed' && input.kind !== 'lift') {
        throw errors.invalidTransition('AccessReview', 'closed', input.kind);
      }
      const now = this.clock.now();
      let status: AccessReviewStatus = review.status;
      let affectedGrantIds: string[] = [];
      const patch: Record<string, unknown> = {};
      // Suspension rows name the decision that made or ended them (written below, same transaction).
      const decisionId = newId();

      switch (input.kind) {
        case 'restrict': {
          // SPK-IAM-005 effective dates: a restriction with an end time stops on its own.
          const suspendedUntil = input.effectiveTo ? new Date(input.effectiveTo) : null;
          if (suspendedUntil !== null && suspendedUntil.getTime() <= now.getTime()) {
            throw errors.validation('A restriction must end after it starts.', {
              effectiveTo: input.effectiveTo,
            });
          }
          // Locked (in id order): a concurrent decision of another review on the same grants
          // waits, so the projection below always sees every committed suspension.
          const grants = await this.targetGrants(
            trx,
            organizationId,
            review.subject_person_id,
            input,
          );
          const own = await this.liveSuspensions(
            trx,
            organizationId,
            id,
            grants.map((g) => g.id),
          );
          const toSuspend: typeof grants = [];
          for (const grant of grants) {
            if (grant.revoked_at !== null) continue;
            const current = own.get(grant.id);
            // This review already restricts the grant; another review's restriction does not count.
            if (current && isSuspendedAt(current, now)) continue;
            // A suspension of this review whose window has passed is superseded by the new one.
            if (current) {
              await this.endSuspensions(trx, organizationId, [current.id], now, decisionId);
            }
            await trx
              .insertInto('access_grant_suspensions')
              .values({
                id: newId(),
                organization_id: organizationId,
                grant_id: grant.id,
                review_id: id,
                restrict_decision_id: decisionId,
                reason: input.note ?? review.reason,
                suspended_at: now,
                suspended_until: suspendedUntil,
                ended_at: null,
                end_decision_id: null,
              })
              .execute();
            toSuspend.push(grant);
          }
          affectedGrantIds = toSuspend.map((g) => g.id);
          if (affectedGrantIds.length > 0) {
            await this.projectSuspensions(trx, organizationId, affectedGrantIds, now);
            await this.outbox.enqueue(trx, IdentityEvents.accessRestricted, {
              organizationId,
              aggregateType: 'access_review',
              aggregateId: id,
              payload: {
                reviewId: id,
                subjectPersonId: review.subject_person_id,
                grantIds: affectedGrantIds,
                actorPersonIds: [...new Set(toSuspend.map((g) => g.actor_person_id))],
              },
              correlationId,
            });
          }
          break;
        }
        case 'lift': {
          // Ends only this review's suspensions; another review's restriction of the same grant
          // stays in force (§4.6).
          const own = [
            ...(
              await this.liveSuspensions(
                trx,
                organizationId,
                id,
                input.grantIds && input.grantIds.length > 0 ? input.grantIds : null,
              )
            ).values(),
          ];
          affectedGrantIds = own.map((s) => s.grant_id).sort();
          if (affectedGrantIds.length > 0) {
            await this.lockGrants(trx, organizationId, affectedGrantIds);
            await this.endSuspensions(
              trx,
              organizationId,
              own.map((s) => s.id),
              now,
              decisionId,
            );
            const stillSuspended = await this.projectSuspensions(
              trx,
              organizationId,
              affectedGrantIds,
              now,
            );
            const restored = affectedGrantIds.filter((g) => !stillSuspended.has(g));
            if (restored.length > 0) {
              await this.outbox.enqueue(trx, IdentityEvents.accessRestrictionLifted, {
                organizationId,
                aggregateType: 'access_review',
                aggregateId: id,
                payload: {
                  reviewId: id,
                  subjectPersonId: review.subject_person_id,
                  grantIds: restored,
                },
                correlationId,
              });
            }
          }
          break;
        }
        case 'escalate':
          status = AccessReviewMachine.next(review.status, 'escalate');
          patch['escalated_at'] = now;
          if (input.ownerRole) patch['owner_role'] = input.ownerRole;
          break;
        case 'decide':
          status = AccessReviewMachine.next(review.status, 'decide');
          patch['decided_at'] = now;
          patch['outcome'] = json(input.outcome ?? { note: input.note ?? null });
          break;
        case 'close':
          // Closing records the end of the review; restrictions stay until lifted explicitly.
          status = AccessReviewMachine.next(review.status, 'close');
          patch['closed_at'] = now;
          if (review.effective_to === null) patch['effective_to'] = now;
          break;
        case 'reassign':
          if (!input.ownerRole && !input.ownerPersonId) {
            throw errors.validation('reassign requires ownerRole or ownerPersonId.');
          }
          if (input.ownerPersonId) {
            const owner = await trx
              .selectFrom('persons')
              .select('id')
              .where('organization_id', '=', organizationId)
              .where('id', '=', input.ownerPersonId)
              .executeTakeFirst();
            if (!owner) throw errors.notFound('person', input.ownerPersonId);
            patch['owner_person_id'] = input.ownerPersonId;
          }
          if (input.ownerRole) patch['owner_role'] = input.ownerRole;
          break;
        case 'note':
          break;
      }

      const sequence =
        Number(
          (
            await trx
              .selectFrom('access_review_decisions')
              .select((eb) => eb.fn.count<number>('id').as('n'))
              .where('review_id', '=', id)
              .executeTakeFirstOrThrow()
          ).n,
        ) + 1;
      try {
        await trx
          .insertInto('access_review_decisions')
          .values({
            id: decisionId,
            organization_id: organizationId,
            review_id: id,
            sequence,
            kind: input.kind,
            decided_by: json(snapshotActor(principal)),
            note: input.note ?? null,
            affected_grant_ids: affectedGrantIds,
            effective_from: now,
            effective_to: input.effectiveTo ? new Date(input.effectiveTo) : null,
            details: json({ actorPersonId: input.actorPersonId ?? null }),
          })
          .execute();
      } catch (error) {
        // Backstop for the row lock: another decision took this sequence number first.
        if (isUniqueViolation(error))
          throw errors.staleRevision(review.revision, review.revision + 1);
        throw error;
      }
      const updated = await trx
        .updateTable('access_reviews')
        .set({ ...patch, status, revision: review.revision + 1 })
        .where('id', '=', id)
        .where('revision', '=', review.revision)
        .executeTakeFirst();
      ensureUpdated(updated.numUpdatedRows, () =>
        errors.staleRevision(review.revision, review.revision + 1),
      );
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: IdentityActions.decideAccessReview.id,
        targetType: 'access_review',
        targetId: id,
        beforeRevision: review.revision,
        afterRevision: review.revision + 1,
        reason: input.reason ?? input.note ?? null,
        correlationId,
        details: { kind: input.kind, status, affectedGrantIds, decisionId },
      });
      await this.outbox.enqueue(trx, IdentityEvents.accessReviewDecided, {
        organizationId,
        aggregateType: 'access_review',
        aggregateId: id,
        payload: {
          reviewId: id,
          subjectPersonId: review.subject_person_id,
          kind: input.kind,
          status,
        },
        correlationId,
      });
      return this.detail(trx, organizationId, id);
    });
  }

  private async targetGrants(
    trx: Trx,
    organizationId: string,
    subjectPersonId: string,
    input: AccessReviewDecisionInput,
  ) {
    if (input.grantIds && input.grantIds.length > 0) {
      const rows = await trx
        .selectFrom('access_grants')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('subject_person_id', '=', subjectPersonId)
        .where('id', 'in', input.grantIds)
        .orderBy('id')
        .forUpdate()
        .execute();
      if (rows.length !== new Set(input.grantIds).size) {
        throw errors.validation('Every grantId must be a grant over the reviewed person.');
      }
      return rows;
    }
    if (input.actorPersonId) {
      return trx
        .selectFrom('access_grants')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('subject_person_id', '=', subjectPersonId)
        .where('actor_person_id', '=', input.actorPersonId)
        .orderBy('id')
        .forUpdate()
        .execute();
    }
    throw errors.validation('restrict requires grantIds or actorPersonId.');
  }

  /** Row locks on the grants, always taken in id order so two reviews never deadlock. */
  private async lockGrants(trx: Trx, organizationId: string, grantIds: string[]): Promise<void> {
    await trx
      .selectFrom('access_grants')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('id', 'in', grantIds)
      .orderBy('id')
      .forUpdate()
      .execute();
  }

  /** The review's unended suspensions by grant (at most one per grant: migration 0103 index). */
  private async liveSuspensions(
    trx: Trx,
    organizationId: string,
    reviewId: string,
    grantIds: string[] | null,
  ): Promise<Map<string, LiveSuspension>> {
    if (grantIds !== null && grantIds.length === 0) return new Map();
    let query = trx
      .selectFrom('access_grant_suspensions')
      .select(['id', 'grant_id', 'suspended_at', 'suspended_until'])
      .where('organization_id', '=', organizationId)
      .where('review_id', '=', reviewId)
      .where('ended_at', 'is', null);
    if (grantIds !== null) query = query.where('grant_id', 'in', grantIds);
    const rows = await query.orderBy('grant_id').execute();
    return new Map(rows.map((r) => [r.grant_id, r]));
  }

  private async endSuspensions(
    trx: Trx,
    organizationId: string,
    suspensionIds: string[],
    now: Date,
    decisionId: string,
  ): Promise<void> {
    await trx
      .updateTable('access_grant_suspensions')
      .set({ ended_at: now, end_decision_id: decisionId })
      .where('organization_id', '=', organizationId)
      .where('id', 'in', suspensionIds)
      .where('ended_at', 'is', null)
      .execute();
  }

  /**
   * Rewrites the grants' suspension projection from the suspensions still in force (any review,
   * closed ones included: closing never lifts). With several, the grant is suspended from the
   * earliest start until the latest end (open-ended if any is), and `suspended_by_review_id`
   * names the review whose restriction lasts longest. Callers hold the grants' row locks.
   * Returns the grants that remain suspended.
   */
  private async projectSuspensions(
    trx: Trx,
    organizationId: string,
    grantIds: string[],
    now: Date,
  ): Promise<Set<string>> {
    const rows = await trx
      .selectFrom('access_grant_suspensions')
      .select(['grant_id', 'review_id', 'reason', 'suspended_at', 'suspended_until'])
      .where('organization_id', '=', organizationId)
      .where('grant_id', 'in', grantIds)
      .where('ended_at', 'is', null)
      .where((eb) => eb.or([eb('suspended_until', 'is', null), eb('suspended_until', '>', now)]))
      .execute();
    const ms = (value: Date | string | null) =>
      value === null ? Number.POSITIVE_INFINITY : new Date(value).getTime();
    const suspended = new Set<string>();
    for (const grantId of grantIds) {
      const inForce = rows
        .filter((r) => r.grant_id === grantId)
        .sort(
          (x, y) =>
            ms(y.suspended_until) - ms(x.suspended_until) ||
            ms(x.suspended_at) - ms(y.suspended_at) ||
            x.review_id.localeCompare(y.review_id),
        );
      const holder = inForce[0];
      if (holder) suspended.add(grantId);
      await trx
        .updateTable('access_grants')
        .set(
          holder
            ? {
                suspended_at: new Date(Math.min(...inForce.map((r) => ms(r.suspended_at)))),
                suspended_until: holder.suspended_until,
                suspended_by_review_id: holder.review_id,
                suspension_reason: holder.reason,
              }
            : {
                suspended_at: null,
                suspended_until: null,
                suspended_by_review_id: null,
                suspension_reason: null,
              },
        )
        .where('organization_id', '=', organizationId)
        .where('id', '=', grantId)
        .execute();
    }
    return suspended;
  }

  async detail(db: Db | Trx, organizationId: string, id: string): Promise<AccessReview> {
    const row = await db
      .selectFrom('access_reviews')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw errors.protectedNotFound('access_review');
    const decisions = await db
      .selectFrom('access_review_decisions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('review_id', '=', id)
      .orderBy('sequence')
      .execute();
    return toAccessReview(row, decisions);
  }
}
