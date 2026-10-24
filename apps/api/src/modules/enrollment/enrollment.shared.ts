import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  errors,
  systemPrincipal,
  type Application,
  type Basket,
  type BasketLine,
  type CapacityPool,
  type EligibilityOverride,
  type EligibilityResult,
  type Enrollment,
  type FinancialConsequence,
  type Hold,
  type MakeupEntitlement,
  type PlacementReason,
  type PlacementRequest,
  type PolicyReferences,
  type PriceSnapshot,
  type Principal,
  type RegistrationActorSnapshot,
  type SessionBooking,
  type TrialParticipation,
  type WaitlistEntry,
  type WaitlistOffer,
} from '@sportspark/contracts';
import type {
  ApplicationsTable,
  BasketLinesTable,
  BasketsTable,
  CapacityPoolsTable,
  Db,
  EnrollmentsTable,
  HoldsTable,
  MakeupEntitlementsTable,
  MakeupRedemptionsTable,
  PlacementRequestsTable,
  SessionBookingsTable,
  TrialParticipationsTable,
  WaitlistEntriesTable,
  WaitlistOffersTable,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import {
  snapshotActor,
  type ActionDefinition,
  type AuthorizationService,
  type AuthorizationTargetInput,
  type RequestWithContext,
  type Trx,
} from '../../kernel';

/** Correlation id assigned by the kernel middleware, for audit and outbox records (§4.10). */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().correlationId ?? null,
);

export type Reader = Db | Trx;

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

export function isStaffLike(principal: Principal): boolean {
  return principal.kind === 'staff' || principal.kind === 'system';
}

/**
 * §4.10: should a denied staff-only command on a customer-private record read as NOT_FOUND? Yes
 * for a customer who may not even read the record (another household), so its existence never
 * leaks; a customer who may read it (their own child's) and staff get the honest ACCESS_DENIED.
 */
export async function hiddenFrom(
  authorization: AuthorizationService,
  principal: Principal,
  readAction: ActionDefinition,
  target: AuthorizationTargetInput,
): Promise<boolean> {
  if (isStaffLike(principal)) return false;
  return !(await authorization.decide(principal, readAction, target)).allowed;
}

/** The system principal enrollment uses for its own follow-up work (outbox handlers, timers). */
export function enrollmentSystem(organizationId: string, label = 'enrollment'): Principal {
  return systemPrincipal(organizationId, label);
}

// ---------------------------------------------------------------------------------------------
// Payer privacy (SPK-AT-004, §4.14): a guardian who may see a child's participation does not
// learn which other adult registered or pays for it. Staff, the payer and the registrant see all.
// ---------------------------------------------------------------------------------------------

const REDACTED_ACTOR: RegistrationActorSnapshot = {
  kind: 'customer',
  accountId: null,
  personId: null,
  staffRoles: [],
  actorLabel: 'another authorized adult',
};

function seesPrivateFacts(principal: Principal, personIds: ReadonlyArray<string | null>): boolean {
  if (isStaffLike(principal)) return true;
  return principal.personId !== null && personIds.includes(principal.personId);
}

export function redactApplication(principal: Principal, application: Application): Application {
  if (seesPrivateFacts(principal, [application.payerPersonId, application.submittedByPersonId])) {
    return application;
  }
  return {
    ...application,
    submittedBy:
      application.submittedBy.kind === 'staff' ? application.submittedBy : REDACTED_ACTOR,
    submittedByPersonId: null,
    payerPersonId: null,
  };
}

export function redactEnrollment(principal: Principal, enrollment: Enrollment): Enrollment {
  if (seesPrivateFacts(principal, [enrollment.payerPersonId, enrollment.registeredBy.personId])) {
    return enrollment;
  }
  return {
    ...enrollment,
    registeredBy:
      enrollment.registeredBy.kind === 'staff' ? enrollment.registeredBy : REDACTED_ACTOR,
    payerPersonId: null,
    basketId: null,
    basketLineId: null,
    orderRef: null,
    cancellationConsequence: null,
  };
}

export function redactSessionBooking(
  principal: Principal,
  booking: SessionBooking,
): SessionBooking {
  if (seesPrivateFacts(principal, [booking.payerPersonId, booking.bookedBy.personId]))
    return booking;
  return {
    ...booking,
    bookedBy: booking.bookedBy.kind === 'staff' ? booking.bookedBy : REDACTED_ACTOR,
    payerPersonId: null,
  };
}

export function redactWaitlistEntry(
  principal: Principal,
  entry: WaitlistEntry,
  requestedByPersonId: string | null,
): WaitlistEntry {
  if (seesPrivateFacts(principal, [entry.payerPersonId, requestedByPersonId])) return entry;
  return { ...entry, payerPersonId: null };
}

