import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import {
  errors,
  type Acknowledgment,
  type AgeBand,
  type Approval,
  type CapacityUnit,
  type ChargeLine,
  type DiscountDefinition,
  type DiscountEligibilityRules,
  type EntitlementDefinition,
  type Offering,
  type OfferingFacility,
  type OfferingLocation,
  type OfferingSession,
  type PolicyVersion,
  type PriceRule,
  type Principal,
  type Program,
  type PublicOffering,
} from '@sportspark/contracts';
import type {
  AcknowledgmentsTable,
  ApprovalsTable,
  DiscountDefinitionsTable,
  EntitlementDefinitionsTable,
  OfferingKind,
  OfferingSessionsTable,
  PolicyVersionsTable,
  PriceRulesTable,
  ProgramsTable,
  PublicationState,
} from '@sportspark/db';
import { sql, type Selectable } from 'kysely';
import type { RequestWithContext } from '../../kernel';

/** Correlation id assigned by the kernel middleware, for audit and outbox records (§4.10). */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null =>
    ctx.switchToHttp().getRequest<RequestWithContext>().correlationId ?? null,
);

export function organizationOf(principal: Principal): string {
  if (!principal.organizationId) throw errors.authenticationRequired();
  return principal.organizationId;
}

export const iso = (value: Date | string): string => new Date(value).toISOString();
export const isoOrNull = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : iso(value);

/** Whether [from, to) contains the instant (to = null means open-ended). */
export function isEffectiveAt(
  row: { effective_from: Date | string; effective_to: Date | string | null },
  at: Date,
): boolean {
  const from = new Date(row.effective_from).getTime();
  const to =
    row.effective_to === null ? Number.POSITIVE_INFINITY : new Date(row.effective_to).getTime();
  return from <= at.getTime() && at.getTime() < to;
}

// ---------------------------------------------------------------------------------------------
// Offerings: explicit column list so `date` columns come back as YYYY-MM-DD on both drivers.
// ---------------------------------------------------------------------------------------------
export const offeringColumns = [
  'offerings.id',
  'offerings.organization_id',
  'offerings.program_id',
  'offerings.facility_id',
  'offerings.name',
  'offerings.description',
  'offerings.kind',
  'offerings.activity_type',
  'offerings.format',
  'offerings.location',
  sql<string>`offerings.starts_on::text`.as('starts_on'),
  sql<string>`offerings.ends_on::text`.as('ends_on'),
  'offerings.registration_opens_at',
  'offerings.registration_closes_at',
  sql<string | null>`offerings.eligibility_reference_date::text`.as('eligibility_reference_date'),
  'offerings.eligibility_policy_version_id',
  'offerings.entitlement_definition_id',
  'offerings.capacity_units',
  'offerings.cancellation_policy_version_id',
  'offerings.responsible_manager_person_id',
  'offerings.publication_state',
  'offerings.published_at',
  'offerings.registration_opened_at',
  'offerings.closed_at',
  'offerings.archived_at',
  'offerings.copied_from_offering_id',
  'offerings.booking_terms_key',
  'offerings.revision',
  'offerings.created_at',
  'offerings.updated_at',
] as const;

