import { Inject, Injectable } from '@nestjs/common';
import {
  errors,
  newId,
  type ListMyPackageEntitlementsQuery,
  type ListPackageEntitlementsQuery,
  type Page,
  type PackageEntitlement,
  type Principal,
  type ReversePackageRedemptionInput,
} from '@sportspark/contracts';
import {
  isCheckViolation,
  json,
  pgConstraintName,
  type Db,
  type PackageEntitlementsTable,
  type PackageRedemptionsTable,
} from '@sportspark/db';
import type { Selectable } from 'kysely';
import {
  AuditWriter,
  AuthorizationService,
  CLOCK,
  DATABASE,
  FacilityDirectory,
  OperationalExceptions,
  Outbox,
  UnitOfWork,
  type Clock,
  type Trx,
} from '../../../kernel';
import {
  OFFERING_LOOKUP_PORT,
  type OfferingLookupPort,
  type OfferingSnapshot,
} from '../../catalog';
import { EnrollmentActions } from '../enrollment.actions';
import { EnrollmentPackageGEvents } from '../enrollment.events';
import {
  actorSnapshot,
  beforeCursor,
  cursorAt,
  decodeCreatedCursor,
  enrollmentSystem,
  iso,
  isoOrNull,
  keysetPage,
  organizationOf,
  type Reader,
} from '../enrollment.shared';
import { PackageEntitlementMachine } from '../enrollment.state-machines';
import { addWholeDays, localMidnightAfter } from '../package-g/local-dates';
import { covers, packageCreditReturn, typedScope } from '../package-g/scopes';
import { CustomerScope } from './customer-scope';
import { EnrollmentFacilityScope } from './facility-scope';
import type { SessionBookingRow } from './session-bookings.service';

export type PackageEntitlementRow = Selectable<PackageEntitlementsTable>;
type RedemptionRow = Selectable<PackageRedemptionsTable>;
export type CreditDisposition = 'returned' | 'retained_by_policy' | 'retained_pending_policy';

/**
 * Session packages (ENR-11; §3.16 Session packages row, SPK-COND-002, SPK-AT-020, §4.7
 * invariant 7). A confirmed package purchase issues one entitlement with the credits its
 * definition states; each booking made with it records a redemption in the same unit of work, and
 * the redemption trigger (migration 0506) is the guarantee that two concurrent redemptions of the
 * last credit never both succeed. Expiry is exactly what the definition chose (POL-039); a
 * canceled booking returns its credit only as the package's approved cancellation policy says
 * (POL-007) and is otherwise retained, pending policy when no policy states it. Redeeming needs
 * the `session_packages` switch (DEC-016, DEC-074); reversal, revocation, expiry and reads never
 * check it.
 */
