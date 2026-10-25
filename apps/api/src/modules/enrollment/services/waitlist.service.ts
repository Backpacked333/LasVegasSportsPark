import { Inject, Injectable } from '@nestjs/common';
import {
  DomainError,
  errors,
  newId,
  type AcceptWaitlistOfferInput,
  type DeclineWaitlistOfferInput,
  type JoinWaitlistInput,
  type ListWaitlistQuery,
  type OfferingSession,
  type Principal,
  type RemoveWaitlistEntryInput,
  type WaitlistAcceptance,
  type WaitlistEntry,
  type WaitlistOffer,
  type WithdrawWaitlistInput,
} from '@sportspark/contracts';
import {
  isUniqueViolation,
  json,
  pgConstraintName,
  type Db,
  type WaitlistEntriesTable,
  type WaitlistOffersTable,
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
import type { OfferingSnapshot } from '../../catalog';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentEvents } from '../enrollment.events';
import { SESSION_INTENT_COMMANDS } from '../enrollment.policy';
import type { WaitlistPort } from '../enrollment.ports';
import {
  actorSnapshot,
  enrollmentSystem,
  hiddenFrom,
  isStaffLike,
  minutesFrom,
  organizationOf,
  redactWaitlistEntry,
  resolveCustomerPayer,
  toSessionBooking,
  toWaitlistEntry,
  toWaitlistOffer,
  withSavepoint,
  type Reader,
} from '../enrollment.shared';
import { missingAcknowledgments } from '../eligibility/registration-eligibility';
import { ApplicationsService } from './applications.service';
import { BasketsService } from './baskets.service';
import { CapacityService, type HoldRow, type PoolRow } from './capacity.service';
import { CatalogSessions } from './catalog-sessions';
import { EnrollmentsService } from './enrollments.service';
import { RegistrationEvaluator } from './registration-evaluator';
import { SessionBookingsService } from './session-bookings.service';

export type WaitlistEntryRow = Selectable<WaitlistEntriesTable>;
export type WaitlistOfferRow = Selectable<WaitlistOffersTable>;

/**
 * Waitlists (§4.4 WaitlistEntry/WaitlistOffer, SPK-REG-008, SPK-AT-006). An entry records the
 * participant, offering (or session), priority basis, preferences, status and offer history. When
 * capacity comes back (`enrollment.capacity_released`) offers go out by priority, each reserving
 * its place through holds on every pool the participant needs until the offer expires; acceptance
 * consumes it once (conditional update plus the `waitlist_offers_guard` trigger). Because an
 * offer's holds count in `held`, a payment that arrives after its own hold expired can never take
 * the place back (SPK-AT-006).
 */
@Injectable()
export class WaitlistService implements WaitlistPort {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly evaluator: RegistrationEvaluator,
    private readonly capacity: CapacityService,
    private readonly enrollments: EnrollmentsService,
    private readonly applications: ApplicationsService,
    private readonly baskets: BasketsService,
    private readonly bookings: SessionBookingsService,
    private readonly sessions: CatalogSessions,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Loading and views
  // -------------------------------------------------------------------------------------------