export interface OfferingRow {
  id: string;
  organization_id: string;
  program_id: string;
  facility_id: string;
  name: string;
  description: string | null;
  kind: OfferingKind;
  activity_type: string;
  format: string | null;
  location: Record<string, unknown>;
  starts_on: string;
  ends_on: string;
  registration_opens_at: Date | string | null;
  registration_closes_at: Date | string | null;
  eligibility_reference_date: string | null;
  eligibility_policy_version_id: string | null;
  entitlement_definition_id: string | null;
  capacity_units: unknown[];
  cancellation_policy_version_id: string | null;
  responsible_manager_person_id: string | null;
  publication_state: PublicationState;
  published_at: Date | string | null;
  registration_opened_at: Date | string | null;
  closed_at: Date | string | null;
  archived_at: Date | string | null;
  copied_from_offering_id: string | null;
  booking_terms_key: string | null;
  revision: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface OfferingViewContext {
  ageBand: AgeBand;
  price: PriceRule | null;
  requiredFormPolicyVersionIds: string[];
  /** SPK-SCHED-008: the facility and its IANA zone (kernel facility directory, K-04). */
  facility: OfferingFacility;
  /** CAT-02: the approved booking terms version effective at the view instant (rental, party). */
  bookingTermsPolicyVersionId: string | null;
}

export function capacityUnitsOf(row: { capacity_units: unknown[] }): CapacityUnit[] {
  return row.capacity_units as CapacityUnit[];
}

/** SPK-REG-002: the configured reference date; the offering start date when none is configured. */
export function eligibilityReferenceDateOf(row: OfferingRow): string {
  return row.eligibility_reference_date ?? row.starts_on;
}

export function toPublicOffering(row: OfferingRow, ctx: OfferingViewContext): PublicOffering {
  const location = row.location as OfferingLocation;
  return {
    id: row.id,
    programId: row.program_id,
    facilityId: row.facility_id,
    facility: ctx.facility,
    name: row.name,
    description: row.description,
    kind: row.kind,
    activityType: row.activity_type,
    format: row.format,
    locationLabel: location.label ?? null,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    registrationOpensAt: isoOrNull(row.registration_opens_at),
    registrationClosesAt: isoOrNull(row.registration_closes_at),
    publicationState: row.publication_state,
    ageBand: ctx.ageBand,
    capacity: capacityUnitsOf(row).map((u) => ({ unit: u.unit, limit: u.limit })),
    price: ctx.price
      ? {
          priceRuleId: ctx.price.id,
          basePriceMinor: ctx.price.basePriceMinor,
          currency: ctx.price.currency,
          chargeLines: ctx.price.chargeLines,
        }
      : null,
    eligibilityPolicyVersionId: row.eligibility_policy_version_id,
    cancellationPolicyVersionId: row.cancellation_policy_version_id,
    requiredFormPolicyVersionIds: ctx.requiredFormPolicyVersionIds,
    entitlementDefinitionId: row.entitlement_definition_id,
    bookingTermsPolicyVersionId: ctx.bookingTermsPolicyVersionId,
  };
}

export function toOffering(
  row: OfferingRow,
  ctx: OfferingViewContext,
  includeStaff: boolean,
): Offering {
  return {
    ...toPublicOffering(row, ctx),
    staff: includeStaff
      ? {
          location: row.location as OfferingLocation,
          eligibilityReferenceDate: eligibilityReferenceDateOf(row),
          capacityUnits: capacityUnitsOf(row),
          responsibleManagerPersonId: row.responsible_manager_person_id,
          copiedFromOfferingId: row.copied_from_offering_id,
          bookingTermsKey: row.booking_terms_key,
          publishedAt: isoOrNull(row.published_at),
          registrationOpenedAt: isoOrNull(row.registration_opened_at),
          closedAt: isoOrNull(row.closed_at),
          archivedAt: isoOrNull(row.archived_at),
          revision: row.revision,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------
export function toProgram(row: Selectable<ProgramsTable>): Program {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    activityType: row.activity_type,
    format: row.format,
    ageBand: row.age_band as AgeBand,
    status: row.status,
    source: row.source,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toEntitlementDefinition(
  row: Selectable<EntitlementDefinitionsTable>,
): EntitlementDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    scope: row.scope,
    equivalenceScope: row.equivalence_scope,
    equivalenceRule: row.equivalence_rule,
    status: row.status,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toPolicyVersion(row: Selectable<PolicyVersionsTable>): PolicyVersion {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    version: row.version,
    title: row.title,
    content: row.content,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    approvalStatus: row.approval_status,
    approvedAt: isoOrNull(row.approved_at),
    retiredAt: isoOrNull(row.retired_at),
    retiredReason: row.retired_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function toApproval(row: Selectable<ApprovalsTable>): Approval {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    decision: row.decision,
    actorPersonId: row.actor_person_id,
    reason: row.reason,
    occurredAt: iso(row.occurred_at),
  };
}

export function toAcknowledgment(row: Selectable<AcknowledgmentsTable>): Acknowledgment {
  return {
    id: row.id,
    subjectPersonId: row.subject_person_id,
    policyVersionId: row.policy_version_id,
    signedByPersonId: row.signed_by_person_id,
    basis: row.basis,
    recordedByPersonId: row.recorded_by_kind === 'staff' ? row.recorded_by_person_id : null,
    recordedByKind: row.recorded_by_kind,
    signedAt: iso(row.signed_at),
    evidence: row.evidence,
    status: row.status,
    withdrawnAt: isoOrNull(row.withdrawn_at),
    withdrawnReason: row.withdrawn_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toOfferingSession(row: Selectable<OfferingSessionsTable>): OfferingSession {
  return {
    id: row.id,
    offeringId: row.offering_id,
    sequence: row.sequence,
    title: row.title,
    scheduledStart: iso(row.scheduled_start),
    scheduledEnd: iso(row.scheduled_end),
    schedulingEventId: row.scheduling_event_id,
    capacityOverride: (row.capacity_override as CapacityUnit[] | null) ?? null,
    status: row.status,
    canceledAt: isoOrNull(row.canceled_at),
    cancelReason: row.cancel_reason,
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

/**
 * The child-safe session view for readers who are not catalog staff (anonymous discovery,
 * customers), §4.14 "child information minimized and separated from public schedules": the same
 * shape, without the free-text cancel reason, the scheduling event id or capacity staffing and
 * group internals (the public capacity is the unit and its limit, as in `PublicOffering`).
 */
export function toPublicOfferingSession(row: Selectable<OfferingSessionsTable>): OfferingSession {
  const full = toOfferingSession(row);
  return {
    ...full,
    schedulingEventId: null,
    capacityOverride: full.capacityOverride?.map((u) => ({ unit: u.unit, limit: u.limit })) ?? null,
    cancelReason: null,
  };
}

export function toPriceRule(row: Selectable<PriceRulesTable>): PriceRule {
  return {
    id: row.id,
    offeringId: row.offering_id,
    version: row.version,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    basePriceMinor: row.base_price_minor,
    currency: row.currency,
    chargeLines: row.charge_lines as ChargeLine[],
    revision: row.revision,
    createdAt: iso(row.created_at),
  };
}

export function toDiscountDefinition(
  row: Selectable<DiscountDefinitionsTable>,
  redeemedCount: number,
): DiscountDefinition {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    amountKind: row.amount_kind,
    amountValue: row.amount_value,
    currency: row.currency,
    eligibilityRules: row.eligibility_rules as DiscountEligibilityRules,
    stackingRule: row.stacking_rule,
    stackingPriority: row.stacking_priority,
    capMinor: row.cap_minor,
    redemptionLimit: row.redemption_limit,
    perPersonLimit: row.per_person_limit,
    rounding: row.rounding,
    allocationMethod: row.allocation_method,
    effectiveFrom: iso(row.effective_from),
    effectiveTo: isoOrNull(row.effective_to),
    status: row.status,
    redeemedCount,
    revision: row.revision,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
