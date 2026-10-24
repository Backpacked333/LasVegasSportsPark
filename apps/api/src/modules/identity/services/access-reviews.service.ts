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

/**
 * Disputed-access reviews (SPK-IAM-005). A restricted set of staff roles owns the workflow;
 * temporary restrictions suspend grants without deleting them (until the restriction's
 * `effectiveTo`, or until lifted), every decision is an append-only history row, and nothing here
 * consults household membership to resolve a dispute. Decisions on one review are serialized by
 * a row lock (§4.9).
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
    return this.detail(this.db, organizationId, id);
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

      switch (input.kind) {
        case 'restrict': {
          // SPK-IAM-005 effective dates: a restriction with an end time stops on its own.
          const suspendedUntil = input.effectiveTo ? new Date(input.effectiveTo) : null;
          if (suspendedUntil !== null && suspendedUntil.getTime() <= now.getTime()) {
            throw errors.validation('A restriction must end after it starts.', {
              effectiveTo: input.effectiveTo,
            });
          }
          const grants = await this.targetGrants(
            trx,
            organizationId,
            review.subject_person_id,
            input,
          );
          // A suspension whose window has passed no longer holds, so it may be applied again.
          const toSuspend = grants.filter((g) => g.revoked_at === null && !isSuspendedAt(g, now));
          affectedGrantIds = toSuspend.map((g) => g.id);
          if (affectedGrantIds.length > 0) {
            await trx
              .updateTable('access_grants')
              .set({
                suspended_at: now,
                suspended_until: suspendedUntil,
                suspended_by_review_id: id,
                suspension_reason: input.note ?? review.reason,
              })
              .where('id', 'in', affectedGrantIds)
              .execute();
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
          let query = trx
            .selectFrom('access_grants')
            .select('id')
            .where('organization_id', '=', organizationId)
            .where('suspended_by_review_id', '=', id);
          if (input.grantIds && input.grantIds.length > 0) {
            query = query.where('id', 'in', input.grantIds);
          }
          affectedGrantIds = (await query.execute()).map((g) => g.id);
          if (affectedGrantIds.length > 0) {
            await trx
              .updateTable('access_grants')
              .set({
                suspended_at: null,
                suspended_until: null,
                suspended_by_review_id: null,
                suspension_reason: null,
              })
              .where('id', 'in', affectedGrantIds)
              .execute();
            await this.outbox.enqueue(trx, IdentityEvents.accessRestrictionLifted, {
              organizationId,
              aggregateType: 'access_review',
              aggregateId: id,
              payload: {
                reviewId: id,
                subjectPersonId: review.subject_person_id,
                grantIds: affectedGrantIds,
              },
              correlationId,
            });
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
      const decisionId = newId();
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
        .execute();
    }
    throw errors.validation('restrict requires grantIds or actorPersonId.');
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