export const iso = (value: Date | string): string => new Date(value).toISOString();
export const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : iso(value);

export function minutesFrom(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

export function actorSnapshot(principal: Principal): RegistrationActorSnapshot {
  const snapshot = snapshotActor(principal);
  return {
    kind: principal.kind,
    accountId: principal.accountId,
    personId: principal.personId,
    staffRoles: [...principal.staffRoles],
    actorLabel: String(snapshot['actorLabel'] ?? principal.actorLabel),
  };
}

function toActor(value: Record<string, unknown>): RegistrationActorSnapshot {
  return {
    kind: (value['kind'] as RegistrationActorSnapshot['kind']) ?? 'system',
    accountId: (value['accountId'] as string | null) ?? null,
    personId: (value['personId'] as string | null) ?? null,
    staffRoles: Array.isArray(value['staffRoles']) ? (value['staffRoles'] as string[]) : [],
    actorLabel: String(value['actorLabel'] ?? 'unknown'),
  };
}

function emptyToNull<T>(value: Record<string, unknown> | null | undefined): T | null {
  if (!value || Object.keys(value).length === 0) return null;
  return value as unknown as T;
}

export function toPolicyReferences(value: Record<string, unknown>): PolicyReferences {
  return {
    eligibilityPolicyVersionId: (value['eligibilityPolicyVersionId'] as string | null) ?? null,
    cancellationPolicyVersionId: (value['cancellationPolicyVersionId'] as string | null) ?? null,
    requiredFormPolicyVersionIds: Array.isArray(value['requiredFormPolicyVersionIds'])
      ? (value['requiredFormPolicyVersionIds'] as string[])
      : [],
    approvalPolicyVersionId: (value['approvalPolicyVersionId'] as string | null) ?? null,
  };
}

/** Runs `fn` inside a savepoint so a failing line of a partial basket rolls back alone. */
export async function withSavepoint<T>(trx: Trx, name: string, fn: () => Promise<T>): Promise<T> {
  await sql.raw(`savepoint "${name}"`).execute(trx);
  try {
    const result = await fn();
    await sql.raw(`release savepoint "${name}"`).execute(trx);
    return result;
  } catch (error) {
    await sql.raw(`rollback to savepoint "${name}"`).execute(trx);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Row → contract mappers
// ---------------------------------------------------------------------------------------------

export function toCapacityPool(row: Selectable<CapacityPoolsTable>): CapacityPool {
  return {
    id: row.id,
    offeringId: row.offering_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    unit: row.unit,
    constraintKind: row.constraint_kind,
    capacity: row.capacity,
    committed: row.committed,
    held: row.held,
    available: row.capacity - row.committed - row.held,
    participantsPerStaff: row.participants_per_staff,
    staffCount: row.staff_count,
    status: row.status,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toHold(row: Selectable<HoldsTable>): Hold {
  return {
    id: row.id,
    poolId: row.pool_id,
    quantity: row.quantity,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    basketId: row.basket_id,
    status: row.status,
    acquiredAt: iso(row.acquired_at),
    expiresAt: iso(row.expires_at),
    committedAt: isoOrNull(row.committed_at),
    releasedAt: isoOrNull(row.released_at),
    expiredAt: isoOrNull(row.expired_at),
    releaseReason: row.release_reason,
    revision: row.revision,
  };
}

export function toApplication(row: Selectable<ApplicationsTable>): Application {
  return {
    id: row.id,
    offeringId: row.offering_id,
    participantPersonId: row.participant_person_id,
    intent: row.intent,
    status: row.status,
    submittedBy: toActor(row.submitted_by),
    submittedByPersonId: row.submitted_by_person_id,
    payerPersonId: row.payer_person_id,
    eligibility: emptyToNull<EligibilityResult>(row.eligibility_result),
    override: emptyToNull<EligibilityOverride>(row.override),
    requiresApproval: row.requires_approval,
    teamEntryId: row.team_entry_id,
    sessionId: row.session_id,
    notes: row.notes,
    submittedAt: isoOrNull(row.submitted_at),
    decidedAt: isoOrNull(row.decided_at),
    decidedByPersonId: row.decided_by_person_id,
    decisionReason: row.decision_reason,
    withdrawnAt: isoOrNull(row.withdrawn_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toEnrollment(row: Selectable<EnrollmentsTable>): Enrollment {
  return {
    id: row.id,
    offeringId: row.offering_id,
    participantPersonId: row.participant_person_id,
    intent: row.intent,
    entitlementDefinitionId: row.entitlement_definition_id,
    equivalenceKey: row.equivalence_key,
    status: row.status,
    payerPersonId: row.payer_person_id,
    registeredBy: toActor(row.registered_by),
    assistedByPersonId: row.assisted_by_person_id,
    sourceApplicationId: row.source_application_id,
    basketId: row.basket_id,
    basketLineId: row.basket_line_id,
    placementRequestId: row.placement_request_id,
    trialParticipationId: row.trial_participation_id,
    orderRef: row.order_ref,
    lastOperationId: row.last_operation_id,
    price: emptyToNull<PriceSnapshot>(row.price_snapshot),
    policies: toPolicyReferences(row.policy_references),
    confirmedAt: isoOrNull(row.confirmed_at),
    canceledAt: isoOrNull(row.canceled_at),
    cancellationReason: row.cancellation_reason,
    cancellationPolicyVersionId: row.cancellation_policy_version_id,
    cancellationConsequence: emptyToNull<FinancialConsequence>(row.cancellation_consequence),
    transferredAt: isoOrNull(row.transferred_at),
    transferredToEnrollmentId: row.transferred_to_enrollment_id,
    transferredFromEnrollmentId: row.transferred_from_enrollment_id,
    completedAt: isoOrNull(row.completed_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface BasketLineRow extends Selectable<BasketLinesTable> {
  offering_kind?: string | null;
  application_status?: string | null;
}

export function toBasketLine(row: BasketLineRow): BasketLine {
  return {
    id: row.id,
    basketId: row.basket_id,
    sequence: row.sequence,
    participantPersonId: row.participant_person_id,
    offeringId: row.offering_id,
    offeringKind: (row.offering_kind as BasketLine['offeringKind']) ?? null,
    sessionId: row.session_id,
    teamEntryId: row.team_entry_id,
    intent: row.intent,
    quantity: row.quantity,
    applicationId: row.application_id,
    applicationStatus: (row.application_status as BasketLine['applicationStatus']) ?? null,
    trialParticipationId: row.trial_participation_id,
    entitlementDefinitionId: row.entitlement_definition_id,
    equivalenceKey: row.equivalence_key,
    eligibility: emptyToNull<EligibilityResult>(row.eligibility_result),
    price: emptyToNull<PriceSnapshot>(row.price_snapshot),
    policies: toPolicyReferences(row.policy_references),
    requiresApproval: row.requires_approval,
    enrollmentId: row.enrollment_id,
    outcome: row.outcome,
    outcomeReason: row.outcome_reason,
    revision: row.revision,
  };
}

export function toBasket(
  row: Selectable<BasketsTable>,
  lines: BasketLine[],
  holds: Hold[],
): Basket {
  const subtotalMinor = lines.reduce(
    (sum, line) => sum + (line.price ? line.price.basePriceMinor * line.quantity : 0),
    0,
  );
  return {
    id: row.id,
    ownerPersonId: row.owner_person_id,
    payerPersonId: row.payer_person_id,
    createdBy: toActor(row.created_by),
    assistedByPersonId: row.assisted_by_person_id,
    fulfillmentMode: row.fulfillment_mode,
    partialAcceptedAt: isoOrNull(row.partial_accepted_at),
    status: row.status,
    holdExpiresAt: isoOrNull(row.hold_expires_at),
    currency: row.currency,
    subtotalMinor,
    approvalPending: lines.some(
      (line) =>
        line.requiresApproval &&
        line.applicationStatus !== 'accepted' &&
        line.outcome !== 'confirmed',
    ),
    orderRef: row.order_ref,
    lastOperationId: row.last_operation_id,
    lines,
    holds,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toPlacementRequest(row: Selectable<PlacementRequestsTable>): PlacementRequest {
  return {
    id: row.id,
    participantPersonId: row.participant_person_id,
    applicationId: row.application_id,
    enrollmentId: row.enrollment_id,
    offeringId: row.offering_id,
    seasonId: row.season_id,
    status: row.status,
    availability: row.availability as PlacementRequest['availability'],
    preferredCompetitionId: row.preferred_competition_id,
    preferredDivisionId: row.preferred_division_id,
    declaredLevel: row.declared_level,
    positionPreferences: row.position_preferences as string[],
    requestedTeammatePersonIds: row.requested_teammate_person_ids as string[],
    notes: row.notes,
    proposedTeamEntryId: row.proposed_team_entry_id,
    proposedAt: isoOrNull(row.proposed_at),
    proposalReasons: row.proposal_reasons as PlacementReason[],
    assignedTeamEntryId: row.assigned_team_entry_id,
    assignedAt: isoOrNull(row.assigned_at),
    decidedByPersonId: row.decided_by_person_id,
    decisionReasons: row.decision_reasons as PlacementReason[],
    rosterMembershipRef: row.roster_membership_ref,
    lastOperationId: row.last_operation_id,
    releasedAt: isoOrNull(row.released_at),
    releaseReason: row.release_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toSessionBooking(row: Selectable<SessionBookingsTable>): SessionBooking {
  return {
    id: row.id,
    offeringId: row.offering_id,
    sessionId: row.session_id,
    participantPersonId: row.participant_person_id,
    kind: row.kind,
    status: row.status,
    poolId: row.pool_id,
    holdId: row.hold_id,
    makeupEntitlementId: row.makeup_entitlement_id,
    scheduledStart: iso(row.scheduled_start),
    scheduledEnd: iso(row.scheduled_end),
    bookedBy: toActor(row.booked_by),
    assistedByPersonId: row.assisted_by_person_id,
    payerPersonId: row.payer_person_id,
    price: emptyToNull<PriceSnapshot>(row.price_snapshot),
    policies: toPolicyReferences(row.policy_references),
    eligibility: emptyToNull<EligibilityResult>(row.eligibility_result),
    expiresAt: isoOrNull(row.expires_at),
    confirmedAt: isoOrNull(row.confirmed_at),
    canceledAt: isoOrNull(row.canceled_at),
    cancelReason: row.cancel_reason,
    expiredAt: isoOrNull(row.expired_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toMakeupEntitlement(
  row: Selectable<MakeupEntitlementsTable>,
  redemptions: Selectable<MakeupRedemptionsTable>[],
): MakeupEntitlement {
  return {
    id: row.id,
    participantPersonId: row.participant_person_id,
    originatingEnrollmentId: row.originating_enrollment_id,
    originatingSessionId: row.originating_session_id,
    originKind: row.origin_kind,
    originReference: row.origin_reference,
    eligibleOfferingIds: row.eligible_offering_ids as string[],
    eligibleProgramIds: row.eligible_program_ids as string[],
    reason: row.reason,
    expiresAt: iso(row.expires_at),
    redemptionLimit: row.redemption_limit,
    redeemedCount: row.redeemed_count,
    status: row.status,
    redemptions: redemptions.map((r) => ({
      id: r.id,
      sessionBookingId: r.session_booking_id,
      kind: r.kind,
      reversesRedemptionId: r.reverses_redemption_id,
      redeemedAt: iso(r.redeemed_at),
    })),
    revokedAt: isoOrNull(row.revoked_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toWaitlistOffer(row: Selectable<WaitlistOffersTable>): WaitlistOffer {
  return {
    id: row.id,
    waitlistEntryId: row.waitlist_entry_id,
    poolId: row.pool_id,
    holdId: row.hold_id,
    quantity: row.quantity,
    offeredAt: iso(row.offered_at),
    expiresAt: iso(row.expires_at),
    status: row.status,
    acceptedAt: isoOrNull(row.accepted_at),
    acceptedBasketId: row.accepted_basket_id,
    acceptedEnrollmentId: row.accepted_enrollment_id,
    acceptedSessionBookingId: row.accepted_session_booking_id,
    declinedAt: isoOrNull(row.declined_at),
    expiredAt: isoOrNull(row.expired_at),
    revision: row.revision,
  };
}

export function toWaitlistEntry(
  row: Selectable<WaitlistEntriesTable>,
  position: number | null,
  offers: Selectable<WaitlistOffersTable>[],
): WaitlistEntry {
  return {
    id: row.id,
    offeringId: row.offering_id,
    poolId: row.pool_id,
    sessionId: row.session_id,
    participantPersonId: row.participant_person_id,
    intent: row.intent,
    priorityBasis: row.priority_basis,
    priorityRank: row.priority_rank,
    joinedAt: iso(row.joined_at),
    queuedAt: iso(row.queued_at),
    preferences: row.preferences,
    payerPersonId: row.payer_person_id,
    status: row.status,
    position,
    offerCount: row.offer_count,
    offers: offers.map(toWaitlistOffer),
    acceptedEnrollmentId: row.accepted_enrollment_id,
    withdrawnAt: isoOrNull(row.withdrawn_at),
    removedAt: isoOrNull(row.removed_at),
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toTrialParticipation(
  row: Selectable<TrialParticipationsTable>,
): TrialParticipation {
  return {
    id: row.id,
    offeringId: row.offering_id,
    sessionId: row.session_id,
    sessionBookingId: row.session_booking_id,
    participantPersonId: row.participant_person_id,
    applicationId: row.application_id,
    status: row.status,
    scheduledFor: isoOrNull(row.scheduled_for),
    attendedAt: isoOrNull(row.attended_at),
    canceledAt: isoOrNull(row.canceled_at),
    followUpConsent: row.follow_up_consent,
    followUp: row.follow_up,
    convertedEnrollmentId: row.converted_enrollment_id,
    convertedBasketId: row.converted_basket_id,
    convertedAt: isoOrNull(row.converted_at),
    registeredBy: toActor(row.registered_by),
    assistedByPersonId: row.assisted_by_person_id,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}
