import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type IssueMakeupInput,
  type ListMakeupEntitlementsQuery,
  type MakeupEntitlement,
  type Principal,
  type RedeemMakeupInput,
  type RevokeMakeupInput,
  type SessionBooking,
} from '@sportspark/contracts';
import {
  isCheckViolation,
  json,
  pgConstraintName,
  type Db,
  type MakeupEntitlementsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  Outbox,
  UnitOfWork,
  assertExpectedRevision,
  type Clock,
  type Trx,
} from '../../../kernel';
import { OFFERING_LOOKUP_PORT, type OfferingLookupPort } from '../../catalog';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import {
  actorSnapshot,
  hiddenFrom,
  organizationOf,
  redactSessionBooking,
  toMakeupEntitlement,
  toSessionBooking,
  type Reader,
} from '../enrollment.shared';
import { CatalogSessions } from './catalog-sessions';
import { RegistrationEvaluator } from './registration-evaluator';
import { SessionBookingsService } from './session-bookings.service';

export type MakeupRow = Selectable<MakeupEntitlementsTable>;

/**
 * Makeup entitlements (SPK-YOUTH-004, SPK-AT-020, §4.7 invariant 7). An entitlement names its
 * origin (session or policy event), its eligible replacements (offerings or programs), its expiry,
 * its redemption limit and keeps an append-only redemption history. The database is the guarantee:
 * inserting a redemption locks the entitlement and moves its counter in a trigger, and
 * `check (redeemed_count <= redemption_limit)` refuses the redemption that would exceed it, so two
 * concurrent redemptions of a single-use makeup yield exactly one booking. A makeup is not money:
 * this table has no amount, and finance's monetary credits are a different asset.
 */
