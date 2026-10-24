import { newId, type RegistrationIntent } from '@sportspark/contracts';
import {
  json,
  type CapacityConstraintKind,
  type CapacityPoolScopeType,
  type CapacityPoolUnit,
  type Db,
  type EnrollmentStatusValue,
  type HoldOwnerKind,
  type SessionBookingKind,
  type SessionBookingStatusValue,
} from '@sportspark/db';
import type { Clock } from '../../../kernel';

/**
 * Enrollment fixtures for downstream module tests (finance, entry, reporting, communications).
 * Rows are written directly through Kysely so they are fast and need no HTTP; the shapes mirror
 * what the services write, including the pool counters a hold or allocation implies, so the
 * capacity invariants (§4.7 invariant 3) hold in fixture data too. People come from the identity
 * fixtures and offerings from the catalog fixtures; the context is structural (a `TestApp` fits).
 */
export interface EnrollmentFixtureContext {
  db: Db;
  clock: Clock;
  organizationId: string;
}

const FIXTURE_ACTOR = { kind: 'system', actorLabel: 'fixtures' };

export async function createCapacityPoolFixture(
  ctx: EnrollmentFixtureContext,
  input: {
    offeringId?: string | null;
    scopeType?: CapacityPoolScopeType;
    scopeId?: string;
    unit?: CapacityPoolUnit;
    constraintKind?: CapacityConstraintKind;
    capacity: number;
    participantsPerStaff?: number | null;
    staffCount?: number | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const scopeType = input.scopeType ?? 'offering';
  const scopeId = input.scopeId ?? input.offeringId;
  if (!scopeId) throw new Error('createCapacityPoolFixture needs scopeId or offeringId');
  await ctx.db
    .insertInto('capacity_pools')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      offering_id: input.offeringId ?? null,
      scope_type: scopeType,
      scope_id: scopeId,
      unit: input.unit ?? 'seats',
      constraint_kind: input.constraintKind ?? 'commercial',
      capacity: input.capacity,
      participants_per_staff: input.participantsPerStaff ?? null,
      staff_count: input.staffCount ?? null,
      created_by: json(FIXTURE_ACTOR),
    })
    .execute();
  return id;
}

/** An enrollment row (confirmed by default) with the facts its status requires. */
export async function createEnrollmentFixture(
  ctx: EnrollmentFixtureContext,
  input: {
    offeringId: string;
    participantPersonId: string;
    status?: Extract<EnrollmentStatusValue, 'pending' | 'confirmed' | 'canceled' | 'completed'>;
    intent?: RegistrationIntent;
    payerPersonId?: string | null;
    equivalenceKey?: string | null;
    entitlementDefinitionId?: string | null;
    orderRef?: string | null;
    price?: { basePriceMinor: number; currency: string; priceRuleId: string } | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const status = input.status ?? 'confirmed';
  await ctx.db
    .insertInto('enrollments')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      offering_id: input.offeringId,
      participant_person_id: input.participantPersonId,
      intent: input.intent ?? 'youth',
      entitlement_definition_id: input.entitlementDefinitionId ?? null,
      equivalence_key: input.equivalenceKey ?? null,
      status,
      payer_person_id: input.payerPersonId ?? null,
      registered_by: json(FIXTURE_ACTOR),
      registered_by_person_id: null,
      assisted_by_person_id: null,
      source_application_id: null,
      basket_id: null,
      basket_line_id: null,
      placement_request_id: null,
      trial_participation_id: null,
      order_ref: input.orderRef ?? null,
      last_operation_id: null,
      price_snapshot: input.price ? json({ ...input.price, chargeLines: [] }) : null,
      policy_references: json({
        eligibilityPolicyVersionId: null,
        cancellationPolicyVersionId: null,
        requiredFormPolicyVersionIds: [],
      }),
      eligibility_result: json({}),
      confirmed_at: status === 'confirmed' || status === 'completed' ? now : null,
      canceled_at: status === 'canceled' ? now : null,
      cancellation_reason: status === 'canceled' ? 'fixture' : null,
      cancellation_policy_version_id: null,
      cancellation_consequence: null,
      transferred_at: null,
      transferred_to_enrollment_id: null,
      transferred_from_enrollment_id: null,
      completed_at: status === 'completed' ? now : null,
    })
    .execute();
  return id;
}