  async loadEntry(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<WaitlistEntryRow | undefined> {
    let q = db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  async loadOffer(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<WaitlistOfferRow | undefined> {
    let q = db
      .selectFrom('waitlist_offers')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  /** Waiting entries of one queue (an offering or one of its sessions) in offer order. */
  private waitingQuery(
    db: Reader,
    organizationId: string,
    offeringId: string,
    sessionId: string | null,
  ) {
    let q = db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', offeringId)
      .where('status', '=', 'waiting');
    q = sessionId ? q.where('session_id', '=', sessionId) : q.where('session_id', 'is', null);
    return q.orderBy('priority_rank').orderBy('queued_at').orderBy('id');
  }

  async view(db: Reader, organizationId: string, row: WaitlistEntryRow): Promise<WaitlistEntry> {
    let position: number | null = null;
    if (row.status === 'waiting') {
      const queue = await this.waitingQuery(
        db,
        organizationId,
        row.offering_id,
        row.session_id,
      ).execute();
      position = queue.findIndex((e) => e.id === row.id) + 1 || null;
    }
    const offers = await db
      .selectFrom('waitlist_offers')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('waitlist_entry_id', '=', row.id)
      .orderBy('offered_at')
      .orderBy('id')
      .execute();
    return toWaitlistEntry(row, position, offers);
  }

  // -------------------------------------------------------------------------------------------
  // WaitlistPort
  // -------------------------------------------------------------------------------------------

  async getOffer(
    organizationId: string,
    offerId: string,
    trx?: Trx,
  ): Promise<WaitlistOffer | null> {
    const row = await this.loadOffer(trx ?? this.uow.reader(), organizationId, offerId);
    return row ? toWaitlistOffer(row) : null;
  }

  async entriesForPool(
    organizationId: string,
    poolId: string,
    trx?: Trx,
  ): Promise<WaitlistEntry[]> {
    const db = trx ?? this.uow.reader();
    const rows = await db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('pool_id', '=', poolId)
      .orderBy('priority_rank')
      .orderBy('queued_at')
      .orderBy('id')
      .execute();
    const out: WaitlistEntry[] = [];
    for (const row of rows) out.push(await this.view(db, organizationId, row));
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // POST /waitlist-entries
  // -------------------------------------------------------------------------------------------

  async join(
    principal: Principal,
    input: JoinWaitlistInput,
    correlationId: string | null,
  ): Promise<WaitlistEntry> {
    const organizationId = organizationOf(principal);
    const sessionScoped = SESSION_INTENT_COMMANDS[input.intent] !== undefined;
    if (sessionScoped && !input.sessionId) {
      throw errors.validation(`A ${input.intent} waitlist is per session: sessionId is required.`, {
        path: 'sessionId',
      });
    }
    if (
      !isStaffLike(principal) &&
      (input.priorityBasis !== undefined || input.priorityRank !== undefined)
    ) {
      throw errors.accessDenied('Only staff set a waitlist priority.');
    }
    const session = sessionScoped
      ? await this.sessions.get(organizationId, input.offeringId, input.sessionId as string)
      : undefined;
    return this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        input.participantPersonId,
      );
      await this.authorization.require(principal, EnrollmentActions.joinWaitlist, {
        type: 'waitlist_entry',
        organizationId,
        subjectPersonIds: [person.id],
      });
      const snapshot = await this.evaluator.snapshot(trx, organizationId, input.offeringId);
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person,
        intent: input.intent,
        session: sessionScoped ? (session ?? null) : undefined,
      });
      if (!evaluation.result.eligible) {
        throw errors.eligibility('The participant is not eligible for this offering.', {
          participantPersonId: person.id,
          reasons: evaluation.result.reasons,
          alternatives: evaluation.result.alternatives,
        });
      }
      const equivalence = this.evaluator.equivalence(snapshot, person.id, session?.id ?? null);
      if (
        await this.enrollments.findEquivalentActive(trx, organizationId, person.id, equivalence)
      ) {
        throw errors.duplicateEntitlement(
          'An equivalent active registration already exists for this participant.',
          {
            participantPersonId: person.id,
            offeringId: snapshot.offering.id,
          },
        );
      }
      const pools = session
        ? await this.capacity.ensureSessionPool(trx, organizationId, snapshot, session, principal)
        : this.capacity.poolsForIntent(
            await this.capacity.ensurePoolsForOffering(trx, organizationId, snapshot, principal),
            input.intent,
          );
      const active = pools.filter((p) => p.status === 'active');
      const primary = active.find((p) => p.constraint_kind === 'commercial') ?? active[0];
      if (!primary) throw errors.validation('This offering has no capacity to wait for.');
      const waiting = await this.capacity.othersWaiting(
        trx,
        organizationId,
        { offeringId: snapshot.offering.id, sessionId: session?.id ?? null },
        person.id,
      );
      if (waiting === 0 && active.every((p) => p.capacity - p.committed - p.held >= 1)) {
        throw errors.resourceConflict('A place is available now; register instead of waiting.', {
          code: 'CAPACITY_AVAILABLE',
          offeringId: snapshot.offering.id,
        });
      }
      const id = newId();
      try {
        await trx
          .insertInto('waitlist_entries')
          .values({
            id,
            organization_id: organizationId,
            offering_id: snapshot.offering.id,
            pool_id: primary.id,
            session_id: session?.id ?? null,
            participant_person_id: person.id,
            intent: input.intent,
            priority_basis: input.priorityBasis ?? 'joined_at',
            priority_rank: input.priorityRank ?? 100,
            joined_at: now,
            queued_at: now,
            preferences: json(input.preferences),
            requested_by: json(actorSnapshot(principal)),
            requested_by_person_id: principal.personId,
            // §4.7 (1), SPK-REG-009: a customer waits as their own payer; staff may name one.
            payer_person_id:
              resolveCustomerPayer(principal, input.payerPersonId, [principal.personId]) ??
              (isStaffLike(principal) ? null : principal.personId),
            status: 'waiting',
            accepted_enrollment_id: null,
            withdrawn_at: null,
            removed_at: null,
            removal_reason: null,
          })
          .execute();
      } catch (error) {
        if (isUniqueViolation(error) && pgConstraintName(error) === 'waitlist_entries_live_idx') {
          throw errors.resourceConflict('The participant is already on this waitlist.', {
            code: 'ALREADY_WAITLISTED',
          });
        }
        throw error;
      }
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.joinWaitlist.id,
        targetType: 'waitlist_entry',
        targetId: id,
        afterRevision: 1,
        correlationId,
        details: {
          offeringId: snapshot.offering.id,
          sessionId: session?.id ?? null,
          poolId: primary.id,
          priorityBasis: input.priorityBasis ?? 'joined_at',
          assistedByStaff: isStaffLike(principal),
        },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.waitlistJoined, {
        organizationId,
        aggregateType: 'waitlist_entry',
        aggregateId: id,
        correlationId,
        payload: {
          organizationId,
          waitlistEntryId: id,
          offeringId: snapshot.offering.id,
          poolId: primary.id,
          participantPersonId: person.id,
        },
      });
      const row = await this.loadEntry(trx, organizationId, id);
      if (!row) throw errors.internal('waitlist entry vanished');
      return this.view(trx, organizationId, row);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async get(principal: Principal, id: string): Promise<WaitlistEntry> {
    const organizationId = organizationOf(principal);
    const row = await this.loadEntry(this.db, organizationId, id);
    if (!row) throw errors.protectedNotFound('waitlist_entry');
    await this.authorization.require(principal, EnrollmentActions.readWaitlist, {
      type: 'waitlist_entry',
      id,
      organizationId,
      subjectPersonIds: [row.participant_person_id],
      protected: true,
    });
    return redactWaitlistEntry(
      principal,
      await this.view(this.db, organizationId, row),
      row.requested_by_person_id,
    );
  }

  async list(principal: Principal, query: ListWaitlistQuery): Promise<WaitlistEntry[]> {
    const organizationId = organizationOf(principal);
    await this.authorization.require(principal, EnrollmentActions.manageWaitlist, {
      type: 'waitlist_entry',
      organizationId,
    });
    let q = this.db
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', query.offeringId)
      .orderBy('priority_rank')
      .orderBy('queued_at')
      .orderBy('id');
    if (query.poolId) q = q.where('pool_id', '=', query.poolId);
    if (query.status) q = q.where('status', '=', query.status);
    const out: WaitlistEntry[] = [];
    for (const row of await q.execute()) out.push(await this.view(this.db, organizationId, row));
    return out;
  }

  async getOfferFor(principal: Principal, id: string): Promise<WaitlistOffer> {
    const organizationId = organizationOf(principal);
    const offer = await this.loadOffer(this.db, organizationId, id);
    const entry = offer
      ? await this.loadEntry(this.db, organizationId, offer.waitlist_entry_id)
      : undefined;
    if (!offer || !entry) throw errors.protectedNotFound('waitlist_offer');
    await this.authorization.require(principal, EnrollmentActions.readWaitlist, {
      type: 'waitlist_offer',
      id,
      organizationId,
      subjectPersonIds: [entry.participant_person_id],
      protected: true,
    });
    return toWaitlistOffer(offer);
  }

  // -------------------------------------------------------------------------------------------
  // Withdraw an entry
  // -------------------------------------------------------------------------------------------

  async withdraw(
    principal: Principal,
    id: string,
    input: WithdrawWaitlistInput,
    correlationId: string | null,
  ): Promise<WaitlistEntry> {
    return this.leave(principal, id, 'withdrawn', input, correlationId);
  }

  /** Staff remove an entry from the queue with a recorded reason (SPK-REG-008 status `removed`). */
  async remove(
    principal: Principal,
    id: string,
    input: RemoveWaitlistEntryInput,
    correlationId: string | null,
  ): Promise<WaitlistEntry> {
    return this.leave(principal, id, 'removed', input, correlationId);
  }

  /**
   * An entry leaves the queue: withdrawn by the participant's authority (or staff), or removed by
   * program administration. An open offer is declined and its places go back to the pools.
   */
  private async leave(
    principal: Principal,
    id: string,
    outcome: 'withdrawn' | 'removed',
    input: { expectedRevision?: number; reason?: string },
    correlationId: string | null,
  ): Promise<WaitlistEntry> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const row = await this.loadEntry(trx, organizationId, id, true);
      if (!row) throw errors.protectedNotFound('waitlist_entry');
      await this.authorization.require(
        principal,
        outcome === 'removed' ? EnrollmentActions.manageWaitlist : EnrollmentActions.joinWaitlist,
        {
          type: 'waitlist_entry',
          id,
          organizationId,
          subjectPersonIds: [row.participant_person_id],
          protected:
            outcome === 'removed'
              ? await hiddenFrom(this.authorization, principal, EnrollmentActions.readWaitlist, {
                  type: 'waitlist_entry',
                  id,
                  organizationId,
                  subjectPersonIds: [row.participant_person_id],
                })
              : true,
        },
      );
      assertExpectedRevision(input.expectedRevision, row.revision);
      if (row.status !== 'waiting' && row.status !== 'offered') {
        throw errors.invalidTransition(
          'WaitlistEntry',
          row.status,
          outcome === 'removed' ? 'remove' : 'withdraw',
        );
      }
      const now = this.clock.now();
      const reason = input.reason ?? (outcome === 'removed' ? 'removed' : 'entry_withdrawn');
      if (row.status === 'offered') {
        const open = await trx
          .selectFrom('waitlist_offers')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('waitlist_entry_id', '=', id)
          .where('status', '=', 'offered')
          .forUpdate()
          .executeTakeFirst();
        if (open)
          await this.closeOffer(
            trx,
            organizationId,
            open,
            'declined',
            reason,
            principal,
            correlationId,
          );
      }
      await trx
        .updateTable('waitlist_entries')
        .set(
          outcome === 'removed'
            ? {
                status: 'removed',
                removed_at: now,
                removal_reason: reason,
                revision: row.revision + 1,
              }
            : { status: 'withdrawn', withdrawn_at: now, revision: row.revision + 1 },
        )
        .where('organization_id', '=', organizationId)
        .where('id', '=', id)
        .where('revision', '=', row.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action:
          outcome === 'removed'
            ? 'enrollment.remove_waitlist_entry'
            : 'enrollment.withdraw_waitlist',
        targetType: 'waitlist_entry',
        targetId: id,
        beforeRevision: row.revision,
        afterRevision: row.revision + 1,
        reason: input.reason ?? null,
        correlationId,
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.waitlistLeft, {
        organizationId,
        aggregateType: 'waitlist_entry',
        aggregateId: id,
        correlationId,
        payload: { organizationId, waitlistEntryId: id, poolId: row.pool_id, status: outcome },
      });
      const updated = await this.loadEntry(trx, organizationId, id);
      return redactWaitlistEntry(
        principal,
        await this.view(trx, organizationId, updated!),
        row.requested_by_person_id,
      );
    });
  }

  // -------------------------------------------------------------------------------------------
  // Offers: generation on capacity release (outbox handler `enrollment.offer_waitlist`)
  // -------------------------------------------------------------------------------------------

  /**
   * Offers the pool's free places to waiting entries by priority (rank, then queue time). The pool
   * row lock serializes concurrent generators; every offer holds each pool its participant needs,
   * so it reserves a defined place until expiry (SPK-REG-008). Generation stops at the first entry
   * that cannot be served so a lower-priority entry is never offered first. Replay-safe: with no
   * free place left nothing more is offered.
   */
  async offerFromPool(
    trx: Trx,
    organizationId: string,
    poolId: string,
    correlationId: string | null,
  ): Promise<WaitlistOffer[]> {
    const released = await this.capacity.loadPool(trx, organizationId, poolId);
    if (!released || !released.offering_id) return [];
    // Lock every pool of the offering in id order — the order every hold acquires them in — so
    // concurrent generators serialize and never deadlock against a basket holding the same pools.
    await trx
      .selectFrom('capacity_pools')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('offering_id', '=', released.offering_id)
      .orderBy('id')
      .forUpdate()
      .execute();
    const pool = await this.capacity.loadPool(trx, organizationId, poolId);
    if (!pool || !pool.offering_id || pool.status !== 'active') return [];
    const sessionId = pool.scope_type === 'session' ? pool.scope_id : null;
    const entries = await this.waitingQuery(trx, organizationId, pool.offering_id, sessionId)
      .forUpdate()
      .execute();
    const made: WaitlistOffer[] = [];
    const policy = this.evaluator.configuration;
    const system = enrollmentSystem(organizationId, 'enrollment.offer_waitlist');
    let snapshot: OfferingSnapshot | undefined;
    const snapshotOf = async () =>
      (snapshot ??= await this.evaluator.snapshot(trx, organizationId, pool.offering_id as string));
    for (const entry of entries) {
      // SPK-REG-008: a participant who already holds what this queue waits for (registered
      // directly, or in an equivalent offering) leaves it instead of being offered a place they
      // cannot accept; one whose own registration is still pending is passed over for now.
      const existing = await this.entitlementOf(trx, organizationId, entry, snapshotOf);
      if (existing === 'confirmed') {
        await this.retireEntry(trx, organizationId, entry, system, correlationId, false);
        continue;
      }
      if (existing === 'pending') continue;
      const required = await this.requiredPools(trx, organizationId, entry);
      if (required.length === 0) continue;
      if (required.some((p) => p.capacity - p.committed - p.held < 1)) break;
      const now = this.clock.now();
      const offerId = newId();
      const expiresAt = minutesFrom(now, policy.waitlistOfferHours * 60);
      try {
        const offer = await withSavepoint(trx, `offer_${made.length}`, async () => {
          const holds = await this.capacity.acquireHolds(trx, organizationId, {
            pools: required.map((p) => ({ poolId: p.id, quantity: 1 })),
            ownerKind: 'waitlist_offer',
            ownerId: offerId,
            actor: system,
            expiresAt,
            correlationId,
          });
          const primary = holds.find((h) => h.poolId === entry.pool_id) ?? holds[0];
          if (!primary) throw errors.internal('offer without a hold');
          await trx
            .insertInto('waitlist_offers')
            .values({
              id: offerId,
              organization_id: organizationId,
              waitlist_entry_id: entry.id,
              pool_id: entry.pool_id,
              hold_id: primary.id,
              quantity: 1,
              offered_at: now,
              expires_at: expiresAt,
              status: 'offered',
              accepted_at: null,
              accepted_basket_id: null,
              accepted_enrollment_id: null,
              accepted_session_booking_id: null,
              declined_at: null,
              expired_at: null,
            })
            .execute();
          await trx
            .updateTable('waitlist_entries')
            .set((eb) => ({
              status: 'offered',
              offer_count: eb('offer_count', '+', 1),
              revision: eb('revision', '+', 1),
            }))
            .where('organization_id', '=', organizationId)
            .where('id', '=', entry.id)
            .where('status', '=', 'waiting')
            .execute();
          const row = await this.loadOffer(trx, organizationId, offerId);
          if (!row) throw errors.internal('waitlist offer vanished');
          return row;
        });
        await this.audit.record(trx, {
          organizationId,
          actor: system,
          action: 'enrollment.make_waitlist_offer',
          targetType: 'waitlist_offer',
          targetId: offerId,
          afterRevision: 1,
          correlationId,
          details: {
            waitlistEntryId: entry.id,
            poolId: entry.pool_id,
            expiresAt: expiresAt.toISOString(),
          },
        });
        await this.outbox.enqueue(trx, EnrollmentEvents.waitlistOfferMade, {
          organizationId,
          aggregateType: 'waitlist_offer',
          aggregateId: offerId,
          correlationId,
          payload: {
            organizationId,
            offerId,
            waitlistEntryId: entry.id,
            poolId: entry.pool_id,
            holdId: offer.hold_id,
            participantPersonId: entry.participant_person_id,
            expiresAt: expiresAt.toISOString(),
          },
        });
        made.push(toWaitlistOffer(offer));
      } catch (error) {
        // Another constraint filled up concurrently: stop here, keeping the queue order.
        if (DomainError.is(error) && error.code === 'CAPACITY_UNAVAILABLE') break;
        throw error;
      }
    }
    return made;
  }

  /**
   * What the entry's participant already holds of what the queue waits for: a live booking of the
   * session (session queues), or an enrollment in the offering or with the same equivalence key
   * (offering queues). `confirmed` wins over `pending`; null when there is none.
   */
  private async entitlementOf(
    trx: Trx,
    organizationId: string,
    entry: WaitlistEntryRow,
    snapshotOf: () => Promise<OfferingSnapshot>,
  ): Promise<'confirmed' | 'pending' | null> {
    let statuses: string[];
    if (entry.session_id) {
      statuses = (
        await trx
          .selectFrom('session_bookings')
          .select('status')
          .where('organization_id', '=', organizationId)
          .where('session_id', '=', entry.session_id)
          .where('participant_person_id', '=', entry.participant_person_id)
          .where('status', 'in', ['pending', 'confirmed'])
          .execute()
      ).map((r) => r.status);
    } else {
      const key = this.evaluator.equivalence(await snapshotOf(), entry.participant_person_id);
      statuses = (
        await trx
          .selectFrom('enrollments')
          .select('status')
          .where('organization_id', '=', organizationId)
          .where('participant_person_id', '=', entry.participant_person_id)
          .where('status', 'in', ['pending', 'confirmed'])
          .where((eb) =>
            key
              ? eb.or([eb('offering_id', '=', entry.offering_id), eb('equivalence_key', '=', key)])
              : eb('offering_id', '=', entry.offering_id),
          )
          .execute()
      ).map((r) => r.status);
    }
    if (statuses.includes('confirmed')) return 'confirmed';
    return statuses.length > 0 ? 'pending' : null;
  }

  /**
   * SPK-REG-008: an entry whose participant now holds an equivalent confirmed entitlement leaves
   * the queue (`removed`, reason `equivalent_entitlement`): an open offer is declined, which gives
   * its places back and offers them to the next waiter, and a waiting entry stops counting against
   * newcomers under waitlist-first (DEC-006). `nudge` re-runs offer generation for the entry's pool
   * when it has a free place (the follow-up path; the generator itself continues its own loop).
   */
  private async retireEntry(
    trx: Trx,
    organizationId: string,
    entry: WaitlistEntryRow,
    actor: Principal,
    correlationId: string | null,
    nudge: boolean,
  ): Promise<void> {
    const reason = 'equivalent_entitlement';
    if (entry.status === 'offered') {
      const open = await trx
        .selectFrom('waitlist_offers')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('waitlist_entry_id', '=', entry.id)
        .where('status', '=', 'offered')
        .forUpdate()
        .executeTakeFirst();
      if (open)
        await this.closeOffer(trx, organizationId, open, 'declined', reason, actor, correlationId);
    }
    const retired = await trx
      .updateTable('waitlist_entries')
      .set({
        status: 'removed',
        removed_at: this.clock.now(),
        removal_reason: reason,
        revision: entry.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', entry.id)
      .where('status', 'in', ['waiting', 'offered'])
      .where('revision', '=', entry.revision)
      .executeTakeFirst();
    if (Number(retired.numUpdatedRows) === 0) return;
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'enrollment.remove_waitlist_entry',
      targetType: 'waitlist_entry',
      targetId: entry.id,
      beforeRevision: entry.revision,
      afterRevision: entry.revision + 1,
      reason,
      correlationId,
      details: { previousStatus: entry.status },
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.waitlistLeft, {
      organizationId,
      aggregateType: 'waitlist_entry',
      aggregateId: entry.id,
      correlationId,
      payload: {
        organizationId,
        waitlistEntryId: entry.id,
        poolId: entry.pool_id,
        status: 'removed',
      },
    });
    if (nudge && entry.status === 'waiting') {
      const pool = await this.capacity.loadPool(trx, organizationId, entry.pool_id);
      const free = pool ? pool.capacity - pool.committed - pool.held : 0;
      if (pool && pool.status === 'active' && free > 0) {
        await this.capacity.enqueueCapacityReleased(
          trx,
          organizationId,
          [{ poolId: pool.id, quantity: free }],
          'waitlist_entry_retired',
          correlationId,
        );
      }
    }
  }

  /**
   * Follow-up of a confirmed enrollment or session booking (outbox handler
   * `enrollment.retire_redundant_waitlist_entries`, SPK-REG-008): the participant's live entries
   * for what they now hold leave their queues. Replay-safe: only live entries move.
   */
  async retireRedundantEntries(
    trx: Trx,
    organizationId: string,
    trigger: { enrollmentId: string } | { sessionBookingId: string },
    correlationId: string | null,
  ): Promise<void> {
    const system = enrollmentSystem(organizationId, 'enrollment.retire_waitlist_entry');
    let participantPersonId: string;
    let matches: (entry: WaitlistEntryRow) => Promise<boolean>;
    let candidates = trx
      .selectFrom('waitlist_entries')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('status', 'in', ['waiting', 'offered']);
    if ('enrollmentId' in trigger) {
      const enrollment = await this.enrollments.load(trx, organizationId, trigger.enrollmentId);
      if (!enrollment || enrollment.status !== 'confirmed') return;
      participantPersonId = enrollment.participant_person_id;
      candidates = candidates.where('session_id', 'is', null);
      const snapshots = new Map<string, OfferingSnapshot>();
      matches = async (entry) => {
        if (entry.offering_id === enrollment.offering_id) return true;
        if (!enrollment.equivalence_key) return false;
        let snapshot = snapshots.get(entry.offering_id);
        if (!snapshot) {
          snapshot = await this.evaluator.snapshot(trx, organizationId, entry.offering_id);
          snapshots.set(entry.offering_id, snapshot);
        }
        return (
          this.evaluator.equivalence(snapshot, participantPersonId) === enrollment.equivalence_key
        );
      };
    } else {
      const booking = await this.bookings.load(trx, organizationId, trigger.sessionBookingId);
      if (!booking || booking.status !== 'confirmed') return;
      participantPersonId = booking.participant_person_id;
      candidates = candidates.where('session_id', '=', booking.session_id);
      matches = async () => true;
    }
    candidates = candidates.where('participant_person_id', '=', participantPersonId);
    const preview = await candidates.execute();
    if (preview.length === 0) return;
    // Pools first, in id order (as holds and offer generation lock them), then the entries.
    await trx
      .selectFrom('capacity_pools')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('offering_id', 'in', [...new Set(preview.map((e) => e.offering_id))])
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const entry of await candidates.orderBy('id').forUpdate().execute()) {
      if (await matches(entry))
        await this.retireEntry(trx, organizationId, entry, system, correlationId, true);
    }
  }

  /** Every pool an entry needs: the session pools of its session, else the offering pools of its intent. */
  private async requiredPools(
    trx: Trx,
    organizationId: string,
    entry: WaitlistEntryRow,
  ): Promise<PoolRow[]> {
    if (entry.session_id) {
      return trx
        .selectFrom('capacity_pools')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('scope_type', '=', 'session')
        .where('scope_id', '=', entry.session_id)
        .where('status', '=', 'active')
        .orderBy('id')
        .execute();
    }
    const pools = await this.capacity.poolRowsForOffering(trx, organizationId, entry.offering_id);
    return this.capacity.poolsForIntent(pools, entry.intent);
  }

  // -------------------------------------------------------------------------------------------
  // POST /waitlist-offers/{id}/accept — §4.8, consumes once
  // -------------------------------------------------------------------------------------------

  async accept(
    principal: Principal,
    offerId: string,
    input: AcceptWaitlistOfferInput,
    correlationId: string | null,
  ): Promise<WaitlistAcceptance> {
    const organizationId = organizationOf(principal);
    // The session of a session waitlist is read before the transaction (catalog service).
    const preOffer = await this.loadOffer(this.db, organizationId, offerId);
    const preEntry = preOffer
      ? await this.loadEntry(this.db, organizationId, preOffer.waitlist_entry_id)
      : undefined;
    if (!preOffer || !preEntry) throw errors.protectedNotFound('waitlist_offer');
    let session: OfferingSession | undefined;
    if (preEntry.session_id) {
      session = await this.sessions.get(organizationId, preEntry.offering_id, preEntry.session_id);
    }
    return this.uow.run(async ({ trx }) => {
      const now = this.clock.now();
      const offer = await this.loadOffer(trx, organizationId, offerId, true);
      const entry = offer
        ? await this.loadEntry(trx, organizationId, offer.waitlist_entry_id, true)
        : undefined;
      if (!offer || !entry) throw errors.protectedNotFound('waitlist_offer');
      await this.authorization.require(principal, EnrollmentActions.joinWaitlist, {
        type: 'waitlist_offer',
        id: offerId,
        organizationId,
        subjectPersonIds: [entry.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, offer.revision);
      if (offer.status !== 'offered')
        throw errors.invalidTransition('WaitlistOffer', offer.status, 'accept');
      if (new Date(offer.expires_at).getTime() <= now.getTime()) {
        throw errors.capacityUnavailable('This offer has expired; its place was released.', {
          offerId,
          expiresAt: new Date(offer.expires_at).toISOString(),
        });
      }
      const holds = await this.capacity.holdsOfOwner(
        trx,
        organizationId,
        'waitlist_offer',
        offerId,
      );
      if (holds.length === 0 || holds.some((h) => h.status !== 'active')) {
        throw errors.capacityUnavailable('The place reserved by this offer is no longer held.', {
          offerId,
        });
      }
      const person = await this.evaluator.participant(
        trx,
        organizationId,
        entry.participant_person_id,
      );
      const snapshot = await this.evaluator.snapshot(trx, organizationId, entry.offering_id);
      const evaluation = await this.evaluator.evaluate(trx, organizationId, {
        snapshot,
        person,
        intent: entry.intent,
        session: session ?? undefined,
      });
      if (!evaluation.result.eligible) {
        throw errors.eligibility('The participant is no longer eligible for this offering.', {
          participantPersonId: person.id,
          reasons: evaluation.result.reasons,
          alternatives: evaluation.result.alternatives,
        });
      }
      const missing = missingAcknowledgments(evaluation.result);
      if (missing.length > 0) {
        throw errors.missingAcknowledgment(
          'Required forms must be acknowledged before accepting.',
          {
            participantPersonId: person.id,
            policyVersionIds: missing,
          },
        );
      }
      // Consume exactly once: only an `offered` row moves, and the guard trigger refuses any later change.
      const consumed = await trx
        .updateTable('waitlist_offers')
        .set({ status: 'accepted', accepted_at: now, revision: offer.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', offerId)
        .where('status', '=', 'offered')
        .executeTakeFirst();
      if (Number(consumed.numUpdatedRows) === 0)
        throw errors.invalidTransition('WaitlistOffer', offer.status, 'accept');

      const staffLike = isStaffLike(principal);
      let basketId: string | null = null;
      let enrollmentId: string | null = null;
      let bookingId: string | null = null;
      if (session) {
        // §4.7 (1), SPK-REG-009: a customer accepting pays for the booking themselves (finance
        // lets only the payer pay); staff may name a payer or keep the one the entry recorded.
        const payerPersonId = staffLike
          ? (input.payerPersonId ?? entry.payer_person_id ?? null)
          : (resolveCustomerPayer(principal, input.payerPersonId, [principal.personId]) ??
            principal.personId);
        const booking = await this.bookings.createInTrx(trx, organizationId, {
          kind:
            entry.intent === 'trial' ? 'trial' : entry.intent === 'makeup' ? 'makeup' : 'pickup',
          snapshot,
          session,
          person,
          evaluation,
          payerPersonId,
          actor: principal,
          existingHoldIds: holds.map((h) => h.id),
          correlationId,
        });
        bookingId = booking.id;
      } else {
        // SPK-REG-009: the basket belongs to the family, never to the staff member who assists: an
        // unnamed owner is the customer accepting, or for staff the entry's payer or the customer
        // who joined the queue.
        const requestedBy = entry.requested_by as { kind?: unknown } | null;
        const ownerPersonId =
          input.ownerPersonId ??
          (staffLike
            ? (entry.payer_person_id ??
              (requestedBy?.kind === 'customer' ? entry.requested_by_person_id : null))
            : principal.personId);
        if (!ownerPersonId)
          throw errors.validation('ownerPersonId is required when staff accept an offer.', {
            path: 'ownerPersonId',
          });
        const owner = await this.evaluator.participant(trx, organizationId, ownerPersonId);
        if (owner.kind !== 'adult')
          throw errors.validation('A basket belongs to an adult household member.');
        // §4.7 (1), §4.14: the same authority POST /baskets and its lines require, over the owner's
        // household and the participant; the offer stays `offered` when it is refused (rollback).
        await this.authorization.require(principal, EnrollmentActions.manageBasket, {
          type: 'basket',
          organizationId,
          subjectPersonIds: [...new Set([owner.id, person.id])],
        });
        // The payer follows the basket owner (finance lets only the payer quote and pay): a
        // customer names only themselves or the owner; staff may name another payer.
        const payerPersonId = staffLike
          ? (input.payerPersonId ?? entry.payer_person_id ?? owner.id)
          : (resolveCustomerPayer(principal, input.payerPersonId, [principal.personId, owner.id]) ??
            owner.id);
        let application = await this.applications.findCurrent(
          trx,
          organizationId,
          snapshot.offering.id,
          person.id,
          [principal.personId, owner.id, payerPersonId],
        );
        application = this.applications.forIntent(application, entry.intent);
        if (!application) {
          application = await this.applications.createInTrx(trx, organizationId, {
            snapshot,
            person,
            intent: entry.intent,
            evaluation,
            payerPersonId,
            teamEntryId: null,
            sessionId: null,
            notes: null,
            actor: principal,
            correlationId,
          });
        }
        const opened = await this.baskets.openForLine(trx, organizationId, {
          owner,
          payerPersonId,
          actor: principal,
          participant: person,
          snapshot,
          intent: entry.intent,
          sessionId: null,
          evaluation,
          applicationId: application.id,
          correlationId,
        });
        const held = await this.baskets.holdOpenedBasket(
          trx,
          organizationId,
          opened.basket,
          opened.lineId,
          principal,
          holds.map((h) => h.id),
          minutesFrom(now, this.evaluator.configuration.holdMinutes),
          correlationId,
        );
        basketId = held.basket.id;
        enrollmentId = held.enrollmentId;
      }
      await trx
        .updateTable('waitlist_offers')
        .set({
          accepted_basket_id: basketId,
          accepted_enrollment_id: enrollmentId,
          accepted_session_booking_id: bookingId,
          revision: offer.revision + 2,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', offerId)
        .execute();
      await trx
        .updateTable('waitlist_entries')
        .set({
          status: 'accepted',
          accepted_enrollment_id: enrollmentId,
          revision: entry.revision + 1,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', entry.id)
        .where('revision', '=', entry.revision)
        .execute();
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: 'enrollment.accept_waitlist_offer',
        targetType: 'waitlist_offer',
        targetId: offerId,
        beforeRevision: offer.revision,
        afterRevision: offer.revision + 2,
        correlationId,
        details: { waitlistEntryId: entry.id, basketId, enrollmentId, sessionBookingId: bookingId },
      });
      await this.outbox.enqueue(trx, EnrollmentEvents.waitlistOfferResolved, {
        organizationId,
        aggregateType: 'waitlist_offer',
        aggregateId: offerId,
        correlationId,
        payload: {
          organizationId,
          offerId,
          waitlistEntryId: entry.id,
          status: 'accepted',
          basketId,
        },
      });
      const updatedOffer = await this.loadOffer(trx, organizationId, offerId);
      const updatedEntry = await this.loadEntry(trx, organizationId, entry.id);
      const basket = basketId ? await this.baskets.getBasket(organizationId, basketId, trx) : null;
      const booking = bookingId
        ? await this.bookings.load(trx, organizationId, bookingId)
        : undefined;
      return {
        offer: toWaitlistOffer(updatedOffer!),
        entry: redactWaitlistEntry(
          principal,
          await this.view(trx, organizationId, updatedEntry!),
          entry.requested_by_person_id,
        ),
        basket,
        sessionBooking: booking ? toSessionBooking(booking) : null,
      };
    });
  }

  async decline(
    principal: Principal,
    offerId: string,
    input: DeclineWaitlistOfferInput,
    correlationId: string | null,
  ): Promise<WaitlistOffer> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const offer = await this.loadOffer(trx, organizationId, offerId, true);
      const entry = offer
        ? await this.loadEntry(trx, organizationId, offer.waitlist_entry_id, true)
        : undefined;
      if (!offer || !entry) throw errors.protectedNotFound('waitlist_offer');
      await this.authorization.require(principal, EnrollmentActions.joinWaitlist, {
        type: 'waitlist_offer',
        id: offerId,
        organizationId,
        subjectPersonIds: [entry.participant_person_id],
        protected: true,
      });
      assertExpectedRevision(input.expectedRevision, offer.revision);
      if (offer.status !== 'offered')
        throw errors.invalidTransition('WaitlistOffer', offer.status, 'decline');
      await this.closeOffer(
        trx,
        organizationId,
        offer,
        'declined',
        input.reason ?? 'declined',
        principal,
        correlationId,
      );
      // Declining leaves the queue: the participant chose not to take the place.
      await trx
        .updateTable('waitlist_entries')
        .set({ status: 'withdrawn', withdrawn_at: this.clock.now(), revision: entry.revision + 1 })
        .where('organization_id', '=', organizationId)
        .where('id', '=', entry.id)
        .where('revision', '=', entry.revision)
        .execute();
      return toWaitlistOffer((await this.loadOffer(trx, organizationId, offerId))!);
    });
  }

  /** Closes an open offer (declined or expired) and gives its places back to the pools. */
  private async closeOffer(
    trx: Trx,
    organizationId: string,
    offer: WaitlistOfferRow,
    status: 'declined' | 'expired',
    reason: string,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    const now = this.clock.now();
    const closed = await trx
      .updateTable('waitlist_offers')
      .set({
        status,
        declined_at: status === 'declined' ? now : null,
        expired_at: status === 'expired' ? now : null,
        revision: offer.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', offer.id)
      .where('status', '=', 'offered')
      .executeTakeFirst();
    if (Number(closed.numUpdatedRows) === 0) return;
    for (const hold of await this.capacity.holdsOfOwner(
      trx,
      organizationId,
      'waitlist_offer',
      offer.id,
    )) {
      if (hold.status === 'active')
        await this.capacity.releaseHoldRow(trx, organizationId, hold.id, reason, correlationId);
    }
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: `enrollment.${status === 'declined' ? 'decline' : 'expire'}_waitlist_offer`,
      targetType: 'waitlist_offer',
      targetId: offer.id,
      beforeRevision: offer.revision,
      afterRevision: offer.revision + 1,
      reason,
      correlationId,
    });
    await this.outbox.enqueue(trx, EnrollmentEvents.waitlistOfferResolved, {
      organizationId,
      aggregateType: 'waitlist_offer',
      aggregateId: offer.id,
      correlationId,
      payload: {
        organizationId,
        offerId: offer.id,
        waitlistEntryId: offer.waitlist_entry_id,
        status,
        basketId: null,
      },
    });
  }

  /**
   * Hold-expiry follow-up for an offer's hold: the offer expires, its other holds are released,
   * and the entry follows the configured priority policy (DEC-006: requeue at the end by default).
   * The released places produce the next offers through `enrollment.capacity_released`.
   */
  async onOfferHoldExpired(
    trx: Trx,
    organizationId: string,
    hold: HoldRow,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    if (!hold.owner_id) return;
    const offer = await this.loadOffer(trx, organizationId, hold.owner_id, true);
    if (!offer || offer.status !== 'offered') return;
    const entry = await this.loadEntry(trx, organizationId, offer.waitlist_entry_id, true);
    await this.closeOffer(
      trx,
      organizationId,
      offer,
      'expired',
      'offer_expired',
      actor,
      correlationId,
    );
    if (!entry || entry.status !== 'offered') return;
    const behaviour = this.evaluator.configuration.offerExpiryBehaviour;
    const now = this.clock.now();
    await trx
      .updateTable('waitlist_entries')
      .set(
        behaviour === 'remove'
          ? { status: 'expired', revision: entry.revision + 1 }
          : behaviour === 'requeue_end'
            ? { status: 'waiting', queued_at: now, revision: entry.revision + 1 }
            : { status: 'waiting', revision: entry.revision + 1 },
      )
      .where('organization_id', '=', organizationId)
      .where('id', '=', entry.id)
      .where('revision', '=', entry.revision)
      .execute();
  }
}