@Injectable()
export class MakeupsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly evaluator: RegistrationEvaluator,
    private readonly bookings: SessionBookingsService,
    private readonly sessions: CatalogSessions,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<MakeupRow | undefined> {
    let q = db
      .selectFrom('makeup_entitlements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async view(db: Reader, organizationId: string, row: MakeupRow): Promise<MakeupEntitlement> {
    const redemptions = await db
      .selectFrom('makeup_redemptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('makeup_entitlement_id', '=', row.id)
      .orderBy('redeemed_at')
      .orderBy('id')
      .execute();
    return toMakeupEntitlement(row, redemptions);
  }

  // -------------------------------------------------------------------------------------------
  // Issue (staff)
  // -------------------------------------------------------------------------------------------

  async issue(
    principal: Principal,
    input: IssueMakeupInput,
    correlationId: string | null,
  ): Promise<MakeupEntitlement> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      await this.authorization.require(principal, EnrollmentActions.issueMakeup, {
        type: 'makeup_entitlement',
        organizationId,
      });
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        input.participantPersonId,
      );
      const expiresAt = new Date(input.expiresAt);
      if (expiresAt.getTime() <= now.getTime()) {
        throw errors.validation('A makeup entitlement must expire in the future.', {
          path: 'expiresAt',
        });
      }
      if (input.originatingEnrollmentId) {
        const origin = await trx
          .selectFrom('enrollments')
          .select(['participant_person_id'])
          .where('organization_id', '=', organizationId)
          .where('id', '=', input.originatingEnrollmentId)
          .executeTakeFirst();
        if (!origin || origin.participant_person_id !== person.id) {
          throw errors.validation('The originating enrollment belongs to another participant.', {
            path: 'originatingEnrollmentId',
          });
        }
      }
      for (const offeringId of input.eligibleOfferingIds) {
        if (!(await this.offerings.getOffering(organizationId, offeringId, now, trx))) {
          throw errors.notFound('offering', offeringId);
        }
      }
      const id = newId();
      await trx
        .insertInto('makeup_entitlements')
        .values({
          id,
          organization_id: organizationId,
          participant_person_id: person.id,
          originating_enrollment_id: input.originatingEnrollmentId ?? null,
          originating_session_id: input.originatingSessionId ?? null,
          origin_kind: input.originKind,
          origin_reference: input.originReference ?? null,
          eligible_offering_ids: json(input.eligibleOfferingIds),
          eligible_program_ids: json(input.eligibleProgramIds),
          issued_by: json(actorSnapshot(principal)),
          issued_by_person_id: principal.personId,
          reason: input.reason,
          expires_at: expiresAt,
          redemption_limit: input.redemptionLimit,
          revoked_at: null,
          revoked_reason: null,
        })
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.issueMakeup.id,
        targetType: 'makeup_entitlement',
        targetId: id,
        afterRevision: 1,
        reason: input.reason,
        correlationId,
        details: {
          originKind: input.originKind,
          originatingSessionId: input.originatingSessionId ?? null,
          redemptionLimit: input.redemptionLimit,
          expiresAt: expiresAt.toISOString(),
        },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.makeupIssued, {
        organizationId,
        aggregateType: 'makeup_entitlement',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          makeupEntitlementId: id,
          participantPersonId: person.id,
          redemptionLimit: input.redemptionLimit,
          expiresAt: expiresAt.toISOString(),
        },
      });
      // Server-owned expiry: the timer marks the entitlement expired when it lapses unused.
      await this.outbox.enqueue(trx, EnrollmentEvents.makeupExpiryDue, {
        organizationId,
        aggregateType: 'makeup_entitlement',
        aggregateId: id,
        correlationId,
        availableAt: expiresAt,
        payload: { organizationId, makeupEntitlementId: id, expiresAt: expiresAt.toISOString() },
      });
      return this.view(trx, organizationId, (await this.load(trx, organizationId, id))!);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<MakeupEntitlement> {
    const organizationId = organizationOf(principal);
    const row = await this.load(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('makeup_entitlement');
    await this.authorization.require(principal, EnrollmentActions.readMakeup, {
      type: 'makeup_entitlement',
      id,
      organizationId,
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return this.view(this.db, organizationId, row);
  }

  async list(
    principal: Principal,
    query: ListMakeupEntitlementsQuery,
  ): Promise<MakeupEntitlement[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EnrollmentActions.readMakeup, {
      type: 'makeup_entitlement',
      organizationId,
      subjectPersonIds: [query.participantPersonId],
      protected: true,
    });
    const rows = await this.db
      .selectFrom('makeup_entitlements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('participant_person_id', '=', query.participantPersonId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    const out: MakeupEntitlement[] = [];
    for (const row of rows) out.push(await this.view(this.db, organizationId, row));
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Redeem (SPK-AT-020)
  // -------------------------------------------------------------------------------------------

  async redeem(
    principal: Principal,
    id: string,
    input: RedeemMakeupInput,
    correlationId: string | null,
  ): Promise<SessionBooking> {
    const organizationId = organizationOf(principal);
    const session = await this.sessions.get(organizationId, input.offeringId, input.sessionId);
    return this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      // The row lock serializes concurrent redemptions; the trigger and check are the guarantee.
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('makeup_entitlement');
      await this.authorization.require(principal, EnrollmentActions.redeemMakeup, {
        type: 'makeup_entitlement',
        id,
        organizationId,
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (row.status !== 'active' || new Date(row.expires_at).getTime() <= now.getTime()) {
        throw errors.resourceConflict(
          `This makeup entitlement is ${row.status === 'active' ? 'expired' : row.status}.`,
          {
            code: 'MAKEUP_NOT_REDEEMABLE',
            status: row.status,
            redeemedCount: row.redeemed_count,
            redemptionLimit: row.redemption_limit,
          },
        );
      }
      const snapshot = await this.evaluator.snapshot(trx, organizationId, input.offeringId);
      const eligibleOfferings = row.eligible_offering_ids as string[];
      const eligiblePrograms = row.eligible_program_ids as string[];
      if (
        !eligibleOfferings.includes(snapshot.offering.id) &&
        !eligiblePrograms.includes(snapshot.offering.programId)
      ) {
        throw errors.eligibility('This session is not an eligible replacement for the makeup.', {
          reasons: [
            {
              code: 'makeup_replacement_not_eligible',
              severity: 'blocking',
              message:
                'The makeup can be redeemed only in its eligible replacement offerings or programs.',
              source: { type: 'makeup_entitlement', id },
              requiredAction: 'choose_eligible_replacement',
            },
          ],
          eligibleOfferingIds: eligibleOfferings,
          eligibleProgramIds: eligiblePrograms,
        });
      }
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        row.participant_person_id,
      );
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person,
        intent: 'makeup',
        session,
      });
      this.bookings.assertBookable(evaluation.result, person.id);
      const booking = await this.bookings.createInTrx(trx, organizationId, {
        kind: 'makeup',
        snapshot,
        session,
        person,
        evaluation,
        payerPersonId: null,
        actor: principal,
        free: true,
        makeupEntitlementId: id,
        correlationId,
      });
      try {
        await trx
          .insertInto('makeup_redemptions')
          .values({
            id: newId(),
            organization_id: organizationId,
            makeup_entitlement_id: id,
            session_booking_id: booking.id,
            participant_person_id: person.id,
            kind: 'redeem',
            reverses_redemption_id: null,
            actor: json(actorSnapshot(principal)),
            redeemed_at: now,
          })
          .execute();
      } catch (error) {
        if (isCheckViolation(error)) {
          throw errors.resourceConflict('This makeup entitlement has no redemption left.', {
            code: 'MAKEUP_REDEMPTION_LIMIT',
            constraint: pgConstraintName(error) ?? null,
          });
        }
        throw error;
      }
      const after = await this.load(trx, organizationId, id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.redeemMakeup.id,
        targetType: 'makeup_entitlement',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: after?.revision ?? null,
        correlationId,
        details: {
          sessionBookingId: booking.id,
          sessionId: session.id,
          redeemedCount: after?.redeemed_count ?? null,
        },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.makeupRedeemed, {
        organizationId,
        aggregateType: 'makeup_entitlement',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          makeupEntitlementId: id,
          bookingId: booking.id,
          redeemedCount: after?.redeemed_count ?? row.redeemed_count + 1,
          redemptionLimit: row.redemption_limit,
        },
      });
      return redactSessionBooking(principal, toSessionBooking(booking));
    });
  }

  // -------------------------------------------------------------------------------------------
  // Revoke (staff) and expiry (timer)
  // -------------------------------------------------------------------------------------------

  async revoke(
    principal: Principal,
    id: string,
    input: RevokeMakeupInput,
    correlationId: string | null,
  ): Promise<MakeupEntitlement> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.load(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('makeup_entitlement');
      await this.authorization.require(principal, EnrollmentActions.issueMakeup, {
        type: 'makeup_entitlement',
        id,
        organizationId,
        protected: await hiddenFrom(this.authorization, principal, EnrollmentActions.readMakeup, {
          type: 'makeup_entitlement',
          id,
          organizationId,
          subjectPersonIds: [row.participant_person_id],
        }),
      });
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (row.status !== 'active')
        throw errors.invalidTransition('MakeupEntitlement', row.status, 'revoke');
      const now = this.clock.now();
      await trx
        .updateTable('makeup_entitlements')
        .set({
          status: 'revoked',
          revoked_at: now,
          revoked_reason: input.reason,
          revision: row.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'enrollment.revoke_makeup',
        targetType: 'makeup_entitlement',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason,
        correlationId,
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.makeupChanged, {
        organizationId,
        aggregateType: 'makeup_entitlement',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          makeupEntitlementId: id,
          status: 'revoked',
          reason: input.reason,
        },
      });
      return this.view(trx, organizationId, (await this.load(trx, organizationId, id))!);
    });
  }

  /** Timer handler body (`enrollment.expire_makeup`): an unused active entitlement lapses. Idempotent. */
  async expireIfDue(
    trx: Trx,
    organizationId: string,
    id: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await this.load(trx, organizationId, id, true);
    if (!row || row.status !== 'active') return;
    if (new Date(row.expires_at).getTime() > this.clock.now().getTime()) return;
    await trx
      .updateTable('makeup_entitlements')
      .set({ status: 'expired', revision: row.revision + 1 })
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .where('revision', '=', row.revision)
      .execute();
    await this.outbox.enqueue(trx, EnrollmentEvents.makeupChanged, {
      organizationId,
      aggregateType: 'makeup_entitlement',
      aggregateId: id,
      correlationId,
      payload: { organizationId, makeupEntitlementId: id, status: 'expired', reason: 'expired' },
    });
  }
}