/** An active hold on a pool; the pool's `held` counter moves with it (the check constraint applies). */
export async function createHoldFixture(
  ctx: EnrollmentFixtureContext,
  input: {
    poolId: string;
    quantity?: number;
    ownerKind?: HoldOwnerKind;
    ownerId?: string | null;
    basketId?: string | null;
    expiresAt?: Date;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const organizationId = input.organizationId ?? ctx.organizationId;
  const quantity = input.quantity ?? 1;
  const now = ctx.clock.now();
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable('capacity_pools')
      .set((eb) => ({ held: eb('held', '+', quantity) }))
      .where('organization_id', '=', organizationId)
      .where('id', '=', input.poolId)
      .execute();
    await trx
      .insertInto('holds')
      .values({
        id,
        organization_id: organizationId,
        pool_id: input.poolId,
        quantity,
        owner_kind: input.ownerKind ?? 'staff',
        owner_id: input.ownerId ?? null,
        basket_id: input.basketId ?? null,
        actor: json(FIXTURE_ACTOR),
        acquired_at: now,
        expires_at: input.expiresAt ?? new Date(now.getTime() + 10 * 60_000),
      })
      .execute();
  });
  return id;
}

/** A session booking row (confirmed by default) for entry, calendar and reporting tests. */
export async function createSessionBookingFixture(
  ctx: EnrollmentFixtureContext,
  input: {
    offeringId: string;
    sessionId: string;
    participantPersonId: string;
    scheduledStart: Date;
    scheduledEnd: Date;
    kind?: SessionBookingKind;
    status?: Extract<SessionBookingStatusValue, 'pending' | 'confirmed' | 'canceled'>;
    payerPersonId?: string | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  const now = ctx.clock.now();
  const status = input.status ?? 'confirmed';
  await ctx.db
    .insertInto('session_bookings')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      offering_id: input.offeringId,
      session_id: input.sessionId,
      participant_person_id: input.participantPersonId,
      kind: input.kind ?? 'pickup',
      status,
      pool_id: null,
      hold_id: null,
      makeup_entitlement_id: null,
      scheduled_start: input.scheduledStart,
      scheduled_end: input.scheduledEnd,
      booked_by: json(FIXTURE_ACTOR),
      booked_by_person_id: null,
      assisted_by_person_id: null,
      payer_person_id: input.payerPersonId ?? null,
      price_snapshot: null,
      policy_references: json({}),
      eligibility_result: json({}),
      expires_at: null,
      confirmed_at: status === 'confirmed' ? now : null,
      canceled_at: status === 'canceled' ? now : null,
      cancel_reason: status === 'canceled' ? 'fixture' : null,
      expired_at: null,
    })
    .execute();
  return id;
}

/** An active makeup entitlement redeemable in the given offerings or programs. */
export async function createMakeupEntitlementFixture(
  ctx: EnrollmentFixtureContext,
  input: {
    participantPersonId: string;
    eligibleOfferingIds?: string[];
    eligibleProgramIds?: string[];
    redemptionLimit?: number;
    expiresAt?: Date;
    originatingSessionId?: string | null;
    organizationId?: string;
  },
): Promise<string> {
  const id = newId();
  await ctx.db
    .insertInto('makeup_entitlements')
    .values({
      id,
      organization_id: input.organizationId ?? ctx.organizationId,
      participant_person_id: input.participantPersonId,
      originating_enrollment_id: null,
      originating_session_id: input.originatingSessionId ?? null,
      origin_kind: input.originatingSessionId ? 'session_canceled' : 'manual',
      origin_reference: null,
      eligible_offering_ids: json(input.eligibleOfferingIds ?? []),
      eligible_program_ids: json(input.eligibleProgramIds ?? []),
      issued_by: json(FIXTURE_ACTOR),
      issued_by_person_id: null,
      reason: 'fixture',
      expires_at: input.expiresAt ?? new Date(ctx.clock.now().getTime() + 30 * 86_400_000),
      redemption_limit: input.redemptionLimit ?? 1,
      revoked_at: null,
      revoked_reason: null,
    })
    .execute();
  return id;
}