@Injectable()
export class PackageEntitlementsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OFFERING_LOOKUP_PORT) private readonly offerings: OfferingLookupPort,
    private readonly uow: UnitOfWork,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly facilities: FacilityDirectory,
    private readonly exceptions: OperationalExceptions,
    private readonly customers: CustomerScope,
    private readonly scope: EnrollmentFacilityScope,
  ) {}

  async load(
    db: Reader,
    organizationId: string,
    id: string,
    forUpdate = false,
  ): Promise<PackageEntitlementRow | undefined> {
    let q = db
      .selectFrom('package_entitlements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    return q.executeTakeFirst();
  }

  private async redemptionsOf(
    db: Reader,
    organizationId: string,
    ids: readonly string[],
  ): Promise<Map<string, RedemptionRow[]>> {
    const out = new Map<string, RedemptionRow[]>();
    if (ids.length === 0) return out;
    const rows = await db
      .selectFrom('package_redemptions')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('package_entitlement_id', 'in', [...ids])
      .orderBy('redeemed_at')
      .orderBy('id')
      .execute();
    for (const row of rows) {
      const list = out.get(row.package_entitlement_id) ?? [];
      list.push(row);
      out.set(row.package_entitlement_id, list);
    }
    return out;
  }

  async views(
    db: Reader,
    organizationId: string,
    rows: readonly PackageEntitlementRow[],
  ): Promise<PackageEntitlement[]> {
    const redemptions = await this.redemptionsOf(
      db,
      organizationId,
      rows.map((r) => r.id),
    );
    const names = new Map<string, string | null>();
    for (const offeringId of new Set(rows.map((r) => r.offering_id))) {
      const snapshot = await this.offerings.getOffering(
        organizationId,
        offeringId,
        this.clock.now(),
        db === this.db ? undefined : (db as Trx),
      );
      names.set(offeringId, snapshot?.offering.name ?? null);
    }
    return rows.map((row) => ({
      id: row.id,
      participantPersonId: row.participant_person_id,
      enrollmentId: row.enrollment_id,
      offeringId: row.offering_id,
      offeringName: names.get(row.offering_id) ?? null,
      entitlementDefinitionId: row.entitlement_definition_id,
      appliesTo: {
        offeringIds: row.applies_to_offering_ids as string[],
        programIds: row.applies_to_program_ids as string[],
      },
      credits: row.credits,
      redeemedCount: row.redeemed_count,
      remainingCredits: Math.max(0, row.credits - row.redeemed_count),
      status: row.status,
      expiresAt: isoOrNull(row.expires_at),
      issuedAt: iso(row.issued_at),
      expiredAt: isoOrNull(row.expired_at),
      revokedAt: isoOrNull(row.revoked_at),
      revokedReason: row.revoked_reason,
      redemptions: (redemptions.get(row.id) ?? []).map((r) => ({
        id: r.id,
        sessionBookingId: r.session_booking_id,
        kind: r.kind,
        reversesRedemptionId: r.reverses_redemption_id,
        reason: r.reason,
        redeemedAt: iso(r.redeemed_at),
      })),
      revision: row.revision,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    }));
  }

  private async changed(
    trx: Trx,
    row: PackageEntitlementRow,
    change: 'issued' | 'redeemed' | 'reversed' | 'expired' | 'revoked',
    sessionBookingId: string | null,
    correlationId: string | null,
  ): Promise<void> {
    const current = (await this.load(trx, row.organization_id, row.id)) ?? row;
    await this.outbox.enqueue(trx, EnrollmentPackageGEvents.packageEntitlementChanged, {
      organizationId: row.organization_id,
      aggregateType: 'package_entitlement',
      aggregateId: row.id,
      correlationId,
      payload: {
        entitlementId: row.id,
        participantPersonId: row.participant_person_id,
        change,
        remainingCredits: Math.max(0, current.credits - current.redeemed_count),
        sessionBookingId,
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Issue (handler `enrollment.issue_package` on enrollment.enrollment_confirmed)
  // -------------------------------------------------------------------------------------------

  /**
   * Issues the credits of a confirmed package purchase once (unique per enrollment, so a replay
   * is a no-op). A definition whose scope cannot be read issues nothing and raises an owned
   * exception: nothing is guessed (POL-039).
   */
  async issueForEnrollment(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    correlationId: string | null,
  ): Promise<PackageEntitlementRow | null> {
    const enrollment = await trx
      .selectFrom('enrollments')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', enrollmentId)
      .executeTakeFirst();
    if (!enrollment || enrollment.intent !== 'package_purchase') return null;
    if (enrollment.status !== 'confirmed') return null;
    const existing = await trx
      .selectFrom('package_entitlements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .executeTakeFirst();
    if (existing) return existing;
    const issuedAt = enrollment.confirmed_at ? new Date(enrollment.confirmed_at) : this.clock.now();
    const snapshot = await this.offerings.getOffering(
      organizationId,
      enrollment.offering_id,
      issuedAt,
      trx,
    );
    const scope = snapshot ? typedScope(snapshot, 'package_credits') : null;
    const timezone = snapshot
      ? (await this.facilities.describe(organizationId, [snapshot.offering.facilityId], trx)).get(
          snapshot.offering.facilityId,
        )?.timezone
      : undefined;
    if (!snapshot || !scope || !timezone || !snapshot.entitlementDefinition) {
      await this.exceptions.raise(trx, {
        organizationId,
        facilityId: snapshot?.offering.facilityId ?? null,
        category: 'enrollment.package_scope_invalid',
        severity: 'high',
        title: 'A confirmed package purchase could not issue its credits',
        affectedType: 'enrollment',
        affectedId: enrollmentId,
        ownerQueue: 'program_manager',
        dedupeKey: `package_scope_invalid:${enrollmentId}`,
        details: {
          enrollmentId,
          offeringId: enrollment.offering_id,
          reason: !snapshot
            ? 'offering_unreadable'
            : !scope
              ? 'package_credits_scope_invalid'
              : 'facility_zone_unknown',
        },
      });
      return null;
    }
    const expiresAt =
      scope.expiry.kind === 'none'
        ? null
        : scope.expiry.kind === 'days_after_issue'
          ? addWholeDays(issuedAt, scope.expiry.days)
          : localMidnightAfter(scope.expiry.date, timezone);
    const id = newId();
    const inserted = await trx
      .insertInto('package_entitlements')
      .values({
        id,
        organization_id: organizationId,
        participant_person_id: enrollment.participant_person_id,
        enrollment_id: enrollmentId,
        entitlement_definition_id: snapshot.entitlementDefinition.id,
        offering_id: enrollment.offering_id,
        applies_to_offering_ids: json(scope.appliesTo.offeringIds ?? []),
        applies_to_program_ids: json(scope.appliesTo.programIds ?? []),
        credits: scope.credits,
        expires_at: expiresAt,
        issued_at: issuedAt,
      })
      .onConflict((oc) => oc.columns(['organization_id', 'enrollment_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!inserted) return null;
    const system = enrollmentSystem(organizationId, 'enrollment.issue_package');
    await this.audit.record(trx, {
      organizationId,
      actor: system,
      action: 'enrollment.issue_package',
      targetType: 'package_entitlement',
      targetId: id,
      afterRevision: 1,
      correlationId,
      details: {
        enrollmentId,
        offeringId: enrollment.offering_id,
        credits: scope.credits,
        expiry: scope.expiry,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    });
    await this.changed(trx, inserted, 'issued', null, correlationId);
    return inserted;
  }

  // -------------------------------------------------------------------------------------------
  // Redemption (called by SessionBookingsService.book in its unit of work)
  // -------------------------------------------------------------------------------------------

  /**
   * Locks the entitlement and checks it may pay for this session: the participant's own, active,
   * not expired at the session's booking instant, and the session's offering among those the
   * package applies to. The row lock serializes concurrent redemptions; the trigger decides.
   */
  async lockForRedemption(
    trx: Trx,
    organizationId: string,
    entitlementId: string,
    participantIds: readonly string[],
    sessionOffering: OfferingSnapshot,
  ): Promise<PackageEntitlementRow> {
    const row = await this.load(trx, organizationId, entitlementId, true);
    // §4.10: another participant's package reads as not found.
    if (!row || !participantIds.includes(row.participant_person_id)) {
      throw errors.protectedNotFound('package_entitlement');
    }
    const now = this.clock.now();
    if (
      row.status !== 'active' ||
      (row.expires_at !== null && new Date(row.expires_at).getTime() <= now.getTime())
    ) {
      throw errors.resourceConflict(
        row.status === 'exhausted'
          ? 'This package has no credit left.'
          : `This package is ${row.status === 'active' ? 'expired' : row.status}.`,
        {
          code: row.status === 'exhausted' ? 'PACKAGE_CREDITS_EXHAUSTED' : 'PACKAGE_NOT_REDEEMABLE',
          status: row.status,
          remainingCredits: Math.max(0, row.credits - row.redeemed_count),
        },
      );
    }
    const appliesTo = {
      offeringIds: row.applies_to_offering_ids as string[],
      programIds: row.applies_to_program_ids as string[],
    };
    if (!covers(appliesTo, sessionOffering.offering)) {
      throw errors.eligibility('This session is not covered by the package.', {
        reasons: [
          {
            code: 'package_not_applicable',
            severity: 'blocking',
            message: 'The package applies only to the offerings and programs it names.',
            source: { type: 'package_entitlement', id: row.id },
            requiredAction: 'choose_covered_session',
          },
        ],
        appliesTo,
      });
    }
    return row;
  }

  /** Records the redemption of one credit for the booking; the trigger refuses an extra one. */
  async recordRedemption(
    trx: Trx,
    organizationId: string,
    row: PackageEntitlementRow,
    booking: SessionBookingRow,
    actor: Principal,
    correlationId: string | null,
  ): Promise<void> {
    const now = this.clock.now();
    try {
      await trx
        .insertInto('package_redemptions')
        .values({
          id: newId(),
          organization_id: organizationId,
          package_entitlement_id: row.id,
          session_booking_id: booking.id,
          participant_person_id: booking.participant_person_id,
          kind: 'redeem',
          reverses_redemption_id: null,
          reason: null,
          actor: json(actorSnapshot(actor)),
          redeemed_at: now,
        })
        .execute();
    } catch (error) {
      if (isCheckViolation(error)) {
        throw errors.resourceConflict('This package has no credit left.', {
          code: 'PACKAGE_CREDITS_EXHAUSTED',
          constraint: pgConstraintName(error) ?? null,
        });
      }
      throw error;
    }
    const after = await this.load(trx, organizationId, row.id);
    await this.audit.record(trx, {
      organizationId,
      actor,
      action: 'enrollment.redeem_package',
      targetType: 'package_entitlement',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: after?.revision ?? null,
      correlationId,
      details: {
        sessionBookingId: booking.id,
        sessionId: booking.session_id,
        redeemedCount: after?.redeemed_count ?? null,
        status: after?.status ?? null,
      },
    });
    await this.changed(trx, row, 'redeemed', booking.id, correlationId);
  }

  /** Inserts the reversal of the booking's redemption, if it has one not yet reversed. */
  private async reverseIn(
    trx: Trx,
    organizationId: string,
    entitlementId: string,
    sessionBookingId: string,
    participantPersonId: string,
    actor: Principal,
    reason: string,
  ): Promise<boolean> {
    const redemption = await trx
      .selectFrom('package_redemptions')
      .select('id')
      .where('organization_id', '=', organizationId)
      .where('package_entitlement_id', '=', entitlementId)
      .where('session_booking_id', '=', sessionBookingId)
      .where('kind', '=', 'redeem')
      .executeTakeFirst();
    if (!redemption) return false;
    const inserted = await trx
      .insertInto('package_redemptions')
      .values({
        id: newId(),
        organization_id: organizationId,
        package_entitlement_id: entitlementId,
        session_booking_id: sessionBookingId,
        participant_person_id: participantPersonId,
        kind: 'reversal',
        reverses_redemption_id: redemption.id,
        reason,
        actor: json(actorSnapshot(actor)),
        redeemed_at: this.clock.now(),
      })
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .executeTakeFirst();
    return !!inserted;
  }

  /**
   * A canceled package booking (POL-007, POL-039): the credit returns when the package's approved
   * cancellation policy says so for this notice (`packageCreditReturn.untilMinutesBeforeStart`);
   * a later cancellation keeps it under that policy; without a policy stating it nothing returns
   * automatically (retained pending policy; staff may reverse the redemption).
   */
  async onBookingCanceled(
    trx: Trx,
    organizationId: string,
    booking: SessionBookingRow,
    actor: Principal,
    reason: string,
    correlationId: string | null,
  ): Promise<CreditDisposition> {
    if (!booking.package_entitlement_id) return 'retained_pending_policy';
    const row = await this.load(trx, organizationId, booking.package_entitlement_id, true);
    if (!row) return 'retained_pending_policy';
    const now = this.clock.now();
    const snapshot = await this.offerings.getOffering(organizationId, row.offering_id, now, trx);
    const rule = packageCreditReturn(snapshot?.cancellationPolicy ?? null);
    if (!rule) return 'retained_pending_policy';
    const deadline =
      new Date(booking.scheduled_start).getTime() - rule.untilMinutesBeforeStart * 60_000;
    if (now.getTime() > deadline) return 'retained_by_policy';
    const reversed = await this.reverseIn(
      trx,
      organizationId,
      row.id,
      booking.id,
      booking.participant_person_id,
      actor,
      reason,
    );
    if (reversed) {
      await this.audit.record(trx, {
        organizationId,
        actor,
        action: 'enrollment.return_package_credit',
        targetType: 'package_entitlement',
        targetId: row.id,
        beforeRevision: row.revision,
        reason,
        correlationId,
        details: {
          sessionBookingId: booking.id,
          cancellationPolicyVersionId: snapshot?.cancellationPolicy?.id ?? null,
          untilMinutesBeforeStart: rule.untilMinutesBeforeStart,
        },
      });
      await this.changed(trx, row, 'reversed', booking.id, correlationId);
    }
    return 'returned';
  }

  // -------------------------------------------------------------------------------------------
  // POST /package-redemptions/{id}/reverse (staff correction; never gated)
  // -------------------------------------------------------------------------------------------

  async reverse(
    principal: Principal,
    redemptionId: string,
    input: ReversePackageRedemptionInput,
    correlationId: string | null,
  ): Promise<PackageEntitlement> {
    const organizationId = organizationOf(principal);
    return this.uow.run(async ({ trx }) => {
      const redemption = await trx
        .selectFrom('package_redemptions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', redemptionId)
        .executeTakeFirst();
      if (!redemption) throw errors.protectedNotFound('package_redemption');
      const row = await this.load(trx, organizationId, redemption.package_entitlement_id, true);
      if (!row) throw errors.protectedNotFound('package_redemption');
      await this.authorization.require(principal, EnrollmentActions.reversePackageRedemption, {
        type: 'package_entitlement',
        id: row.id,
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
        subjectPersonIds: [row.participant_person_id],
        protected: true,
      });
      if (redemption.kind !== 'redeem') {
        throw errors.invalidTransition('PackageRedemption', 'reversal', 'reverse');
      }
      const reversed = await this.reverseIn(
        trx,
        organizationId,
        row.id,
        redemption.session_booking_id,
        redemption.participant_person_id,
        principal,
        input.reason,
      );
      if (!reversed) {
        throw errors.resourceConflict('This redemption was already reversed.', {
          code: 'REDEMPTION_ALREADY_REVERSED',
        });
      }
      // A canceled booking whose credit was kept now records it as returned.
      await trx
        .updateTable('session_bookings')
        .set((eb) => ({ credit_disposition: 'returned', revision: eb('revision', '+', 1) }))
        .where('organization_id', '=', organizationId)
        .where('id', '=', redemption.session_booking_id)
        .where('status', '=', 'canceled')
        .execute();
      const after = await this.load(trx, organizationId, row.id);
      await this.audit.record(trx, {
        organizationId,
        actor: principal,
        action: EnrollmentActions.reversePackageRedemption.id,
        targetType: 'package_entitlement',
        targetId: row.id,
        beforeRevision: row.revision,
        afterRevision: after?.revision ?? null,
        reason: input.reason,
        correlationId,
        details: { redemptionId, sessionBookingId: redemption.session_booking_id },
      });
      await this.changed(trx, row, 'reversed', redemption.session_booking_id, correlationId);
      const [view] = await this.views(trx, organizationId, [after ?? row]);
      return view as PackageEntitlement;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Revocation (handler on enrollment.enrollment_canceled) and expiry (periodic job)
  // -------------------------------------------------------------------------------------------

  /**
   * The purchase was canceled: its entitlement is revoked (`purchase_canceled`). Bookings already
   * made stay as they are; a future live one raises an owned exception so a person decides.
   */
  async revokeForEnrollment(
    trx: Trx,
    organizationId: string,
    enrollmentId: string,
    correlationId: string | null,
  ): Promise<void> {
    const row = await trx
      .selectFrom('package_entitlements')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('enrollment_id', '=', enrollmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!row || !PackageEntitlementMachine.can(row.status, 'revoke')) return;
    const now = this.clock.now();
    await trx
      .updateTable('package_entitlements')
      .set({
        status: PackageEntitlementMachine.next(row.status, 'revoke'),
        revoked_at: now,
        revoked_reason: 'purchase_canceled',
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .execute();
    const system = enrollmentSystem(organizationId, 'enrollment.revoke_package');
    await this.audit.record(trx, {
      organizationId,
      actor: system,
      action: 'enrollment.revoke_package',
      targetType: 'package_entitlement',
      targetId: row.id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      reason: 'purchase_canceled',
      correlationId,
      details: { enrollmentId },
    });
    await this.changed(trx, row, 'revoked', null, correlationId);
    const future = await trx
      .selectFrom('session_bookings')
      .select(['id', 'scheduled_start', 'offering_id'])
      .where('organization_id', '=', organizationId)
      .where('package_entitlement_id', '=', row.id)
      .where('status', 'in', ['pending', 'confirmed'])
      .where('scheduled_start', '>', now)
      .orderBy('scheduled_start')
      .execute();
    if (future.length > 0) {
      await this.exceptions.raise(trx, {
        organizationId,
        facilityId: await this.scope.facilityOf(organizationId, row.offering_id, trx),
        category: 'enrollment.revoked_package_has_bookings',
        severity: 'warning',
        title: 'A revoked session package still has future bookings',
        affectedType: 'package_entitlement',
        affectedId: row.id,
        ownerQueue: 'program_manager',
        deadlineAt: new Date(future[0]!.scheduled_start),
        dedupeKey: `revoked_package_bookings:${row.id}`,
        details: {
          enrollmentId,
          participantPersonId: row.participant_person_id,
          sessionBookingIds: future.map((b) => b.id),
        },
      });
    }
  }

  /** Expires one active entitlement whose expiry has passed (idempotent). */
  async expireIfDue(
    trx: Trx,
    organizationId: string,
    id: string,
    correlationId: string | null,
  ): Promise<boolean> {
    const row = await this.load(trx, organizationId, id, true);
    const now = this.clock.now();
    if (
      !row ||
      row.status !== 'active' ||
      row.expires_at === null ||
      new Date(row.expires_at).getTime() > now.getTime()
    ) {
      return false;
    }
    await trx
      .updateTable('package_entitlements')
      .set({
        status: PackageEntitlementMachine.next(row.status, 'expire'),
        expired_at: now,
        revision: row.revision + 1,
      })
      .where('organization_id', '=', organizationId)
      .where('id', '=', id)
      .where('revision', '=', row.revision)
      .execute();
    await this.audit.record(trx, {
      organizationId,
      actor: enrollmentSystem(organizationId, 'enrollment.expire_package_entitlements'),
      action: 'enrollment.expire_package',
      targetType: 'package_entitlement',
      targetId: id,
      beforeRevision: row.revision,
      afterRevision: row.revision + 1,
      correlationId,
      details: { expiresAt: iso(row.expires_at) },
    });
    await this.changed(trx, row, 'expired', null, correlationId);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async listMine(
    principal: Principal,
    query: ListMyPackageEntitlementsQuery,
  ): Promise<Page<PackageEntitlement>> {
    const organizationId = organizationOf(principal);
    const subjects = await this.customers.subjectIds(
      principal,
      EnrollmentActions.readPackageEntitlement,
    );
    if (subjects.length === 0) return { items: [], nextCursor: null };
    return this.page(organizationId, query, { participantIds: subjects });
  }

  async list(
    principal: Principal,
    query: ListPackageEntitlementsQuery,
  ): Promise<Page<PackageEntitlement>> {
    const organizationId = organizationOf(principal);
    if (!query.participantPersonId && principal.kind !== 'staff' && principal.kind !== 'system') {
      throw errors.validation('participantPersonId is required.');
    }
    await this.authorization.require(principal, EnrollmentActions.readPackageEntitlement, {
      type: 'package_entitlement',
      organizationId,
      subjectPersonIds: query.participantPersonId ? [query.participantPersonId] : undefined,
      protected: true,
    });
    // §4.3, §4.14: facility-scoped staff list only their facilities' packages.
    const offerings = await this.scope.listOfferings(
      principal,
      EnrollmentActions.readPackageEntitlement,
      organizationId,
      query.participantPersonId,
    );
    if (offerings?.length === 0) return { items: [], nextCursor: null };
    return this.page(organizationId, query, {
      participantIds: query.participantPersonId ? [query.participantPersonId] : undefined,
      offeringIds: query.offeringId
        ? offerings && !offerings.includes(query.offeringId)
          ? []
          : [query.offeringId]
        : (offerings ?? undefined),
    });
  }

  private async page(
    organizationId: string,
    query: { limit: number; cursor?: string; status?: PackageEntitlementRow['status'] },
    filter: { participantIds?: readonly string[]; offeringIds?: readonly string[] },
  ): Promise<Page<PackageEntitlement>> {
    if (filter.offeringIds?.length === 0) return { items: [], nextCursor: null };
    const cursor = decodeCreatedCursor(query.cursor);
    let q = this.db
      .selectFrom('package_entitlements')
      .selectAll()
      .select(cursorAt('package_entitlements').as('cursor_at'))
      .where('organization_id', '=', organizationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1);
    if (filter.participantIds)
      q = q.where('participant_person_id', 'in', [...filter.participantIds]);
    if (filter.offeringIds) q = q.where('offering_id', 'in', [...filter.offeringIds]);
    if (query.status) q = q.where('status', '=', query.status);
    if (cursor) q = q.where(beforeCursor('package_entitlements', cursor));
    const page = keysetPage(await q.execute(), query.limit);
    return {
      items: await this.views(this.db, organizationId, page.rows),
      nextCursor: page.nextCursor,
    };
  }

  /** Active entitlements whose expiry has passed (for the expiry job). */
  async dueForExpiry(
    now: Date,
    limit: number,
  ): Promise<Array<{ id: string; organization_id: string }>> {
    return this.db
      .selectFrom('package_entitlements')
      .select(['id', 'organization_id'])
      .where('status', '=', 'active')
      .where('expires_at', 'is not', null)
      .where('expires_at', '<=', now)
      .orderBy('expires_at')
      .orderBy('id')
      .limit(limit)
      .execute();
  }
}
